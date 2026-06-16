const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proto = require('../orch-protocol');
const { OrchWatcher } = require('../orch-watcher');
const { OrchSpawner } = require('../orch-spawner');

const ROLES = {
  master: { profileId: 'anthropic' },
  worker: { profileId: 'deepseek', maxConcurrent: 2 },
  reviewer: { profileId: 'anthropic', maxConcurrent: 1 },
};

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-spawn-'));
}

// A run that is active with isolation disabled (no git needed in unit tests).
function makeActiveRun(project, policy = {}) {
  const { run } = proto.createRun(project, {
    title: 'demo', roles: ROLES,
    policy: { isolation: 'none', ...policy },
  });
  const active = { ...run, status: 'active', masterSessionId: 'master-1111-2222-3333-444444444444' };
  proto.writeRun(project, active);
  return active;
}

function makeHarness({ failSpawns = 0, busyMaster = false } = {}) {
  const calls = { openTerminal: [], sendInput: [], seeds: [] };
  let failures = failSpawns;
  let counter = 0;
  const activeSessions = new Set(['master-1111-2222-3333-444444444444']);
  const deps = {
    openTerminal: async (sessionId, cwd, isNew, opts) => {
      calls.openTerminal.push({ sessionId, cwd, isNew, opts });
      if (failures > 0) { failures--; return { ok: false, error: 'boom' }; }
      activeSessions.add(sessionId);
      return { ok: true };
    },
    sendInput: (sessionId, text) => { calls.sendInput.push({ sessionId, text }); return true; },
    isSessionActive: (id) => activeSessions.has(id),
    isSessionBusy: () => busyMaster,
    seedSessionJsonl: (args) => { calls.seeds.push(args); return true; },
    ensureTaskWorktree: async () => { throw new Error('not used with isolation none'); },
    rolePrompt: (role) => `system prompt for ${role}`,
    newSessionId: () => `sess-${String(++counter).padStart(4, '0')}-aaaa-bbbb-cccc`,
  };
  return { calls, deps, activeSessions };
}

async function settle(ms = 50) { return new Promise(r => setTimeout(r, ms)); }

