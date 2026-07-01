// schedule-runner.js — Scan schedule-*.md files, match cron, build commands
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// Persist the last-fired time per task so a slot missed while the machine was
// asleep or the app was quit can be caught up on the next tick after wake/relaunch.
// (The tick is a plain per-minute poll: while the process runs its main-thread
// setInterval is precise — measured, not throttled by Chromium/App Nap — so the
// only real gaps are OS sleep and a full quit.) Mirrors db.js's data dir so a
// dev/test run with SWITCHBOARD_DATA_DIR stays isolated.
const DATA_DIR = process.env.SWITCHBOARD_DATA_DIR
  ? path.resolve(process.env.SWITCHBOARD_DATA_DIR.replace(/^~(?=$|\/)/, os.homedir()))
  : path.join(os.homedir(), '.switchboard');
const SCHEDULE_STATE_PATH = path.join(DATA_DIR, 'schedule-state.json');

// Bounded catch-up: only recover a slot missed within this window, so reopening
// after a long absence never resurrects an ancient (or a flood of) slots.
const CATCHUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function loadScheduleState() {
  try {
    const data = JSON.parse(fs.readFileSync(SCHEDULE_STATE_PATH, 'utf8'));
    const map = new Map();
    if (data && typeof data.lastFired === 'object' && data.lastFired) {
      for (const [k, v] of Object.entries(data.lastFired)) {
        if (typeof v === 'number' && Number.isFinite(v)) map.set(k, v);
      }
    }
    return map;
  } catch { return new Map(); }
}

function saveScheduleState(map) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = { lastFired: Object.fromEntries(map) };
    const tmp = SCHEDULE_STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, SCHEDULE_STATE_PATH); // atomic
  } catch { /* best-effort; a lost write just re-baselines next launch */ }
}

// Newest cron-matching minute in (max(sinceMs, now-window), now], or null.
// Returns at most one slot so a run is caught up ONCE, never once-per-missed-minute.
function newestDueSlot(cronExpr, nowMs, sinceMs) {
  const windowStart = Math.max(sinceMs, nowMs - CATCHUP_WINDOW_MS);
  const nowMinute = nowMs - (nowMs % 60000);
  for (let m = nowMinute; m > windowStart; m -= 60000) {
    if (cronMatches(cronExpr, new Date(m))) return m;
  }
  return null;
}

/** Parse YAML-like frontmatter from a markdown file (simple key: value parser). */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };

  const meta = {};
  let currentKey = null;
  const nested = {};

  for (const line of match[1].split('\n')) {
    if (currentKey && line.match(/^\s+/) && line.includes(':')) {
      const m = line.match(/^\s+([^:]+):\s*(.*)$/);
      if (m && !m[1].trim().startsWith('#')) {
        if (!nested[currentKey]) nested[currentKey] = {};
        nested[currentKey][m[1].trim()] = m[2].trim();
      }
      continue;
    }
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1].trim();
      const val = kv[2].trim();
      if (val === '' || val === undefined) {
        currentKey = key;
      } else {
        meta[key] = val;
        currentKey = null;
      }
    }
  }
  for (const [k, v] of Object.entries(nested)) {
    meta[k] = v;
  }
  return { meta, body: match[2].trim() };
}

// Check if a cron field matches a value. Supports *, ranges (1-5), lists (1,3,5), and steps.
function cronFieldMatches(field, value) {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (!Number.isInteger(step) || step < 1) return false; // '*/0' -> NaN, guard div-by-zero
    return value % step === 0;
  }
  if (field.includes(',')) {
    return field.split(',').some(f => cronFieldMatches(f.trim(), value));
  }
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  return parseInt(field, 10) === value;
}

/** Check if a 5-field cron expression matches the current time. */
function cronMatches(cronExpr, now) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dom, month, dow] = parts;
  const domMatch = cronFieldMatches(dom, now.getDate());
  // Standard cron treats both 0 and 7 as Sunday, but getDay() only returns 0-6.
  // On Sunday, also try 7 so fields/ranges/lists written with 7 (e.g. '7', '0,7',
  // '1-7') still match.
  const day = now.getDay();
  const dowMatch = cronFieldMatches(dow, day) || (day === 0 && cronFieldMatches(dow, 7));
  // POSIX cron: when BOTH day-of-month and day-of-week are restricted, the entry
  // fires if EITHER matches (OR). If one is '*', they are AND-combined (which, with
  // the '*' side always true, collapses to the restricted side).
  const dayMatch = (dom === '*' || dow === '*') ? (domMatch && dowMatch) : (domMatch || dowMatch);
  return (
    cronFieldMatches(minute, now.getMinutes()) &&
    cronFieldMatches(hour, now.getHours()) &&
    cronFieldMatches(month, now.getMonth() + 1) &&
    dayMatch
  );
}

