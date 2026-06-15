// orch-cost.js — token/cost telemetry for Agent Teams runs.
//
// Every worker/reviewer/master session writes a JSONL transcript under
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. Assistant turns carry a
// `usage` block (input/output/cache tokens) and, when Claude Code provides
// it, a per-turn cost (`costUSD`). We sum those by the session ids a task
// owns, and roll the result up per task, per complexity tier, and per run.
//
// Tokens are always reported (reliable). Cost is reported only when the
// transcripts actually contain cost figures — never estimated from a guessed
// price table, so the number you see is real or absent.

const fs = require('fs');
const os = require('os');
const path = require('path');
const proto = require('./orch-protocol');
const { encodeProjectPath } = require('./encode-project-path');

let PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
function setProjectsDirForTesting(dir) { PROJECTS_DIR = dir; _cache.clear(); }

// MUST match Claude CLI's folder naming exactly (hash suffix for >200 chars),
// or transcripts for long worktree paths land in the wrong / a missing folder
// and cost is misattributed. Reuse the canonical encoder.
function encodeFolder(p) { return encodeProjectPath(p); }

// Per-file usage cache keyed by path → {mtimeMs, usage}. computeSpend runs
// every reconcile when a budget cap is set; without this it would re-parse
// every transcript each pass. A stat is cheap; a re-parse only on change.
const _cache = new Map();

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheTokens: 0, costUSD: 0, hasCost: false, sessions: 0, found: false };
}

function addInto(acc, b) {
  acc.inputTokens += b.inputTokens;
  acc.outputTokens += b.outputTokens;
  acc.cacheTokens += b.cacheTokens;
  acc.costUSD += b.costUSD;
  acc.hasCost = acc.hasCost || b.hasCost;
  acc.found = acc.found || b.found;
}

// Find a session transcript. Worker sessions run with cwd = their worktree, so
// try the task's recorded worktree folder first, then the project folder, then
// a last-resort scan of PROJECTS_DIR (bounded, cheap: it's a readdir + stat).
function findTranscript(sessionId, candidateCwds) {
  for (const cwd of candidateCwds) {
    if (!cwd) continue;
    const f = path.join(PROJECTS_DIR, encodeFolder(cwd), `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  try {
    for (const folder of fs.readdirSync(PROJECTS_DIR)) {
      const f = path.join(PROJECTS_DIR, folder, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}

function sessionUsage(sessionId, candidateCwds) {
  const file = findTranscript(sessionId, candidateCwds);
  const out = emptyUsage();
  if (!file) return out;
  out.sessions = 1;
  // Skip re-parsing an unchanged transcript.
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return out; }
  const cached = _cache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return { ...cached.usage, sessions: 1 };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const u = e?.message?.usage || e?.usage;
    if (u) {
      out.found = true;
      out.inputTokens += (u.input_tokens || 0);
      out.outputTokens += (u.output_tokens || 0);
      out.cacheTokens += (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    }
    // Claude Code records per-turn cost under a few possible keys depending on
    // version; accept any of them and only count real numbers.
    const cost = e?.costUSD ?? e?.total_cost_usd ?? e?.message?.costUSD;
    if (typeof cost === 'number' && cost > 0) { out.costUSD += cost; out.hasCost = true; }
  }
  _cache.set(file, { mtimeMs, usage: { ...out } });
  return out;
}

// Roll up usage for a whole run. Returns:
//   { run: <usage>, byTask: {taskId: usage}, byTier: {complexity: usage} }
function runUsage(projectPath, run, tasks) {
  const byTask = {};
  const byTier = {};
  const total = emptyUsage();
  for (const t of tasks) {
    const ids = [...(t.sessionIds || []), ...(t.reviewSessionIds || [])];
    const candidates = [t.worktree, projectPath];
    const u = emptyUsage();
    for (const sid of ids) addInto(u, sessionUsage(sid, candidates));
    u.sessions = ids.length;
    byTask[t.id] = u;
    addInto(total, u);
    const tier = proto.taskComplexity(t);
    if (!byTier[tier]) byTier[tier] = emptyUsage();
    addInto(byTier[tier], u);
  }
  // Master session counts toward the run total (planning/orchestration cost).
  if (run && run.masterSessionId) {
    const mu = sessionUsage(run.masterSessionId, [projectPath]);
    addInto(total, mu);
    byTask.__master__ = mu;
  }
  return { run: total, byTask, byTier };
}

module.exports = { runUsage, sessionUsage, setProjectsDirForTesting, emptyUsage };
