// orch-spawner.js — turns task state into running sessions.
//
// The spawner is the only "active" part of Switchboard's orchestration: it
// watches the file protocol (via OrchWatcher) and, for runs with status
// "active", it
//   - dispatches `ready` leaf tasks to worker sessions (one worktree each),
//   - dispatches `needs_review` tasks to reviewer sessions,
//   - re-dispatches `changes_requested` tasks back to their worker,
//   - recovers tasks whose sessions died without finishing (stale sweep),
//   - nudges the master session's terminal when there is a decision to make
//     (approved tasks to merge, blocked/failed tasks, run completion).
//
// It makes no decisions about WHAT to build — that's the master agent's job.
// All effects go through injected deps so the whole thing is testable
// without Electron or node-pty:
//
//   openTerminal(sessionId, cwd, isNew, sessionOptions) → Promise<{ok,error?}>
//   sendInput(sessionId, text) → boolean
//   isSessionActive(sessionId) → boolean
//   isSessionBusy(sessionId) → boolean
//   seedSessionJsonl({sessionId, cwd, slug, text}) → boolean
//   ensureTaskWorktree(projectPath, runId, taskId, integrationBranch) → Promise<{ok,path,branch}>
//   rolePrompt(role, run, projectPath, task) → string|null
//   newSessionId() → uuid (defaults to crypto.randomUUID)
//
// Reconciliation is level-triggered and idempotent: every pass re-derives
// what should be running from the current snapshot, so missed events or
// crashes self-heal on the next pass / periodic tick. Status transitions are
// optimistic (orch-protocol re-validates against disk at write time), so two
// concurrent passes can never double-dispatch the same task — the loser of
// the race gets a conflict and skips.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const proto = require('./orch-protocol');
const { stripSubmitChars } = require('./submit-chars');

const RECONCILE_TICK_MS = 15_000;
const NUDGE_DEBOUNCE_MS = 2_000;
const NUDGE_RETRY_MS = 10_000;
const NUDGE_MAX_QUEUE = 40;
const NUDGE_MAX_RETRIES = 30; // ~5 min of an unreachable master before we drop the queue
// How long a task may sit in an "active" status with no live session before
// the sweep recovers it. Generous: a session needs time to appear between
// the status write and the PTY registering.
const STALE_GRACE_MS = 90_000;

