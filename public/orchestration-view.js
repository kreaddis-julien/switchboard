// orchestration-view.js — Agent Teams GUI: run list (sidebar), run detail
// (board / plan / timeline) in the main area, and the new-run dialog.
//
// All state comes from main via window.api.orchestration; this file never
// makes orchestration decisions — even human overrides (approve, retry,
// pause) round-trip through the same file protocol the agents use.
//
// DOM is built with createElement/textContent throughout: task titles,
// plan content and event text are agent-written and must never reach
// innerHTML unsanitised (renderer-innerhtml-lint enforces this).

/* global escapeHtml, safeSetHtml, formatDate, openSession, cachedProjects, activeTab */

let orchState = {};            // projectPath → snapshot from main
let orchSelected = null;       // { projectPath, runId }
let orchDetail = null;         // last orch:get-run payload for the selection
let orchDetailTab = 'overview'; // overview | board | plan | timeline
let orchRefreshTimer = null;
let orchInitDone = false;
let orchProfiles = [];          // [{id,name}] cached for label lookup

const COMPLEXITY_ORDER = ['trivial', 'low', 'medium', 'high', 'critical'];

function profileLabel(id) {
  if (!id) return 'default';
  const p = orchProfiles.find(x => x.id === id);
  return p ? p.name : id;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

// "12.3k tok" or "12.3k tok · $0.41" when real cost is present.
function fmtUsage(u) {
  if (!u || !u.found) return '';
  const out = `${fmtTokens(u.outputTokens)} out / ${fmtTokens(u.inputTokens)} in`;
  return u.hasCost ? `${out} · $${u.costUSD.toFixed(2)}` : out;
}

// Mirror orch-protocol resolveProfile so the board can show which model a
// task will actually run on (explicit override → complexity tier → role).
function resolveTaskProfile(run, task, role) {
  if (!run) return null;
  const tierName = COMPLEXITY_ORDER.includes(task?.complexity) ? task.complexity : 'medium';
  const tier = run.tiers && run.tiers[tierName];
  if (role === 'reviewer') {
    return (task && task.reviewerProfileId) || (tier && tier.reviewerProfileId) || run.roles?.reviewer?.profileId || null;
  }
  return (task && task.profileId) || (tier && tier.profileId) || run.roles?.worker?.profileId || null;
}

const ORCH_BOARD_COLUMNS = [
  { key: 'backlog',  label: 'Backlog',     statuses: ['draft'] },
  { key: 'ready',    label: 'Ready',       statuses: ['ready'] },
  { key: 'progress', label: 'In progress', statuses: ['spawning', 'in_progress'] },
  { key: 'review',   label: 'Review',      statuses: ['needs_review', 'reviewing', 'changes_requested'] },
  { key: 'merge',    label: 'Merge',       statuses: ['approved', 'merging'] },
  { key: 'done',     label: 'Done',        statuses: ['done'] },
  { key: 'attention', label: 'Attention',  statuses: ['blocked', 'failed'] },
];

// Overview (dashboard) groups — urgent/active first, terminal states last.
// `tone` maps to a semantic token (--<tone>) for the group dot.
const ORCH_OVERVIEW_GROUPS = [
  { key: 'attention', label: 'Attention',   statuses: ['blocked', 'failed'], tone: 'err' },
  { key: 'running',   label: 'Running',     statuses: ['spawning', 'in_progress'], tone: 'ok' },
  { key: 'review',    label: 'Review',      statuses: ['needs_review', 'reviewing', 'changes_requested'], tone: 'mauve' },
  { key: 'merge',     label: 'Merge',       statuses: ['approved', 'merging'], tone: 'amber' },
  { key: 'ready',     label: 'Ready',       statuses: ['ready'], tone: 'info' },
  { key: 'backlog',   label: 'Backlog',     statuses: ['draft'], tone: 'muted' },
  { key: 'done',      label: 'Done',        statuses: ['done'], tone: 'ok' },
];

const ORCH_DETAIL_TABS = [
  { key: 'overview', label: 'Aperçu' },
  { key: 'board',    label: 'Board' },
  { key: 'plan',     label: 'Plan' },
  { key: 'timeline', label: 'Timeline' },
];

const ORCH_STATUS_LABELS = {
  draft: 'draft', ready: 'ready', spawning: 'spawning', in_progress: 'in progress',
  needs_review: 'needs review', reviewing: 'reviewing', changes_requested: 'changes requested',
  approved: 'approved', merging: 'merging', done: 'done', blocked: 'blocked', failed: 'failed',
};

// Actions a human may take per status (must mirror TASK_ACTIONS in orch-ipc.js).
const ORCH_TASK_ACTIONS = {
  draft: [{ action: 'to-ready', label: 'Mark ready' }],
  needs_review: [{ action: 'approve', label: 'Approve (skip review)' }],
  reviewing: [{ action: 'approve', label: 'Force approve' }, { action: 'request-changes', label: 'Request changes' }],
  approved: [{ action: 'mark-done', label: 'Mark done (skip merge)' }],
  blocked: [{ action: 'retry', label: 'Retry' }],
  failed: [{ action: 'retry', label: 'Retry' }],
};

function initOrchestration() {
  if (orchInitDone || !window.api?.orchestration) return;
  orchInitDone = true;
  window.api.orchestration.onUpdated((state) => {
    orchState = state || {};
    if (typeof activeTab !== 'undefined' && activeTab === 'teams') {
      renderTeamsSidebar();
      scheduleOrchDetailRefresh();
    }
  });
}

async function loadTeams() {
  initOrchestration();
  try { orchProfiles = (await window.api.profiles.list())?.profiles || []; } catch {}
  const projectPaths = (typeof cachedProjects !== 'undefined' ? cachedProjects : [])
    .map(p => p.projectPath).filter(Boolean);
  try {
    const res = await window.api.orchestration.watchProjects(projectPaths);
    if (res?.ok) orchState = res.state || {};
  } catch (err) {
    window.api.log?.error('orch watchProjects failed', { err: String(err) });
  }
  renderTeamsSidebar();
  showOrchViewer();
  if (orchSelected) {
    refreshOrchDetail();
  } else {
    renderOrchPlaceholder();
  }
}

function orchAllRuns() {
  const out = [];
  for (const [projectPath, snap] of Object.entries(orchState)) {
    for (const entry of snap.runs || []) out.push({ projectPath, ...entry });
  }
  out.sort((a, b) => (b.run.createdAt || '').localeCompare(a.run.createdAt || ''));
  return out;
}

function orchProjectLabel(projectPath) {
  const parts = String(projectPath).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || projectPath;
}

// --- sidebar -------------------------------------------------------------

function renderTeamsSidebar() {
  const pane = document.getElementById('teams-content');
  if (!pane) return;
  pane.replaceChildren();

  const newBtn = document.createElement('button');
  newBtn.id = 'orch-new-run-btn';
  newBtn.textContent = '+ New run';
  newBtn.addEventListener('click', showNewRunDialog);
  pane.appendChild(newBtn);

  const runs = orchAllRuns();
  if (runs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No Agent Teams runs yet. Start one with "+ New run".';
    pane.appendChild(empty);
    return;
  }

  let lastProject = null;
  for (const entry of runs) {
    if (entry.projectPath !== lastProject) {
      lastProject = entry.projectPath;
      const head = document.createElement('div');
      head.className = 'orch-run-project';
      head.textContent = orchProjectLabel(entry.projectPath);
      head.title = entry.projectPath;
      pane.appendChild(head);
    }
    pane.appendChild(buildRunRow(entry));
  }
}

function buildRunRow({ projectPath, run, summary }) {
  const row = document.createElement('div');
  row.className = 'orch-run-row';
  row.dataset.runId = run.id;
  if (orchSelected && orchSelected.runId === run.id && orchSelected.projectPath === projectPath) {
    row.classList.add('active');
  }

  const title = document.createElement('div');
  title.className = 'orch-run-title';
  title.textContent = run.title;
  row.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'orch-run-meta';
  const chip = document.createElement('span');
  chip.className = `orch-chip orch-run-status-${run.status}`;
  chip.textContent = run.status;
  meta.appendChild(chip);
  const progress = document.createElement('span');
  progress.className = 'orch-run-progress';
  progress.textContent = summary ? `${summary.leavesDone}/${summary.leaves} tasks` : '';
  meta.appendChild(progress);
  row.appendChild(meta);

  // Hover-revealed delete control. stopPropagation so it doesn't select the row.
  const del = document.createElement('button');
  del.className = 'orch-run-delete';
  del.textContent = '×';
  del.title = 'Delete run';
  del.setAttribute('aria-label', `Delete run ${run.title}`);
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    orchDeleteRun(projectPath, run.id, run.title);
  });
  row.appendChild(del);

  row.addEventListener('click', () => {
    orchSelected = { projectPath, runId: run.id };
    renderTeamsSidebar();
    refreshOrchDetail();
  });
  return row;
}