test('ready leaf task gets a worker session and moves to in_progress', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project);
  proto.writeTask(project, run.id, { id: 'T-1', title: 'do it', status: 'ready', kind: 'leaf' });

  const watcher = new OrchWatcher();
  const { calls, deps } = makeHarness();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);

    assert.equal(calls.openTerminal.length, 1);
    const call = calls.openTerminal[0];
    assert.equal(call.cwd, project); // isolation none
    assert.equal(call.isNew, true); // fresh spawn (claude --session-id), not seed+resume
    assert.equal(call.opts.profileId, 'deepseek');
    assert.equal(call.opts.agentTeams, true); // sets SWITCHBOARD_AGENT_TEAMS so guardrail hooks waive prompts
    assert.equal(call.opts.permissionMode, 'acceptEdits');
    assert.equal(call.opts.initialPrompt, `/sb-work ${run.id} T-1`);
    assert.match(call.opts.appendSystemPrompt, /worker/);
    assert.equal(calls.seeds.length, 0); // no synthetic seed — boot prompt is the positional arg

    const task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.status, 'in_progress');
    assert.deepEqual(task.sessionIds, [call.sessionId]);
    assert.equal(task.attempts, 1);
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('concurrency cap and dependency gating are respected', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project);
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf' });
  proto.writeTask(project, run.id, { id: 'T-2', title: 'b', status: 'ready', kind: 'leaf' });
  proto.writeTask(project, run.id, { id: 'T-3', title: 'c', status: 'ready', kind: 'leaf' });
  proto.writeTask(project, run.id, { id: 'T-4', title: 'd', status: 'ready', kind: 'leaf', dependsOn: ['T-9'] });
  proto.writeTask(project, run.id, { id: 'T-9', title: 'dep', status: 'draft', kind: 'leaf' });

  const watcher = new OrchWatcher();
  const { calls, deps } = makeHarness();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);

    // worker cap is 2: T-1 and T-2 spawn, T-3 waits, T-4 dep-gated
    assert.equal(calls.openTerminal.length, 2);
    assert.equal(proto.readTask(project, run.id, 'T-1').status, 'in_progress');
    assert.equal(proto.readTask(project, run.id, 'T-2').status, 'in_progress');
    assert.equal(proto.readTask(project, run.id, 'T-3').status, 'ready');
    assert.equal(proto.readTask(project, run.id, 'T-4').status, 'ready');

    // one worker finishes → next reconcile dispatches T-3 only
    proto.transitionTask(project, run.id, 'T-1', 'in_progress', 'needs_review');
    watcher.refresh(project);
    await spawner.reconcile(project);
    assert.equal(proto.readTask(project, run.id, 'T-3').status, 'in_progress');
    assert.equal(proto.readTask(project, run.id, 'T-4').status, 'ready');
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('needs_review spawns lens reviewers with the reviewer profile', async () => {
  const project = tmpProject();
  // single lens keeps this focused; multi-lens is covered in orch-review
  const { run: base } = proto.createRun(project, {
    title: 'demo', roles: ROLES, policy: { isolation: 'none' }, review: { lenses: ['functionality'] },
  });
  proto.writeRun(project, { ...base, status: 'active', masterSessionId: 'master-1111-2222-3333-444444444444' });
  const run = proto.readRun(project, base.id);
  proto.writeTask(project, run.id, {
    id: 'T-1', title: 'a', status: 'needs_review', kind: 'leaf',
    sessionIds: ['w-1'], attempts: 1,
  });

  const watcher = new OrchWatcher();
  const { calls, deps } = makeHarness();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(calls.openTerminal.length, 1);
    assert.equal(calls.openTerminal[0].opts.profileId, 'anthropic');
    assert.equal(calls.openTerminal[0].opts.initialPrompt, `/sb-review ${run.id} T-1 functionality`);
    const task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.status, 'reviewing');
    assert.deepEqual(task.pendingLenses, ['functionality']);
    assert.equal(task.reviewSessionIds.length, 1);
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('spawn failure rolls back to ready; attempts exhaust into blocked', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project, { maxAttempts: 2 });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf' });

  const watcher = new OrchWatcher();
  const { deps } = makeHarness({ failSpawns: 99 });
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    let task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.status, 'ready');
    assert.equal(task.attempts, 1);

    watcher.refresh(project);
    await spawner.reconcile(project);
    task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.attempts, 2);

    watcher.refresh(project);
    await spawner.reconcile(project);
    task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.status, 'blocked');

    const events = proto.readEvents(project, run.id);
    assert.ok(events.some(e => e.type === 'spawn-failed'));
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('changes_requested feeds rework into the still-active worker session', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project);

  const watcher = new OrchWatcher();
  const { calls, deps, activeSessions } = makeHarness();
  activeSessions.add('w-original');
  proto.writeTask(project, run.id, {
    id: 'T-1', title: 'a', status: 'changes_requested', kind: 'leaf',
    sessionIds: ['w-original'], attempts: 1,
    reviews: [{ file: 'reviews/T-1-1.md', verdict: 'changes_requested' }],
  });

  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(calls.openTerminal.length, 0); // no new terminal
    assert.equal(calls.sendInput.length, 1);
    assert.equal(calls.sendInput[0].sessionId, 'w-original');
    assert.match(calls.sendInput[0].text, new RegExp(`/sb-work ${run.id} T-1`));
    assert.match(calls.sendInput[0].text, /reviews\/T-1-1\.md/);
    assert.equal(proto.readTask(project, run.id, 'T-1').status, 'in_progress');
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('paused or planning runs spawn nothing', async () => {
  const project = tmpProject();
  const { run } = proto.createRun(project, {
    title: 'demo', roles: ROLES, policy: { isolation: 'none' },
  }); // status: planning
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf' });

  const watcher = new OrchWatcher();
  const { calls, deps } = makeHarness();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(calls.openTerminal.length, 0);

    proto.writeRun(project, { ...run, status: 'paused' });
    watcher.refresh(project);
    await spawner.reconcile(project);
    assert.equal(calls.openTerminal.length, 0);
    assert.equal(proto.readTask(project, run.id, 'T-1').status, 'ready');
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('approved task nudges the idle master once, batched', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project);
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'reviewing', kind: 'leaf' });
  proto.writeTask(project, run.id, { id: 'T-2', title: 'b', status: 'reviewing', kind: 'leaf' });

  const watcher = new OrchWatcher();
  const { calls, deps } = makeHarness();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    spawner.start();
    watcher.watchProject(project);
    await settle(50);
    proto.transitionTask(project, run.id, 'T-1', 'reviewing', 'approved', null, 'reviewer');
    proto.transitionTask(project, run.id, 'T-2', 'reviewing', 'approved', null, 'reviewer');
    watcher.refresh(project);
    // Poll instead of a fixed sleep — under full-suite parallel load the
    // debounce timer can land late.
    const masterNudges = () => calls.sendInput.filter(c => c.sessionId === 'master-1111-2222-3333-444444444444');
    const deadline = Date.now() + 10_000;
    while (masterNudges().length === 0 && Date.now() < deadline) await settle(100);
    await settle(300); // ensure no second nudge follows

    const nudges = masterNudges();
    assert.equal(nudges.length, 1);
    assert.match(nudges[0].text, /T-1 approved/);
    assert.match(nudges[0].text, /T-2 approved/);
    assert.match(nudges[0].text, /\/sb-orchestrate/);
    const events = proto.readEvents(project, run.id);
    assert.ok(events.some(e => e.type === 'master-nudged'));
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('chunk in_progress is never recovered as worker-died (chunks carry no worker session)', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project);
  // Master sets the chunk to in_progress while its single leaf runs. The chunk
  // has no worker session; liveness recovery must skip it (regression: it was
  // flagged worker-died -> failed). The live leaf must also be left alone.
  proto.writeTask(project, run.id, { id: 'C-1', title: 'chunk', status: 'in_progress', kind: 'chunk' });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'leaf', status: 'in_progress', kind: 'leaf', parent: 'C-1', sessionIds: ['leaf-sid'] });

  const watcher = new OrchWatcher();
  const { deps, activeSessions } = makeHarness();
  activeSessions.add('leaf-sid'); // the leaf's worker is alive

  const spawner = new OrchSpawner({ watcher, deps, staleGraceMs: 0 });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project); // records stale-since (grace 0)
    await spawner.reconcile(project); // past grace -> would act
    assert.equal(proto.readTask(project, run.id, 'C-1').status, 'in_progress'); // chunk untouched
    assert.equal(proto.readTask(project, run.id, 'T-1').status, 'in_progress'); // live leaf untouched
  } finally { spawner.stop?.(); watcher.dispose(); }
});