class OrchSpawner {
  constructor({ watcher, log, deps, staleGraceMs, nudgeRetryMs, nudgeDebounceMs }) {
    this.watcher = watcher;
    this.log = log || { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    this.deps = { newSessionId: () => crypto.randomUUID(), ...deps };
    this.staleGraceMs = staleGraceMs ?? STALE_GRACE_MS;
    this.nudgeRetryMs = nudgeRetryMs ?? NUDGE_RETRY_MS;
    this.nudgeDebounceMs = nudgeDebounceMs ?? NUDGE_DEBOUNCE_MS;
    this._reconciling = new Set();   // projectPath currently reconciling
    this._dirty = new Set();         // projectPath needing another pass
    this._nudgeQueues = new Map();   // `${projectPath} ${runId}` → { lines, timer, ... }
    this._staleSince = new Map();    // `${projectPath}|${runId}|${taskId}|${status}` → first-seen ms
    this._protocolWarned = new Set(); // dedupe keys for protocol-warning events
    this._cleanedWorktrees = new Set(); // `${projectPath}|${runId}|${taskId}` worktrees removed
    this._cleanedRuns = new Set();   // `${projectPath}|${runId}` finished runs cleaned
    this._gatingChunks = new Set();  // `${projectPath}|${runId}|${chunkId}` gate in flight
    this._budgetPaused = new Set();  // `${projectPath}|${runId}` already nudged about budget
    this._tick = null;
    this._stopped = false;

    this._onState = (projectPath) => { this.reconcile(projectPath); };
    this._onTaskChanged = (projectPath, runId, task, prev) => {
      this._maybeQueueNudge(projectPath, runId, task, prev);
    };
  }

  start() {
    this.watcher.on('state', this._onState);
    this.watcher.on('task-changed', this._onTaskChanged);
    this._tick = setInterval(() => {
      for (const p of this.watcher.watchedProjects()) this.reconcile(p);
    }, RECONCILE_TICK_MS);
    if (this._tick.unref) this._tick.unref();
  }

  stop() {
    this._stopped = true;
    this.watcher.removeListener('state', this._onState);
    this.watcher.removeListener('task-changed', this._onTaskChanged);
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    for (const q of this._nudgeQueues.values()) {
      if (q.timer) clearTimeout(q.timer);
    }
    this._nudgeQueues.clear();
    this._staleSince.clear();
  }

  // --- reconciliation -----------------------------------------------------

  async reconcile(projectPath) {
    if (this._stopped) return;
    if (this._reconciling.has(projectPath)) { this._dirty.add(projectPath); return; }
    this._reconciling.add(projectPath);
    let acted = false;
    try {
      const snapshot = this.watcher.getSnapshot(projectPath);
      if (snapshot) {
        for (const entry of snapshot.runs) {
          try {
            if (await this._reconcileRun(projectPath, entry)) acted = true;
          } catch (err) {
            this.log.error(`[orch] reconcile run ${entry.run.id} failed: ${err.message}`);
          }
        }
      }
    } finally {
      // Only force a rescan when this pass changed something — an idle tick
      // must not turn into a full disk scan every 15s per project.
      if (acted) this.watcher.refresh(projectPath);
      this._reconciling.delete(projectPath);
      if (this._dirty.delete(projectPath)) setImmediate(() => this.reconcile(projectPath));
    }
  }

  async _reconcileRun(projectPath, { run, tasks }) {
    if (['done', 'abandoned'].includes(run.status)) {
      await this._cleanupFinishedRun(projectPath, run);
      return false;
    }
    if (run.status !== 'active') return false;
    const policy = { ...proto.DEFAULT_POLICY, ...(run.policy || {}) };
    const byId = new Map(tasks.map(t => [t.id, t]));
    const leaf = (t) => (t.kind || 'leaf') === 'leaf';
    let acted = false;

    this._persistStatusAliases(projectPath, run, tasks);
    // Stop-loss: if spend crossed a cap, pause the run before any new spawn.
    if (this._enforceBudget(projectPath, run, tasks, policy)) return true;
    // Aggregate reviews BEFORE the stale sweep: a completable review must
    // finish even though its (headless) reviewer sessions have exited.
    acted = this._aggregateReviews(projectPath, run, tasks) || acted;
    acted = this._sweepStaleTasks(projectPath, run, tasks) || acted;
    acted = this._auditProtocol(projectPath, run, tasks) || acted;
    acted = this._blockCycles(projectPath, run, tasks) || acted;
    acted = this._runPhaseGates(projectPath, run, tasks, policy) || acted;
    if (policy.isolation !== 'none') await this._cleanupDoneWorktrees(projectPath, run, tasks);

    let activeWorkers = tasks.filter(t => proto.ACTIVE_WORKER_STATUSES.has(t.status)).length;
    let activeReviewers = tasks.filter(t => proto.ACTIVE_REVIEWER_STATUSES.has(t.status)).length;
    const workerCap = run.roles.worker?.maxConcurrent ?? 4;
    const reviewerCap = run.roles.reviewer?.maxConcurrent ?? 2;

    // Per-complexity-tier worker counts, so each tier can ramp independently
    // (e.g. 8 cheap "trivial" tasks in parallel but only 1 "critical" on Opus).
    const tierActive = {};
    for (const t of tasks) {
      if (proto.ACTIVE_WORKER_STATUSES.has(t.status)) {
        const c = proto.taskComplexity(t);
        tierActive[c] = (tierActive[c] || 0) + 1;
      }
    }
    const tierSaturated = (t) => {
      const cap = proto.tierCap(run, proto.taskComplexity(t));
      return cap != null && (tierActive[proto.taskComplexity(t)] || 0) >= cap;
    };
    const countTier = (t) => {
      const c = proto.taskComplexity(t);
      tierActive[c] = (tierActive[c] || 0) + 1;
    };

    // Concurrency is bounded by the role cap AND by file overlap: two tasks
    // whose filesHint intersect must never run at the same time, however
    // high the cap is. Every not-yet-merged task that has started work
    // occupies its files (its branch holds unmerged edits until `done`).
    const occupiedFiles = new Set();
    for (const t of tasks) {
      if (['spawning', 'in_progress', 'needs_review', 'reviewing', 'changes_requested', 'approved', 'merging'].includes(t.status)) {
        for (const f of t.filesHint || []) occupiedFiles.add(proto.normalizeFileHint(f));
      }
    }
    const overlapsOccupied = (t) => (t.filesHint || []).some(f => occupiedFiles.has(proto.normalizeFileHint(f)));
    const occupy = (t) => { for (const f of t.filesHint || []) occupiedFiles.add(proto.normalizeFileHint(f)); };

    if (policy.autoSpawnWorkers) {
      // Rework first — those tasks are closest to completion (their files
      // are already counted as occupied by themselves).
      for (const t of tasks.filter(x => x.status === 'changes_requested' && leaf(x))) {
        if (activeWorkers >= workerCap) break;
        if (tierSaturated(t)) continue;
        if (await this._dispatchRework(projectPath, run, policy, t)) { activeWorkers++; countTier(t); acted = true; }
      }
      const inCycle = proto.tasksInDependencyCycle(tasks);
      const ready = tasks
        .filter(x => x.status === 'ready' && leaf(x))
        .sort((a, b) => a.id.localeCompare(b.id));
      for (const t of ready) {
        if (inCycle.has(t.id)) continue; // handled by _blockCycles
        if (!proto.depsSatisfied(t, byId)) continue;
        if (overlapsOccupied(t)) {
          this.log.debug(`[orch] ${run.id}/${t.id} deferred: files overlap an active task`);
          continue;
        }
        if ((t.attempts || 0) >= policy.maxAttempts) {
          const r = proto.transitionTask(projectPath, run.id, t.id, 'ready', 'blocked',
            { blockedReason: `max attempts (${policy.maxAttempts}) exhausted` });
          if (r.ok) {
            acted = true;
            this.log.warn(`[orch] ${run.id}/${t.id} blocked: attempts exhausted`);
          }
          continue;
        }
        if (tierSaturated(t)) {
          this.log.debug(`[orch] ${run.id}/${t.id} deferred: ${proto.taskComplexity(t)} tier at capacity`);
          continue;
        }
        if (activeWorkers >= workerCap) break;
        if (await this._dispatchWorker(projectPath, run, policy, t)) {
          activeWorkers++;
          countTier(t);
          acted = true;
          occupy(t);
        }
      }
    }

    if (policy.autoSpawnReviewers) {
      for (const t of tasks.filter(x => x.status === 'needs_review' && leaf(x))) {
        if (activeReviewers >= reviewerCap) break;
        if (await this._dispatchReviewer(projectPath, run, policy, t)) { activeReviewers++; acted = true; }
      }
    }

    return acted;
  }

  // --- stale-session sweep -------------------------------------------------
  //
  // A worker/reviewer can die without performing its closing transition
  // (claude crash, PTY killed, machine slept through it). Status alone would
  // then claim the task is active forever and its concurrency slot is lost.
  // The sweep notices "active status but no live session", waits a grace
  // period (the condition must persist across passes), then recovers the
  // task to a re-dispatchable state.

  _sweepStaleTasks(projectPath, run, tasks) {
    // spawning/in_progress recover on SESSION liveness (a dead worker means
    // the work stopped). `reviewing` is different: headless lens reviewers
    // are EXPECTED to exit after writing their verdict files, so liveness is
    // the wrong signal — _aggregateReviews completes a healthy review. A
    // reviewing task is only stuck if its verdict files never appear; that's
    // checked by file presence, not session liveness, to avoid re-dispatching
    // a review that simply hasn't been aggregated yet.
    const RECOVERY = {
      spawning: { to: 'ready', patch: { pendingSessionId: null }, event: 'stale-spawn-recovered' },
      in_progress: { to: 'failed', patch: { failReason: 'worker session ended without completing the task' }, event: 'worker-died' },
    };
    let acted = false;
    const liveKeys = new Set();
    const reviewsDir = path.join(proto.runDir(projectPath, run.id), 'reviews');
    for (const task of tasks) {
      let stuck, key, rec, sid = null;
      if (task.status === 'reviewing') {
        // Stuck only if a pending-lens verdict file is still missing.
        const round = task.reviewRound || 1;
        const lenses = Array.isArray(task.pendingLenses) ? task.pendingLenses : [];
        const missing = lenses.filter(l => !fs.existsSync(path.join(reviewsDir, `${task.id}-${l}-${round}.md`)));
        if (lenses.length === 0 || missing.length === 0) continue; // aggregation will finish it
        stuck = true;
        key = `${projectPath}|${run.id}|${task.id}|reviewing|${round}`;
        rec = { to: 'needs_review', patch: { pendingLenses: [] }, event: 'review-stuck' };
      } else {
        rec = RECOVERY[task.status];
        if (!rec) continue;
        sid = task.pendingSessionId || (task.sessionIds || []).slice(-1)[0];
        key = `${projectPath}|${run.id}|${task.id}|${task.status}`;
        if (sid && this.deps.isSessionActive(sid)) { this._staleSince.delete(key); continue; }
        stuck = true;
      }
      liveKeys.add(key);
      const first = this._staleSince.get(key);
      if (!first) { this._staleSince.set(key, Date.now()); continue; }
      if (Date.now() - first < this.staleGraceMs) continue;
      this._staleSince.delete(key);
      const r = proto.transitionTask(projectPath, run.id, task.id, task.status, rec.to, rec.patch);
      if (r.ok) {
        acted = true;
        proto.appendEvent(projectPath, run.id, { type: rec.event, task: task.id, sessionId: sid });
        this.log.warn(`[orch] ${run.id}/${task.id}: stuck in ${task.status} → ${rec.to}`);
      }
    }
    // Drop bookkeeping for tasks that moved on (status changed / task done).
    for (const key of this._staleSince.keys()) {
      if (key.startsWith(`${projectPath}|${run.id}|`) && !liveKeys.has(key)) {
        this._staleSince.delete(key);
      }
    }
    return acted;
  }

  // A small model may write a status alias (e.g. `needs_revision`). The
  // snapshot already shows it canonicalized; rewrite the file once so the
  // agent's own next read sees the canonical value too.
  _persistStatusAliases(projectPath, run, tasks) {
    for (const task of tasks) {
      if (!task._statusWas) continue;
      const fresh = proto.readJsonSafe(
        path.join(proto.runDir(projectPath, run.id), 'tasks', `${task.id}.json`));
      if (!fresh || fresh.status !== task._statusWas) continue; // moved on / already fixed
      const { _statusWas, ...clean } = task;
      proto.writeTask(projectPath, run.id, clean);
      proto.appendEvent(projectPath, run.id, {
        type: 'status-normalized', task: task.id, from: _statusWas, to: task.status,
      });
      this.log.info(`[orch] normalized status alias for ${run.id}/${task.id}: ${_statusWas} → ${task.status}`);
    }
  }

  // Stop-loss. Pause the run (and nudge the master) when spend crosses a cap.
  // Cost is only enforced when transcripts carry real figures; the
  // output-token cap always works. Returns true if it paused the run.
  _enforceBudget(projectPath, run, tasks, policy) {
    const budgetUsd = policy.maxBudgetUsd;
    const tokenCap = policy.maxOutputTokens;
    if (!budgetUsd && !tokenCap) return false;
    if (!this.deps.computeSpend) return false;
    let spend;
    try { spend = this.deps.computeSpend(projectPath, run, tasks); } catch { return false; }
    if (!spend) return false;
    const overCost = budgetUsd && spend.hasCost && spend.costUSD >= budgetUsd;
    const overTokens = tokenCap && spend.outputTokens >= tokenCap;
    if (!overCost && !overTokens) return false;
    const reason = overCost
      ? `budget reached: $${spend.costUSD.toFixed(2)} ≥ $${budgetUsd}`
      : `token budget reached: ${spend.outputTokens} ≥ ${tokenCap} output tokens`;
    const wrote = proto.writeRun(projectPath, { ...run, status: 'paused' });
    if (wrote.ok) {
      proto.appendEvent(projectPath, run.id, { type: 'budget-paused', text: reason });
      // Dedupe the nudge: if the user resumes while still over budget the run
      // re-pauses immediately; don't spam the master each flap.
      const flapKey = `${projectPath}|${run.id}`;
      if (!this._budgetPaused.has(flapKey)) {
        this._budgetPaused.add(flapKey);
        this._queueNudgeLine(projectPath, run.id,
          `run auto-paused — ${reason}. In-flight sessions keep running; raise the cap (run.json) or finish manually.`);
      }
      this.log.warn(`[orch] ${run.id} auto-paused: ${reason}`);
    }
    return true;
  }

  // dependsOn cycles would wedge every task in the cycle at `ready` forever.
  // Block them with a clear reason so the master (or the user) can fix the
  // graph, instead of an invisible deadlock.
  _blockCycles(projectPath, run, tasks) {
    let acted = false;
    const inCycle = proto.tasksInDependencyCycle(tasks);
    for (const t of tasks) {
      if (t.status !== 'ready' || !inCycle.has(t.id)) continue;
      const r = proto.transitionTask(projectPath, run.id, t.id, 'ready', 'blocked',
        { blockedReason: 'dependsOn cycle — this task can never become unblocked' });
      if (r.ok) {
        acted = true;
        proto.appendEvent(projectPath, run.id, { type: 'dependency-cycle', task: t.id });
        this.log.warn(`[orch] ${run.id}/${t.id} blocked: dependsOn cycle`);
      }
    }
    return acted;
  }

  // Phase gates: when every leaf of a chunk is done, validate the chunk on
  // the integration branch and only then mark the chunk done. A failing gate
  // blocks the chunk (the master adds fix tasks and re-opens it). This is what
  // keeps the app working as layers build up — verified deterministically by
  // Switchboard, not just promised by the master prompt.
  // Non-blocking: a phase gate (e.g. `npm test`, which can take minutes) must
  // NOT be awaited inside reconcile — reconcile is serialized per project, so
  // awaiting here would freeze all of that project's orchestration (worker
  // dispatch, review aggregation, the stale sweep) for the gate's duration.
  // We start the validation in the background, guard re-entry with
  // _gatingChunks, and apply the result + refresh when it resolves.
  _runPhaseGates(projectPath, run, tasks, policy) {
    let acted = false;
    const chunks = tasks.filter(t => (t.kind === 'chunk' || t.kind === 'epic') && t.status === 'in_progress');
    for (const chunk of chunks) {
      if (!proto.allLeavesDone(chunk.id, tasks)) continue;
      const cmd = (typeof chunk.validateCmd === 'string' && chunk.validateCmd.trim())
        ? chunk.validateCmd : policy.validateCmd;

      // No gate configured (or gates off / no runner): the phase passes by
      // virtue of its leaves being done.
      if (!cmd || policy.gatesEnabled === false || !this.deps.runValidation) {
        if (this._markChunkDone(projectPath, run, chunk, null)) acted = true;
        continue;
      }
      const key = `${projectPath}|${run.id}|${chunk.id}`;
      if (this._gatingChunks.has(key)) continue; // gate already in flight

      // validateCmd is agent/file-writable — refuse anything that isn't a
      // single command (no chaining/redirection/substitution).
      if (!proto.isSafeValidateCmd(cmd)) {
        const fresh = proto.readTask(projectPath, run.id, chunk.id);
        if (fresh && fresh.status === 'in_progress') {
          proto.writeTask(projectPath, run.id, { ...fresh, status: 'blocked',
            blockedReason: `phase gate command rejected as unsafe: ${cmd.slice(0, 120)}` });
          proto.appendEvent(projectPath, run.id, { type: 'gate-rejected', task: chunk.id, text: cmd.slice(0, 200) });
          this._queueNudgeLine(projectPath, run.id, `phase ${chunk.id} validateCmd rejected as unsafe — use a single command`);
          acted = true;
        }
        continue;
      }

      const cwd = policy.isolation === 'none'
        ? projectPath
        : path.join(proto.worktreesRoot(projectPath), `${run.id}--integration`);
      if (policy.isolation !== 'none' && !fs.existsSync(cwd)) {
        proto.appendEvent(projectPath, run.id, { type: 'gate-skipped', task: chunk.id, error: 'integration worktree missing' });
        if (this._markChunkDone(projectPath, run, chunk, 'no integration worktree')) acted = true;
        continue;
      }

      this._gatingChunks.add(key);
      proto.appendEvent(projectPath, run.id, { type: 'gate-running', task: chunk.id, text: cmd });
      acted = true;
      Promise.resolve()
        .then(() => this.deps.runValidation(cmd, cwd))
        .then((r) => {
          if (this._stopped) return;
          const fresh = proto.readTask(projectPath, run.id, chunk.id);
          if (!fresh || fresh.status !== 'in_progress') return;
          if (r && r.ok) {
            proto.writeTask(projectPath, run.id, { ...fresh, status: 'done', gate: { cmd, passed: true } });
            proto.appendEvent(projectPath, run.id, { type: 'gate-passed', task: chunk.id, text: cmd });
            this.log.info(`[orch] phase gate passed for ${run.id}/${chunk.id}`);
          } else {
            const detail = ((r && (r.stderr || r.stdout)) || `exit ${r && r.code}`).slice(0, 500);
            proto.writeTask(projectPath, run.id, { ...fresh, status: 'blocked',
              blockedReason: `phase gate failed: ${cmd}`, gate: { cmd, passed: false, detail } });
            proto.appendEvent(projectPath, run.id, { type: 'gate-failed', task: chunk.id, text: cmd, error: detail });
            this._queueNudgeLine(projectPath, run.id, `phase ${chunk.id} gate failed (${cmd}) — add fix tasks and re-open the chunk`);
            this.log.warn(`[orch] phase gate FAILED for ${run.id}/${chunk.id}: ${detail}`);
          }
        })
        .catch((err) => proto.appendEvent(projectPath, run.id, { type: 'gate-error', task: chunk.id, error: err.message }))
        .finally(() => {
          this._gatingChunks.delete(key);
          if (!this._stopped) this.watcher.refresh(projectPath);
        });
    }
    return acted;
  }

  _markChunkDone(projectPath, run, chunk, note) {
    const fresh = proto.readTask(projectPath, run.id, chunk.id);
    if (!fresh || fresh.status !== 'in_progress') return false;
    proto.writeTask(projectPath, run.id, { ...fresh, status: 'done', ...(note ? { gateNote: note } : {}) });
    proto.appendEvent(projectPath, run.id, { type: 'phase-done', task: chunk.id, text: note || 'all leaves done' });
    return true;
  }

  // Worktrees accumulate otherwise: the master's /sb-merge prompt removes a
  // task worktree on done, but we enforce it mechanically too (idempotent,
  // tracked so we don't shell out repeatedly). `done` means merged, so the
  // working tree is disposable; the branch is kept.
  async _cleanupDoneWorktrees(projectPath, run, tasks) {
    if (!this.deps.removeTaskWorktree) return;
    for (const t of tasks) {
      if (t.status !== 'done' || !t.worktree) continue;
      const key = `${projectPath}|${run.id}|${t.id}`;
      if (this._cleanedWorktrees.has(key)) continue;
      this._cleanedWorktrees.add(key);
      try {
        const r = await this.deps.removeTaskWorktree(projectPath, run.id, t.id);
        if (r && r.ok && r.removed) {
          proto.appendEvent(projectPath, run.id, { type: 'worktree-cleaned', task: t.id });
        } else if (r && !r.ok) {
          this._cleanedWorktrees.delete(key); // let a later pass retry
        }
      } catch { this._cleanedWorktrees.delete(key); }
    }
  }

  // When a run finishes, remove all its worktrees once (integration + any
  // leftover task worktrees) and prune.
  async _cleanupFinishedRun(projectPath, run) {
    if (!this.deps.removeRunWorktrees) return;
    const key = `${projectPath}|${run.id}`;
    if (this._cleanedRuns.has(key)) return;
    this._cleanedRuns.add(key);
    try {
      const r = await this.deps.removeRunWorktrees(projectPath, run.id);
      if (r && r.ok && r.removed?.length) {
        proto.appendEvent(projectPath, run.id, { type: 'run-worktrees-cleaned', count: r.removed.length });
        this.log.info(`[orch] cleaned ${r.removed.length} worktree(s) for finished run ${run.id}`);
      }
    } catch { this._cleanedRuns.delete(key); }
  }

  // --- protocol audit & normalization ---------------------------------------
  //
  // Agents of varying quality write these files; the conventions the
  // prompts demand are also enforced mechanically. Live testing with haiku
  // produced both observed drift modes: a verdict with no review recorded
  // at all, and a verdict recorded in an invented shape (`review` object
  // instead of the `reviews` array, off-pattern file name). Near-misses
  // with real evidence are NORMALIZED into the canonical schema —
  // Switchboard owns the schema, agents only approximate it. Evidence-free
  // verdicts become events + master nudges instead of silent drift.

  _auditProtocol(projectPath, run, tasks) {
    let acted = false;
    // Keep _protocolWarned from growing without bound across a long run: a
    // warning key is only meaningful while its task is still in that status.
    const liveWarnKeys = new Set(
      tasks.filter(t => ['approved', 'changes_requested'].includes(t.status))
        .map(t => `${projectPath}|${run.id}|${t.id}|${t.status}|no-review`));
    for (const k of this._protocolWarned) {
      if (k.startsWith(`${projectPath}|${run.id}|`) && !liveWarnKeys.has(k)) this._protocolWarned.delete(k);
    }
    for (const task of tasks) {
      if (!['approved', 'changes_requested'].includes(task.status)) continue;
      if ((task.reviews || []).length > 0) continue;

      // Evidence hunt: a rogue `review` object on the task, or a review
      // markdown for this task on disk (any name variant).
      const rogue = (task.review && typeof task.review === 'object' && !Array.isArray(task.review))
        ? task.review : null;
      let reviewFiles = [];
      try {
        reviewFiles = fs.readdirSync(path.join(proto.runDir(projectPath, run.id), 'reviews'))
          .filter(f => f.endsWith('.md') && (f === `${task.id}.md` || f.startsWith(`${task.id}-`)))
          .sort();
      } catch {}

      if (rogue || reviewFiles.length) {
        const verdict = (rogue && ['approved', 'changes_requested'].includes(rogue.verdict))
          ? rogue.verdict : task.status;
        const fresh = proto.readTask(projectPath, run.id, task.id);
        if (!fresh || fresh.status !== task.status || (fresh.reviews || []).length > 0) continue;
        const next = {
          ...fresh,
          reviews: [{
            file: reviewFiles.length ? `reviews/${reviewFiles[reviewFiles.length - 1]}` : null,
            verdict,
            normalized: true,
          }],
        };
        delete next.review;
        if (proto.writeTask(projectPath, run.id, next).ok) {
          acted = true;
          proto.appendEvent(projectPath, run.id, {
            type: 'review-normalized', task: task.id, verdict,
            file: next.reviews[0].file,
            error: 'reviewer wrote a non-canonical verdict shape; coerced into reviews[]',
          });
          this.log.info(`[orch] normalized review verdict for ${run.id}/${task.id} (${verdict})`);
        }
        continue;
      }

      const key = `${projectPath}|${run.id}|${task.id}|${task.status}|no-review`;
      if (this._protocolWarned.has(key)) continue;
      this._protocolWarned.add(key);
      proto.appendEvent(projectPath, run.id, {
        type: 'protocol-warning', task: task.id,
        error: `status ${task.status} recorded without a review entry — verdict is unaudited`,
      });
      this._queueNudgeLine(projectPath, run.id,
        `task ${task.id} is ${task.status} but has NO recorded review — verify before merging`);
      this.log.warn(`[orch] protocol warning: ${run.id}/${task.id} ${task.status} without review entry`);
    }
    return acted;
  }

  // --- dispatch helpers -----------------------------------------------------

  _roleCfg(run, role) { return run.roles[role] || {}; }

  // One resolver for the session options of every dispatch path, so policy
  // decisions (permission mode, protocol access, MCP) can't drift apart.
  _sessionOptions(projectPath, run, task, role, cwd, initialPrompt, extraSystemPrompt) {
    const roleCfg = this._roleCfg(run, role);
    // Model profile is resolved per task: explicit task override → the run's
    // tier for this task's complexity → the role default. This is the knob
    // that routes leaf tasks to cheap/local models and hard ones to Opus.
    const profileId = proto.resolveProfile(run, task, role);
    const base = this.deps.rolePrompt(role, run, projectPath, task) || '';
    return {
      profileId: profileId || undefined,
      permissionMode: roleCfg.permissionMode || 'acceptEdits',
      initialPrompt,
      appendSystemPrompt: (extraSystemPrompt ? `${base}\n\n${extraSystemPrompt}` : base) || undefined,
      mcpEmulation: false,
      // Worktree sessions need access to the protocol files, which live
      // outside the worktree subtree (.switchboard/runs, guidelines.md).
      addDirs: cwd === projectPath ? undefined : proto.orchDir(projectPath),
      orchestration: { runId: run.id, taskId: task.id, role },
    };
  }

  async _prepareCwd(projectPath, run, policy, task) {
    if (policy.isolation === 'none') {
      return { ok: true, cwd: projectPath, worktree: null, branch: null };
    }
    const w = await this.deps.ensureTaskWorktree(projectPath, run.id, task.id, run.integrationBranch);
    if (!w.ok) return { ok: false, error: w.error };
    return { ok: true, cwd: w.path, worktree: w.path, branch: w.branch };
  }

  async _spawnSession(projectPath, run, task, role, cwd, initialPrompt, sessionId, extraSystemPrompt) {
    // Spawn FRESH (isNew=true -> claude --session-id), not seed+resume: resuming
    // a synthetic JSONL fails interactively. The task prompt is delivered as
    // claude's positional [prompt] arg so the worker starts working immediately.
    const res = await this.deps.openTerminal(sessionId, cwd, true,
      this._sessionOptions(projectPath, run, task, role, cwd, initialPrompt, extraSystemPrompt));
    if (!res || !res.ok) {
      return { ok: false, error: (res && res.error) || 'openTerminal failed' };
    }
    return { ok: true, sessionId };
  }

  // A completing transition can conflict if some other writer moved the task
  // while the session was being spawned. The session is then running without
  // a task that records it — make that loudly visible instead of silent.
  _completeDispatch(projectPath, run, task, from, patch, eventType, sessionId) {
    const done = proto.transitionTask(projectPath, run.id, task.id, from, 'in_progress', patch);
    if (done.ok) {
      proto.appendEvent(projectPath, run.id, { type: eventType, task: task.id, sessionId });
      return true;
    }
    proto.appendEvent(projectPath, run.id, {
      type: 'orphan-session', task: task.id, sessionId,
      error: `session spawned but task left ${from}: ${done.error}`,
    });
    this.log.warn(`[orch] orphan session ${sessionId} for ${run.id}/${task.id}: ${done.error}`);
    return true; // a session IS running — it still occupies a concurrency slot
  }

  async _dispatchWorker(projectPath, run, policy, task) {
    const sessionId = this.deps.newSessionId();
    const tr = proto.transitionTask(projectPath, run.id, task.id, 'ready', 'spawning',
      { attempts: (task.attempts || 0) + 1, role: task.role || 'worker', pendingSessionId: sessionId });
    if (!tr.ok) return false;

    const prep = await this._prepareCwd(projectPath, run, policy, task);
    if (!prep.ok) return this._spawnFailed(projectPath, run, task, `worktree: ${prep.error}`);

    const spawn = await this._spawnSession(projectPath, run, task, task.role || 'worker',
      prep.cwd, `/sb-work ${run.id} ${task.id}`, sessionId);
    if (!spawn.ok) return this._spawnFailed(projectPath, run, task, spawn.error);

    this._completeDispatch(projectPath, run, task, 'spawning', {
      sessionIds: [...(task.sessionIds || []), sessionId],
      pendingSessionId: null,
      worktree: prep.worktree,
      branch: prep.branch,
    }, 'worker-spawned', sessionId);
    this.log.info(`[orch] worker spawned for ${run.id}/${task.id} (${sessionId})`);
    return true;
  }

  async _dispatchRework(projectPath, run, policy, task) {
    const role = task.role || 'worker';
    const freshSessionId = this.deps.newSessionId();
    const tr = proto.transitionTask(projectPath, run.id, task.id, 'changes_requested', 'spawning',
      { attempts: (task.attempts || 0) + 1, pendingSessionId: freshSessionId });
    if (!tr.ok) return false;

    const prep = await this._prepareCwd(projectPath, run, policy, task);
    if (!prep.ok) return this._spawnFailed(projectPath, run, task, `worktree: ${prep.error}`);

    // Point the worker at every lens review that asked for changes in the
    // most recent round (multi-lens), or the last single review.
    const lastRound = Math.max(0, ...(task.reviews || []).map(r => r.round || 0));
    const rejected = (task.reviews || [])
      .filter(r => r.verdict === 'changes_requested' && (lastRound === 0 || r.round === lastRound) && r.file)
      .map(r => r.file);
    const files = rejected.length ? rejected : (task.reviews || []).slice(-1).map(r => r.file).filter(Boolean);
    const prompt = `/sb-work ${run.id} ${task.id} — the reviewers requested changes` +
      (files.length ? `; read ${files.join(' and ')} and address every point` : '');

    // Prefer feeding the rework into the still-alive worker session (its
    // context is intact); a failed PTY write falls through to a resume.
    const lastSession = (task.sessionIds || []).slice(-1)[0];
    if (lastSession && this.deps.isSessionActive(lastSession)) {
      if (this.deps.sendInput(lastSession, prompt + '\r')) {
        this._completeDispatch(projectPath, run, task, 'spawning',
          { pendingSessionId: null }, 'rework-nudged', lastSession);
        return true;
      }
      this.log.warn(`[orch] rework input to ${lastSession} failed; resuming in a fresh terminal`);
    }
    if (lastSession) {
      const res = await this.deps.openTerminal(lastSession, prep.cwd, false,
        this._sessionOptions(projectPath, run, task, role, prep.cwd, prompt));
      if (res && res.ok) {
        this._completeDispatch(projectPath, run, task, 'spawning',
          { pendingSessionId: null }, 'rework-resumed', lastSession);
        return true;
      }
    }
    // No previous session (or resume failed) — dispatch as a fresh worker.
    const spawn = await this._spawnSession(projectPath, run, task, role, prep.cwd, prompt, freshSessionId);
    if (!spawn.ok) return this._spawnFailed(projectPath, run, task, spawn.error);
    this._completeDispatch(projectPath, run, task, 'spawning', {
      sessionIds: [...(task.sessionIds || []), freshSessionId],
      pendingSessionId: null,
    }, 'rework-spawned', freshSessionId);
    return true;
  }

  // Multi-lens review: each applicable lens (spec, functionality, tests,
  // security, style — depth scales with complexity) becomes its OWN reviewer
  // session with a focused prompt, possibly a different model. Each writes its
  // own verdict file; Switchboard aggregates them deterministically
  // (_aggregateReviews) — the lens agents never set the task status, so N
  // concurrent reviewers never race on the task file.
  async _dispatchReviewer(projectPath, run, policy, task) {
    const lenses = proto.resolveLenses(run, task);

    // Review disabled → auto-approve (explicit opt-out only).
    if (lenses.length === 0) {
      const r = proto.transitionTask(projectPath, run.id, task.id, 'needs_review', 'approved',
        { reviews: [...(task.reviews || []), { verdict: 'approved', autoApproved: true }] });
      if (r.ok) proto.appendEvent(projectPath, run.id, { type: 'review-skipped', task: task.id });
      return r.ok;
    }

    const round = (task.reviewRound || 0) + 1;

    // Spawn the lens reviewers FIRST, then claim `reviewing` in a single write
    // whose pendingLenses are EXACTLY the lenses that spawned — so aggregation
    // can never wait on a lens that never started. Safe because reconcile is
    // serialized per project, so the task can't be re-dispatched mid-spawn.
    const prep = await this._prepareCwd(projectPath, run, policy, task);
    if (!prep.ok) {
      proto.appendEvent(projectPath, run.id, { type: 'review-spawn-failed', task: task.id, error: prep.error });
      return false;
    }
    const spawnedLenses = [];
    const sessionIds = [...(task.reviewSessionIds || [])];
    for (const lens of lenses) {
      const sessionId = this.deps.newSessionId();
      const meta = proto.REVIEW_LENSES[lens];
      const extra = `## Your review lens: ${meta.label}\n${meta.focus}\n\n` +
        `Write your verdict to \`../../runs/${run.id}/reviews/${task.id}-${lens}-${round}.md\` ` +
        `starting with a line \`Verdict: approved\` or \`Verdict: changes_requested\`, then your findings. ` +
        `Do NOT edit the task JSON or its status — Switchboard aggregates the lenses. Do NOT modify code.`;
      const spawn = await this._spawnSession(projectPath, run, task, 'reviewer', prep.cwd,
        `/sb-review ${run.id} ${task.id} ${lens}`, sessionId, extra);
      if (spawn.ok) {
        spawnedLenses.push(lens);
        sessionIds.push(sessionId);
        proto.appendEvent(projectPath, run.id, { type: 'reviewer-spawned', task: task.id, sessionId, lens });
      } else {
        proto.appendEvent(projectPath, run.id, { type: 'review-spawn-failed', task: task.id, lens, error: spawn.error });
      }
    }
    if (spawnedLenses.length === 0) return false; // task stays needs_review; retried next pass

    const tr = proto.transitionTask(projectPath, run.id, task.id, 'needs_review', 'reviewing',
      { reviewRound: round, pendingLenses: spawnedLenses, reviewSessionIds: sessionIds });
    if (!tr.ok) {
      // A concurrent writer moved the task between spawn and claim — the lens
      // sessions are running but unrecorded; the file-based review sweep and
      // the next pass reconcile it. Make it visible.
      proto.appendEvent(projectPath, run.id, { type: 'orphan-review', task: task.id, error: tr.error });
      return true;
    }
    this.log.info(`[orch] ${spawnedLenses.length}-lens review dispatched for ${run.id}/${task.id} (round ${round}): ${spawnedLenses.join(', ')}`);
    return true;
  }

  // Aggregate the per-lens verdict files for tasks under review. Once every
  // pending lens for the current round has a parseable verdict, decide the
  // task: approved if approvals ≥ quorum (default: all lenses), else
  // changes_requested. This write is Switchboard's alone — single writer.
  _aggregateReviews(projectPath, run, tasks) {
    let acted = false;
    const reviewsDir = path.join(proto.runDir(projectPath, run.id), 'reviews');
    for (const task of tasks) {
      if (task.status !== 'reviewing') continue;
      const lenses = Array.isArray(task.pendingLenses) ? task.pendingLenses : [];
      if (lenses.length === 0) continue;
      const round = task.reviewRound || 1;
      const verdicts = {};
      let allIn = true;
      for (const lens of lenses) {
        const file = `${task.id}-${lens}-${round}.md`;
        let text = null;
        try { text = fs.readFileSync(path.join(reviewsDir, file), 'utf8'); } catch {}
        const v = text != null ? proto.parseVerdict(text) : null;
        if (!v) { allIn = false; break; }
        verdicts[lens] = { lens, file: `reviews/${file}`, verdict: v };
      }
      if (!allIn) continue;

      const verdictList = Object.values(verdicts);
      const outcome = proto.reviewOutcome(run, verdictList);
      const passed = outcome.passed;
      const fresh = proto.readTask(projectPath, run.id, task.id);
      if (!fresh || fresh.status !== 'reviewing' || fresh.reviewRound !== round) continue;
      const reviewEntries = verdictList.map(v => ({ file: v.file, verdict: v.verdict, lens: v.lens, round }));
      const next = proto.transitionTask(projectPath, run.id, task.id, 'reviewing',
        passed ? 'approved' : 'changes_requested',
        { reviews: [...(fresh.reviews || []), ...reviewEntries], pendingLenses: [] });
      if (next.ok) {
        acted = true;
        const summary = verdictList.map(v => `${v.lens}:${v.verdict === 'approved' ? '✓' : '✗'}`).join(' ');
        const why = outcome.vetoed ? ' (security veto)' : '';
        proto.appendEvent(projectPath, run.id, {
          type: passed ? 'review-approved' : 'review-changes-requested',
          task: task.id, text: `${outcome.approvals}/${lenses.length} lenses approved${why} (${summary})`,
        });
        this.log.info(`[orch] review aggregated for ${run.id}/${task.id}: ${passed ? 'approved' : 'changes_requested'} (${summary})`);
      }
    }
    return acted;
  }

  _spawnFailed(projectPath, run, task, error) {
    proto.appendEvent(projectPath, run.id, { type: 'spawn-failed', task: task.id, error });
    this.log.warn(`[orch] spawn failed for ${run.id}/${task.id}: ${error}`);
    // Roll back so the next reconcile pass (or a human) can retry; attempts
    // were already incremented at spawning time, so maxAttempts still bites.
    proto.transitionTask(projectPath, run.id, task.id, 'spawning', 'ready', { pendingSessionId: null });
    return false;
  }

  // --- master nudging -----------------------------------------------------
  //
  // The master agent doesn't poll; when something needs its judgment we type
  // one line into its terminal. Edge-triggered from watcher task deltas,
  // debounced so bursts collapse into a single nudge.

  _maybeQueueNudge(projectPath, runId, task, prev) {
    if (!prev || prev.status === task.status) {
      // Brand-new tasks are the master's own writes — no nudge needed.
      if (prev) return;
    }
    const noteworthy = {
      approved: `task ${task.id} approved by review`,
      blocked: `task ${task.id} is blocked (${task.blockedReason || 'see task file'})`,
      failed: `task ${task.id} failed${task.failReason ? ` (${task.failReason})` : ''}`,
      done: null, // handled below via run-completion check
    };
    let line = noteworthy[task.status];
    if (task.status === 'done') {
      const snap = this.watcher.getSnapshot(projectPath);
      const entry = snap?.runs.find(r => r.run.id === runId);
      if (entry && entry.summary.leaves > 0 && entry.summary.leavesDone === entry.summary.leaves) {
        line = 'all leaf tasks are done';
      }
    }
    if (!line) return;
    this._queueNudgeLine(projectPath, runId, line);
  }

  _queueNudgeLine(projectPath, runId, line) {
    // Nudge lines embed agent-written text (blockedReason, failReason) and
    // are typed into the master's PTY — control characters here would let a
    // rogue/buggy task file inject extra submitted prompts into the master
    // session. Strip C0/C7F/DEL AND the Unicode line/paragraph separators
    // (U+2028/U+2029) and NEL (U+0085) that some terminals treat as Enter.
    line = stripSubmitChars(String(line)).slice(0, 300);
    const key = projectPath + ' ' + runId;
    let q = this._nudgeQueues.get(key);
    if (!q) {
      q = { lines: [], timer: null, projectPath, runId };
      this._nudgeQueues.set(key, q);
    }
    if (q.lines.length < NUDGE_MAX_QUEUE && !q.lines.includes(line)) q.lines.push(line);
    if (!q.timer) {
      q.timer = setTimeout(() => { q.timer = null; this._flushNudge(key); }, this.nudgeDebounceMs);
      if (q.timer.unref) q.timer.unref();
    }
  }

  _flushNudge(key) {
    const q = this._nudgeQueues.get(key);
    if (!q || q.lines.length === 0 || this._stopped) return;
    const run = proto.readRun(q.projectPath, q.runId);
    if (!run || ['done', 'abandoned'].includes(run.status)) {
      this._nudgeQueues.delete(key);
      return;
    }
    const master = run.masterSessionId;
    const deliverable = master && this.deps.isSessionActive(master) && !this.deps.isSessionBusy(master);
    if (!deliverable) {
      // Master closed or thinking — retry, but bound it: a master that never
      // comes back (closed terminal) must not leave a timer rescheduling
      // itself forever. After a cap we drop the queue; the event log and the
      // master's own /sb-orchestrate re-scan still carry the information.
      q.retries = (q.retries || 0) + 1;
      if (q.retries > NUDGE_MAX_RETRIES) {
        this.log.warn(`[orch] giving up nudging ${q.runId} after ${q.retries} retries (master unreachable)`);
        this._nudgeQueues.delete(key);
        return;
      }
      q.timer = setTimeout(() => { q.timer = null; this._flushNudge(key); }, this.nudgeRetryMs);
      if (q.timer.unref) q.timer.unref();
      return;
    }
    q.retries = 0;
    const text = `[switchboard] ${q.lines.join('; ')} — run /sb-orchestrate to continue.`;
    this.deps.sendInput(master, text + '\r');
    proto.appendEvent(q.projectPath, q.runId, { type: 'master-nudged', lines: q.lines });
    this.log.info(`[orch] nudged master of ${q.runId}: ${q.lines.join('; ')}`);
    q.lines = [];
  }
}

module.exports = { OrchSpawner, RECONCILE_TICK_MS, NUDGE_DEBOUNCE_MS, STALE_GRACE_MS };