// --- main viewer ---------------------------------------------------------

function showOrchViewer() {
  const orchViewer = document.getElementById('orch-viewer');
  if (!orchViewer) return;
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  planViewer.style.display = 'none';
  statsViewer.style.display = 'none';
  memoryViewer.style.display = 'none';
  settingsViewer.style.display = 'none';
  jsonlViewer.style.display = 'none';
  orchViewer.style.display = 'flex';
}

function hideOrchViewer() {
  const orchViewer = document.getElementById('orch-viewer');
  if (orchViewer) orchViewer.style.display = 'none';
}

function renderOrchPlaceholder() {
  const body = document.getElementById('orch-viewer-body');
  if (!body) return;
  body.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'plans-empty';
  empty.textContent = 'Select a run from the sidebar, or create a new one.';
  body.appendChild(empty);
  const header = document.getElementById('orch-viewer-header');
  if (header) header.replaceChildren();
}

function scheduleOrchDetailRefresh() {
  if (!orchSelected || orchRefreshTimer) return;
  orchRefreshTimer = setTimeout(() => {
    orchRefreshTimer = null;
    refreshOrchDetail();
  }, 250);
}

async function refreshOrchDetail() {
  if (!orchSelected) return;
  const { projectPath, runId } = orchSelected;
  let res;
  try {
    res = await window.api.orchestration.getRun(projectPath, runId);
  } catch { return; }
  if (!res?.ok) return;
  orchDetail = res;
  renderOrchDetail();
}

function renderOrchDetail() {
  if (!orchDetail || (typeof activeTab !== 'undefined' && activeTab !== 'teams')) return;
  renderOrchHeader();
  const body = document.getElementById('orch-viewer-body');
  if (!body) return;
  body.replaceChildren();
  body.appendChild(buildOrchTabs());
  const content = document.createElement('div');
  content.className = 'orch-tab-content';
  if (orchDetailTab === 'overview') content.appendChild(buildOrchOverview());
  else if (orchDetailTab === 'board') content.appendChild(buildOrchBoard());
  else if (orchDetailTab === 'plan') content.appendChild(buildOrchPlan());
  else content.appendChild(buildOrchTimeline());
  body.appendChild(content);
}