test('chunks (in_progress) do not occupy worker slots or files — leaves still dispatch', async () => {
  // Regression: chunks sit at in_progress while their leaves run AND carry the
  // union of their children's filesHint. They must NOT (a) count against the
  // worker cap nor (b) occupy files, or every leaf overlaps its own parent and
  // the worker pool saturates on chunks → run deadlocks at 0 workers spawned.
  const project = tmpProject();
  const run = makeActiveRun(project); // worker maxConcurrent = 2
  // Two chunks in_progress, each sharing its leaf's single file.
  proto.writeTask(project, run.id, { id: 'C-01', title: 'c1', status: 'in_progress', kind: 'chunk', filesHint: ['a.md'] });
  proto.writeTask(project, run.id, { id: 'C-02', title: 'c2', status: 'in_progress', kind: 'chunk', filesHint: ['b.md'] });
  proto.writeTask(project, run.id, { id: 'T-101', title: 'l1', status: 'ready', kind: 'leaf', parent: 'C-01', filesHint: ['a.md'] });
  proto.writeTask(project, run.id, { id: 'T-201', title: 'l2', status: 'ready', kind: 'leaf', parent: 'C-02', filesHint: ['b.md'] });

  const watcher = new OrchWatcher();
  const { calls, deps } = makeHarness();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    const dispatched = calls.openTerminal.map(c => c.opts.initialPrompt).sort();
    assert.equal(calls.openTerminal.length, 2, 'both leaves dispatched despite in_progress chunks');
    assert.deepEqual(dispatched, [`/sb-work ${run.id} T-101`, `/sb-work ${run.id} T-201`]);
    assert.equal(proto.readTask(project, run.id, 'T-101').status, 'in_progress');
    assert.equal(proto.readTask(project, run.id, 'T-201').status, 'in_progress');
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('two ready leaves sharing a file: only one dispatches at a time (real overlap still enforced)', async () => {
  // The leaf-only file-occupancy must still prevent two LEAVES on the same file.
  const project = tmpProject();
  const run = makeActiveRun(project);
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf', filesHint: ['shared.md'] });
  proto.writeTask(project, run.id, { id: 'T-2', title: 'b', status: 'ready', kind: 'leaf', filesHint: ['shared.md'] });

  const watcher = new OrchWatcher();
  const { calls, deps } = makeHarness();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(calls.openTerminal.length, 1, 'second leaf deferred — same file');
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});
