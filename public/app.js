const statusBarInfo = document.getElementById('status-bar-info');
const statusBarActivity = document.getElementById('status-bar-activity');
const terminalsEl = document.getElementById('terminals');
const sidebarContent = document.getElementById('sidebar-content');
const plansContent = document.getElementById('plans-content');
const placeholder = document.getElementById('placeholder');
const archiveToggle = document.getElementById('archive-toggle');
const starToggle = document.getElementById('star-toggle');
const searchInput = document.getElementById('search-input');
const terminalHeader = document.getElementById('terminal-header');
const terminalHeaderName = document.getElementById('terminal-header-name');
const terminalHeaderId = document.getElementById('terminal-header-id');
const terminalHeaderStatus = document.getElementById('terminal-header-status');
const terminalHeaderShell = document.getElementById('terminal-header-shell');
const terminalStopBtn = document.getElementById('terminal-stop-btn');
const runningToggle = document.getElementById('running-toggle');
const todayToggle = document.getElementById('today-toggle');
const planViewer = document.getElementById('plan-viewer');
const planPanel = new ViewerPanel(planViewer, {
  copyPath: true, copyContent: true,
  language: 'markdown', storageKey: 'markdownPreviewMode',
  onSave: (filePath, content) => window.api.savePlan(filePath, content),
});

// currentPlanContent, currentPlanFilePath, currentPlanFilename → plans-memory-view.js
const loadingStatus = document.getElementById('loading-status');
const sessionFilters = document.getElementById('session-filters');
const searchBar = document.getElementById('search-bar');
const statsContent = document.getElementById('stats-content');
const memoryContent = document.getElementById('memory-content');
const teamsContent = document.getElementById('teams-content');
const statsViewer = document.getElementById('stats-viewer');
const statsViewerBody = document.getElementById('stats-viewer-body');
const memoryViewer = document.getElementById('memory-viewer');
const memoryPanel = new ViewerPanel(memoryViewer, {
  copyPath: true, copyContent: true,
  language: 'markdown', storageKey: 'markdownPreviewMode',
  onSave: (filePath, content) => window.api.saveMemory(filePath, content),
});
const terminalArea = document.getElementById('terminal-area');
const settingsViewer = document.getElementById('settings-viewer');
const globalSettingsBtn = document.getElementById('global-settings-btn');
const addProjectBtn = document.getElementById('add-project-btn');
const resortBtn = document.getElementById('resort-btn');
const refreshCacheBtn = document.getElementById('refresh-cache-btn');
if (refreshCacheBtn) {
  refreshCacheBtn.addEventListener('click', async () => {
    if (refreshCacheBtn.disabled) return;
    refreshCacheBtn.disabled = true;
    refreshCacheBtn.classList.add('refreshing');
    try {
      // Forces a full re-scan: rebuilds the search index and prunes ghost rows
      // for deleted sessions/folders. The scan emits 'projects-changed' on
      // completion, which reloads the sidebar (debounced).
      await window.api.rebuildCache();
      // Re-run the active search so results reflect the fresh index.
      if (searchInput.value.trim()) searchInput.dispatchEvent(new Event('input'));
    } catch (e) {
      console.error('[refresh] rebuild-cache failed', e);
    } finally {
      refreshCacheBtn.disabled = false;
      refreshCacheBtn.classList.remove('refreshing');
    }
  });
}
const jsonlViewer = document.getElementById('jsonl-viewer');
const jsonlViewerTitle = document.getElementById('jsonl-viewer-title');
const jsonlViewerSessionId = document.getElementById('jsonl-viewer-session-id');
const jsonlViewerBody = document.getElementById('jsonl-viewer-body');
const gridViewer = document.getElementById('grid-viewer');
const gridViewerCount = document.getElementById('grid-viewer-count');
let gridViewActive = localStorage.getItem('gridViewActive') === '1';

// Map<sessionId, { terminal, element, fitAddon, session, closed }>
const openSessions = new Map();
window._openSessions = openSessions;
let activeSessionId = sessionStorage.getItem('activeSessionId') || null;
function setActiveSession(id) {
  activeSessionId = id;
  if (id) sessionStorage.setItem('activeSessionId', id);
  else sessionStorage.removeItem('activeSessionId');
  // Tell main which session is focused so it suppresses notifications for it and
  // clears its alerts (notifications are now fired by the main process).
  if (window.api?.setActiveSession) window.api.setActiveSession(id);
  // Update file panel to show this session's open files/diffs
  if (typeof switchPanel === 'function') switchPanel(id);
}
// Persist slug group expand state across reloads
function getExpandedSlugs() {
  try { return new Set(JSON.parse(sessionStorage.getItem('expandedSlugs') || '[]')); } catch { return new Set(); }
}
function saveExpandedSlugs() {
  const expanded = [];
  document.querySelectorAll('.slug-group:not(.collapsed)').forEach(g => { if (g.id) expanded.push(g.id); });
  sessionStorage.setItem('expandedSlugs', JSON.stringify(expanded));
}
let showArchived = false;
let showStarredOnly = false;
let showRunningOnly = false;
let showTodayOnly = false;
let cachedProjects = [];
let cachedAllProjects = [];
let activePtyIds = new Set();
let sortedOrder = []; // [{ projectPath, itemIds: [itemId, ...] }, ...] — single source of truth for sidebar order
let activeTab = 'sessions';
let cachedPlans = [];
let visibleSessionCount = 10;
let sessionMaxAgeDays = 3;
const pendingSessions = new Map(); // sessionId → { session, projectPath, folder }

// Bridge functions for settings-panel.js
window._setVisibleSessionCount = (v) => { visibleSessionCount = v; };
window._setSessionMaxAge = (v) => { sessionMaxAgeDays = v; };
// Appearance: auto (follow OS / macOS auto), light, or dark. Sets data-theme on
// <html>; style.css maps it to the light/dark token sets. Mirrored to
// localStorage so the inline <head> script can apply it before first paint.
window._applyAppearance = (mode) => {
  const m = (mode === 'light' || mode === 'dark') ? mode : 'auto';
  document.documentElement.dataset.theme = m;
  try { localStorage.setItem('appearance', m); } catch {}
  // If the terminal theme follows the app ('auto'), repaint it for the new appearance.
  if (currentThemeName === 'auto' && typeof window._applyTerminalTheme === 'function') {
    window._applyTerminalTheme('auto');
  }
  // CodeMirror editors (plans/diffs) follow the app appearance too.
  if (typeof window._applyCmTheme === 'function') window._applyCmTheme();
};
// Follow OS light/dark flips for an 'auto' terminal theme when appearance is auto
// (the app's CSS variables flip on their own via the prefers-color-scheme media query).
if (window.matchMedia) {
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      const t = document.documentElement.dataset.theme;
      if ((!t || t === 'auto') && currentThemeName === 'auto' && typeof window._applyTerminalTheme === 'function') {
        window._applyTerminalTheme('auto');
      }
      if ((!t || t === 'auto') && typeof window._applyCmTheme === 'function') window._applyCmTheme();
    });
  } catch {}
}
// Show/hide sidebar tabs (Plans / Agent Files / Stats) from settings. Each key
// defaults to shown unless explicitly false. If the active tab is hidden, fall
// back to the always-visible Sessions tab.
window._applyTabVisibility = (s) => {
  s = s || {};
  const map = { plans: s.showPlansTab !== false, memory: s.showMemoryTab !== false, stats: s.showStatsTab !== false };
  for (const [tab, show] of Object.entries(map)) {
    const btn = document.querySelector(`.sidebar-tab[data-tab="${tab}"]`);
    if (btn) btn.style.display = show ? '' : 'none';
    if (!show && activeTab === tab) {
      const sessionsBtn = document.querySelector('.sidebar-tab[data-tab="sessions"]');
      if (sessionsBtn) sessionsBtn.click();
    }
  }
  // Reglages respectes : le strip d'onglets se masque quand aucun onglet optionnel
  // n'est actif. Le bouton collapse vit TOUJOURS dans la rangee de filtres pour que
  // la pilule d'onglets reste propre (sans bouton parasite) quand elle est visible.
  const anyShown = map.plans || map.memory || map.stats;
  const tabsRow = document.getElementById('sidebar-tabs');
  const filtersRow = document.getElementById('session-filters');
  const collapse = document.getElementById('sidebar-collapse-btn');
  const sessionsTabBtn = document.querySelector('.sidebar-tab[data-tab="sessions"]');
  document.body.classList.toggle('sb-no-tabs', !anyShown);
  if (tabsRow) tabsRow.style.display = anyShown ? '' : 'none';
  if (sessionsTabBtn) sessionsTabBtn.style.display = '';
  if (collapse && filtersRow && collapse.parentElement !== filtersRow) filtersRow.appendChild(collapse);
};
window._applyTerminalTheme = (themeName) => {
  currentThemeName = themeName;
  TERMINAL_THEME = getTerminalTheme();
  for (const [, entry] of openSessions) {
    entry.terminal.options.theme = TERMINAL_THEME;
    entry.element.style.backgroundColor = TERMINAL_THEME.background;
  }
};
let searchMatchIds = null; // null = no search active; Set<string> = matched session IDs
let searchMatchProjectPaths = null; // Set<string> of project paths matched by name