// Overview: tasks grouped by status category. Non-empty groups render as
// sections of rows (urgent/active first); empty groups collapse into a single
// muted summary line, so the common "few tasks" case stays compact.
function buildOrchOverview() {
  const wrap = document.createElement('div');
  wrap.className = 'orch-overview';
  const tasks = orchDetail.tasks.filter(t => (t.kind || 'leaf') === 'leaf');

  if (tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = orchDetail.run.status === 'planning'
      ? 'Le master planifie — les tâches apparaîtront après /sb-decompose.'
      : 'Aucune tâche pour ce run.';
    wrap.appendChild(empty);
    return wrap;
  }

  const emptyGroups = [];
  for (const g of ORCH_OVERVIEW_GROUPS) {
    const groupTasks = tasks
      .filter(t => g.statuses.includes(t.status))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (groupTasks.length === 0) { emptyGroups.push(g); continue; }

    const section = document.createElement('div');
    section.className = 'orch-ov-group';
    const head = document.createElement('div');
    head.className = 'orch-ov-group-head';
    const dot = document.createElement('span');
    dot.className = 'orch-ov-dot';
    dot.style.background = `var(--${g.tone === 'muted' ? 'sb-fg-faint' : g.tone})`;
    head.appendChild(dot);
    const lbl = document.createElement('span');
    lbl.className = 'orch-ov-group-label';
    lbl.textContent = g.label;
    head.appendChild(lbl);
    const count = document.createElement('span');
    count.className = 'orch-ov-group-count';
    count.textContent = String(groupTasks.length);
    head.appendChild(count);
    section.appendChild(head);
    for (const t of groupTasks) section.appendChild(buildOrchTaskRow(t));
    wrap.appendChild(section);
  }

  if (emptyGroups.length) {
    const summary = document.createElement('div');
    summary.className = 'orch-ov-empty-summary';
    summary.textContent = emptyGroups.map(g => `${g.label} 0`).join('  ·  ');
    wrap.appendChild(summary);
  }
  return wrap;
}

// One task as a row (overview). Reuses the same handlers as the board cards.
function buildOrchTaskRow(task) {
  const row = document.createElement('div');
  row.className = `orch-ov-row orch-card-${task.status}`;
  row.dataset.taskId = task.id;

  const dot = document.createElement('span');
  dot.className = `orch-ov-rowdot orch-status-${task.status}`;
  row.appendChild(dot);

  const main = document.createElement('div');
  main.className = 'orch-ov-main';
  const line = document.createElement('div');
  line.className = 'orch-ov-line';
  const id = document.createElement('span');
  id.className = 'orch-ov-id';
  id.textContent = task.id;
  line.appendChild(id);
  const ttl = document.createElement('span');
  ttl.className = 'orch-ov-title';
  ttl.textContent = task.title;
  line.appendChild(ttl);
  main.appendChild(line);

  // Sub-line: complexity → model, attempts, blockedReason, cost, lens verdicts.
  const sub = document.createElement('div');
  sub.className = 'orch-ov-sub';
  const complexity = COMPLEXITY_ORDER.includes(task.complexity) ? task.complexity : 'medium';
  const cx = document.createElement('span');
  cx.className = `orch-cx orch-cx-${complexity}`;
  cx.textContent = complexity;
  sub.appendChild(cx);
  const model = document.createElement('span');
  model.className = 'orch-ov-model';
  model.textContent = '→ ' + profileLabel(resolveTaskProfile(orchDetail.run, task, 'worker'));
  sub.appendChild(model);
  const bits = [];
  if (task.attempts) bits.push(`attempt ${task.attempts}`);
  if (task.blockedReason) bits.push(task.blockedReason);
  const u = orchDetail.cost && orchDetail.cost.byTask && orchDetail.cost.byTask[task.id];
  if (u && u.found) bits.push(fmtUsage(u));
  if (bits.length) {
    const extra = document.createElement('span');
    extra.className = 'orch-ov-extra';
    extra.textContent = '· ' + bits.join(' · ');
    sub.appendChild(extra);
  }
  // Per-lens review verdicts / pending lenses.
  const latestRound = Math.max(0, ...(task.reviews || []).map(r => r.round || 0));
  const lensReviews = (task.reviews || []).filter(r => r.lens && (latestRound === 0 || r.round === latestRound));
  for (const r of lensReviews) {
    const lc = document.createElement('span');
    lc.className = `orch-lens orch-lens-${r.verdict === 'approved' ? 'ok' : 'bad'}`;
    lc.textContent = `${r.lens} ${r.verdict === 'approved' ? '✓' : '✗'}`;
    sub.appendChild(lc);
  }
  for (const lens of (task.pendingLenses || [])) {
    if (lensReviews.some(r => r.lens === lens)) continue;
    const lc = document.createElement('span');
    lc.className = 'orch-lens orch-lens-pending';
    lc.textContent = `${lens} …`;
    sub.appendChild(lc);
  }
  main.appendChild(sub);
  row.appendChild(main);

  // Actions — session/file links + human overrides. Compact, right-aligned.
  const acts = document.createElement('div');
  acts.className = 'orch-ov-actions';
  const lastWorker = (task.sessionIds || []).slice(-1)[0];
  if (lastWorker) acts.appendChild(orchRowBtn('Worker', () => orchOpenSession(lastWorker, `${task.id} worker`)));
  const lastReviewer = (task.reviewSessionIds || []).slice(-1)[0];
  if (lastReviewer) acts.appendChild(orchRowBtn('Reviewer', () => orchOpenSession(lastReviewer, `${task.id} reviewer`)));
  acts.appendChild(orchRowBtn('Spec', () => orchShowTaskFile(task.id, 'spec', `${task.id} spec`)));
  const lastReview = (task.reviews || []).slice(-1)[0];
  if (lastReview?.file) acts.appendChild(orchRowBtn('Review', () => orchShowTaskFile(task.id, lastReview.file, `${task.id} review`)));
  for (const { action, label } of ORCH_TASK_ACTIONS[task.status] || []) {
    acts.appendChild(orchRowBtn(label, () => orchTaskAction(task.id, action), 'orch-card-action-primary'));
  }
  row.appendChild(acts);
  return row;
}

