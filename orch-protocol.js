// orch-protocol.js — the Agent Teams file protocol.
//
// A "run" is an orchestrated build: a master session plans and decomposes
// work into tasks; worker/reviewer sessions implement and review them. All
// state lives as files under <project>/.switchboard/runs/<runId>/ so any
// party (master agent, workers, Switchboard, the user) can read or write it
// and every party can crash/restart without losing the world:
//
//   .switchboard/
//     guidelines.md              code style + review rubric (shared by runs)
//     runs/<runId>/
//       run.json                 roles→profiles, policy, status
//       plan.md                  master's plan
//       tasks/<taskId>.json      task state (this module owns the schema)
//       tasks/<taskId>.spec.md   self-contained spec for the implementer
//       reviews/<taskId>-<n>.md  reviewer verdicts
//       prompts/<role>.md        role system prompts (generated at run init)
//       events.jsonl             append-only audit log
//
// Concurrency model: every JSON write is atomic (tmp+rename); status
// transitions are optimistic — the writer asserts the status it read is
// still current at write time (best-effort on a filesystem, but combined
// with the single-writer-per-transition convention it keeps races benign).
// events.jsonl is append-only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ORCH_DIRNAME = '.switchboard';
const RUNS_DIRNAME = 'runs';
const WORKTREES_DIRNAME = 'worktrees';

const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROLE_RE = /^[a-z][a-z0-9-]{0,31}$/;

const RUN_STATUSES = new Set(['draft', 'planning', 'active', 'paused', 'done', 'abandoned']);
const TASK_KINDS = new Set(['epic', 'chunk', 'leaf']);

// Task complexity, cheapest → hardest. The decomposer tags each leaf task;
// the run's `tiers` map turns a complexity into a model profile (+ optional
// per-tier concurrency), so cost scales with difficulty: trivial leaves run
// on a cheap/local model with high parallelism, the rare hard task on Opus.
const COMPLEXITIES = ['trivial', 'low', 'medium', 'high', 'critical'];
const DEFAULT_COMPLEXITY = 'medium';
const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // matches profiles.js ID_RE

// Review lenses — the distinct concerns a review can cover. Each becomes a
// separate reviewer session (possibly a different model) with a focused
// prompt, and writes its own verdict file. Switchboard aggregates them.
const REVIEW_LENSES = {
  spec:          { label: 'spec/PRD/goal conformance', focus: 'Does the change do EXACTLY what the task spec, acceptance criteria, and the run goal require? Flag anything missing, hard-coded, faked, or scope-crept.' },
  functionality: { label: 'functionality & integration', focus: 'Correctness, edge cases, error handling, race conditions; and does it integrate cleanly without breaking existing callers elsewhere in the repo?' },
  tests:         { label: 'test coverage', focus: 'Do tests exist, assert real behaviour (not mock echo), and fail if the change is reverted? Are the important paths and edge cases covered?' },
  security:      { label: 'vulnerability', focus: 'Injection, path traversal, secrets in code/logs, unsafe input handling, authn/authz, unsafe dependencies.' },
  style:         { label: 'code style & maintainability', focus: 'Matches guidelines.md and the surrounding code: naming, duplication, dead code, complexity, comment quality.' },
};
const LENS_KEYS = Object.keys(REVIEW_LENSES);
const LENS_RE = /^[a-z][a-z0-9-]{0,31}$/;

// Cost-aware default: more lenses for harder tasks. The cheap path stays
// cheap (one combined review for trivial work); critical work gets all five.
const DEFAULT_LENSES_BY_COMPLEXITY = {
  trivial:  ['functionality', 'style'],
  low:      ['functionality', 'tests', 'style'],
  medium:   ['spec', 'functionality', 'tests', 'style'],
  high:     ['spec', 'functionality', 'tests', 'security', 'style'],
  critical: ['spec', 'functionality', 'tests', 'security', 'style'],
};