// --- Activity tracking ---
//
// Activity is determined by two signals:
//   1. OSC 0 braille spinner (authoritative: Claude CLI sets title to spinner chars)
//   2. Noise-filtered terminal output (fallback: non-noise, non-TUI-repaint data)
//
// Both feed into setActivity(sessionId, active):
//   active=true  → cli-busy (spinner dot)
//   active=false → response-ready if not focused (terminal state until user clicks)
// OSC 0 idle signal is the authoritative source for marking sessions as idle.
//
const attentionSessions = new Set(); // sessions needing user action (OSC 9)
const responseReadySessions = new Set(); // Claude finished, user hasn't looked (terminal state)
const sessionBusyState = new Map(); // sessionId → boolean (currently active)
const lastActivityTime = new Map(); // sessionId → Date of last terminal output

// Noise patterns — these don't count as activity
const activityNoiseRe = /file-history-snapshot|^\s*$/;

// --- Sound notifications (#66) ---
// Synthesized via Web Audio so no audio assets need bundling. A gentle rising
// chime when a run finishes, a more insistent two-tone when a session needs
// attention (permission / input). Only fires for non-focused sessions, matching
// the visual response-ready / needs-attention signals.
let soundNotificationsEnabled = true;
window._setSoundNotifications = (v) => { soundNotificationsEnabled = v !== false; };

// System (OS) notifications + dock badge (#feature) ; read-only-by-default click (#25)
let systemNotificationsEnabled = true;
window._setSystemNotifications = (v) => {
  systemNotificationsEnabled = v !== false;
  // Main owns the notifications + dock badge now — push the setting to it.
  if (window.api?.setNotificationsEnabled) window.api.setNotificationsEnabled(systemNotificationsEnabled);
};
let showSubagentSessions = true;
window._setShowSubagentSessions = (v) => { showSubagentSessions = v !== false; };

let _audioCtx = null;
function _audio() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { return null; }
  }
  if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
  return _audioCtx;
}

function _chime(ctx, freq, startAt, dur, peak) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + dur + 0.02);
}

function playNotifSound(kind) {
  if (!soundNotificationsEnabled) return;
  const ctx = _audio();
  if (!ctx) return;
  const t = ctx.currentTime;
  if (kind === 'attention') {
    _chime(ctx, 880, t, 0.18, 0.22);
    _chime(ctx, 1175, t + 0.16, 0.22, 0.22);
  } else {
    _chime(ctx, 660, t, 0.16, 0.16);
    _chime(ctx, 988, t + 0.13, 0.30, 0.16);
  }
}

// Label lisible d'une session pour les notifications OS
function _sessionLabel(sessionId) {
  const s = sessionMap.get(sessionId);
  if (!s) return 'A session';
  const proj = (s.projectPath || '').split('/').filter(Boolean).pop() || '';
  // cleanDisplayName attend une CHAINE (name), pas l'objet session.
  const raw = s.name || s.aiTitle || s.summary || '';
  let name = '';
  try { name = (typeof cleanDisplayName === 'function' ? cleanDisplayName(raw) : raw) || ''; } catch { name = raw; }
  name = String(name).trim();
  return name ? (proj ? `${name} · ${proj}` : name) : (proj || 'A session');
}

// Notification native macOS (Notification Center) ; clic -> focus la session
// OS notifications are now fired by the main process (see main.js) so they work
// when this renderer is suspended (occluded / minimized / on another Space). The
// renderer only plays the in-app sound and toggles the sidebar's visual badges.

// The dock badge is now owned by the main process (so it stays correct when the
// renderer is suspended on another macOS Space). This stub stays because callers
// throughout the renderer invoke it after mutating the visual attention sets.
function updateAttentionBadge() { /* badge handled in main */ }

// Central activity dispatcher
function setActivity(sessionId, active) {
  if (responseReadySessions.has(sessionId)) {
    return;
  }

  const wasActive = sessionBusyState.get(sessionId) || false;
  sessionBusyState.set(sessionId, active);

  if (wasActive && !active) {
    // Activity ended → response-ready if user isn't looking at this session
    if (sessionId !== activeSessionId) {
      responseReadySessions.add(sessionId);
      const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
      if (item) {
        item.classList.remove('cli-busy');
        item.classList.add('response-ready');
      }
      playNotifSound('finished'); // #66 (OS notification is fired by main.js)
      updateAttentionBadge();
    }
  }

  // Sync cli-busy class (only if not response-ready)
  if (!responseReadySessions.has(sessionId)) {
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.toggle('cli-busy', active);
  }
}

// Terminal output activity — updates lastActivityTime only, busy state driven by backend
function trackActivity(sessionId, data) {
  if (activityNoiseRe.test(data)) return;
  lastActivityTime.set(sessionId, new Date());
}

function clearUnread(sessionId) {
  responseReadySessions.delete(sessionId);
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (item) {
    item.classList.remove('response-ready');
  }
  updateAttentionBadge();
}

function clearNotifications(sessionId) {
  clearUnread(sessionId);
  attentionSessions.delete(sessionId);
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (item) item.classList.remove('needs-attention');
  updateAttentionBadge();
}
// Terminal themes, utils (cleanDisplayName, formatDate, escapeHtml, shellEscape)
// are defined in terminal-themes.js and utils.js (loaded before app.js).

// Terminal key bindings, write buffering, isAtBottom, safeFit, fitAndScroll → terminal-manager.js

// --- IPC listeners from main process ---

// Buffering + sync-block handling + activity tracking live in
// terminal-manager.js (handleTerminalData) so the flush interplay is
// covered by jsdom tests — app.js itself cannot be loaded in jsdom.
window.api.onTerminalData((sessionId, data) => handleTerminalData(sessionId, data));

window.api.onSessionDetected((tempId, realId) => {
  const entry = openSessions.get(tempId);
  if (!entry) return;

  entry.session.sessionId = realId;
  if (activeSessionId === tempId) setActiveSession(realId);

  // Re-key in openSessions
  openSessions.delete(tempId);
  openSessions.set(realId, entry);

  terminalHeaderId.textContent = realId;
  terminalHeaderName.textContent = t('app.new_session');

  // Refresh sidebar to show the new session, then select it
  loadProjects().then(() => {
    const item = document.querySelector(`[data-session-id="${realId}"]`);
    if (item) {
      document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
    }
  });
  pollActiveSessions();
});