function orchRowBtn(label, onClick, extraClass) {
  const b = document.createElement('button');
  b.className = 'orch-ov-btn' + (extraClass ? ` ${extraClass}` : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function renderOrchHeader() {
  const header = document.getElementById('orch-viewer-header');
  if (!header) return;
  const { run } = orchDetail;
  header.replaceChildren();

  // --- Row 1: title + status (left) · run actions (right) ------------------
  const top = document.createElement('div');
  top.className = 'orch-dash-top';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'orch-dash-titlewrap';
  const title = document.createElement('span');
  title.id = 'orch-viewer-title';
  title.textContent = run.title;
  titleWrap.appendChild(title);
  const chip = document.createElement('span');
  chip.className = `orch-chip orch-run-status-${run.status}`;
  chip.textContent = run.status;
  titleWrap.appendChild(chip);
  // Malformed task files (bad agent writes) must stay loudly visible.
  if (orchDetail.invalid?.length) {
    const warn = document.createElement('span');
    warn.className = 'orch-invalid-warning';
    warn.textContent = `⚠ ${orchDetail.invalid.length} invalid task file${orchDetail.invalid.length > 1 ? 's' : ''}`;
    warn.title = orchDetail.invalid.map(i => `${i.file}: ${i.error}`).join('\n');
    titleWrap.appendChild(warn);
  }
  top.appendChild(titleWrap);

  const actions = document.createElement('div');
  actions.className = 'orch-dash-actions';
  if (run.masterSessionId) {
    const masterBtn = document.createElement('button');
    masterBtn.className = 'orch-action-btn';
    masterBtn.textContent = 'Master session';
    masterBtn.addEventListener('click', () => orchOpenSession(run.masterSessionId, `${run.title} (master)`));
    actions.appendChild(masterBtn);
  }
  if (['active', 'planning'].includes(run.status)) {
    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'orch-action-btn';
    pauseBtn.textContent = 'Pause';
    pauseBtn.addEventListener('click', () => orchRunAction('pause'));
    actions.appendChild(pauseBtn);
  } else if (run.status === 'paused') {
    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'orch-action-btn';
    resumeBtn.textContent = 'Resume';
    resumeBtn.addEventListener('click', () => orchRunAction('resume'));
    actions.appendChild(resumeBtn);
  }
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'orch-action-btn orch-danger-btn';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => orchDeleteRun(orchSelected.projectPath, run.id, run.title));
  actions.appendChild(deleteBtn);
  top.appendChild(actions);
  header.appendChild(top);

  // --- Row 2: progress bar · cost/budget · role+tier roster ----------------
  header.appendChild(buildOrchStats());
}

// Progress + spend + roster strip beneath the title.
function buildOrchStats() {
  const { run, summary } = orchDetail;
  const stats = document.createElement('div');
  stats.className = 'orch-dash-stats';

  const done = summary ? summary.leavesDone : 0;
  const total = summary ? summary.leaves : 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const prog = document.createElement('div');
  prog.className = 'orch-progress';
  const bar = document.createElement('div');
  bar.className = 'orch-progress-bar';
  const fill = document.createElement('div');
  fill.className = 'orch-progress-fill';
  fill.style.width = `${pct}%`;
  if (done === total && total > 0) fill.classList.add('complete');
  bar.appendChild(fill);
  prog.appendChild(bar);
  const label = document.createElement('span');
  label.className = 'orch-progress-label';
  label.textContent = `${done}/${total} tâches`;
  prog.appendChild(label);
  stats.appendChild(prog);

  const meta = document.createElement('div');
  meta.className = 'orch-dash-meta';

  // Spend / budget — always show a token figure when known; cost when present.
  const cost = orchDetail.cost && orchDetail.cost.run;
  if (cost && cost.found) {
    const spend = document.createElement('span');
    spend.className = 'orch-stat orch-stat-spend';
    let txt = fmtUsage(cost);
    if (run.policy && (run.policy.maxBudgetUsd || run.policy.maxOutputTokens)) {
      const cap = run.policy.maxBudgetUsd ? `$${run.policy.maxBudgetUsd}` : `${fmtTokens(run.policy.maxOutputTokens)} tok`;
      txt += ` / ${cap}`;
    }
    spend.textContent = txt;
    meta.appendChild(spend);
  }

  // role → profile roster, e.g. "master opus · worker ×6 deepseek"
  const roles = document.createElement('span');
  roles.className = 'orch-stat orch-stat-roles';
  roles.textContent = Object.entries(run.roles || {})
    .map(([role, cfg]) => `${role}${cfg.maxConcurrent > 1 ? ` ×${cfg.maxConcurrent}` : ''} ${profileLabel(cfg.profileId)}`)
    .join(' · ');
  meta.appendChild(roles);

  if (run.tiers && Object.keys(run.tiers).length) {
    const tiers = document.createElement('span');
    tiers.className = 'orch-stat orch-stat-tiers';
    tiers.textContent = 'tiers — ' + COMPLEXITY_ORDER
      .filter(cx => run.tiers[cx])
      .map(cx => {
        const t = run.tiers[cx];
        return `${cx} ${profileLabel(t.profileId)}${t.maxConcurrent ? ` ×${t.maxConcurrent}` : ''}`;
      })
      .join(' · ');
    meta.appendChild(tiers);
  }
  stats.appendChild(meta);
  return stats;
}

// Tab strip rendered at the top of the body so it survives tab switches.
function buildOrchTabs() {
  const bar = document.createElement('div');
  bar.className = 'orch-tabbar';
  for (const { key, label } of ORCH_DETAIL_TABS) {
    const btn = document.createElement('button');
    btn.className = 'orch-tab-btn' + (orchDetailTab === key ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => { orchDetailTab = key; renderOrchDetail(); });
    bar.appendChild(btn);
  }
  return bar;
}

async function orchRunAction(action) {
  if (!orchSelected) return;
  await window.api.orchestration.runAction(orchSelected.projectPath, orchSelected.runId, action);
  refreshOrchDetail();
}

async function orchTaskAction(taskId, action) {
  if (!orchSelected) return;
  const res = await window.api.orchestration.taskAction(orchSelected.projectPath, orchSelected.runId, taskId, action);
  if (!res?.ok && res?.error && typeof setStatus === 'function') setStatus(res.error, 'error');
  refreshOrchDetail();
}

function orchOpenSession(sessionId, label) {
  if (!orchSelected || typeof openSession !== 'function') return;
  // Switch to the sessions tab so the terminal area is visible, then open.
  const sessionsTab = document.querySelector('.sidebar-tab[data-tab="sessions"]');
  if (sessionsTab && typeof activeTab !== 'undefined' && activeTab !== 'sessions') sessionsTab.click();
  openSession({ sessionId, projectPath: orchSelected.projectPath, summary: label || sessionId });
}

// --- board ---------------------------------------------------------------

function buildOrchBoard() {
  const board = document.createElement('div');
  board.id = 'orch-board';
  const tasks = orchDetail.tasks.filter(t => (t.kind || 'leaf') === 'leaf');
  for (const col of ORCH_BOARD_COLUMNS) {
    const colEl = document.createElement('div');
    colEl.className = 'orch-board-col';
    colEl.dataset.col = col.key;
    const head = document.createElement('div');
    head.className = 'orch-board-col-head';
    const colTasks = tasks.filter(t => col.statuses.includes(t.status));
    head.textContent = `${col.label} (${colTasks.length})`;
    colEl.appendChild(head);
    for (const task of colTasks) colEl.appendChild(buildOrchCard(task));
    board.appendChild(colEl);
  }
  return board;
}

function buildOrchCard(task) {
  const card = document.createElement('div');
  card.className = `orch-card orch-card-${task.status}`;
  card.dataset.taskId = task.id;

  const head = document.createElement('div');
  head.className = 'orch-card-head';
  const id = document.createElement('span');
  id.className = 'orch-card-id';
  id.textContent = task.id;
  head.appendChild(id);
  const status = document.createElement('span');
  status.className = `orch-chip orch-status-${task.status}`;
  status.textContent = ORCH_STATUS_LABELS[task.status] || task.status;
  head.appendChild(status);
  card.appendChild(head);

  const title = document.createElement('div');
  title.className = 'orch-card-title';
  title.textContent = task.title;
  card.appendChild(title);

  // Complexity + the model it resolves to — so cost routing is visible at a
  // glance ("trivial → qwen-local", "critical → opus").
  const tier = document.createElement('div');
  tier.className = 'orch-card-tier';
  const complexity = COMPLEXITY_ORDER.includes(task.complexity) ? task.complexity : 'medium';
  const cx = document.createElement('span');
  cx.className = `orch-cx orch-cx-${complexity}`;
  cx.textContent = complexity;
  tier.appendChild(cx);
  const model = document.createElement('span');
  model.className = 'orch-card-model';
  model.textContent = '→ ' + profileLabel(resolveTaskProfile(orchDetail.run, task, 'worker'));
  tier.appendChild(model);
  card.appendChild(tier);

  const meta = document.createElement('div');
  meta.className = 'orch-card-meta';
  const bits = [];
  if (task.parent) bits.push(task.parent);
  if (task.attempts) bits.push(`attempt ${task.attempts}`);
  if (task.blockedReason) bits.push(task.blockedReason);
  const u = orchDetail.cost && orchDetail.cost.byTask && orchDetail.cost.byTask[task.id];
  if (u && u.found) bits.push(fmtUsage(u));
  meta.textContent = bits.join(' · ');
  card.appendChild(meta);

  // Per-lens review verdicts (multi-lens), or pending lenses while reviewing.
  const latestRound = Math.max(0, ...(task.reviews || []).map(r => r.round || 0));
  const lensReviews = (task.reviews || []).filter(r => r.lens && (latestRound === 0 || r.round === latestRound));
  if (lensReviews.length || (task.pendingLenses || []).length) {
    const lensRow = document.createElement('div');
    lensRow.className = 'orch-card-lenses';
    for (const r of lensReviews) {
      const chip = document.createElement('span');
      chip.className = `orch-lens orch-lens-${r.verdict === 'approved' ? 'ok' : 'bad'}`;
      chip.textContent = `${r.lens} ${r.verdict === 'approved' ? '✓' : '✗'}`;
      lensRow.appendChild(chip);
    }
    for (const lens of (task.pendingLenses || [])) {
      if (lensReviews.some(r => r.lens === lens)) continue;
      const chip = document.createElement('span');
      chip.className = 'orch-lens orch-lens-pending';
      chip.textContent = `${lens} …`;
      lensRow.appendChild(chip);
    }
    card.appendChild(lensRow);
  }

  const actions = document.createElement('div');
  actions.className = 'orch-card-actions';
  const lastWorker = (task.sessionIds || []).slice(-1)[0];
  if (lastWorker) {
    const btn = document.createElement('button');
    btn.textContent = 'Worker';
    btn.title = 'Open the worker session terminal';
    btn.addEventListener('click', () => orchOpenSession(lastWorker, `${task.id} worker`));
    actions.appendChild(btn);
  }
  const lastReviewer = (task.reviewSessionIds || []).slice(-1)[0];
  if (lastReviewer) {
    const btn = document.createElement('button');
    btn.textContent = 'Reviewer';
    btn.title = 'Open the reviewer session terminal';
    btn.addEventListener('click', () => orchOpenSession(lastReviewer, `${task.id} reviewer`));
    actions.appendChild(btn);
  }
  const specBtn = document.createElement('button');
  specBtn.textContent = 'Spec';
  specBtn.addEventListener('click', () => orchShowTaskFile(task.id, 'spec', `${task.id} spec`));
  actions.appendChild(specBtn);
  const lastReview = (task.reviews || []).slice(-1)[0];
  if (lastReview?.file) {
    const btn = document.createElement('button');
    btn.textContent = 'Review';
    btn.addEventListener('click', () => orchShowTaskFile(task.id, lastReview.file, `${task.id} review`));
    actions.appendChild(btn);
  }
  for (const { action, label } of ORCH_TASK_ACTIONS[task.status] || []) {
    const btn = document.createElement('button');
    btn.className = 'orch-card-action-primary';
    btn.textContent = label;
    btn.addEventListener('click', () => orchTaskAction(task.id, action));
    actions.appendChild(btn);
  }
  card.appendChild(actions);
  return card;
}

async function orchShowTaskFile(taskId, which, label) {
  if (!orchSelected) return;
  const res = await window.api.orchestration.readTaskFile(
    orchSelected.projectPath, orchSelected.runId, taskId, which);
  showOrchTextModal(label, res?.ok ? res.content : `(${res?.error || 'not found'})`);
}

function showOrchTextModal(title, text) {
  const overlay = document.createElement('div');
  overlay.className = 'orch-modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'orch-modal';
  const head = document.createElement('div');
  head.className = 'orch-modal-head';
  const titleEl = document.createElement('span');
  titleEl.textContent = title;
  head.appendChild(titleEl);
  const close = document.createElement('button');
  close.textContent = '×';
  close.addEventListener('click', () => overlay.remove());
  head.appendChild(close);
  modal.appendChild(head);
  const body = document.createElement('pre');
  body.className = 'orch-modal-body';
  body.textContent = text;
  modal.appendChild(body);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// In-app confirm (no native dialog) reusing the orch-modal styling. Resolves
// true on confirm, false on cancel / overlay click / Escape.
function showOrchConfirm(title, message, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'orch-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'orch-modal orch-confirm-modal';
    const head = document.createElement('div');
    head.className = 'orch-modal-head';
    const titleEl = document.createElement('span');
    titleEl.textContent = title;
    head.appendChild(titleEl);
    modal.appendChild(head);
    const body = document.createElement('div');
    body.className = 'orch-modal-body';
    body.textContent = message;
    modal.appendChild(body);
    const actions = document.createElement('div');
    actions.className = 'orch-confirm-actions';
    const close = (val) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const cancel = document.createElement('button');
    cancel.className = 'orch-action-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => close(false));
    const confirm = document.createElement('button');
    confirm.className = 'orch-action-btn orch-danger-btn';
    confirm.textContent = confirmLabel;
    confirm.addEventListener('click', () => close(true));
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    confirm.focus();
  });
}