/**
 * Resolve a project folder name to its project path from the SQLite cache.
 * Returns a Map<folder, projectPath>, or an empty Map if the cache is
 * unavailable (e.g. in tests that don't load the native DB binding).
 */
function loadFolderMetaMap() {
  try {
    // Lazy require so requiring schedule-runner.js never forces the native
    // better-sqlite3 binding to load (keeps the module test-friendly).
    const { getAllFolderMeta } = require('./db');
    const meta = getAllFolderMeta();
    const map = new Map();
    for (const [folder, row] of meta) {
      if (row && row.projectPath) map.set(folder, row.projectPath);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Read a project folder's first JSONL just enough to extract its cwd. */
function readProjectPathFromJsonl(folderPath) {
  try {
    const jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
    for (const jf of jsonlFiles) {
      const head = fs.readFileSync(path.join(folderPath, jf), 'utf8').slice(0, 4000);
      for (const line of head.split('\n').filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          if (entry.cwd) return entry.cwd;
        } catch {}
      }
    }
  } catch {}
  return null;
}

/** Scan all projects for schedule-*.md files and return parsed schedule objects. */
function scanSchedules(log) {
  const schedules = [];
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return schedules;
    const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    // Prefer the cached folder→projectPath mapping; only read JSONLs for
    // folders genuinely missing from the cache. This avoids re-reading 4KB of
    // every JSONL of every project on each 60s tick.
    const folderMeta = loadFolderMetaMap();

    for (const folder of folders) {
      const folderPath = path.join(PROJECTS_DIR, folder.name);
      let projectPath = folderMeta.get(folder.name) || null;
      if (!projectPath) {
        projectPath = readProjectPathFromJsonl(folderPath);
      }
      if (!projectPath) continue;

      const commandsDir = path.join(projectPath, '.claude', 'commands');
      try {
        if (!fs.existsSync(commandsDir)) continue;
        const files = fs.readdirSync(commandsDir).filter(f => f.startsWith('schedule-') && f.endsWith('.md'));
        for (const file of files) {
          try {
            const content = fs.readFileSync(path.join(commandsDir, file), 'utf8');
            const { meta, body } = parseFrontmatter(content);
            if (!meta.cron || !body) continue;
            // Frontmatter values are raw strings; treat any common falsy spelling as
            // disabled (not just the exact 'false') so a hand-edited `enabled: no` works.
            if (meta.enabled !== undefined && ['false', 'no', '0', 'off'].includes(String(meta.enabled).trim().toLowerCase())) continue;
            schedules.push({
              file, filePath: path.join(commandsDir, file),
              projectPath, folder: folder.name,
              name: meta.name || file, cron: meta.cron,
              slug: meta.slug || file.replace(/^schedule-/, '').replace(/\.md$/, ''),
              cli: meta.cli || {}, prompt: body,
            });
          } catch (err) {
            if (log) log.warn(`[schedule] Failed to parse ${file}:`, err.message);
          }
        }
      } catch {}
    }
  } catch (err) {
    if (log) log.error('[schedule] Error scanning schedules:', err);
  }
  return schedules;
}

/** Create a pre-seeded JSONL session file with user message and slug for grouping. */
function createScheduleSession(schedule) {
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const claudeProjectDir = path.join(PROJECTS_DIR, schedule.folder);

  fs.mkdirSync(claudeProjectDir, { recursive: true });
  const jsonlPath = path.join(claudeProjectDir, `${sessionId}.jsonl`);

  const msgId = crypto.randomUUID();
  const lines = [
    JSON.stringify({ type: 'user', parentUuid: null, uuid: msgId, sessionId, cwd: schedule.projectPath, slug: schedule.slug, timestamp, message: { role: 'user', content: 'Scheduled Task: ' + schedule.prompt } }),
  ];
  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  return { sessionId, jsonlPath };
}

// Defense-in-depth: reject control chars in frontmatter values (shell-quoter is the real defense)
function isSafeScalar(s) {
  if (s == null) return true;
  return !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(String(s));
}

function assertSafe(field, value) {
  if (!isSafeScalar(value)) {
    throw new Error(`Schedule field "${field}" contains unsafe characters`);
  }
  return value;
}

/**
 * Build the argv for a scheduled claude invocation.
 * Returns `{ claudeArgs: string[] }` — a plain argv array, with zero shell interpretation.
 * The caller is responsible for shell-quoting when constructing a shell command string.
 */
function buildScheduleCommand(sessionId, schedule) {
  const cli = schedule.cli || {};
  const args = [
    '--resume', assertSafe('sessionId', sessionId),
    '-p', 'Run the scheduled task',
    '--permission-mode', assertSafe('permission-mode', cli['permission-mode'] || 'acceptEdits'),
  ];

  if (cli.model) args.push('--model', assertSafe('model', cli.model));
  if (cli['max-budget-usd']) {
    const budget = String(cli['max-budget-usd']).trim();
    if (!/^\d+(\.\d+)?$/.test(budget)) {
      throw new Error(`Schedule field "max-budget-usd" must be a number, got: ${cli['max-budget-usd']}`);
    }
    args.push('--max-budget-usd', budget);
  }
  args.push('--allowedTools', assertSafe('allowed-tools', cli['allowed-tools'] || 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch'));
  if (cli['append-system-prompt']) {
    // Allow newlines in prompt text, but not control chars other than \n, \r, \t
    const prompt = String(cli['append-system-prompt']);
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(prompt)) {
      throw new Error('Schedule field "append-system-prompt" contains unsafe characters');
    }
    args.push('--append-system-prompt', prompt);
  }
  if (cli['add-dirs']) {
    for (const dir of String(cli['add-dirs']).split(',').map(d => d.trim()).filter(Boolean)) {
      args.push('--add-dir', assertSafe('add-dirs', dir));
    }
  }

  return { claudeArgs: args };
}

/**
 * Start the cron loop. Checks every 60 seconds.
 * @param {object} log - Logger
 * @param {function} runCommand - Function to spawn a shell command: runCommand(cmd, cwd, name)
 * @returns {function} stop - Call to stop the scheduler
 */
function startScheduler(log, runCommand) {
  let running = true;
  const runningTasks = new Set();
  const lastFired = loadScheduleState(); // taskKey -> epoch ms of last fire

  function tick() {
    if (!running) return;
    const now = new Date();
    const nowMs = now.getTime();
    const schedules = scanSchedules(log);
    let dirty = false;

    for (const schedule of schedules) {
      const taskKey = `${schedule.folder}:${schedule.slug}`;
      const lf = lastFired.get(taskKey);
      // Known task: recover any slot after its last fire (bounded). First sight:
      // only the current minute — never reach back before we started tracking it,
      // so enabling catch-up (or adding a task) can't retro-fire old slots.
      const since = (lf === undefined) ? (nowMs - 60000) : lf;
      const slot = newestDueSlot(schedule.cron, nowMs, since);
      if (lf === undefined) { lastFired.set(taskKey, nowMs); dirty = true; } // baseline

      if (slot === null) continue; // nothing due (on-time or missed)

      if (runningTasks.has(taskKey)) {
        // Leave lastFired unadvanced (known task) so it retries once the previous
        // run finishes and the slot is still within the window.
        log.info(`[schedule] Skipping ${schedule.name} — still running from previous trigger`);
        continue;
      }

      lastFired.set(taskKey, nowMs); // mark fired -> next ticks won't re-fire this slot
      dirty = true;
      const caughtUp = slot < nowMs - 60000;
      log.info(`[schedule] Triggering: ${schedule.name} (${schedule.cron})${caughtUp ? ' [catch-up]' : ''}`);
      try {
        const { sessionId } = createScheduleSession(schedule);
        const { claudeArgs } = buildScheduleCommand(sessionId, schedule);

        runningTasks.add(taskKey);
        runCommand(claudeArgs, schedule.projectPath, schedule.name, () => {
          runningTasks.delete(taskKey);
        });
      } catch (err) {
        log.error(`[schedule] Failed to run ${schedule.name}:`, err);
      }
    }

    if (dirty) saveScheduleState(lastFired);
  }

  const msUntilNextMinute = (60 - new Date().getSeconds()) * 1000;
  const initialTimer = setTimeout(() => {
    tick();
    const interval = setInterval(tick, 60 * 1000);
    initialTimer._interval = interval;
  }, msUntilNextMinute);

  return function stop() {
    running = false;
    clearTimeout(initialTimer);
    if (initialTimer._interval) clearInterval(initialTimer._interval);
  };
}

module.exports = { parseFrontmatter, cronMatches, newestDueSlot, scanSchedules, startScheduler, createScheduleSession, buildScheduleCommand };