window.api.onSessionForked((oldId, newId) => {
  const entry = openSessions.get(oldId);
  if (!entry) return;

  entry.session.sessionId = newId;
  if (activeSessionId === oldId) setActiveSession(newId);

  openSessions.delete(oldId);
  openSessions.set(newId, entry);

  // Re-key file panel state for the new session ID
  if (typeof rekeyFilePanelState === 'function') rekeyFilePanelState(oldId, newId);

  // Re-key pending session to newId so sidebar item persists until DB has real data
  const pendingEntry = pendingSessions.get(oldId);
  pendingSessions.delete(oldId);
  if (pendingEntry) {
    pendingEntry.sessionId = newId;
    pendingSessions.set(newId, pendingEntry);
  }
  sessionMap.delete(oldId);
  sessionMap.set(newId, entry.session);

  // Migrate per-session status/activity maps (not re-keyed above) so the old temp
  // id doesn't leak and the forked session keeps its busy/attention/activity state.
  for (const set of [attentionSessions, responseReadySessions]) {
    if (set.has(oldId)) { set.delete(oldId); set.add(newId); }
  }
  if (sessionBusyState.has(oldId)) { sessionBusyState.set(newId, sessionBusyState.get(oldId)); sessionBusyState.delete(oldId); }
  if (lastActivityTime.has(oldId)) { lastActivityTime.set(newId, lastActivityTime.get(oldId)); lastActivityTime.delete(oldId); }

  terminalHeaderId.textContent = newId;

  loadProjects().then(() => {
    const item = document.querySelector(`[data-session-id="${newId}"]`);
    if (item) {
      document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      const summary = item.querySelector('.session-summary');
      if (summary) terminalHeaderName.textContent = summary.textContent;
    }
  });
  pollActiveSessions();
});

window.api.onProcessExited((sessionId, exitCode) => {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId);
  if (entry) {
    entry.closed = true;
    // Write a visible exit banner so the user can see when the process ended
    // and read any error output it printed (claude / devbox / shell stderr).
    // Without this, a fast-failing pre-launch command would tear down the
    // terminal before the user could read the error.
    try {
      const colour = exitCode === 0 ? '\x1b[2m' : '\x1b[33m';
      entry.terminal.write(
        `\r\n${colour}── session exited (code ${exitCode}) — re-click this session in the sidebar to relaunch, or click another to dismiss ──\x1b[0m\r\n`
      );
    } catch {}
  }

  // Plain terminal sessions are ephemeral — destroy immediately and remove from
  // the sidebar. Claude sessions stay mounted (see below) so the user can read
  // the exit reason.
  if (session?.type === 'terminal') {
    if (entry) destroySession(sessionId);
    if (gridViewActive) {
      gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
    } else if (activeSessionId === sessionId) {
      setActiveSession(null);
      terminalHeader.style.display = 'none';
      placeholder.style.display = '';
    }
    pendingSessions.delete(sessionId);
    for (const projList of [cachedProjects, cachedAllProjects]) {
      for (const proj of projList) {
        proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
      }
    }
    sessionMap.delete(sessionId);
    refreshSidebar();
    pollActiveSessions();
    return;
  }

  // Claude sessions: keep the terminal mounted with the exit banner visible so
  // the user can read what happened. Cleanup is deferred — openSession destroys
  // the closed entry when the user re-clicks the session (existing behavior).
  // If the session was pending (no .jsonl was written), leave the sidebar
  // entry in place too so the user has somewhere to relaunch from; it'll be
  // tidied up by the regular pending-reconciliation pass once it's clear no
  // real session file is coming.

  if (gridViewActive) {
    gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
  }

  // The session is now closed (banner shown). Re-render so it drops out of the
  // "running only" filter and its running indicator clears.
  refreshSidebar();
  pollActiveSessions();
});

// --- Terminal notifications (iTerm2 OSC 9 — "needs attention") ---
window.api.onTerminalNotification((sessionId, message) => {
  // Only mark as needing attention for "attention" messages, not "waiting for input"
  // Matches all four CLI notification types:
  // 1. "Claude Code needs your attention"         → attention
  // 2. "Claude Code needs your approval for the plan" → approval, needs your
  // 3. "Claude needs your permission to use {tool}"   → permission, needs your
  // 4. "Claude Code wants to enter plan mode"         → wants to enter
  if (/attention|approval|permission|needs your|wants to enter/i.test(message) && sessionId !== activeSessionId) {
    // Ne notifier/chimer qu'à la PREMIERE entrée en attention (le CLI peut
    // réémettre l'OSC 9 plusieurs fois pour la même session -> pas de spam).
    const isNewAttention = !attentionSessions.has(sessionId);
    attentionSessions.add(sessionId);
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.add('needs-attention');
    if (isNewAttention) {
      playNotifSound('attention'); // #66 (OS notification is fired by main.js)
      updateAttentionBadge();
    }
  } else if (/waiting for your input/i.test(message)) {
    // "Claude is waiting for your input" — delayed idle notification, mark response-ready
    setActivity(sessionId, false);
  }

  // Show in header if active
  if (sessionId === activeSessionId && terminalHeaderPtyTitle) {
    terminalHeaderPtyTitle.textContent = message;
    terminalHeaderPtyTitle.style.display = '';
  }
});

// --- CLI busy state (OSC 0 title spinner detection) ---
window.api.onCliBusyState((sessionId, busy) => {
  setActivity(sessionId, busy);
});

// Clic sur une notification macOS -> ouvrir/focaliser la session concernée
if (window.api.onFocusSession) {
  window.api.onFocusSession((sessionId) => {
    const s = sessionMap.get(sessionId);
    if (s) openSession(s);
    else console.warn('[focus-session] unknown session', sessionId);
  });
}

// --- Single entry point for all sidebar renders ---
// resort=true: re-sort items by priority+time (use for user-initiated actions)
// resort=false (default): preserve existing DOM order, new items go to top
function refreshSidebar({ resort = false } = {}) {
  // When searching, always use all projects (search ignores archive filter)
  let projects = (searchMatchIds !== null)
    ? cachedAllProjects
    : (showArchived ? cachedAllProjects : cachedProjects);

  if (searchMatchIds !== null) {
    projects = projects.map(p => {
      const hasMatchingSessions = p.sessions.some(s => searchMatchIds.has(s.sessionId));
      const projectMatched = searchMatchProjectPaths && searchMatchProjectPaths.has(p.projectPath);
      if (!hasMatchingSessions && !projectMatched) return null;
      return {
        ...p,
        sessions: hasMatchingSessions ? p.sessions.filter(s => searchMatchIds.has(s.sessionId)) : [],
        _projectMatchedOnly: projectMatched && !hasMatchingSessions,
      };
    }).filter(Boolean);
  }

  renderProjects(projects, resort);
}

// --- Archive toggle ---
archiveToggle.innerHTML = ICONS.archive(18);
archiveToggle.addEventListener('click', () => {
  showArchived = !showArchived;
  archiveToggle.classList.toggle('active', showArchived);
  refreshSidebar({ resort: true });
});

// --- Star filter toggle ---
starToggle.addEventListener('click', () => {
  showStarredOnly = !showStarredOnly;
  if (showStarredOnly) { showRunningOnly = false; runningToggle.classList.remove('active'); }
  starToggle.classList.toggle('active', showStarredOnly);
  refreshSidebar({ resort: true });
});

// --- Running filter toggle ---
runningToggle.addEventListener('click', () => {
  showRunningOnly = !showRunningOnly;
  if (showRunningOnly) { showStarredOnly = false; starToggle.classList.remove('active'); }
  runningToggle.classList.toggle('active', showRunningOnly);
  refreshSidebar({ resort: true });
});