async function orchDeleteRun(projectPath, runId, title) {
  const ok = await showOrchConfirm(
    'Delete run',
    `Delete "${title}" and its worktrees, session transcripts and run files? This cannot be undone.`,
    'Delete run',
  );
  if (!ok) return;
  const res = await window.api.orchestration.deleteRun(projectPath, runId);
  if (!res?.ok) {
    if (typeof setStatus === 'function') setStatus(res?.error || 'delete failed', 'error');
    else showOrchTextModal('Delete failed', res?.error || 'unknown error');
    return;
  }
  if (orchSelected && orchSelected.projectPath === projectPath && orchSelected.runId === runId) {
    orchSelected = null;
    renderOrchPlaceholder();
  }
  // Drop it locally for instant feedback; the watcher push will reconcile.
  const snap = orchState[projectPath];
  if (snap && Array.isArray(snap.runs)) snap.runs = snap.runs.filter(r => r.run.id !== runId);
  renderTeamsSidebar();
}

// --- plan tab ------------------------------------------------------------

function buildOrchPlan() {
  const wrap = document.createElement('div');
  wrap.id = 'orch-plan';

  const tree = document.createElement('div');
  tree.id = 'orch-plan-tree';
  const tasks = orchDetail.tasks;
  const byParent = new Map();
  for (const t of tasks) {
    const key = t.parent || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(t);
  }
  const addNodes = (parentKey, depth) => {
    for (const t of byParent.get(parentKey) || []) {
      const node = document.createElement('div');
      node.className = 'orch-tree-node';
      node.style.paddingLeft = `${depth * 18}px`;
      const dot = document.createElement('span');
      dot.className = `orch-tree-dot orch-status-${t.status}`;
      node.appendChild(dot);
      const label = document.createElement('span');
      label.className = 'orch-tree-label';
      label.textContent = `${t.id} — ${t.title}`;
      node.appendChild(label);
      const st = document.createElement('span');
      st.className = 'orch-tree-status';
      st.textContent = ORCH_STATUS_LABELS[t.status] || t.status;
      node.appendChild(st);
      tree.appendChild(node);
      addNodes(t.id, depth + 1);
    }
  };
  addNodes('', 0);
  if (tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No tasks yet — the master is still planning.';
    tree.appendChild(empty);
  }
  wrap.appendChild(tree);

  const planEl = document.createElement('div');
  planEl.id = 'orch-plan-md';
  if (orchDetail.plan) {
    // plan.md is agent-written markdown → sanitize before rendering.
    if (window.marked && window.DOMPurify) {
      safeSetHtml(planEl, window.marked.parse(orchDetail.plan));
    } else {
      const pre = document.createElement('pre');
      pre.textContent = orchDetail.plan;
      planEl.appendChild(pre);
    }
  } else {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'plan.md has not been written yet.';
    planEl.appendChild(empty);
  }
  wrap.appendChild(planEl);
  return wrap;
}

