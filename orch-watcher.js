// orch-watcher.js — watches .switchboard/runs/ in each registered project
// and turns file changes into in-memory state + events.
//
// Level-triggered by design: consumers (spawner, GUI) receive a full,
// freshly-scanned snapshot per project and reconcile against it, so a missed
// fs event can never wedge the system — the next event (or poll tick) heals
// it. We deliberately watch runs/ only, NOT the whole .switchboard dir:
// task worktrees live under .switchboard/worktrees and generate heavy fs
// traffic (installs, builds) that must not thrash the scanner.
//
// Events emitted:
//   'state'        (projectPath, snapshot)            — after every rescan that changed anything
//   'task-changed' (projectPath, runId, task, prev)   — per-task status delta (prev null = new)
//   'run-changed'  (projectPath, runId, run, prev)    — run.json delta (prev null = new)

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const proto = require('./orch-protocol');

const DEBOUNCE_MS = 150;
const POLL_MS = 2500; // fallback + waiting-for-dir-to-exist cadence
// Safety net kept running EVEN when fs.watch is attached: a recursive fs.watch
// can attach without error yet miss events (macOS FSEvents on atomic
// rename-writes, newly-created subdirs, or a handle that quietly stops
// delivering). Without a poll the snapshot then freezes at its last-seen state
// and the spawner never sees a run go active → workers never dispatch. The poll
// guarantees eventual consistency; scanProject dedups, so idle polls are quiet.
const SAFETY_POLL_MS = 5000;

class OrchWatcher extends EventEmitter {
  constructor({ log } = {}) {
    super();
    this.log = log || { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    // projectPath → { watcher, pollTimer, debounceTimer, snapshot }
    this._projects = new Map();
    this._disposed = false;
  }

  watchedProjects() { return Array.from(this._projects.keys()); }

  watchProject(projectPath) {
    if (this._disposed || !projectPath) return;
    const key = path.resolve(projectPath);
    if (this._projects.has(key)) return;
    const entry = { watcher: null, pollTimer: null, pollIntervalMs: null, debounceTimer: null, snapshot: null };
    this._projects.set(key, entry);
    this._attach(key, entry);
    this._rescan(key);
  }

  unwatchProject(projectPath) {
    const key = path.resolve(projectPath);
    const entry = this._projects.get(key);
    if (!entry) return;
    this._detach(entry);
    this._projects.delete(key);
  }

  dispose() {
    this._disposed = true;
    for (const entry of this._projects.values()) this._detach(entry);
    this._projects.clear();
    this.removeAllListeners();
  }

  getSnapshot(projectPath) {
    const entry = this._projects.get(path.resolve(projectPath));
    return entry ? entry.snapshot : null;
  }

  getAllSnapshots() {
    const out = {};
    for (const [key, entry] of this._projects) {
      if (entry.snapshot) out[key] = entry.snapshot;
    }
    return out;
  }

  // Force an immediate rescan (used by IPC handlers right after they write).
  refresh(projectPath) {
    const key = path.resolve(projectPath);
    if (this._projects.has(key)) this._rescan(key);
  }

  _detach(entry) {
    if (entry.watcher) { try { entry.watcher.close(); } catch {} entry.watcher = null; }
    if (entry.pollTimer) { clearInterval(entry.pollTimer); entry.pollTimer = null; }
    if (entry.debounceTimer) { clearTimeout(entry.debounceTimer); entry.debounceTimer = null; }
  }

  _attach(key, entry) {
    const runsDir = proto.runsRoot(key);
    if (entry.watcher) return;
    if (fs.existsSync(runsDir)) {
      try {
        entry.watcher = fs.watch(runsDir, { recursive: true }, () => this._scheduleRescan(key));
        entry.watcher.on('error', (err) => {
          this.log.warn(`[orch] watcher error for ${key}: ${err.message}; falling back to polling`);
          try { entry.watcher.close(); } catch {}
          entry.watcher = null;
          this._ensurePolling(key, entry, POLL_MS);
        });
        // fs.watch handles latency; a slow safety poll stays on as a net against
        // missed events (see SAFETY_POLL_MS) so the snapshot can't freeze.
        this._ensurePolling(key, entry, SAFETY_POLL_MS);
        return;
      } catch (err) {
        this.log.warn(`[orch] fs.watch failed for ${key}: ${err.message}; polling instead`);
      }
    }
    this._ensurePolling(key, entry, POLL_MS);
  }

  _ensurePolling(key, entry, intervalMs) {
    // Replace an existing poll only if the cadence changed (e.g. fast fallback
    // poll → slow safety poll once fs.watch attaches), so we never stack timers.
    if (entry.pollTimer) {
      if (entry.pollIntervalMs === intervalMs) return;
      clearInterval(entry.pollTimer);
      entry.pollTimer = null;
    }
    entry.pollIntervalMs = intervalMs;
    entry.pollTimer = setInterval(() => {
      // Try to upgrade to a real watcher once the runs dir appears.
      if (!entry.watcher) this._attach(key, entry);
      this._rescan(key);
    }, intervalMs);
    if (entry.pollTimer.unref) entry.pollTimer.unref();
  }

  _scheduleRescan(key) {
    const entry = this._projects.get(key);
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      this._rescan(key);
    }, DEBOUNCE_MS);
  }

  _rescan(key) {
    const entry = this._projects.get(key);
    if (!entry) return;
    let snapshot;
    try {
      snapshot = scanProject(key);
    } catch (err) {
      this.log.error(`[orch] rescan failed for ${key}: ${err.message}`);
      return;
    }
    const prev = entry.snapshot;
    entry.snapshot = snapshot;
    if (prev && JSON.stringify(prev) === JSON.stringify(snapshot)) return; // nothing changed

    // Granular deltas for consumers that want them (nudger, logging).
    const prevRuns = new Map((prev?.runs || []).map(r => [r.run.id, r]));
    for (const cur of snapshot.runs) {
      const old = prevRuns.get(cur.run.id);
      if (!old || JSON.stringify(old.run) !== JSON.stringify(cur.run)) {
        this.emit('run-changed', key, cur.run.id, cur.run, old ? old.run : null);
      }
      const oldTasks = new Map((old?.tasks || []).map(t => [t.id, t]));
      for (const task of cur.tasks) {
        const oldTask = oldTasks.get(task.id);
        if (!oldTask || oldTask.status !== task.status) {
          this.emit('task-changed', key, cur.run.id, task, oldTask || null);
        }
      }
    }
    this.emit('state', key, snapshot);
  }
}

function scanProject(projectPath) {
  const runs = [];
  for (const runId of proto.listRunIds(projectPath)) {
    const run = proto.readRun(projectPath, runId);
    if (!run) continue;
    const { tasks, invalid } = proto.readTasksDetailed(projectPath, runId);
    runs.push({ run, tasks, invalid, summary: proto.summarizeTasks(tasks) });
  }
  runs.sort((a, b) => (b.run.createdAt || '').localeCompare(a.run.createdAt || ''));
  return { projectPath, scannedAt: new Date().toISOString(), runs };
}

module.exports = { OrchWatcher, scanProject, DEBOUNCE_MS, POLL_MS };