// --- Today filter toggle ---
todayToggle.addEventListener('click', () => {
  showTodayOnly = !showTodayOnly;
  todayToggle.classList.toggle('active', showTodayOnly);
  refreshSidebar({ resort: true });
});

// --- Re-sort button ---
resortBtn.addEventListener('click', () => {
  loadProjects({ resort: true });
});

// --- Global settings: opened from the macOS menu bar (Switchboard > Settings, Cmd+,) ---
// The in-UI gear button was removed in favor of the native menu item.
if (window.api && typeof window.api.onOpenGlobalSettings === 'function') {
  window.api.onOpenGlobalSettings(() => {
    if (typeof openSettingsViewer === 'function') openSettingsViewer('global');
  });
}

// --- Add project button ---
addProjectBtn.addEventListener('click', () => {
  showAddProjectDialog();
});

// --- Search (debounced, per-tab FTS) ---
// Trigram tokenizer makes 1-2 char queries the most expensive (they match
// enormous row sets). Treat any query shorter than this as "no filter".
const MIN_SEARCH_CHARS = 3;
let searchDebounceTimer = null;
const searchClear = document.getElementById('search-clear');
const searchTitlesToggle = document.getElementById('search-titles-toggle');
let searchTitlesOnly = false;

// Load persisted preference
(async () => {
  const saved = await window.api.getSetting('searchTitlesOnly');
  if (saved) {
    searchTitlesOnly = true;
    searchTitlesToggle.classList.add('active');
  }
})();

searchTitlesToggle.addEventListener('click', async () => {
  searchTitlesOnly = !searchTitlesOnly;
  searchTitlesToggle.classList.toggle('active', searchTitlesOnly);
  await window.api.setSetting('searchTitlesOnly', searchTitlesOnly);
  // Re-run current search if there's a query
  const query = searchInput.value.trim();
  if (query) {
    searchInput.dispatchEvent(new Event('input'));
  }
});

function clearSearch() {
  searchInput.value = '';
  searchBar.classList.remove('has-query');
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  if (activeTab === 'sessions') {
    searchMatchIds = null;
    searchMatchProjectPaths = null;
    refreshSidebar({ resort: true });
  } else if (activeTab === 'plans') {
    renderPlans(cachedPlans);
  } else if (activeTab === 'memory') {
    renderMemories();
  }
}

// Reset the search filter state WITHOUT clearing the input text. Used when the
// query drops below MIN_SEARCH_CHARS while the user is still typing — we want no
// filter applied, but must not wipe the partially-typed text.
function resetSearchFilter() {
  if (activeTab === 'sessions') {
    searchMatchIds = null;
    searchMatchProjectPaths = null;
    refreshSidebar({ resort: true });
  } else if (activeTab === 'plans') {
    renderPlans(cachedPlans);
  } else if (activeTab === 'memory') {
    renderMemories();
  }
}

searchClear.addEventListener('click', () => {
  clearSearch();
  searchInput.focus();
});

searchInput.addEventListener('input', () => {
  // Toggle clear button visibility
  searchBar.classList.toggle('has-query', searchInput.value.length > 0);

  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(async () => {
    searchDebounceTimer = null;
    const query = searchInput.value.trim();

    if (!query) {
      clearSearch();
      return;
    }

    // 1-2 char queries are the most expensive for the trigram tokenizer (they
    // match enormous row sets). Treat them as "no filter" — show the full list
    // without wiping the partially-typed text (resetSearchFilter, not clearSearch).
    if (query.length < MIN_SEARCH_CHARS) {
      resetSearchFilter();
      return;
    }

    try {
      if (activeTab === 'sessions') {
        const results = await window.api.search('session', query, searchTitlesOnly);
        searchMatchIds = new Set(results.map(r => r.id));
        // When title-only, also match project names
        searchMatchProjectPaths = null;
        if (searchTitlesOnly) {
          const lowerQ = query.toLowerCase();
          for (const p of cachedAllProjects) {
            const shortName = p.projectPath.split('/').filter(Boolean).slice(-2).join('/');
            if (shortName.toLowerCase().includes(lowerQ)) {
              if (!searchMatchProjectPaths) searchMatchProjectPaths = new Set();
              searchMatchProjectPaths.add(p.projectPath);
            }
          }
        }
        refreshSidebar({ resort: true });
      } else if (activeTab === 'plans') {
        const results = await window.api.search('plan', query, searchTitlesOnly);
        const matchIds = new Set(results.map(r => r.id));
        renderPlans(cachedPlans.filter(p => matchIds.has(p.filename)));
      } else if (activeTab === 'memory') {
        const results = await window.api.search('memory', query, searchTitlesOnly);
        const matchIds = new Set(results.map(r => r.id));
        renderMemories(matchIds);
      }
    } catch {
      if (activeTab === 'sessions') {
        searchMatchIds = null;
        searchMatchProjectPaths = null;
        refreshSidebar({ resort: true });
      }
    }
  }, 200);
});

// --- Stop session helper ---
async function confirmAndStopSession(sessionId) {
  if (!confirm('Stop this session?')) return;
  await window.api.stopSession(sessionId);
  activePtyIds.delete(sessionId);
  // Mark the entry closed now so it drops out of the "running only" filter
  // immediately, without waiting for the async process-exited event.
  const _stopped = openSessions.get(sessionId);
  if (_stopped) _stopped.closed = true;
  if (!gridViewActive && activeSessionId === sessionId) {
    setActiveSession(null);
    terminalHeader.style.display = 'none';
    placeholder.style.display = '';
  } else if (gridViewActive) {
    // In the session overview, stopping should remove the card so the grid
    // reflects only live/open work (not a lingering stopped terminal).
    destroySession(sessionId);
    gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
  }
  refreshSidebar();
}

// --- Terminal header controls ---
terminalStopBtn.addEventListener('click', () => {
  if (activeSessionId) confirmAndStopSession(activeSessionId);
});


// --- Poll for active PTY sessions ---
// Adaptive cadence: poll fast (3s) only while PTYs are running; when idle, back
// off to 30s. Every renderer path that starts a session (launchNewSession,
// openSession, launchTerminalSession, onSessionDetected/Forked) calls
// pollActiveSessions() explicitly, which re-arms the fast cadence immediately.
// The 30s idle floor still catches sessions started outside the renderer
// (scheduler-spawned PTYs, other windows) within at most 30s.
const POLL_FAST_MS = 3000;
const POLL_IDLE_MS = 30000;
let pollTimer = null;

function scheduleActiveSessionsPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const delay = activePtyIds.size > 0 ? POLL_FAST_MS : POLL_IDLE_MS;
  pollTimer = setTimeout(pollActiveSessions, delay);
}

async function pollActiveSessions() {
  try {
    const ids = await window.api.getActiveSessions();
    activePtyIds = new Set(ids);
    updateRunningIndicators();
    updateTerminalHeader();
  } catch {}
  scheduleActiveSessionsPoll();
}

// Signature of the pty-id set from the last updateRunningIndicators() call.
// Used to skip the two full querySelectorAll sidebar scans when nothing changed.
// A sorted join is a cheap signature for the small counts expected (<20 active
// sessions). The gridCards loop runs every call regardless because
// sessionBusyState can change between polls without the pty-set changing.
let _lastPtySignature = '';