// --- timeline ------------------------------------------------------------

function buildOrchTimeline() {
  const wrap = document.createElement('div');
  wrap.id = 'orch-timeline';
  const events = [...(orchDetail.events || [])].reverse();
  if (events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No events yet.';
    wrap.appendChild(empty);
    return wrap;
  }
  for (const evt of events) {
    const row = document.createElement('div');
    row.className = 'orch-event';
    const ts = document.createElement('span');
    ts.className = 'orch-event-ts';
    ts.textContent = (evt.ts || '').replace('T', ' ').slice(0, 19);
    row.appendChild(ts);
    const type = document.createElement('span');
    type.className = 'orch-event-type';
    type.textContent = evt.type || 'note';
    row.appendChild(type);
    const text = document.createElement('span');
    text.className = 'orch-event-text';
    const bits = [];
    if (evt.task) bits.push(evt.task);
    if (evt.from && evt.to) bits.push(`${evt.from} → ${evt.to}`);
    if (evt.actor) bits.push(`by ${evt.actor}`);
    if (evt.sessionId) bits.push(`session ${String(evt.sessionId).slice(0, 8)}`);
    if (evt.text) bits.push(evt.text);
    if (evt.error) bits.push(evt.error);
    if (evt.lines) bits.push(evt.lines.join('; '));
    text.textContent = bits.join(' · ');
    row.appendChild(text);
    wrap.appendChild(row);
  }
  return wrap;
}