// Which lenses to apply to a task. Precedence: per-task `lenses` → run-level
// `review.lensesByComplexity[tier]` → run-level `review.lenses` (flat) →
// the cost-aware default for the tier. Returns [] only if review is disabled.
function resolveLenses(run, task) {
  const tier = taskComplexity(task);
  const review = (run && isPlainObject(run.review)) ? run.review : {};
  if (review.enabled === false) return [];
  let lenses;
  if (Array.isArray(task && task.lenses)) lenses = task.lenses;
  else if (review.lensesByComplexity && Array.isArray(review.lensesByComplexity[tier])) lenses = review.lensesByComplexity[tier];
  else if (Array.isArray(review.lenses)) lenses = review.lenses;
  else lenses = DEFAULT_LENSES_BY_COMPLEXITY[tier] || ['functionality', 'tests', 'style'];
  // keep only known lens keys, dedup, preserve order
  const seen = new Set();
  const out = [];
  for (const l of lenses) {
    if (LENS_KEYS.includes(l) && !seen.has(l)) { seen.add(l); out.push(l); }
  }
  return out.length ? out : ['functionality'];
}

// How many lens approvals are needed. review.quorum: 'all' (default) or an
// integer N (at least N of the applied lenses must approve, and none may have
// a hard blocker). Returns the integer threshold for a given lens count.
function lensQuorum(run, lensCount) {
  const q = run && isPlainObject(run.review) ? run.review.quorum : undefined;
  if (Number.isInteger(q) && q > 0) return Math.min(q, lensCount);
  return lensCount; // 'all'
}

// Lenses whose rejection is a hard veto: even under a numeric quorum, if one
// of these requested changes, the task does NOT pass. Security is the obvious
// one (a single vulnerability should block a merge no matter the vote).
const VETO_LENSES = ['security'];