function updateRunningIndicators() {
  // Build a cheap signature for the current running set.
  const sig = Array.from(activePtyIds).sort().join(',');
  const ptySetChanged = sig !== _lastPtySignature;
  _lastPtySignature = sig;

  if (ptySetChanged) {
    // Full sidebar DOM scan: only when the set of running sessions changed.
    // Each call hits every .session-item and every .slug-group, which can be
    // expensive on large projects; skip when nothing moved.
    document.querySelectorAll('.session-item').forEach(item => {
      const id = item.dataset.sessionId;
      const running = activePtyIds.has(id);
      item.classList.toggle('has-running-pty', running);
      if (!running) {
        item.classList.remove('needs-attention', 'response-ready', 'cli-busy');
        attentionSessions.delete(id);
        responseReadySessions.delete(id);
        sessionBusyState.delete(id);
        updateAttentionBadge();
      }
      const dot = item.querySelector('.session-status-dot');
      if (dot) dot.classList.toggle('running', running);
    });
    // Update slug group running dots
    document.querySelectorAll('.slug-group').forEach(group => {
      const hasRunning = group.querySelector('.session-item.has-running-pty') !== null;
      const dot = group.querySelector('.slug-group-dot');
      if (dot) dot.classList.toggle('running', hasRunning);
    });
  }

  // Update grid card dots and status text — always run because sessionBusyState
  // (CLI-busy indicator) can change without affecting activePtyIds.
  for (const [sid, card] of gridCards) {
    const running = activePtyIds.has(sid);
    const busy = sessionBusyState.get(sid) || false;
    const dot = card.querySelector('.grid-card-dot');
    if (dot) dot.className = 'grid-card-dot ' + (busy ? 'busy' : (running ? 'running' : 'stopped'));
    const footer = card.querySelector('.grid-card-footer');
    if (footer) footer.children[0].textContent = running ? 'Running' : 'Stopped';
    const stopBtn = card.querySelector('.grid-card-stop-btn');
    if (stopBtn) stopBtn.style.display = running ? '' : 'none';
  }
}

function updateTerminalHeader() {
  if (!activeSessionId) return;
  const running = activePtyIds.has(activeSessionId);
  terminalHeaderStatus.className = running ? 'running' : 'stopped';
  terminalHeaderStatus.textContent = running ? 'Running' : 'Stopped';
  terminalStopBtn.style.display = running ? '' : 'none';
  updatePtyTitle();
}

const terminalHeaderPtyTitle = document.getElementById('terminal-header-pty-title');

function updatePtyTitle() {
  if (!activeSessionId || !terminalHeaderPtyTitle) return;
  const entry = openSessions.get(activeSessionId);
  const title = entry?.ptyTitle || '';
  terminalHeaderPtyTitle.textContent = title;
  terminalHeaderPtyTitle.style.display = title ? '' : 'none';
}

scheduleActiveSessionsPoll();

// Refresh sidebar timeago labels every 30s so "just now" ticks forward
setInterval(() => {
  if (lastActivityTime.size === 0) return;
  for (const [sessionId, time] of lastActivityTime) {
    const item = document.getElementById('si-' + sessionId);
    if (!item) continue;
    const meta = item.querySelector('.session-meta');
    if (!meta) continue;
    const session = sessionMap.get(sessionId);
    const msgSuffix = session?.messageCount ? ' \u00b7 ' + session.messageCount + ' msgs' : '';
    meta.textContent = formatDate(time);
    const row = item.querySelector('.session-row');
    if (row) row.title = formatDate(time) + msgSuffix;
  }
}, 30000);

// Shared session map so all caches reference the same objects
const sessionMap = new Map();

function dedup(projects) {
  for (const p of projects) {
    for (let i = 0; i < p.sessions.length; i++) {
      const s = p.sessions[i];
      if (sessionMap.has(s.sessionId)) {
        Object.assign(sessionMap.get(s.sessionId), s);
        p.sessions[i] = sessionMap.get(s.sessionId);
      } else {
        sessionMap.set(s.sessionId, s);
      }
    }
  }
}

async function loadProjects({ resort = false } = {}) {
  const wasEmpty = cachedProjects.length === 0;
  if (wasEmpty) {
    loadingStatus.textContent = t('app.loading');
    loadingStatus.className = 'active';
    loadingStatus.style.display = '';
  }
  const [defaultProjects, allProjects] = await Promise.all([
    window.api.getProjects(false),
    window.api.getProjects(true),
  ]);
  cachedProjects = defaultProjects;
  cachedAllProjects = allProjects;
  loadingStatus.style.display = 'none';
  loadingStatus.className = '';
  dedup(cachedProjects);
  dedup(cachedAllProjects);

  // Reconcile pending sessions: remove ones that now have real data
  let hasReinjected = false;
  for (const [sid, pending] of [...pendingSessions]) {
    const realExists = allProjects.some(p => p.sessions.some(s => s.sessionId === sid));
    if (realExists) {
      pendingSessions.delete(sid);
    } else {
      hasReinjected = true;
      // Still pending — re-inject into cached data
      for (const projList of [cachedProjects, cachedAllProjects]) {
        let proj = projList.find(p => p.projectPath === pending.projectPath);
        if (!proj) {
          // Project not in list (no other sessions) — create a synthetic entry
          proj = { folder: pending.folder, projectPath: pending.projectPath, sessions: [] };
          projList.unshift(proj);
        }
        if (!proj.sessions.some(s => s.sessionId === sid)) {
          proj.sessions.unshift(pending.session);
        }
      }
    }
  }

  // Track active plain terminals in pendingSessions/sessionMap (data now comes from backend)
  try {
    const activeTerminals = await window.api.getActiveTerminals();
    for (const { sessionId, projectPath } of activeTerminals) {
      if (pendingSessions.has(sessionId)) continue; // already tracked
      const folder = encodeProjectPath(projectPath);
      // Find the session object already injected by the backend
      let session;
      for (const proj of cachedAllProjects) {
        session = proj.sessions.find(s => s.sessionId === sessionId);
        if (session) break;
      }
      if (!session) continue;
      pendingSessions.set(sessionId, { session, projectPath, folder });
      sessionMap.set(sessionId, session);
    }
  } catch {}

  await pollActiveSessions();
  refreshSidebar({ resort });
  renderDefaultStatus();
}

// Sidebar rendering (slugId, folderId, buildSlugGroup, renderProjects,
// rebindSidebarEvents, buildSessionItem, startRename) → sidebar.js


async function launchNewSession(project, sessionOptions) {
  const sessionId = crypto.randomUUID();
  const projectPath = project.projectPath;
  const session = {
    sessionId,
    summary: t('app.new_session'),
    firstPrompt: '',
    projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
  };

  // Track as pending (no .jsonl yet)
  const folder = encodeProjectPath(projectPath);
  pendingSessions.set(sessionId, { session, projectPath, folder });

  // Inject into cached project data so it appears in sidebar immediately
  sessionMap.set(sessionId, session);
  for (const projList of [cachedProjects, cachedAllProjects]) {
    let proj = projList.find(p => p.projectPath === projectPath);
    if (!proj) {
      proj = { folder, projectPath, sessions: [] };
      projList.unshift(proj);
    }
    proj.sessions.unshift(session);
  }
  refreshSidebar();

  const entry = createTerminalEntry(session);

  // Open terminal in main process with session options
  const result = await window.api.openTerminal(sessionId, projectPath, true, sessionOptions || null);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);
  if (result.mcpError) entry.terminal.write(`\r\n\x1b[33m[Switchboard] IDE emulation unavailable: ${result.mcpError}\x1b[0m\r\n`);

  showSession(sessionId);
  pollActiveSessions();
}

// Legacy alias
function openNewSession(project) {
  return launchNewSession(project);
}

function prettyModel(m) {
  if (!m) return '';
  const parts = m.replace(/^claude-/, '').split('-');
  const fam = parts.shift() || '';
  const nums = parts.filter(p => /^\d+$/.test(p)).slice(0, 2);
  return fam.charAt(0).toUpperCase() + fam.slice(1) + (nums.length ? ' ' + nums.join('.') : '');
}
function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return '' + n;
}