// --- new run dialog -------------------------------------------------------

async function showNewRunDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'orch-modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'orch-modal orch-new-run-modal';

  const head = document.createElement('div');
  head.className = 'orch-modal-head';
  const titleEl = document.createElement('span');
  titleEl.textContent = 'New Agent Teams run';
  head.appendChild(titleEl);
  const close = document.createElement('button');
  close.textContent = '×';
  close.addEventListener('click', () => overlay.remove());
  head.appendChild(close);
  modal.appendChild(head);

  const form = document.createElement('div');
  form.className = 'orch-modal-body orch-form';

  const field = (labelText, input) => {
    const wrap = document.createElement('label');
    wrap.className = 'orch-field';
    const lab = document.createElement('span');
    lab.textContent = labelText;
    wrap.appendChild(lab);
    wrap.appendChild(input);
    form.appendChild(wrap);
    return input;
  };

  const projectSel = document.createElement('select');
  const projects = (typeof cachedProjects !== 'undefined' ? cachedProjects : []);
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.projectPath;
    opt.textContent = p.projectPath;
    projectSel.appendChild(opt);
  }
  field('Project', projectSel);

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'e.g. Auth refactor';
  field('Run title', titleInput);

  const goalInput = document.createElement('textarea');
  goalInput.rows = 5;
  goalInput.placeholder = 'What should be built? The master agent starts from this.';
  field('Goal', goalInput);

  let profiles = [];
  try { profiles = (await window.api.profiles.list())?.profiles || []; } catch {}
  const profileSelect = (defaultHint) => {
    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Default profile';
    sel.appendChild(none);
    for (const p of profiles) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (defaultHint && p.name.toLowerCase().includes(defaultHint)) opt.selected = true;
      sel.appendChild(opt);
    }
    return sel;
  };
  const masterSel = field('Master profile (planner/orchestrator — strongest model)', profileSelect('opus'));
  const workerSel = field('Default worker profile (fallback when no tier matches)', profileSelect('deepseek'));
  const reviewerSel = field('Default reviewer profile (adversarial review)', profileSelect('opus'));

  const workerCount = document.createElement('input');
  workerCount.type = 'number';
  workerCount.min = '1'; workerCount.max = '16'; workerCount.value = '6';
  field('Max parallel workers (global ceiling across all tiers)', workerCount);

  // --- Per-complexity model tiers (cost optimisation) ---
  // Each leaf task is tagged trivial→critical by the planner; here you bind
  // each tier to a model profile and an optional parallelism cap, so cheap
  // tasks run wide on a local/cheap model and hard ones on the strong one.
  const tierWrap = document.createElement('details');
  tierWrap.className = 'orch-tier-editor';
  const tierSummary = document.createElement('summary');
  tierSummary.textContent = 'Model tiers by task complexity (optional — cost control)';
  tierWrap.appendChild(tierSummary);
  const tierHint = document.createElement('div');
  tierHint.className = 'orch-tier-hint';
  tierHint.textContent = 'Leave a tier on "Default worker profile" to fall back. Per-tier max caps run within the global ceiling above.';
  tierWrap.appendChild(tierHint);

  const tierRows = {};
  const TIER_HINTS = { trivial: 'qwen', low: 'deepseek', medium: 'deepseek', high: 'opus', critical: 'opus' };
  for (const cx of COMPLEXITY_ORDER) {
    const row = document.createElement('div');
    row.className = 'orch-tier-row';
    const lab = document.createElement('span');
    lab.className = `orch-cx orch-cx-${cx}`;
    lab.textContent = cx;
    row.appendChild(lab);
    const sel = profileSelect();
    sel.title = `Model for ${cx} tasks`;
    row.appendChild(sel);
    const cap = document.createElement('input');
    cap.type = 'number'; cap.min = '1'; cap.max = '16'; cap.placeholder = 'max';
    cap.className = 'orch-tier-cap';
    cap.title = `Max parallel ${cx} tasks`;
    row.appendChild(cap);
    tierRows[cx] = { sel, cap };
    tierWrap.appendChild(row);
  }
  form.appendChild(tierWrap);

  const isolationSel = document.createElement('select');
  for (const [v, label] of [['worktree', 'Git worktree per task (recommended)'], ['none', 'Shared working dir (no isolation)']]) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = label;
    isolationSel.appendChild(opt);
  }
  field('Isolation', isolationSel);

  // Review rigor: how many lenses each task gets reviewed through.
  const reviewSel = document.createElement('select');
  for (const [v, label] of [
    ['tiered', 'Tiered by complexity (recommended — more lenses for harder tasks)'],
    ['all', 'All lenses every task (spec, functionality, tests, security, style)'],
    ['functionality', 'Single combined review (cheapest)'],
    ['disabled', 'No review (auto-approve — not recommended)'],
  ]) {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = label;
    reviewSel.appendChild(opt);
  }
  field('Review rigor', reviewSel);

  // Phase gate command (deterministic validation before a chunk completes).
  const validateInput = document.createElement('input');
  validateInput.type = 'text';
  validateInput.placeholder = 'e.g. npm test  (run on the integration branch per phase)';
  field('Default phase-gate command (optional)', validateInput);

  // Budget stop-loss.
  const budgetUsd = document.createElement('input');
  budgetUsd.type = 'number'; budgetUsd.min = '0'; budgetUsd.step = '0.5'; budgetUsd.placeholder = 'USD (optional)';
  field('Budget cap — auto-pause at $ (needs provider cost data)', budgetUsd);
  const budgetTok = document.createElement('input');
  budgetTok.type = 'number'; budgetTok.min = '0'; budgetTok.placeholder = 'output tokens (optional)';
  field('Budget cap — auto-pause at output tokens', budgetTok);

  const error = document.createElement('div');
  error.className = 'orch-form-error';
  form.appendChild(error);

  const submit = document.createElement('button');
  submit.className = 'orch-card-action-primary orch-form-submit';
  submit.textContent = 'Create run & start master';
  submit.addEventListener('click', async () => {
    error.textContent = '';
    if (!projectSel.value) { error.textContent = 'No project selected — add a project first.'; return; }
    if (!titleInput.value.trim()) { error.textContent = 'Title is required.'; return; }
    if (!goalInput.value.trim()) { error.textContent = 'Goal is required.'; return; }
    submit.disabled = true;
    submit.textContent = 'Creating…';
    const tiers = {};
    for (const cx of COMPLEXITY_ORDER) {
      const { sel, cap } = tierRows[cx];
      const entry = {};
      if (sel.value) entry.profileId = sel.value;
      const capN = parseInt(cap.value, 10);
      if (Number.isInteger(capN) && capN > 0) entry.maxConcurrent = capN;
      if (Object.keys(entry).length) tiers[cx] = entry;
    }
    let review;
    if (reviewSel.value === 'disabled') review = { enabled: false };
    else if (reviewSel.value === 'all') review = { lenses: ['spec', 'functionality', 'tests', 'security', 'style'] };
    else if (reviewSel.value === 'functionality') review = { lenses: ['functionality'] };
    // 'tiered' → leave review undefined (cost-aware default per complexity)

    const policy = { isolation: isolationSel.value };
    if (validateInput.value.trim()) policy.validateCmd = validateInput.value.trim();
    const usd = parseFloat(budgetUsd.value); if (usd > 0) policy.maxBudgetUsd = usd;
    const tok = parseInt(budgetTok.value, 10); if (tok > 0) policy.maxOutputTokens = tok;

    const res = await window.api.orchestration.createRun(projectSel.value, {
      title: titleInput.value.trim(),
      goal: goalInput.value.trim(),
      roles: {
        master: { profileId: masterSel.value || null },
        worker: { profileId: workerSel.value || null, maxConcurrent: parseInt(workerCount.value, 10) || 6 },
        reviewer: { profileId: reviewerSel.value || null },
      },
      tiers: Object.keys(tiers).length ? tiers : undefined,
      review,
      policy,
    });
    if (!res?.ok) {
      submit.disabled = false;
      submit.textContent = 'Create run & start master';
      error.textContent = res?.error || 'Failed to create run.';
      return;
    }
    overlay.remove();
    orchSelected = { projectPath: projectSel.value, runId: res.run.id };
    await loadTeams();
    // Drop the user straight into the master session terminal.
    orchOpenSession(res.masterSessionId, `${res.run.title} (master)`);
  });
  form.appendChild(submit);

  modal.appendChild(form);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  titleInput.focus();
}