// Parse a verdict from a review markdown file. We anchor on the line that
// declares the verdict (the prompt requires the FIRST line to be
// "Verdict: ..."), scanning lines so a stray "approved" in the findings body
// can't be misread, and we handle negations ("not approved" → changes).
function parseVerdict(text) {
  if (typeof text !== 'string') return null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[#>*\-\s]+/, '');
    const m = line.match(/^verdict[\s:*_\-–—]*(.+)$/i);
    if (!m) continue;
    const rest = m[1].toLowerCase();
    // Explicit negation flips an "approve" reading.
    if (/\b(not|cannot|can't|isn't|won't|no)\b.*\bapprov/.test(rest)) return 'changes_requested';
    if (/\b(approved|approve|lgtm|pass(?:ed|es)?|ok)\b/.test(rest)) return 'approved';
    if (/\b(changes[_\s-]?requested|reject(?:ed)?|block(?:ed)?|fail(?:ed|s)?|deny|denied)\b/.test(rest)) return 'changes_requested';
  }
  return null;
}

// Decide a task's review outcome from its per-lens verdicts. `verdicts` is an
// array of { lens, verdict }. A veto lens that requested changes forces a
// changes_requested; otherwise approve iff approvals ≥ quorum.
function reviewOutcome(run, verdicts) {
  const total = verdicts.length;
  const approvals = verdicts.filter(v => v.verdict === 'approved').length;
  const vetoed = verdicts.some(v => VETO_LENSES.includes(v.lens) && v.verdict !== 'approved');
  if (vetoed) return { passed: false, approvals, total, vetoed: true };
  return { passed: approvals >= lensQuorum(run, total), approvals, total, vetoed: false };
}

// A validation command runs in the user's shell in the integration worktree.
// It comes from run.json (agent/file-writable), so refuse anything that chains
// commands, redirects, substitutes, or globs into another command — a phase
// gate is a single program with arguments (e.g. "npm test -- auth"). This
// blocks "; rm -rf /", "&& curl|sh", "$(...)", backticks, redirects, etc.
function isSafeValidateCmd(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return false;
  if (cmd.length > 4096) return false;
  if (/[;&|`$<>(){}\n\r\\!*?~#]/.test(cmd)) return false;
  return true;
}

// Task status machine. Keys are "from" statuses; values are the set of
// legal "to" statuses. The conventional owner of each transition is noted —
// not enforceable on a shared filesystem, but Switchboard validates every
// transition it performs and the watcher flags illegal ones it observes.
const TASK_TRANSITIONS = {
  draft:             ['ready', 'blocked'],                       // master
  ready:             ['spawning', 'draft', 'blocked'],           // switchboard | master
  spawning:          ['in_progress', 'ready', 'failed'],         // switchboard
  in_progress:       ['needs_review', 'failed', 'blocked'],      // worker
  needs_review:      ['reviewing', 'approved'],                  // switchboard | human override
  reviewing:         ['approved', 'changes_requested', 'failed', 'needs_review'], // reviewer; needs_review = spawn-failure rollback
  changes_requested: ['spawning', 'ready', 'failed'],            // switchboard (re-dispatch)
  approved:          ['merging', 'done'],                        // master
  merging:           ['done', 'failed'],                         // master
  blocked:           ['ready', 'draft', 'failed'],               // master
  failed:            ['ready', 'draft'],                         // master | human retry
  done:              [],
};
const TASK_STATUSES = new Set(Object.keys(TASK_TRANSITIONS));

// Small models reliably emit lexical variants of the canonical statuses
// (observed live: haiku wrote `needs_revision` for `needs_review`). Mapping
// these obvious same-state variants keeps a run moving instead of dropping
// the task as invalid. Only same-state aliases are listed — never a mapping
// that would change which state the agent intended (e.g. `reviewed`→approved
// is deliberately NOT here; that's a decision, not a typo).
const STATUS_ALIASES = {
  'needs_revision': 'needs_review',
  'needs-review': 'needs_review',
  'needs-revision': 'needs_review',
  'needsreview': 'needs_review',
  'in-progress': 'in_progress',
  'inprogress': 'in_progress',
  'changes-requested': 'changes_requested',
  'changes_required': 'changes_requested',
  'changes-required': 'changes_requested',
  'change_requested': 'changes_requested',
};
function canonicalStatus(s) {
  if (typeof s !== 'string') return s;
  if (TASK_STATUSES.has(s)) return s;
  return STATUS_ALIASES[s.toLowerCase()] || s;
}

// Statuses that count against a role's maxConcurrent budget.
const ACTIVE_WORKER_STATUSES = new Set(['spawning', 'in_progress']);
const ACTIVE_REVIEWER_STATUSES = new Set(['reviewing']);

const DEFAULT_POLICY = Object.freeze({
  autoSpawnWorkers: true,
  autoSpawnReviewers: true,
  autoMerge: true,
  maxAttempts: 3,
  isolation: 'worktree', // 'worktree' | 'none' (shared dir — only safe with maxConcurrent 1 or disjoint files)
  // Stop-loss. When spend crosses either cap the run auto-pauses and the
  // master is nudged. null = no cap. Cost is only enforced when transcripts
  // carry real cost figures; output-token cap always works.
  maxBudgetUsd: null,
  maxOutputTokens: null,
  // Phase gates: when all of a chunk's leaf tasks are done, Switchboard runs
  // the chunk's validateCmd (or this default) in the integration worktree and
  // only marks the chunk done if it passes. Keeps the build green as layers
  // land. null command = no gate (chunk completes on leaves-done alone).
  gatesEnabled: true,
  validateCmd: null,
});

const DEFAULT_ROLE_LIMITS = Object.freeze({ worker: 4, reviewer: 2 });

function orchDir(projectPath) { return path.join(projectPath, ORCH_DIRNAME); }
function runsRoot(projectPath) { return path.join(orchDir(projectPath), RUNS_DIRNAME); }
function runDir(projectPath, runId) { return path.join(runsRoot(projectPath), runId); }
function tasksDir(rDir) { return path.join(rDir, 'tasks'); }
function worktreesRoot(projectPath) { return path.join(orchDir(projectPath), WORKTREES_DIRNAME); }

function isPlainObject(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = JSON.stringify(obj, null, 2);
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, data);
  // Windows can refuse the rename transiently (antivirus or a reader holding
  // the target). Retry briefly, then fall back to a direct write — losing
  // atomicity for one write beats losing the write entirely, and every
  // reader of these files already tolerates a torn read (readJsonSafe →
  // null → next watcher pass re-reads).
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        try { fs.writeFileSync(file, data); } finally {
          try { fs.unlinkSync(tmp); } catch {}
        }
        return;
      }
    }
  }
}

// --- validation -----------------------------------------------------------

function validateRun(run) {
  if (!isPlainObject(run)) return 'run.json is not an object';
  if (typeof run.id !== 'string' || !RUN_ID_RE.test(run.id)) return 'invalid run id';
  if (typeof run.title !== 'string' || !run.title.trim()) return 'missing title';
  if (!RUN_STATUSES.has(run.status)) return `invalid run status: ${run.status}`;
  if (!isPlainObject(run.roles)) return 'missing roles';
  for (const [role, cfg] of Object.entries(run.roles)) {
    if (!ROLE_RE.test(role)) return `invalid role name: ${role}`;
    if (!isPlainObject(cfg)) return `invalid role config: ${role}`;
  }
  if (run.policy !== undefined && isPlainObject(run.policy)) {
    for (const k of ['maxBudgetUsd', 'maxOutputTokens']) {
      const v = run.policy[k];
      if (v !== undefined && v !== null && (typeof v !== 'number' || v <= 0)) return `invalid policy.${k}`;
    }
    if (run.policy.validateCmd !== undefined && run.policy.validateCmd !== null
      && (typeof run.policy.validateCmd !== 'string' || run.policy.validateCmd.length > 4096)) {
      return 'invalid policy.validateCmd';
    }
  }
  if (run.review !== undefined) {
    if (!isPlainObject(run.review)) return 'review must be an object';
    if (run.review.lenses !== undefined && (!Array.isArray(run.review.lenses) || run.review.lenses.some(l => !LENS_KEYS.includes(l)))) {
      return 'invalid review.lenses';
    }
    if (run.review.lensesByComplexity !== undefined) {
      if (!isPlainObject(run.review.lensesByComplexity)) return 'invalid review.lensesByComplexity';
      for (const [k, v] of Object.entries(run.review.lensesByComplexity)) {
        if (!COMPLEXITIES.includes(k)) return `invalid review tier: ${k}`;
        if (!Array.isArray(v) || v.some(l => !LENS_KEYS.includes(l))) return `invalid lenses for tier ${k}`;
      }
    }
    if (run.review.quorum !== undefined && run.review.quorum !== 'all' && !(Number.isInteger(run.review.quorum) && run.review.quorum > 0)) {
      return 'invalid review.quorum';
    }
  }
  if (run.tiers !== undefined) {
    if (!isPlainObject(run.tiers)) return 'tiers must be an object';
    for (const [name, cfg] of Object.entries(run.tiers)) {
      if (!COMPLEXITIES.includes(name)) return `invalid tier name: ${name}`;
      if (!isPlainObject(cfg)) return `invalid tier config: ${name}`;
      for (const k of ['profileId', 'reviewerProfileId']) {
        if (cfg[k] !== undefined && cfg[k] !== null && (typeof cfg[k] !== 'string' || !PROFILE_ID_RE.test(cfg[k]))) {
          return `invalid ${k} in tier ${name}`;
        }
      }
      if (cfg.maxConcurrent !== undefined && (!Number.isInteger(cfg.maxConcurrent) || cfg.maxConcurrent < 1)) {
        return `invalid maxConcurrent in tier ${name}`;
      }
    }
  }
  return null;
}

function validateTask(task) {
  if (!isPlainObject(task)) return 'task is not an object';
  if (typeof task.id !== 'string' || !TASK_ID_RE.test(task.id)) return 'invalid task id';
  if (typeof task.title !== 'string' || !task.title.trim()) return 'missing title';
  if (!TASK_STATUSES.has(task.status)) return `invalid status: ${task.status}`;
  if (task.kind !== undefined && !TASK_KINDS.has(task.kind)) return `invalid kind: ${task.kind}`;
  if (task.dependsOn !== undefined) {
    if (!Array.isArray(task.dependsOn)) return 'dependsOn must be an array';
    for (const d of task.dependsOn) {
      if (typeof d !== 'string' || !TASK_ID_RE.test(d)) return `invalid dependency: ${d}`;
    }
  }
  if (task.filesHint !== undefined) {
    if (!Array.isArray(task.filesHint) || task.filesHint.some(f => typeof f !== 'string')) {
      return 'filesHint must be an array of strings';
    }
  }
  if (task.complexity !== undefined && !COMPLEXITIES.includes(task.complexity)) {
    return `invalid complexity: ${task.complexity}`;
  }
  for (const k of ['profileId', 'reviewerProfileId']) {
    if (task[k] !== undefined && task[k] !== null && (typeof task[k] !== 'string' || !PROFILE_ID_RE.test(task[k]))) {
      return `invalid ${k}`;
    }
  }
  if (task.validateCmd !== undefined && task.validateCmd !== null
    && (typeof task.validateCmd !== 'string' || task.validateCmd.length > 4096)) {
    return 'validateCmd must be a string under 4096 chars';
  }
  if (task.lenses !== undefined && (!Array.isArray(task.lenses) || task.lenses.some(l => !LENS_KEYS.includes(l)))) {
    return 'invalid task.lenses';
  }
  return null;
}

// Leaf children of a chunk/epic, and whether they're all done — the trigger
// for running that phase's validation gate.
function leafChildren(parentId, tasks) {
  return tasks.filter(t => t.parent === parentId && (t.kind || 'leaf') === 'leaf');
}
function allLeavesDone(parentId, tasks) {
  const kids = leafChildren(parentId, tasks);
  return kids.length > 0 && kids.every(t => t.status === 'done');
}

// Resolve which model profile a task should run under, for a given role.
// Precedence (most specific wins):
//   1. explicit per-task override (task.profileId / task.reviewerProfileId)
//   2. the run's tier for the task's complexity
//   3. the role's default profile
// Returns a profile id string, or null meaning "use the global default".
function resolveProfile(run, task, role) {
  const tierName = (task && COMPLEXITIES.includes(task.complexity)) ? task.complexity : DEFAULT_COMPLEXITY;
  const tier = run.tiers && run.tiers[tierName];
  if (role === 'reviewer') {
    if (task && task.reviewerProfileId) return task.reviewerProfileId;
    if (tier && tier.reviewerProfileId) return tier.reviewerProfileId;
    return run.roles.reviewer?.profileId || null;
  }
  if (role === 'worker') {
    if (task && task.profileId) return task.profileId;
    if (tier && tier.profileId) return tier.profileId;
    return run.roles.worker?.profileId || null;
  }
  return run.roles[role]?.profileId || null;
}

// Per-tier concurrency cap for a complexity, if the run defines one.
function tierCap(run, complexity) {
  const name = COMPLEXITIES.includes(complexity) ? complexity : DEFAULT_COMPLEXITY;
  const c = run.tiers && run.tiers[name] && run.tiers[name].maxConcurrent;
  return Number.isInteger(c) && c > 0 ? c : null;
}

function taskComplexity(task) {
  return (task && COMPLEXITIES.includes(task.complexity)) ? task.complexity : DEFAULT_COMPLEXITY;
}

// Canonical form for overlap comparison: case- and separator-insensitive,
// so "src\A.js" and "src/a.js" count as the same file.
function normalizeFileHint(f) {
  return String(f).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

// --- reading --------------------------------------------------------------

function listRunIds(projectPath) {
  try {
    return fs.readdirSync(runsRoot(projectPath), { withFileTypes: true })
      .filter(e => e.isDirectory() && RUN_ID_RE.test(e.name))
      .map(e => e.name);
  } catch { return []; }
}

// Map every orchestrated worker/reviewer session id to its run's master session
// id, so the sidebar can nest team sessions under the master row. Read-only scan
// of <project>/.switchboard/runs; returns {} when the project has no runs.
function sessionMasters(projectPath) {
  const map = {};
  for (const runId of listRunIds(projectPath)) {
    const run = readRun(projectPath, runId);
    const master = run && run.masterSessionId;
    if (!master) continue;
    let detailed;
    try { detailed = readTasksDetailed(projectPath, runId); } catch { continue; }
    for (const t of (detailed.tasks || [])) {
      for (const sid of [...(t.sessionIds || []), ...(t.reviewSessionIds || [])]) {
        if (sid && sid !== master) map[sid] = master;
      }
    }
  }
  return map;
}

function readRun(projectPath, runId) {
  if (!RUN_ID_RE.test(runId || '')) return null;
  const run = readJsonSafe(path.join(runDir(projectPath, runId), 'run.json'));
  if (!run || validateRun(run)) return null;
  return run;
}

// Reads every task file, separating valid tasks from broken ones. Agent
// writes go through models of varying quality — a malformed file must be
// VISIBLE (GUI warning, master can fix it), never silently ignored.
function readTasksDetailed(projectPath, runId) {
  const dir = tasksDir(runDir(projectPath, runId));
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return { tasks: [], invalid: [] }; }
  const tasks = [];
  const invalid = [];
  for (const name of names) {
    const task = readJsonSafe(path.join(dir, name));
    if (!task) {
      invalid.push({ file: `tasks/${name}`, error: 'unparseable JSON' });
      continue;
    }
    // Coerce a same-state status alias to canonical before validating, and
    // flag it so the spawner can rewrite the file once.
    if (task && typeof task.status === 'string' && !TASK_STATUSES.has(task.status)) {
      const canon = canonicalStatus(task.status);
      if (canon !== task.status) { task._statusWas = task.status; task.status = canon; }
    }
    const err = validateTask(task);
    if (err) {
      invalid.push({ file: `tasks/${name}`, error: err });
      continue;
    }
    if (name !== task.id + '.json') {
      invalid.push({ file: `tasks/${name}`, error: `filename does not match task id "${task.id}"` });
      continue;
    }
    tasks.push(task);
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return { tasks, invalid };
}

function readTasks(projectPath, runId) {
  return readTasksDetailed(projectPath, runId).tasks;
}

function readTask(projectPath, runId, taskId) {
  if (!TASK_ID_RE.test(taskId || '')) return null;
  const task = readJsonSafe(path.join(tasksDir(runDir(projectPath, runId)), taskId + '.json'));
  if (task && typeof task.status === 'string') task.status = canonicalStatus(task.status);
  if (!task || validateTask(task)) return null;
  return task;
}

// Read the last `limit` events without loading unbounded history — only the
// file's tail is read, so a weeks-long run with a multi-MB events.jsonl
// costs the same as a fresh one. Corrupt/torn lines are skipped.
const EVENTS_TAIL_BYTES = 512 * 1024;

function readEvents(projectPath, runId, limit = 200) {
  if (!Number.isInteger(limit) || limit <= 0) limit = 200;
  const file = path.join(runDir(projectPath, runId), 'events.jsonl');
  let raw;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - EVENTS_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString('utf8');
      if (start > 0) {
        // We landed mid-line — drop the partial first line.
        const nl = raw.indexOf('\n');
        raw = nl === -1 ? '' : raw.slice(nl + 1);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { return []; }
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  for (const line of lines.slice(-limit)) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// --- writing --------------------------------------------------------------

function writeRun(projectPath, run) {
  const err = validateRun(run);
  if (err) return { ok: false, error: err };
  writeJsonAtomic(path.join(runDir(projectPath, run.id), 'run.json'), run);
  return { ok: true };
}

function writeTask(projectPath, runId, task) {
  const err = validateTask(task);
  if (err) return { ok: false, error: err };
  writeJsonAtomic(path.join(tasksDir(runDir(projectPath, runId)), task.id + '.json'), task);
  return { ok: true };
}

function appendEvent(projectPath, runId, event) {
  const file = path.join(runDir(projectPath, runId), 'events.jsonl');
  const entry = { ts: new Date().toISOString(), ...event };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function isTransitionAllowed(from, to) {
  const allowed = TASK_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

// Optimistic status transition: re-reads the task, asserts the status still
// matches `from`, applies `patch`, writes atomically, logs an event.
function transitionTask(projectPath, runId, taskId, from, to, patch, actor) {
  const task = readTask(projectPath, runId, taskId);
  if (!task) return { ok: false, error: `task not found: ${taskId}` };
  if (task.status !== from) {
    return { ok: false, error: `status conflict: expected ${from}, found ${task.status}`, conflict: true };
  }
  if (!isTransitionAllowed(from, to)) {
    return { ok: false, error: `illegal transition: ${from} → ${to}` };
  }
  const next = { ...task, ...(patch || {}), status: to };
  const wrote = writeTask(projectPath, runId, next);
  if (!wrote.ok) return wrote;
  appendEvent(projectPath, runId, {
    type: 'task-transition', task: taskId, from, to,
    actor: actor || 'switchboard',
  });
  return { ok: true, task: next };
}

// --- run scaffolding ------------------------------------------------------

function slugify(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'run';
}

function newRunId(title) {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = crypto.randomBytes(2).toString('hex');
  return `${date}-${slugify(title)}-${suffix}`;
}

// Creates the directory skeleton + run.json for a new run. Roles must map
// role name → { profileId, maxConcurrent? }. Returns { ok, run, dir }.
function createRun(projectPath, { title, goal, roles, policy, integrationBranch, tiers, review }) {
  if (typeof title !== 'string' || !title.trim()) return { ok: false, error: 'title required' };
  if (!isPlainObject(roles) || !roles.master || !roles.worker || !roles.reviewer) {
    return { ok: false, error: 'roles must define master, worker and reviewer' };
  }
  const id = newRunId(title);
  const run = {
    id,
    title: title.trim(),
    goal: typeof goal === 'string' ? goal : '',
    status: 'planning',
    createdAt: new Date().toISOString(),
    masterSessionId: null,
    integrationBranch: integrationBranch || `teams/${id}`,
    roles: {},
    policy: { ...DEFAULT_POLICY, ...(isPlainObject(policy) ? policy : {}) },
  };
  for (const [role, cfg] of Object.entries(roles)) {
    if (!ROLE_RE.test(role) || !isPlainObject(cfg)) return { ok: false, error: `invalid role: ${role}` };
    run.roles[role] = {
      profileId: typeof cfg.profileId === 'string' ? cfg.profileId : null,
      maxConcurrent: Number.isInteger(cfg.maxConcurrent) && cfg.maxConcurrent > 0
        ? Math.min(cfg.maxConcurrent, 16)
        : (DEFAULT_ROLE_LIMITS[role] || 1),
    };
  }
  // Optional complexity→model tiers. Only keep recognised tier names and
  // clean fields; an empty/absent map means "every task uses the role default".
  if (isPlainObject(tiers)) {
    const cleaned = {};
    for (const name of COMPLEXITIES) {
      const t = tiers[name];
      if (!isPlainObject(t)) continue;
      const entry = {};
      if (typeof t.profileId === 'string' && PROFILE_ID_RE.test(t.profileId)) entry.profileId = t.profileId;
      if (typeof t.reviewerProfileId === 'string' && PROFILE_ID_RE.test(t.reviewerProfileId)) entry.reviewerProfileId = t.reviewerProfileId;
      if (Number.isInteger(t.maxConcurrent) && t.maxConcurrent > 0) entry.maxConcurrent = Math.min(t.maxConcurrent, 16);
      if (Object.keys(entry).length) cleaned[name] = entry;
    }
    if (Object.keys(cleaned).length) run.tiers = cleaned;
  }
  if (isPlainObject(review)) {
    const r = {};
    if (review.enabled === false) r.enabled = false;
    if (Array.isArray(review.lenses)) r.lenses = review.lenses.filter(l => LENS_KEYS.includes(l));
    if (isPlainObject(review.lensesByComplexity)) {
      const lbc = {};
      for (const k of COMPLEXITIES) {
        if (Array.isArray(review.lensesByComplexity[k])) lbc[k] = review.lensesByComplexity[k].filter(l => LENS_KEYS.includes(l));
      }
      if (Object.keys(lbc).length) r.lensesByComplexity = lbc;
    }
    if (review.quorum === 'all' || (Number.isInteger(review.quorum) && review.quorum > 0)) r.quorum = review.quorum;
    if (Object.keys(r).length) run.review = r;
  }
  const err = validateRun(run);
  if (err) return { ok: false, error: err };
  const dir = runDir(projectPath, id);
  for (const sub of ['tasks', 'reviews', 'prompts']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  writeJsonAtomic(path.join(dir, 'run.json'), run);
  appendEvent(projectPath, id, { type: 'run-created', title: run.title, actor: 'switchboard' });
  return { ok: true, run, dir };
}

// Dependencies satisfied = every dependsOn task is done.
function depsSatisfied(task, tasksById) {
  for (const dep of task.dependsOn || []) {
    const d = tasksById.get(dep);
    if (!d || d.status !== 'done') return false;
  }
  return true;
}

// Detect dependsOn cycles across a task set. A cycle would otherwise wedge
// every task in it at `ready` forever (depsSatisfied never becomes true),
// with no error — the spawner uses this to block them with a clear reason.
// Returns a Set of task ids that are part of, or transitively depend on, a
// cycle.
function tasksInDependencyCycle(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const state = new Map(); // id → 0 unvisited, 1 in-stack, 2 done
  const bad = new Set();
  function visit(id, stack) {
    const t = byId.get(id);
    if (!t) return false;
    const s = state.get(id) || 0;
    if (s === 1) { for (const x of stack) bad.add(x); bad.add(id); return true; }
    if (s === 2) return bad.has(id);
    state.set(id, 1);
    stack.push(id);
    let onCycle = false;
    for (const dep of t.dependsOn || []) {
      if (visit(dep, stack)) onCycle = true;
    }
    stack.pop();
    state.set(id, 2);
    if (onCycle) bad.add(id);
    return onCycle;
  }
  for (const t of tasks) visit(t.id, []);
  return bad;
}

// Roll-up used by the GUI and by spawn decisions.
function summarizeTasks(tasks) {
  const byStatus = {};
  for (const s of TASK_STATUSES) byStatus[s] = 0;
  let leaves = 0, leavesDone = 0;
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    if ((t.kind || 'leaf') === 'leaf') {
      leaves++;
      if (t.status === 'done') leavesDone++;
    }
  }
  return { total: tasks.length, byStatus, leaves, leavesDone };
}

module.exports = {
  ORCH_DIRNAME, RUNS_DIRNAME, WORKTREES_DIRNAME,
  RUN_ID_RE, TASK_ID_RE,
  TASK_TRANSITIONS, TASK_STATUSES, RUN_STATUSES,
  ACTIVE_WORKER_STATUSES, ACTIVE_REVIEWER_STATUSES,
  DEFAULT_POLICY,
  orchDir, runsRoot, runDir, worktreesRoot,
  readJsonSafe, writeJsonAtomic,
  validateRun, validateTask, normalizeFileHint, canonicalStatus, STATUS_ALIASES,
  COMPLEXITIES, DEFAULT_COMPLEXITY, resolveProfile, tierCap, taskComplexity,
  REVIEW_LENSES, LENS_KEYS, DEFAULT_LENSES_BY_COMPLEXITY, resolveLenses, lensQuorum, parseVerdict,
  reviewOutcome, VETO_LENSES, isSafeValidateCmd,
  listRunIds, readRun, readTasks, readTasksDetailed, readTask, readEvents, sessionMasters,
  writeRun, writeTask, appendEvent,
  isTransitionAllowed, transitionTask,
  createRun, newRunId, slugify,
  depsSatisfied, tasksInDependencyCycle, summarizeTasks,
  leafChildren, allLeavesDone,
};