async function showTerminalHeader(session) {
  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary);
  // Breadcrumb projet / session (prefixe attenue facon mock)
  const projLeaf = (session.projectPath || '').split('/').filter(Boolean).slice(-1)[0] || '';
  terminalHeaderName.innerHTML = (projLeaf ? `<span class="th-proj">${escapeHtml(projLeaf)}</span><span class="th-sep">/</span>` : '') + escapeHtml(displayName);
  terminalHeaderId.textContent = session.sessionId || '';
  terminalHeader.style.display = '';
  updateTerminalHeader();

  // Chips meta (modele, branche git, contexte) parses du .jsonl — conteneur vide+rempli.
  let meta = document.getElementById('terminal-header-meta');
  if (!meta) { meta = document.createElement('span'); meta.id = 'terminal-header-meta'; terminalHeaderId.insertAdjacentElement('afterend', meta); }
  // Indicateurs d'etat (Running / IDE Emulation) = des INFOS, pas des boutons :
  // on les place dans la rangee de tags a gauche (ils gardent leurs couleurs).
  const thInfo = terminalHeaderId.parentElement;
  const statusEl = document.getElementById('terminal-header-status');
  if (statusEl && thInfo && statusEl.parentElement !== thInfo) thInfo.insertBefore(statusEl, thInfo.firstChild);
  const mcpEl = document.querySelector('.mcp-toggle');
  if (mcpEl && thInfo && mcpEl.parentElement !== thInfo) thInfo.insertBefore(mcpEl, statusEl ? statusEl.nextSibling : thInfo.firstChild);
  meta.dataset.sid = session.sessionId;
  meta.innerHTML = '';
  window.api.getSessionMeta(session.sessionId).then(m => {
    // Garde anti-race : si la session a change (ou un 2e appel a eu lieu), on abandonne.
    if (meta.dataset.sid !== session.sessionId || !m || m.error) return;
    meta.innerHTML = '';
    if (m.model) meta.insertAdjacentHTML('beforeend', `<span class="th-chip">${escapeHtml(prettyModel(m.model))}</span>`);
    if (m.gitBranch && m.gitBranch !== 'HEAD') meta.insertAdjacentHTML('beforeend', `<span class="th-chip th-branch"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 9v6M18 6a3 3 0 0 1-3 3H9"/></svg>${escapeHtml(m.gitBranch)}</span>`);
    if (m.ctxTokens) meta.insertAdjacentHTML('beforeend', `<span class="th-chip th-ctx">${fmtTokens(m.ctxTokens)} ctx</span>`);
  }).catch(() => {});

  // Actions rapides (facon mock) : "Voir messages" + "Fork", en groupe ghost bordé,
  // a gauche du bouton Stop. Cablees sur les memes handlers que le menu de session.
  const stopBtn = document.getElementById('terminal-stop-btn');
  let actions = document.getElementById('terminal-header-actions');
  if (!actions && stopBtn && stopBtn.parentElement) {
    actions = document.createElement('div');
    actions.id = 'terminal-header-actions';
    actions.innerHTML =
      '<button class="th-act" data-act="messages" title="Voir les messages"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg></button>' +
      '<button class="th-act" data-act="fork" title="Fork (nouvelle session branchee depuis celle-ci)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"/><path d="M12 12v3"/></svg></button>';
    stopBtn.parentElement.insertBefore(actions, stopBtn);
  }
  if (actions) {
    const msgBtn = actions.querySelector('[data-act="messages"]');
    const forkBtn = actions.querySelector('[data-act="fork"]');
    if (msgBtn) msgBtn.onclick = () => { if (typeof showJsonlViewer === 'function') showJsonlViewer(session); };
    if (forkBtn) forkBtn.onclick = () => {
      const project = (typeof cachedAllProjects !== 'undefined' && cachedAllProjects.find(p => p.projectPath === session.projectPath)) || { projectPath: session.projectPath };
      if (typeof forkSession === 'function') forkSession(session, project);
    };
  }

  // Show active shell profile
  try {
    const effective = await window.api.getEffectiveSettings(session.projectPath);
    const profileId = effective.shellProfile || 'auto';
    if (profileId === 'auto') {
      terminalHeaderShell.style.display = 'none';
    } else {
      const profiles = await window.api.getShellProfiles();
      const profile = profiles.find(p => p.id === profileId);
      terminalHeaderShell.textContent = profile ? profile.name : profileId;
      terminalHeaderShell.style.display = '';
    }
  } catch {
    terminalHeaderShell.style.display = 'none';
  }
}

// Terminal lifecycle (createTerminalEntry, destroySession, showSession, setupDragAndDrop) → terminal-manager.js

async function openSession(session, customOptions) {
  const { sessionId, projectPath } = session;

  // If already open, handle closed-session cleanup or just show it
  if (openSessions.has(sessionId)) {
    const entry = openSessions.get(sessionId);
    if (entry.closed) {
      destroySession(sessionId);
      if (session.type === 'terminal') {
        launchTerminalSession({ projectPath: session.projectPath });
        return;
      }
    } else {
      showSession(sessionId);
      return;
    }
  }

  // Create new terminal entry (hidden until showSession)
  const entry = createTerminalEntry(session);

  // Open terminal in main process
  const resumeOptions = customOptions || await resolveDefaultSessionOptions({ projectPath });
  // The `worktree` default applies to NEW sessions only. Resuming must reuse the
  // session's existing directory, so never pass --worktree on resume — otherwise
  // a plain-click resume tries to spin up a fresh git worktree and fails to attach
  // (the Resume-with-config dialog already omits worktree, which is why it works).
  if (resumeOptions) { delete resumeOptions.worktree; delete resumeOptions.worktreeName; }
  const result = await window.api.openTerminal(sessionId, projectPath, false, resumeOptions);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);
  if (result.mcpError) entry.terminal.write(`\r\n\x1b[33m[Switchboard] IDE emulation unavailable: ${result.mcpError}\x1b[0m\r\n`);

  showSession(sessionId);
  pollActiveSessions();
}

// Handle window resize
window.addEventListener('resize', () => {
  if (gridViewActive) {
    for (const entry of openSessions.values()) {
      fitAndScroll(entry);
    }
    return;
  }
  if (activeSessionId && openSessions.has(activeSessionId)) {
    const entry = openSessions.get(activeSessionId);
    safeFit(entry);
  }
});

// --- Tab switching ---
document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    if (tabName === activeTab) return;
    activeTab = tabName;
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));

    // Clear search on tab switch
    searchInput.value = '';
    searchBar.classList.remove('has-query');
    searchMatchIds = null;
    searchMatchProjectPaths = null;

    // Hide all sidebar content areas
    sidebarContent.style.display = 'none';
    plansContent.style.display = 'none';
    statsContent.style.display = 'none';
    memoryContent.style.display = 'none';
    if (teamsContent) teamsContent.style.display = 'none';
    sessionFilters.style.display = 'none';
    searchBar.style.display = 'none';

    if (tabName === 'sessions') {
      sessionFilters.style.display = '';
      searchBar.style.display = '';
      searchInput.placeholder = 'Search sessions...';
      sidebarContent.style.display = '';
      // Restore terminal area
      hideAllViewers();
      if (gridViewActive) {
        // Grid is still set up — just re-show it and refit
        placeholder.style.display = 'none';
        terminalHeader.style.display = 'none';
        gridViewer.style.display = 'block';
        for (const entry of openSessions.values()) {
          if (!entry.closed) fitAndScroll(entry);
        }
      } else if (activeSessionId && openSessions.has(activeSessionId)) {
        showSession(activeSessionId);
      } else {
        placeholder.style.display = '';
      }
      // Catch up on changes that happened while on another tab
      if (projectsChangedWhileAway) {
        projectsChangedWhileAway = false;
        loadProjects();
      }
    } else if (tabName === 'plans') {
      searchBar.style.display = '';
      searchInput.placeholder = 'Search plans...';
      plansContent.style.display = '';
      loadPlans();
    } else if (tabName === 'stats') {
      statsContent.style.display = '';
      // Immediately show stats viewer in main area
      placeholder.style.display = 'none';
      terminalArea.style.display = 'none';
      planViewer.style.display = 'none';
      memoryViewer.style.display = 'none';
      settingsViewer.style.display = 'none';
      statsViewer.style.display = 'flex';
      loadStats();
    } else if (tabName === 'memory') {
      searchBar.style.display = '';
      searchInput.placeholder = 'Search agent files...';
      memoryContent.style.display = '';
      loadMemories();
    } else if (tabName === 'teams') {
      // Agent Teams (experimental): sidebar lists runs; orch-viewer (managed by
      // orchestration-view.js) shows the selected run's board in the main area.
      if (teamsContent) teamsContent.style.display = '';
      placeholder.style.display = 'none';
      terminalArea.style.display = 'none';
      planViewer.style.display = 'none';
      memoryViewer.style.display = 'none';
      settingsViewer.style.display = 'none';
      statsViewer.style.display = 'none';
      jsonlViewer.style.display = 'none';
      if (typeof loadTeams === 'function') loadTeams();
      if (typeof renderOrchPlaceholder === 'function') renderOrchPlaceholder();
    }
  });
});

// Plans & viewer helpers → plans-memory-view.js


// Grid view → grid-view.js
// Initialize grid observers now that DOM refs are ready
initGridObservers();

// JSONL viewer (renderJsonlText, formatDuration, makeCollapsible, renderJsonlEntry, showJsonlViewer) → jsonl-viewer.js

// Stats view (loadStats, buildUsageSection, buildDailyBarChart, buildHeatmap, calculateStreak, buildStatsSummary) → stats-view.js

// Memory viewer → plans-memory-view.js


// Dialogs (resolveDefaultSessionOptions, forkSession, showNewSessionPopover,
// showNewSessionDialog, showResumeSessionDialog, showAddProjectDialog, launchTerminalSession) → dialogs.js


// --- Sidebar toggle ---
{
  const sidebar = document.getElementById('sidebar');
  const collapseBtn = document.getElementById('sidebar-collapse-btn');
  const expandBtn = document.getElementById('sidebar-expand-btn');

  collapseBtn.addEventListener('click', () => sidebar.classList.add('collapsed'));
  expandBtn.addEventListener('click', () => sidebar.classList.remove('collapsed'));
}

// --- Sidebar resize ---
{
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('sidebar-resize-handle');
  let dragging = false;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const width = Math.min(600, Math.max(200, e.clientX));
    sidebar.style.width = width + 'px';
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Refit active terminal
    if (!gridViewActive && activeSessionId && openSessions.has(activeSessionId)) {
      const entry = openSessions.get(activeSessionId);
      safeFit(entry);
    }
    // Save sidebar width to settings
    const width = parseInt(sidebar.style.width);
    if (width) {
      window.api.getSetting('global').then(g => {
        const global = g || {};
        global.sidebarWidth = width;
        window.api.setSetting('global', global);
      });
    }
  });
}

// --- Sidebar toolbar: action buttons + a "more" popover, with per-action
//     placement (visible vs popover) configurable from Settings → Toolbar. ---
{
  const filtersRow = document.getElementById('session-filters');

  const gridToggleBtn = document.createElement('button');
  gridToggleBtn.id = 'grid-toggle-btn';
  gridToggleBtn.title = t('tb.t.grid');
  gridToggleBtn.innerHTML = '<svg width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>';
  gridToggleBtn.addEventListener('click', toggleGridView);

  const collapseAllBtn = document.createElement('button');
  collapseAllBtn.id = 'collapse-all-btn';
  collapseAllBtn.title = t('tb.t.collapse');
  collapseAllBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 9 12 5 20 9"/><polyline points="4 15 12 19 20 15"/></svg>';
  collapseAllBtn.addEventListener('click', () => {
    const headers = sidebarContent.querySelectorAll('.project-header');
    const anyOpen = [...headers].some(h => !h.classList.contains('collapsed'));
    headers.forEach(h => h.classList.toggle('collapsed', anyOpen));
  });

  const bookmarksBtn = document.createElement('button');
  bookmarksBtn.id = 'bookmarks-btn';
  bookmarksBtn.title = t('tb.t.bookmarks');
  bookmarksBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
  bookmarksBtn.addEventListener('click', () => { if (window._openBookmarks) window._openBookmarks(); });

  if (filtersRow) {
    const magic = document.createElement('button');
    magic.id = 'filters-toggle-btn';
    magic.title = t('tb.t.more');
    magic.setAttribute('aria-label', t('tb.t.more'));
    magic.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2" fill="currentColor"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2" fill="currentColor"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="18" r="2" fill="currentColor"/></svg>';
    const popover = document.createElement('div');
    popover.id = 'filters-popover';
    const wrap = document.createElement('span');
    wrap.className = 'filters-magic-wrap';
    wrap.appendChild(magic);
    wrap.appendChild(popover);

    // Ensure the JS-built buttons are in the DOM; _applyToolbarLayout positions all.
    filtersRow.appendChild(gridToggleBtn);
    filtersRow.appendChild(collapseAllBtn);
    filtersRow.appendChild(bookmarksBtn);
    filtersRow.appendChild(wrap);

    // Ordered action list. Default placement = the layout shipped before this
    // setting existed (pin/running/overview/collapse/bookmarks visible, rest in popover).
    const TOOLBAR_ACTIONS = [
      { key: 'pin',        id: 'star-toggle',      label: t('tb.pin') },
      { key: 'running',    id: 'running-toggle',   label: t('tb.running') },
      { key: 'overview',   id: 'grid-toggle-btn',  label: t('tb.overview') },
      { key: 'collapse',   id: 'collapse-all-btn', label: t('tb.collapse') },
      { key: 'bookmarks',  id: 'bookmarks-btn',    label: t('tb.bookmarks') },
      { key: 'today',      id: 'today-toggle',     label: t('tb.today') },
      { key: 'archive',    id: 'archive-toggle',   label: t('tb.archive') },
      { key: 'resort',     id: 'resort-btn',       label: t('tb.resort') },
      { key: 'refresh',    id: 'refresh-cache-btn', label: t('tb.refresh') },
      { key: 'addProject', id: 'add-project-btn',  label: t('tb.add_project') },
    ];
    const TOOLBAR_DEFAULT = { pin: 'visible', running: 'visible', overview: 'visible', collapse: 'visible', bookmarks: 'visible', today: 'popover', archive: 'popover', resort: 'popover', refresh: 'popover', addProject: 'popover' };
    window._toolbarActions = TOOLBAR_ACTIONS;
    window._toolbarDefault = TOOLBAR_DEFAULT;
    // placement: { key -> 'visible'|'popover' } ; order: optional [key,...] custom order.
    window._applyToolbarLayout = (placement, order) => {
      const p = { ...TOOLBAR_DEFAULT, ...(placement || {}) };
      const known = TOOLBAR_ACTIONS.map((a) => a.key);
      const keys = (Array.isArray(order) && order.length)
        ? order.filter((k) => known.includes(k)).concat(known.filter((k) => !order.includes(k)))
        : known;
      for (const key of keys) {
        const a = TOOLBAR_ACTIONS.find((x) => x.key === key);
        if (!a) continue;
        const el = document.getElementById(a.id);
        if (!el) continue;
        if (p[key] === 'popover') popover.appendChild(el);
        else filtersRow.insertBefore(el, wrap); // visible, before the "more" button
      }
      // Hide the "more" button entirely when the popover is empty.
      wrap.style.display = popover.children.length ? '' : 'none';
    };
    window._applyToolbarLayout(); // default placement; boot re-applies the saved one

    const closePopover = () => { popover.classList.remove('open'); magic.classList.remove('active'); };
    magic.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = popover.classList.toggle('open');
      magic.classList.toggle('active', open);
    });
    document.addEventListener('click', (e) => {
      if (popover.classList.contains('open') && !popover.contains(e.target) && !magic.contains(e.target)) closePopover();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });
  }

  // Global keyboard shortcuts (covers non-terminal focus)
  // When a terminal is focused, xterm's customKeyEventHandler fires first and sets
  // e._handled to prevent the document listener from double-firing the same action.
  document.addEventListener('keydown', (e) => {
    if (e._handled) return;
    // Toggle grid view (default Cmd/Ctrl+Shift+G)
    if (matchShortcut('gridToggle', e, isMac, appShortcuts)) {
      e.preventDefault();
      toggleGridView();
      return;
    }
    // Session navigation: Cmd+Shift+[/], Cmd+Arrow
    handleSessionNavKey(e);
  });
}

// Warm up xterm.js renderer so first terminal open is fast
setTimeout(() => {
  const warmEl = document.createElement('div');
  warmEl.style.cssText = 'position:absolute;left:-9999px;width:400px;height:200px;';
  document.body.appendChild(warmEl);
  const warmTerm = new Terminal({ cols: 80, rows: 10 });
  const warmFit = new FitAddon.FitAddon();
  warmTerm.loadAddon(warmFit);
  warmTerm.open(warmEl);
  warmTerm.write(' ');
  requestAnimationFrame(() => {
    warmTerm.dispose();
    warmEl.remove();
  });
}, 100);


// --- Init: restore settings ---
(async () => {
  const global = await window.api.getSetting('global');
  if (global) {
    if (global.sidebarWidth) {
      document.getElementById('sidebar').style.width = global.sidebarWidth + 'px';
    }
    if (global.visibleSessionCount) {
      visibleSessionCount = global.visibleSessionCount;
    }
    if (global.sessionMaxAgeDays) {
      sessionMaxAgeDays = global.sessionMaxAgeDays;
    }
    if (global.terminalTheme && TERMINAL_THEMES[global.terminalTheme]) {
      currentThemeName = global.terminalTheme;
      TERMINAL_THEME = getTerminalTheme();
    }
    if (global.appearance) {
      window._applyAppearance(global.appearance);
    }
    window._setSoundNotifications(global.soundNotifications);
    window._setSystemNotifications(global.systemNotifications);
    // Seed main with the restored focused session so it doesn't alert it on boot.
    if (window.api?.setActiveSession) window.api.setActiveSession(activeSessionId);
    window._setShowSubagentSessions(global.showSubagentSessions);
    if (typeof window._applyToolbarLayout === 'function') window._applyToolbarLayout(global.toolbarIcons, global.toolbarOrder);
    window._applyTabVisibility(global);
    if (global.shortcuts) setAppShortcuts(global.shortcuts);
  }
})();

// Let the settings panel push updated key bindings live (no restart needed).
window._applyShortcuts = (stored) => setAppShortcuts(stored);

// Load the saved interface language (and translate static chrome) BEFORE the
// first render, so t()-based strings render in the right language from the start.
(window.I18N ? window.I18N.init() : Promise.resolve())
  .catch(() => {})
  .then(() => loadProjects())
  .then(() => {
    // Restore grid view preference before opening sessions so they enter grid mode
    if (localStorage.getItem('gridViewActive') === '1') {
      showGridView();
    }
    // Restore active session after reload
    if (activeSessionId && !openSessions.has(activeSessionId)) {
      const session = sessionMap.get(activeSessionId);
      if (session) openSession(session);
    }
  });

// Live-reload sidebar when filesystem changes are detected
let projectsChangedTimer = null;
let projectsChangedWhileAway = false;
window.api.onProjectsChanged(() => {
  // Debounce to avoid rapid re-renders during bulk changes
  if (projectsChangedTimer) clearTimeout(projectsChangedTimer);
  if (activeTab !== 'sessions') {
    projectsChangedWhileAway = true;
    return;
  }
  // 900ms debounce: 300ms was visibly flickering while live JSONLs trigger
  // watcher flushes every ~500ms; with the main-side notify throttle (1.5s) too
  // the sidebar redraws at most ~1x/sec.
  projectsChangedTimer = setTimeout(() => {
    projectsChangedTimer = null;
    loadProjects();
  }, 900);
});

// Status bar
let activityTimer = null;

function renderDefaultStatus() {
  const totalSessions = cachedAllProjects.reduce((n, p) => n + p.sessions.length, 0);
  const totalProjects = cachedAllProjects.length;
  const running = activePtyIds.size;
  const parts = [];
  if (running > 0) parts.push(`${running} running`);
  parts.push(`${totalSessions} sessions`);
  parts.push(`${totalProjects} projects`);
  statusBarInfo.textContent = parts.join(' \u00b7 ');
}

window.api.onStatusUpdate((text, type) => {
  if (activityTimer) clearTimeout(activityTimer);
  statusBarActivity.textContent = text;
  statusBarActivity.className = type === 'done' ? 'status-done' : '';
  if (!text || type === 'done') {
    activityTimer = setTimeout(() => {
      statusBarActivity.textContent = '';
      statusBarActivity.className = '';
    }, type === 'done' ? 3000 : 0);
  }
});

// --- Auto-update status + toast ---
const statusBarUpdater = document.getElementById('status-bar-updater');
let updaterStatusTimer = null;
function setUpdaterStatus(text, duration) {
  if (updaterStatusTimer) clearTimeout(updaterStatusTimer);
  statusBarUpdater.textContent = text;
  if (duration) {
    updaterStatusTimer = setTimeout(() => { statusBarUpdater.textContent = ''; }, duration);
  }
}
const updaterHandler = (type, data) => {
  switch (type) {
    case 'checking':
      setUpdaterStatus(t('upd.checking'));
      break;
    case 'update-available':
      setUpdaterStatus(`Downloading v${data.version}…`);
      break;
    case 'update-not-available':
      setUpdaterStatus(t('upd.uptodate'), 3000);
      break;
    case 'download-progress':
      setUpdaterStatus(`Updating… ${Math.round(data.percent)}%`);
      break;
    case 'update-downloaded': {
      setUpdaterStatus(`v${data.version} ready — restart to update`);
      const dismissed = localStorage.getItem('update-dismissed');
      if (dismissed === data.version) return;
      const toast = document.getElementById('update-toast');
      const msg = document.getElementById('update-toast-msg');
      const notice = (data.releaseName && data.releaseName !== `v${data.version}` && data.releaseName !== data.version) ? `<span class="update-summary">${escapeHtml(data.releaseName)}</span>` : '';
      msg.innerHTML = `${escapeHtml(t('upd.new_ready'))}<br><span class="update-version">v${data.version}</span> (<a href="https://github.com/doctly/switchboard/releases" target="_blank" class="update-notes-link">${escapeHtml(t('upd.release_notes'))}</a>)${notice}`;
      toast.classList.remove('hidden');
      document.getElementById('update-restart-btn').onclick = () => window.api.updaterInstall();
      document.getElementById('update-dismiss-btn').onclick = () => {
        toast.classList.add('hidden');
        localStorage.setItem('update-dismissed', data.version);
      };
      break;
    }
    case 'error':
      setUpdaterStatus(t('upd.failed'), 5000);
      break;
  }
};
window.api.onUpdaterEvent(updaterHandler);

// --- Initialize file panel (MCP bridge UI) ---
if (typeof initFilePanel === 'function') initFilePanel();
