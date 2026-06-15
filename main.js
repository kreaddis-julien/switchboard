const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, screen, session, shell } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const log = require('electron-log');
// getFolderIndexMtimeMs moved to session-cache.js
const { startMcpServer, shutdownMcpServer, shutdownAll: shutdownAllMcp, resolvePendingDiff, rekeyMcpServer, cleanStaleLockFiles } = require('./mcp-bridge');
const { fetchAndTransformUsage } = require('./claude-auth');
log.transports.file.level = app.isPackaged ? 'info' : 'debug';
log.transports.console.level = app.isPackaged ? 'info' : 'debug';

try { require('electron-reloader')(module, { watchRenderer: true }); } catch {};

// Notifications must fire while the app is in the background. Chromium otherwise
// "backgrounds" the renderer once its window is occluded (covered by another app)
// and defers the IPC that triggers a notification until the window is refocused —
// so an attention/finished alert only appeared when Switchboard was already in the
// foreground. Disable occlusion-based backgrounding (covers the "covered window"
// case); the per-window `backgroundThrottling: false` covers minimized/hidden.
// The cost is some renderer CPU while hidden, acceptable for a session monitor.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Clean env for child processes — strip Electron internals that cause nested
// Electron apps (or node-pty inside them) to malfunction.
const cleanPtyEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    !k.startsWith('ELECTRON_') &&
    !k.startsWith('GOOGLE_API_KEY') &&
    // Strip Claude-Code-injected runtime vars. If Switchboard is itself launched
    // from within a Claude Code session (e.g. `npm start` from a terminal inside a
    // session, or a nested terminal), these leak into every spawned claude session
    // and make it run as a CHILD/SUBAGENT (CLAUDE_CODE_SESSION_ID / _CHILD_SESSION /
    // _FORK_SUBAGENT) — which does NOT persist a transcript, so the session shows as
    // "New session" forever and /rename never appears. Switchboard re-adds the one it
    // needs (CLAUDE_CODE_SSE_PORT) per session. CLAUDE_CONFIG_DIR is intentionally NOT
    // stripped (prefix is CLAUDE_CODE_, not CLAUDE_).
    !k.startsWith('CLAUDE_CODE_') &&
    k !== 'CLAUDECODE' &&
    k !== 'CLAUDE_EFFORT' &&
    k !== 'NODE_OPTIONS' &&
    k !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
    k !== 'WT_SESSION'
  )
);

// Shell profiles → shell-profiles.js
const { discoverShellProfiles, getShellProfiles, resolveShell, isWindows, isWslShell, windowsToWslPath, shellArgs, quoteArgvForShell } = require('./shell-profiles');
const { startScheduler } = require('./schedule-runner');
const { encodeProjectPath } = require('./encode-project-path');



// --- Auto-updater (DISABLED in this fork) ---
// FORK redesign-shadcn: l'updater est totalement desactive en usage normal pour
// que les builds locaux (refonte shadcn + Geist) ne soient jamais ecrases par une
// release upstream doctly/switchboard. Mise a jour = rebuild local uniquement.
// Reactivable ponctuellement avec FORCE_UPDATER=1 (test).
let autoUpdater = null;
if (process.env.FORCE_UPDATER) {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.logger = log;
  // FORK: never auto-download/install upstream releases — they would overwrite
  // this patched build (light theme + curated PRs). Update via local rebuild
  // instead. "Check for Updates" still reports availability but won't replace.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;

  function sendUpdaterEvent(type, data) {
    log.info(`[updater] ${type}`, data || '');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater-event', type, data);
    }
  }
  autoUpdater.on('checking-for-update', () => sendUpdaterEvent('checking'));
  autoUpdater.on('update-available', (info) => sendUpdaterEvent('update-available', info));
  autoUpdater.on('update-not-available', (info) => sendUpdaterEvent('update-not-available', info));
  autoUpdater.on('download-progress', (progress) => sendUpdaterEvent('download-progress', progress));
  autoUpdater.on('update-downloaded', (info) => sendUpdaterEvent('update-downloaded', info));
  autoUpdater.on('error', (err) => {
    log.error('[updater] Error:', err?.message || String(err));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater-event', 'error', { message: err?.message || String(err) });
    }
  });
}
const {
  getMeta, getAllMeta, toggleStar, setName, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedByParent, getCachedFolder, getCachedSession, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting,
  closeDb,
} = require('./db');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STATS_CACHE_PATH = path.join(CLAUDE_DIR, 'stats-cache.json');
const MAX_BUFFER_SIZE = 256 * 1024;

// --- Path validation for IPC file operations ---
// Sensitive paths that should never be read/written via the file panel IPC.
// The file panel intentionally opens arbitrary files (OSC8 hyperlinks from
// terminal output), so we block known-sensitive locations rather than
// allowlisting. The primary XSS→file-access chain is mitigated by CSP +
// DOMPurify; this is defense-in-depth.
const SENSITIVE_PATH_PATTERNS = [
  /[/\\]\.ssh[/\\]/i,
  /[/\\]\.gnupg[/\\]/i,
  /[/\\]\.aws[/\\]credentials/i,
  /[/\\]\.env$/i,
  /[/\\]\.env\.local$/i,
  /[/\\]\.netrc$/i,
  /[/\\]\.docker[/\\]config\.json$/i,
  /[/\\]\.kube[/\\]config$/i,
];

function isSensitivePath(filePath) {
  const resolved = path.resolve(filePath);
  return SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(resolved));
}

// Stricter allowlist for memory/plan files that should only be under ~/.claude/
// or active project directories.
function isAllowedMemoryPath(filePath) {
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(CLAUDE_DIR + path.sep) || resolved === CLAUDE_DIR) return true;
  for (const [, session] of activeSessions) {
    if (session.projectPath && resolved.startsWith(session.projectPath + path.sep)) return true;
  }
  return false;
}

// --- Input sanitization for shell command arguments ---
const SHELL_META_CHARS = /[;&|`$(){}!#\n\r]/;
function validateShellArg(value, fieldName) {
  if (!value) return;
  if (SHELL_META_CHARS.test(value)) {
    throw new Error(`${fieldName} contains invalid characters`);
  }
}

// Active PTY sessions
const activeSessions = new Map();
let mainWindow = null;

function createWindow() {
  // Restore saved window bounds
  const savedBounds = getSetting('global')?.windowBounds;
  let bounds = { width: 1400, height: 900 };

  let restorePosition = null;
  if (savedBounds && savedBounds.width && savedBounds.height) {
    bounds.width = savedBounds.width;
    bounds.height = savedBounds.height;

    // Only restore position if it's on a visible display
    if (savedBounds.x != null && savedBounds.y != null) {
      const displays = screen.getAllDisplays();
      const onScreen = displays.some(d => {
        const b = d.bounds;
        return savedBounds.x >= b.x - 100 && savedBounds.x < b.x + b.width &&
               savedBounds.y >= b.y - 100 && savedBounds.y < b.y + b.height;
      });
      if (onScreen) {
        restorePosition = { x: savedBounds.x, y: savedBounds.y };
      }
    }
  }

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 500,
    title: 'Switchboard',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Sandbox the renderer AND the preload. Safe here: preload only requires the
      // `electron` module and uses process.platform / webUtils, all available in a
      // sandboxed preload; the renderer uses no Node APIs.
      sandbox: true,
      // Keep the renderer running at full cadence when the window is hidden or
      // minimized so notification-triggering IPC isn't deferred until refocus.
      backgroundThrottling: false,
    },
  });

  // Set position after creation to prevent macOS from clamping size
  if (restorePosition) {
    mainWindow.setBounds({ ...restorePosition, width: bounds.width, height: bounds.height });
  }

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  // Open external links in the system browser instead of a child BrowserWindow
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalOnce(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      openExternalOnce(url);
    }
  });
  // Override window.open so xterm WebLinksAddon's default handler (which does
  // window.open() then sets location.href) routes through our IPC instead of
  // creating a child BrowserWindow.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      window.open = function(url) {
        if (url && /^https?:\\/\\//i.test(url)) { window.api.openExternal(url); return null; }
        const proxy = {};
        Object.defineProperty(proxy, 'location', { get() {
          const loc = {};
          Object.defineProperty(loc, 'href', {
            set(u) { if (/^https?:\\/\\//i.test(u)) window.api.openExternal(u); }
          });
          return loc;
        }});
        return proxy;
      };
      void 0;
    `);
  });

  // Prevent Cmd+R / Ctrl+Shift+R from reloading the page (Chromium built-in).
  // Ctrl+R alone on macOS is NOT a reload shortcut and must pass through to xterm
  // for reverse-i-search.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'r' && input.meta) event.preventDefault();
    if (key === 'r' && input.control && input.shift) event.preventDefault();
  });

  // Save window bounds on move/resize (debounced)
  let boundsTimer = null;
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      const b = mainWindow.getBounds();
      const global = getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      setSetting('global', global);
    }, 500);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Returning to the app while viewing a session acknowledges its pending alert,
  // so the dock badge clears for the session you're now actually looking at.
  mainWindow.on('focus', () => clearSessionNotifications(notifyActiveSessionId));

  // Also save immediately before close (debounce may not have flushed)
  mainWindow.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    if (!mainWindow.isMinimized()) {
      const b = mainWindow.getBounds();
      const global = getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      setSetting('global', global);
    }
  });

  mainWindow.on('closed', () => {
    // On macOS the app stays alive in the dock after the last window closes.
    // Kill all running PTY processes so orphaned `claude` processes don't
    // accumulate in the background with no way for the user to interact.
    for (const [id, session] of activeSessions) {
      if (!session.exited) {
        try { session.pty.kill(); } catch {}
      }
      activeSessions.delete(id);
    }
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => { if (mainWindow) mainWindow.webContents.send('open-global-settings'); },
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Session cache helpers ---

const { deriveProjectPath } = require('./derive-project-path');

// Session cache → session-cache.js
const sessionCache = require('./session-cache');
sessionCache.init({
  PROJECTS_DIR,
  activeSessions,
  getMainWindow: () => mainWindow,
  log,
  db: {
    deleteCachedFolder, getCachedByFolder, upsertCachedSessions, deleteCachedSession,
    deleteSearchFolder, deleteSearchSession, upsertSearchEntries,
    setFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName,
  },
});
const { readSessionFile, readFolderFromFilesystem, refreshFolder, reconcileCacheFromFilesystem,
        buildProjectsFromCache, notifyRendererProjectsChanged, sendStatus, populateCacheViaWorker } = sessionCache;


// --- IPC: browse-folder ---
ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Project Folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// --- IPC: add-project ---
ipcMain.handle('add-project', (_event, projectPath) => {
  try {
    // Validate the path exists and is a directory
    const stat = fs.statSync(projectPath);
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };

    // Unhide if previously hidden
    const global = getSetting('global') || {};
    if (global.hiddenProjects && global.hiddenProjects.includes(projectPath)) {
      global.hiddenProjects = global.hiddenProjects.filter(p => p !== projectPath);
      setSetting('global', global);
    }

    // Create the corresponding folder in ~/.claude/projects/ so it persists
    const folder = encodeProjectPath(projectPath);
    const folderPath = path.join(PROJECTS_DIR, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Seed a minimal .jsonl so deriveProjectPath can read the cwd
    if (!fs.readdirSync(folderPath).some(f => f.endsWith('.jsonl'))) {
      const seedId = require('crypto').randomUUID();
      const seedFile = path.join(folderPath, seedId + '.jsonl');
      const now = new Date().toISOString();
      const line = JSON.stringify({ type: 'user', cwd: projectPath, sessionId: seedId, uuid: require('crypto').randomUUID(), timestamp: now, message: { role: 'user', content: 'New project' } });
      fs.writeFileSync(seedFile, line + '\n');
    }

    // Immediately index the new folder so it's in cache before frontend renders
    refreshFolder(folder);
    notifyRendererProjectsChanged();

    return { ok: true, folder, projectPath };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: remove-project ---
ipcMain.handle('remove-project', (_event, projectPath) => {
  try {
    // Add to hidden projects list
    const global = getSetting('global') || {};
    const hidden = global.hiddenProjects || [];
    if (!hidden.includes(projectPath)) hidden.push(projectPath);
    global.hiddenProjects = hidden;
    setSetting('global', global);

    // Clean up DB cache and search index for this folder
    const folder = encodeProjectPath(projectPath);
    deleteCachedFolder(folder);
    deleteSearchFolder(folder);
    deleteSetting('project:' + projectPath);

    notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: list / unhide hidden projects ---
ipcMain.handle('get-hidden-projects', () => {
  return (getSetting('global') || {}).hiddenProjects || [];
});
ipcMain.handle('unhide-project', (_event, projectPath) => {
  try {
    const global = getSetting('global') || {};
    global.hiddenProjects = (global.hiddenProjects || []).filter((p) => p !== projectPath);
    setSetting('global', global);
    notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: remap-project (#35) — point a moved/renamed project at a new path ---
ipcMain.handle('remap-project', (_event, oldPath, newPath) => {
  try {
    const global = getSetting('global') || {};
    const remap = global.projectPathRemap || {};
    // If oldPath is itself the TARGET of an existing remap (re-relocating an
    // already-moved project), repoint that original source key — the lookup in
    // buildProjectsFromCache is single-level, so we must keep the raw key current.
    const srcKey = Object.keys(remap).find((k) => remap[k] === oldPath);
    const key = srcKey || oldPath;
    if (newPath && newPath !== key) remap[key] = newPath;
    else delete remap[key]; // clearing the remap
    global.projectPathRemap = remap;
    setSetting('global', global);
    notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: set-project-group — assign/clear a sidebar group for a project ---
ipcMain.handle('set-project-group', (_event, projectPath, group) => {
  try {
    const global = getSetting('global') || {};
    const groups = global.projectGroups || {};
    const g = (group || '').trim();
    if (g) groups[projectPath] = g;
    else delete groups[projectPath];
    global.projectGroups = groups;
    setSetting('global', global);
    notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: get-projects ---
// Open an external URL, collapsing duplicate requests for the same URL within a
// short window. A terminal URL can be matched by BOTH xterm's OSC 8 link provider
// (via the linkHandler option) and the WebLinksAddon regex when a hyperlink's
// visible text is itself a URL — common with CLIs like Claude Code that emit OSC 8.
// Both fire on a single click, so the browser would otherwise open twice.
let _lastExternalUrl = null;
let _lastExternalAt = 0;
function openExternalOnce(url) {
  if (!/^https?:\/\//i.test(url)) return;
  const now = Date.now();
  if (url === _lastExternalUrl && now - _lastExternalAt < 700) return;
  _lastExternalUrl = url;
  _lastExternalAt = now;
  return shell.openExternal(url).catch(() => {});
}

// --- IPC: open-external ---
ipcMain.handle('open-external', (_event, url) => {
  log.info('[open-external IPC]', url);
  return openExternalOnce(url);
});

// --- Native OS notifications + dock badge (decided in MAIN) ---
// Notifications are decided and fired here, not in the renderer, so they land
// even when the renderer is suspended — occluded, minimized, or (the common
// macOS case) on another Space. The renderer keeps only the in-app sound and
// the sidebar's visual badges. Main learns the focused session via
// `set-active-session` so it never alerts the session you're already looking at.
let notifyActiveSessionId = null;       // session the user is currently viewing
let notificationsEnabled = true;        // mirrors the renderer's systemNotifications setting
const notifyAttention = new Set();      // sessions flagged "needs attention" (dedup)
const notifyResponseReady = new Set();  // sessions that finished while not focused

function showOsNotification(body, sessionId) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: 'Switchboard', body: body || '', silent: true });
    n.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        if (sessionId) mainWindow.webContents.send('focus-session', sessionId);
      }
    });
    n.show();
  } catch (e) { log.warn('[notify]', e?.message || e); }
}

function notifyLabelFor(sessionId) {
  const s = activeSessions.get(sessionId);
  if (s) {
    if (s.isPlainTerminal) return 'Terminal';
    const base = String(s.projectPath || '').split('/').filter(Boolean).pop();
    if (base) return base;
  }
  return 'Session';
}

function refreshDockBadge() {
  try {
    const n = notificationsEnabled ? new Set([...notifyAttention, ...notifyResponseReady]).size : 0;
    app.setBadgeCount(n);
  } catch (e) { log.warn('[badge]', e?.message || e); }
}

// The "active" session is only genuinely on-screen when the Switchboard window
// itself is focused. If the user switched to another app or another macOS Space,
// even the active session is out of sight and must still notify — otherwise the
// common case (launch a prompt, step away, wait) stays silent, which is exactly
// what notifications are for.
function userViewingSession(sessionId) {
  return sessionId === notifyActiveSessionId
    && !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
}

// Deduped: a session notifies at most once per state until acknowledged (viewed)
// or, for "finished", until it resumes work.
function notifySessionAttention(sessionId) {
  if (!notificationsEnabled || userViewingSession(sessionId) || notifyAttention.has(sessionId)) return;
  notifyAttention.add(sessionId);
  log.info(`[notify] attention session=${sessionId}`);
  showOsNotification(`${notifyLabelFor(sessionId)} needs your attention`, sessionId);
  refreshDockBadge();
}
function notifySessionFinished(sessionId) {
  if (!notificationsEnabled || userViewingSession(sessionId) || notifyResponseReady.has(sessionId)) return;
  notifyResponseReady.add(sessionId);
  log.info(`[notify] finished session=${sessionId}`);
  showOsNotification(`${notifyLabelFor(sessionId)} finished`, sessionId);
  refreshDockBadge();
}
function clearSessionNotifications(sessionId) {
  if (!sessionId) return;
  const a = notifyAttention.delete(sessionId);
  const b = notifyResponseReady.delete(sessionId);
  if (a || b) refreshDockBadge();
}

// Legacy bridge — kept harmless; the renderer no longer drives notifications.
ipcMain.on('notify-session', (_event, payload) => {
  const { body, sessionId } = payload || {};
  showOsNotification(body, sessionId);
});

// The renderer reports which session is focused (so we don't alert the one being
// viewed) and pushes the notifications on/off setting.
ipcMain.on('set-active-session', (_event, sessionId) => {
  notifyActiveSessionId = sessionId || null;
  clearSessionNotifications(sessionId); // viewing a session acknowledges its alerts
});
ipcMain.on('set-notifications-enabled', (_event, enabled) => {
  notificationsEnabled = enabled !== false;
  refreshDockBadge();
});

// --- IPC: MCP bridge ---
ipcMain.on('mcp-diff-response', (_event, sessionId, diffId, action, editedContent) => {
  resolvePendingDiff(sessionId, diffId, action, editedContent);
});

ipcMain.handle('read-file-for-panel', async (_event, filePath) => {
  try {
    const resolved = path.resolve(filePath);
    if (isSensitivePath(resolved)) return { ok: false, error: 'access to sensitive path denied' };
    const content = fs.readFileSync(resolved, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('save-file-for-panel', async (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (isSensitivePath(resolved)) return { ok: false, error: 'access to sensitive path denied' };
    if (!fs.existsSync(resolved)) return { ok: false, error: 'File does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── File Watching (for viewer panels) ────────────────────────────────
const fileWatchers = new Map(); // filePath → FSWatcher

ipcMain.handle('watch-file', (_event, filePath) => {
  const resolved = path.resolve(filePath);
  if (isSensitivePath(resolved)) return { ok: false, error: 'access to sensitive path denied' };
  if (fileWatchers.has(resolved)) return { ok: true };
  try {
    let debounce = null;
    const watcher = fs.watch(resolved, (eventType) => {
      if (eventType !== 'change') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('file-changed', resolved);
        }
      }, 300);
    });
    // Without this, an OS-level watch error (inotify ENOSPC/EMFILE, fd loss) emits
    // an unhandled 'error' on the FSWatcher and crashes the main process (no global
    // uncaughtException handler). Reap the dead watcher so a later re-watch recreates it.
    watcher.on('error', (err) => {
      log.warn('[watch-file] watcher error for', resolved, err.message);
      try { watcher.close(); } catch (_) {}
      fileWatchers.delete(resolved);
    });
    fileWatchers.set(resolved, watcher);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('unwatch-file', (_event, filePath) => {
  const resolved = path.resolve(filePath);
  const watcher = fileWatchers.get(resolved);
  if (watcher) {
    watcher.close();
    fileWatchers.delete(resolved);
  }
  return { ok: true };
});

ipcMain.handle('get-projects', async (_event, showArchived) => {
  try {
    const needsPopulate = !isCachePopulated() || !isSearchIndexPopulated();

    if (needsPopulate) {
      // First call after a migration that clears session_cache (e.g. v4) finds
      // an empty cache. Returning [] immediately makes the renderer paint an
      // empty list and rely on `notifyRendererProjectsChanged` firing later —
      // which only triggers a reload if the user is on the Sessions tab. To
      // avoid that race, await the scan here so the response carries the
      // freshly-populated cache. Concurrent callers share the same Promise.
      await populateCacheViaWorker();
    }

    // Pick up folders changed while the app was closed, or never indexed by an
    // older build, so sessions/worktrees don't silently go missing. Stat-gated,
    // so it's cheap when nothing has changed.
    reconcileCacheFromFilesystem();
    return buildProjectsFromCache(showArchived);
  } catch (err) {
    console.error('Error listing projects:', err);
    return [];
  }
});

// --- IPC: rebuild-cache ---
// Manual full re-scan, triggered by the sidebar refresh button. Forces a fresh
// worker pass that re-reads every project, rebuilds the search index, and prunes
// rows for sessions/folders that have since been deleted (ghost cleanup). Awaits
// completion so the renderer can stop its spinner; the scan emits
// 'projects-changed' on finish, which reloads the sidebar.
ipcMain.handle('rebuild-cache', async () => {
  try {
    await populateCacheViaWorker();
    return { ok: true };
  } catch (err) {
    console.error('Error rebuilding cache:', err);
    return { ok: false, error: String(err && err.message || err) };
  }
});

// --- IPC: get-plans ---
ipcMain.handle('get-plans', () => {
  try {
    if (!fs.existsSync(PLANS_DIR)) return [];
    const files = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md'));
    const plans = [];
    for (const file of files) {
      const filePath = path.join(PLANS_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const firstLine = content.split('\n').find(l => l.trim());
        const title = firstLine && firstLine.startsWith('# ')
          ? firstLine.slice(2).trim()
          : file.replace(/\.md$/, '');
        plans.push({ filename: file, title, modified: stat.mtime.toISOString() });
      } catch {}
    }
    plans.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    // Index plans for FTS
    try {
      deleteSearchType('plan');
      upsertSearchEntries(plans.map(p => ({
        id: p.filename, type: 'plan', folder: null,
        title: p.title,
        body: fs.readFileSync(path.join(PLANS_DIR, p.filename), 'utf8'),
      })));
    } catch {}

    return plans;
  } catch (err) {
    console.error('Error reading plans:', err);
    return [];
  }
});

// --- IPC: read-plan ---
ipcMain.handle('read-plan', (_event, filename) => {
  const filePath = path.join(PLANS_DIR, path.basename(filename));
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { ok: true, content, filePath };
  } catch (err) {
    // Discriminated result so the renderer shows a read error instead of opening a
    // blank editor that could then be SAVED over the file.
    console.error('Error reading plan:', err);
    return { ok: false, error: err.message, filePath };
  }
});

// --- IPC: save-plan ---
ipcMain.handle('save-plan', (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    // Prefix match WITH a trailing separator (so `plans-evil/` can't pass) and
    // restrict to .md, mirroring isAllowedMemoryPath.
    if ((resolved !== PLANS_DIR && !resolved.startsWith(PLANS_DIR + path.sep)) || !resolved.toLowerCase().endsWith('.md')) {
      return { ok: false, error: 'path outside plans directory or not a .md file' };
    }
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    console.error('Error saving plan:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: get-stats ---
ipcMain.handle('get-stats', () => {
  try {
    if (!fs.existsSync(STATS_CACHE_PATH)) return null;
    const raw = fs.readFileSync(STATS_CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading stats cache:', err);
    return null;
  }
});

// --- IPC: get-token-analytics (derived from the JSONL scan cache) ---
// Per-model token breakdown + tool-call / subagent-invocation totals that
// Claude's /stats doesn't surface. Tokens for very large (>2MB) transcripts are
// approximate (the scan caps reads at 2MB).
ipcMain.handle('get-token-analytics', () => {
  try {
    const rows = getAllCached();
    const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, toolCalls: 0, subagentInvocations: 0, parentSessions: 0, subagentSessions: 0 };
    const byModel = {};
    for (const r of rows) {
      const isSub = typeof r.sessionId === 'string' && r.sessionId.startsWith('sub:');
      if (isSub) t.subagentSessions++; else t.parentSessions++;
      t.inputTokens += r.inputTokens || 0;
      t.outputTokens += r.outputTokens || 0;
      t.cacheReadTokens += r.cacheReadTokens || 0;
      t.cacheCreationTokens += r.cacheCreationTokens || 0;
      t.toolCalls += r.toolCalls || 0;
      t.subagentInvocations += r.subagentInvocations || 0;
      const m = r.model || 'unknown';
      const mm = byModel[m] || (byModel[m] = { model: m, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, sessions: 0 });
      mm.inputTokens += r.inputTokens || 0;
      mm.outputTokens += r.outputTokens || 0;
      mm.cacheReadTokens += r.cacheReadTokens || 0;
      mm.cacheCreationTokens += r.cacheCreationTokens || 0;
      mm.sessions++;
    }
    const total = (m) => m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens;
    const models = Object.values(byModel).filter(total).sort((a, b) => total(b) - total(a));
    return { totals: t, models };
  } catch (e) {
    log.warn('[token-analytics]', e?.message || e);
    return { error: e.message };
  }
});

// --- IPC: refresh-stats (run /stats + /usage via PTY) ---
ipcMain.handle('refresh-stats', async () => {
  // For stats, use the configured shell profile
  const globalSettings = getSetting('global') || {};
  const statsProfileId = globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile;
  const statsShellProfile = resolveShell(statsProfileId);
  const statsShell = statsShellProfile.path;
  const statsShellExtraArgs = statsShellProfile.args || [];
  const ptyEnv = {
    ...cleanPtyEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'iTerm.app',
    TERM_PROGRAM_VERSION: '3.6.6',
    FORCE_COLOR: '3',
    ITERM_SESSION_ID: '1',
  };

  // Helper: spawn claude with args, collect output, auto-accept trust, kill when idle
  // waitFor: optional regex tested against stripped output — finish only when matched
  function runClaude(args, { timeoutMs = 15000, waitFor = null } = {}) {
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      let trustAccepted = false;
      // Track idle: ✳ in OSC title means Claude is idle and waiting for input
      let sawActivity = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        try { p.kill(); } catch {}
        resolve(output);
      };

      const claudeCmd = `claude ${args}`;
      const p = pty.spawn(statsShell, shellArgs(statsShell, claudeCmd, statsShellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: os.homedir(),
        env: ptyEnv,
      });

      const strip = (s) => s
        .replace(/\x1b\[[^@-~]*[@-~]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b[^[\]].?/g, '');

      p.onData((data) => {
        output += data;

        // Auto-accept trust directory prompt (Enter selects "1. Yes")
        if (!trustAccepted) {
          if (/trust\s*this\s*folder/i.test(strip(output))) {
            trustAccepted = true;
            try { p.write('\r'); } catch {}
            return;
          }
        }

        // If waitFor is set, finish when that pattern appears in stripped output
        if (waitFor) {
          if (waitFor.test(strip(output))) {
            finish();
          }
          return;
        }

        // Default: detect busy→idle transition via OSC title containing ✳
        if (!sawActivity) {
          const oscTitle = data.match(/\x1b\]0;([^\x07\x1b]*)/);
          if (oscTitle) {
            const first = oscTitle[1].charAt(0);
            if (first.charCodeAt(0) >= 0x2800 && first.charCodeAt(0) <= 0x28FF) {
              sawActivity = true;
            }
          }
        } else if (data.includes('\u2733')) {
          finish();
        }
      });

      p.onExit(() => finish());
      setTimeout(finish, timeoutMs);
    });
  }

  try {
    // Run /stats via PTY (for heatmap/chart data) and fetch usage via API in parallel
    const [, usage] = await Promise.all([
      runClaude('"/stats"', { waitFor: /streak/i, timeoutMs: 10000 }),
      fetchAndTransformUsage().catch(() => ({})),
    ]);

    // Read refreshed stats cache
    let stats = null;
    try {
      if (fs.existsSync(STATS_CACHE_PATH)) {
        stats = JSON.parse(fs.readFileSync(STATS_CACHE_PATH, 'utf8'));
      }
    } catch {}

    return { stats, usage: usage || {} };
  } catch (err) {
    log.error('Error refreshing stats:', err);
    return { stats: null, usage: {} };
  }
});

// --- IPC: get-usage (lightweight, API-only, no PTY) ---
ipcMain.handle('get-usage', async () => {
  try {
    return await fetchAndTransformUsage() || {};
  } catch (err) {
    log.error('Error fetching usage:', err);
    return {};
  }
});

// --- IPC: get-memories ---
function folderToShortPath(folder) {
  // Convert "-Users-home-dev-MyClaude" → "dev/MyClaude"
  const parts = folder.replace(/^-/, '').split('-');
  const meaningful = parts.filter(Boolean);
  return meaningful.slice(-2).join('/');
}

/** Scan a directory for .md files (non-recursive). Returns array of { filename, filePath, modified }. */
function scanMdFiles(dir) {
  const results = [];
  try {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const fp = path.join(dir, e.name);
        const content = fs.readFileSync(fp, 'utf8').trim();
        if (content) {
          const stat = fs.statSync(fp);
          results.push({ filename: e.name, filePath: fp, modified: stat.mtime.toISOString() });
        }
      }
    }
  } catch {}
  return results;
}

ipcMain.handle('get-memories', () => {
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);

  // --- Global files ---
  const globalFiles = scanMdFiles(CLAUDE_DIR).map(f => ({ ...f, displayPath: '~/.claude' }));

  // --- Per-project files ---
  const projects = [];
  try {
    if (fs.existsSync(PROJECTS_DIR)) {
      const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.git')
        .map(d => d.name);

      for (const folder of folders) {
        const folderPath = path.join(PROJECTS_DIR, folder);
        const projectPath = deriveProjectPath(folderPath, folder);
        if (projectPath && hiddenProjects.has(projectPath)) continue;

        // Use same 2-deep short path as Sessions tab (e.g. "dev/MyClaude")
        const shortName = projectPath
          ? projectPath.split('/').filter(Boolean).slice(-2).join('/')
          : folderToShortPath(folder);
        const files = [];
        const seenPaths = new Set();

        // 1. ~/.claude/projects/{folder}/ — claude-home .md files
        const claudeHomeFiles = scanMdFiles(folderPath);
        for (const f of claudeHomeFiles) {
          files.push({ ...f, displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }
        // memory/MEMORY.md
        const memoryDir = path.join(folderPath, 'memory');
        const memoryFiles = scanMdFiles(memoryDir);
        for (const f of memoryFiles) {
          files.push({ ...f, displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }

        // 2. {projectPath}/ — project root CLAUDE.md, agents.md
        if (projectPath) {
          for (const name of ['CLAUDE.md', 'GEMINI.md', 'agents.md']) {
            const fp = path.join(projectPath, name);
            try {
              if (fs.existsSync(fp)) {
                const content = fs.readFileSync(fp, 'utf8').trim();
                if (content && !seenPaths.has(fp)) {
                  const stat = fs.statSync(fp);
                  files.push({ filename: name, filePath: fp, modified: stat.mtime.toISOString(), displayPath: shortName + '/', source: 'project' });
                  seenPaths.add(fp);
                }
              }
            } catch {}
          }

          // 3. {projectPath}/.claude/ — commands/*.md and other .md files
          const dotClaudeDir = path.join(projectPath, '.claude');
          const dotClaudeFiles = scanMdFiles(dotClaudeDir);
          for (const f of dotClaudeFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...f, displayPath: shortName + '/.claude/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
          // commands/*.md
          const commandsDir = path.join(dotClaudeDir, 'commands');
          const commandFiles = scanMdFiles(commandsDir);
          for (const f of commandFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...f, displayPath: shortName + '/.claude/commands/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
        }

        if (files.length > 0) {
          projects.push({ folder, projectPath: projectPath || '', shortName, files });
        }
      }
    }
  } catch (err) {
    console.error('Error scanning memories:', err);
  }

  // Sort projects by most recent file modified date
  projects.sort((a, b) => {
    const aMax = Math.max(...a.files.map(f => new Date(f.modified).getTime()));
    const bMax = Math.max(...b.files.map(f => new Date(f.modified).getTime()));
    return bMax - aMax;
  });

  const result = { global: { files: globalFiles }, projects };

  // Index all files for FTS
  try {
    deleteSearchType('memory');
    const allFiles = [
      ...globalFiles.map(f => ({ ...f, label: 'Global' })),
      ...projects.flatMap(p => p.files.map(f => ({ ...f, label: p.shortName }))),
    ];
    upsertSearchEntries(allFiles.map(f => ({
      id: f.filePath, type: 'memory', folder: null,
      title: f.label + ' ' + f.filename,
      body: fs.readFileSync(f.filePath, 'utf8'),
    })));
  } catch {}

  return result;
});

// --- IPC: read-memory ---
ipcMain.handle('read-memory', (_event, filePath) => {
  const resolved = path.resolve(filePath);
  if (!resolved.endsWith('.md')) return { ok: false, error: 'not a .md file' };
  if (!isAllowedMemoryPath(resolved)) return { ok: false, error: 'path not allowed' };
  try {
    return { ok: true, content: fs.readFileSync(resolved, 'utf8') };
  } catch (err) {
    // Discriminated result so a read error shows instead of a blank, saveable editor.
    console.error('Error reading memory file:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: save-memory ---
ipcMain.handle('save-memory', (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.endsWith('.md')) return { ok: false, error: 'not a .md file' };
    if (!isAllowedMemoryPath(resolved)) return { ok: false, error: 'path not allowed' };
    if (!fs.existsSync(resolved)) return { ok: false, error: 'file does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    console.error('Error saving memory file:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: search ---
ipcMain.handle('search', (_event, type, query, titleOnly) => {
  return searchByType(type, query, 50, !!titleOnly);
});

// --- IPC: settings ---
ipcMain.handle('get-setting', (_event, key) => {
  return getSetting(key);
});

ipcMain.handle('set-setting', (_event, key, value) => {
  setSetting(key, value);
  return { ok: true };
});

ipcMain.handle('delete-setting', (_event, key) => {
  deleteSetting(key);
  return { ok: true };
});

// --- Scheduled tasks ---
const scheduleIpc = require('./schedule-ipc');

const SETTING_DEFAULTS = {
  permissionMode: null,
  dangerouslySkipPermissions: false,
  worktree: false,
  worktreeName: '',
  chrome: false,
  preLaunchCmd: '',
  addDirs: '',
  visibleSessionCount: 5,
  sidebarWidth: 340,
  terminalTheme: 'switchboard',
  mcpEmulation: false,
  shellProfile: 'auto',
};

ipcMain.handle('get-shell-profiles', () => {
  _shellProfiles = null; // refresh on each request
  return getShellProfiles();
});

ipcMain.handle('get-effective-settings', (_event, projectPath) => {
  const global = getSetting('global') || {};
  const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
  const effective = { ...SETTING_DEFAULTS };
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    if (global[key] !== undefined && global[key] !== null) {
      effective[key] = global[key];
    }
    if (project[key] !== undefined && project[key] !== null) {
      effective[key] = project[key];
    }
  }
  return effective;
});

// --- IPC: get-active-sessions ---
ipcMain.handle('get-active-sessions', () => {
  const active = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited) active.push(sessionId);
  }
  return active;
});

// --- IPC: get-active-terminals --- (plain terminal sessions for renderer restore)
ipcMain.handle('get-active-terminals', () => {
  const terminals = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited && session.isPlainTerminal) {
      terminals.push({ sessionId, projectPath: session.projectPath });
    }
  }
  return terminals;
});

// --- IPC: stop-session ---
ipcMain.handle('stop-session', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (!session || session.exited) return { ok: false, error: 'not running' };
  session.pty.kill();
  return { ok: true };
});

// --- IPC: toggle-star ---
ipcMain.handle('toggle-star', (_event, sessionId) => {
  const starred = toggleStar(sessionId);
  return { starred };
});

// --- IPC: rename-session ---
ipcMain.handle('rename-session', (_event, sessionId, name) => {
  setName(sessionId, name || null, 'user'); // UI rename — protected from JSONL custom-title clobber
  // Update search index title to include the new name
  const cached = getCachedSession(sessionId);
  const summary = cached?.summary || '';
  updateSearchTitle(sessionId, 'session', (name ? name + ' ' : '') + summary);
  return { name: name || null };
});

// --- IPC: archive-session ---
ipcMain.handle('read-session-jsonl', (_event, sessionId) => {
  const folder = getCachedFolder(sessionId);
  if (!folder) return { error: 'Session not found in cache' };
  const jsonlPath = path.join(PROJECTS_DIR, folder, sessionId + '.jsonl');
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const entries = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return { entries };
  } catch (err) {
    return { error: err.message };
  }
});

// Meta de session pour le header (modele, branche git, tokens) — parsé du .jsonl.
// Le .jsonl porte deja message.model, message.usage et gitBranch par entrée.
ipcMain.handle('get-session-meta', (_event, sessionId) => {
  const folder = getCachedFolder(sessionId);
  if (!folder) return {};
  const jsonlPath = path.join(PROJECTS_DIR, folder, sessionId + '.jsonl');
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    let model = null, gitBranch = null, cwd = null, ctxTokens = 0, outTokens = 0;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.gitBranch) gitBranch = e.gitBranch;
      if (e.cwd) cwd = e.cwd;
      const m = e.message;
      if (m && m.model && m.model !== '<synthetic>') model = m.model;
      const u = m && m.usage;
      if (u) {
        outTokens += (u.output_tokens || 0);
        // Contexte courant = derniere usage observee (entree + cache lu + cache cree).
        ctxTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      }
    }
    return { model, gitBranch, cwd, ctxTokens, outTokens };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('read-subagent-jsonl', (_event, parentSessionId, agentId) => {
  const row = getCachedSession('sub:' + parentSessionId + ':' + agentId);
  if (!row) return { error: 'Subagent session not found in cache' };
  const jsonlPath = path.join(PROJECTS_DIR, row.folder, parentSessionId, 'subagents', 'agent-' + agentId + '.jsonl');
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const entries = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return { entries };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('list-subagents', (_event, parentSessionId) => {
  return getCachedByParent(parentSessionId).map(r => ({
    sessionId: r.sessionId,
    agentId: r.agentId,
    subagentType: r.subagentType,
    description: r.description,
    modified: r.modified,
    messageCount: r.messageCount,
  }));
});

ipcMain.handle('archive-session', (_event, sessionId, archived) => {
  const val = archived ? 1 : 0;
  setArchived(sessionId, val);
  return { archived: val };
});

// --- IPC: open-terminal ---
ipcMain.handle('open-terminal', async (_event, sessionId, projectPath, isNew, sessionOptions) => {
  if (!mainWindow) return { ok: false, error: 'no window' };

  // Reattach to existing session
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    session.rendererAttached = true;
    session.firstResize = !session.isPlainTerminal;

    // If TUI is in alternate screen mode, send escape to switch into it
    if (session.altScreen && !session.isPlainTerminal) {
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?1049h');
    }

    // Send buffered output for reattach
    for (const chunk of session.outputBuffer) {
      mainWindow.webContents.send('terminal-data', sessionId, chunk);
    }

    if (!session.isPlainTerminal) {
      // Hide cursor after buffer replay — the live PTY stream or resize nudge
      // will re-show it at the correct position, avoiding a stale cursor artifact
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?25l');
    }

    return { ok: true, reattached: true, mcpActive: !!session.mcpServer };
  }

  // Spawn new PTY
  if (!fs.existsSync(projectPath)) {
    return { ok: false, error: `project directory no longer exists: ${projectPath}` };
  }

  const isPlainTerminal = sessionOptions?.type === 'terminal';

  // Resolve shell profile from effective settings
  const effectiveProfileId = (() => {
    const global = getSetting('global') || {};
    const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
    let profileId = SETTING_DEFAULTS.shellProfile;
    if (global.shellProfile !== undefined && global.shellProfile !== null) profileId = global.shellProfile;
    if (project.shellProfile !== undefined && project.shellProfile !== null) profileId = project.shellProfile;
    return profileId;
  })();
  // WSL profiles only work for plain terminals — Claude CLI sessions need the
  // Windows shell because session data lives on the Windows filesystem.
  const requestedProfile = resolveShell(effectiveProfileId);
  const useWslProfile = isWslShell(requestedProfile.path) && isPlainTerminal;
  const shellProfile = (isWslShell(requestedProfile.path) && !isPlainTerminal)
    ? resolveShell('auto')
    : requestedProfile;
  const shell = shellProfile.path;
  const shellExtraArgs = [...(shellProfile.args || [])];
  const isWsl = isWslShell(shell);
  // For WSL, convert Windows path to /mnt/ path and pass via --cd;
  // the spawn cwd must remain a valid Windows path for wsl.exe itself.
  if (isWsl) {
    const wslCwd = windowsToWslPath(projectPath);
    shellExtraArgs.unshift('--cd', wslCwd);
  }
  log.info(`[shell] profile=${shellProfile.id} shell=${shell} args=${JSON.stringify(shellExtraArgs)}`);

  let knownJsonlFiles = new Set();
  let sessionSlug = null;
  let projectFolder = null;

  if (!isPlainTerminal) {
    // Snapshot existing .jsonl files before spawning (for new session + fork/plan detection)
    projectFolder = encodeProjectPath(projectPath);
    const claudeProjectDir = path.join(PROJECTS_DIR, projectFolder);
    if (fs.existsSync(claudeProjectDir)) {
      try {
        knownJsonlFiles = new Set(
          fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'))
        );
      } catch {}
    }

    // Read slug from the session's jsonl file (for plan-accept detection)
    if (!isNew) {
      try {
        const jsonlPath = path.join(claudeProjectDir, sessionId + '.jsonl');
        const head = fs.readFileSync(jsonlPath, 'utf8').slice(0, 8000);
        const firstLines = head.split('\n').filter(Boolean);
        for (const line of firstLines) {
          const entry = JSON.parse(line);
          if (entry.slug) { sessionSlug = entry.slug; break; }
        }
      } catch {}
    }
  }

  let ptyProcess;
  let mcpServer = null;
  let mcpStartError = null;
  try {
    if (isPlainTerminal) {
      // Plain terminal: interactive login shell, no claude command
      // Inject a shell function to override `claude` with a helpful message
      const claudeShim = 'claude() { echo "\\033[33mTo start a Claude session, use the + button in the sidebar.\\033[0m"; return 1; }; export -f claude 2>/dev/null;';
      ptyProcess = pty.spawn(shell, shellArgs(shell, undefined, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        env: {
          ...cleanPtyEnv,
          TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
          CLAUDECODE: '1',
          // ZDOTDIR trick won't work reliably; instead inject via ENV (sh/bash) or precmd
          ENV: claudeShim,
          BASH_ENV: claudeShim,
        },
      });
      // For zsh, ENV/BASH_ENV don't apply — write the function after shell starts
      setTimeout(() => {
        if (!ptyProcess._isDisposed) {
          try {
            ptyProcess.write(claudeShim + ' clear\n');
          } catch {}
        }
      }, 300);
    } else {
      // Build claude command, using array to prevent accidental shell injection
      const claudeArgs = [];
      if (sessionOptions?.forkFrom) {
        claudeArgs.push('--resume', String(sessionOptions.forkFrom), '--fork-session');
      } else if (isNew) {
        claudeArgs.push('--session-id', String(sessionId));
      } else {
        claudeArgs.push('--resume', String(sessionId));
      }

      if (sessionOptions) {
        if (sessionOptions.dangerouslySkipPermissions) {
          claudeArgs.push('--dangerously-skip-permissions');
        } else if (sessionOptions.permissionMode) {
          claudeArgs.push('--permission-mode', String(sessionOptions.permissionMode));
        }
        if (sessionOptions.worktree) {
          claudeArgs.push('--worktree');
          if (sessionOptions.worktreeName) {
            claudeArgs.push(String(sessionOptions.worktreeName));
          }
        }
        if (sessionOptions.chrome) {
          claudeArgs.push('--chrome');
        }
        if (sessionOptions.addDirs) {
          const dirs = String(sessionOptions.addDirs).split(',').map(d => d.trim()).filter(Boolean);
          for (const dir of dirs) {
            claudeArgs.push('--add-dir', dir);
          }
        }
      }

      if (sessionOptions?.appendSystemPrompt) {
        claudeArgs.push('--append-system-prompt', String(sessionOptions.appendSystemPrompt));
      }

      let claudeCmd = 'claude ' + quoteArgvForShell(shell, claudeArgs);

      // preLaunchCmd is raw shell by design (e.g. "aws-vault exec profile --") — block newlines only
      if (sessionOptions?.preLaunchCmd) {
        const pre = String(sessionOptions.preLaunchCmd);
        if (/[\r\n]/.test(pre)) {
          return { ok: false, error: 'preLaunchCmd must not contain newlines' };
        }
        claudeCmd = pre + ' ' + claudeCmd;
      }

      // Start MCP server for this session so Claude CLI sends diffs/file opens to Switchboard
      // (skip if user disabled IDE emulation in global settings)
      if (sessionOptions?.mcpEmulation !== false) {
        try {
          mcpServer = await startMcpServer(sessionId, [projectPath], mainWindow, log);
          claudeCmd += ' --ide';
        } catch (err) {
          log.error(`[mcp] Failed to start MCP server for ${sessionId}: ${err.message}`);
          mcpStartError = err.message;
        }
      }

      const ptyEnv = {
        ...cleanPtyEnv,
        TERM: 'xterm-256color', COLORTERM: 'truecolor',
        TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
      };
      if (mcpServer) {
        ptyEnv.CLAUDE_CODE_SSE_PORT = String(mcpServer.port);
      }

      ptyProcess = pty.spawn(shell, shellArgs(shell, claudeCmd, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        // TERM_PROGRAM=iTerm.app: Claude Code checks this to decide whether to emit
        // OSC 9 notifications (e.g. "needs your attention"). Without it, the packaged
        // app's minimal Electron environment won't trigger those sequences.
        env: ptyEnv,
      });

    }
  } catch (err) {
    return { ok: false, error: `Error spawning PTY: ${err.message}` };
  }

  const session = {
    pty: ptyProcess, rendererAttached: true, exited: false,
    outputBuffer: [], outputBufferSize: 0, altScreen: false,
    projectPath, firstResize: true,
    projectFolder, knownJsonlFiles, sessionSlug,
    isPlainTerminal, forkFrom: sessionOptions?.forkFrom || null,
    mcpServer, _openedAt: Date.now(),
  };
  activeSessions.set(sessionId, session);

  ptyProcess.onData(data => {
    const currentId = session.realSessionId || sessionId;

    // Parse OSC sequences (title changes, progress, notifications, etc.)
    if (data.includes('\x1b]')) {
      const oscMatches = data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const m of oscMatches) {
        const code = m[1];
        const payload = m[2].slice(0, 120);
        // Detect Claude CLI busy state from OSC 0 title (spinner chars = busy, ✳ = idle)
        if (code === '0') {
          const firstChar = payload.charAt(0);
          const isBusy = firstChar.charCodeAt(0) >= 0x2800 && firstChar.charCodeAt(0) <= 0x28FF;
          const isIdle = firstChar === '\u2733'; // ✳
          log.debug(`[OSC 0] session=${currentId} char=U+${firstChar.charCodeAt(0).toString(16).toUpperCase()} busy=${isBusy} idle=${isIdle} wasBusy=${!!session._cliBusy}`);
          if (isBusy && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            log.debug(`[OSC 0] session=${currentId} → BUSY`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
            }
            // Resumed work → no longer "finished"; let the next idle re-notify.
            if (notifyResponseReady.delete(currentId)) refreshDockBadge();
          } else if (isIdle && session._cliBusy) {
            session._cliBusy = false;
            session._oscIdle = true;
            log.debug(`[OSC 0] session=${currentId} → IDLE`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, false);
            }
            // Fire "finished" from main so it lands even when the window is hidden.
            notifySessionFinished(currentId);
          }
        }
      }
      // Parse iTerm2 OSC 9 sequences (terminated by BEL \x07 or ST \x1b\\)
      const osc9Matches = data.matchAll(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const osc9 of osc9Matches) {
        const payload = osc9[1];
        // OSC 9;4 progress: 4;0; = clear/done, 4;1;N = running at N%, 4;2;N = error, 4;3; = indeterminate
        if (payload.startsWith('4;')) {
          const level = payload.split(';')[1];
          if (level === '0') continue; // 4;0 is also used for clearing, making it unreliable as an idle signal
          log.debug(`[OSC 9;4] session=${currentId} level=${level} payload="${payload}" wasBusy=${!!session._cliBusy}`);
          if ((level === '1' || level === '2' || level === '3') && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            log.debug(`[OSC 9;4] session=${currentId} → BUSY`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
            }
          }
        } else {
          // Regular notification (attention, permission, etc.)
          log.info(`[OSC 9] session=${currentId} message="${payload}"`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('terminal-notification', currentId, payload);
          }
          // Decide + fire the OS notification in main so it works when the
          // renderer is suspended (occluded / minimized / on another Space).
          if (/attention|approval|permission|needs your|wants to enter/i.test(payload)) {
            notifySessionAttention(currentId);
          }
        }
      }
    }

    // Standalone BEL (not part of an OSC sequence)
    if (data.includes('\x07') && !data.includes('\x1b]')) {
      log.info(`[BEL] session=${currentId}`);
    }

    // Track alternate screen mode (only if data contains the marker)
    if (data.includes('\x1b[?')) {
      if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
        session.altScreen = true;
        log.info(`[altscreen] session=${currentId} ON`);
      }
      if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
        session.altScreen = false;
        log.info(`[altscreen] session=${currentId} OFF`);
      }
    }

    // Buffer output (skip resize-triggered redraws for plain terminals)
    if (!session._suppressBuffer) {
      session.outputBuffer.push(data);
      session.outputBufferSize += data.length;
      while (session.outputBufferSize > MAX_BUFFER_SIZE && session.outputBuffer.length > 1) {
        session.outputBufferSize -= session.outputBuffer.shift().length;
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', currentId, data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.exited = true;
    // Clean up MCP server
    const mcpId = session.realSessionId || sessionId;
    shutdownMcpServer(mcpId);
    session.mcpServer = null;

    const realId = session.realSessionId || sessionId;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process-exited', realId, exitCode);
      // If a fork/plan-accept transition re-keyed this session under realId
      // but the PTY exited before transition detection ran, also notify the
      // renderer for the original sessionId so it doesn't stay stuck as "Running".
      if (realId !== sessionId && activeSessions.has(sessionId)) {
        mainWindow.webContents.send('process-exited', sessionId, exitCode);
      }
    }
    clearSessionNotifications(realId);
    activeSessions.delete(realId);
    // Clean up the original key too in case transition detection hasn't run yet
    activeSessions.delete(sessionId);
  });

  if (sessionOptions?.forkFrom) {
    log.info(`[fork-spawn] tempId=${sessionId} forkFrom=${sessionOptions.forkFrom} folder=${projectFolder} knownFiles=${knownJsonlFiles.size}`);
  }

  return { ok: true, reattached: false, mcpActive: !!mcpServer, mcpError: mcpStartError };
});

// --- IPC: terminal-input (fire-and-forget) ---
ipcMain.on('terminal-input', (_event, sessionId, data) => {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    session.pty.write(data);
  }
});

// --- IPC: terminal-resize (fire-and-forget) ---
ipcMain.on('terminal-resize', (_event, sessionId, cols, rows) => {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    // For plain terminals, suppress buffering during resize to avoid
    // accumulating prompt redraws that pollute reattach replay
    if (session.isPlainTerminal) session._suppressBuffer = true;

    session.pty.resize(cols, rows);

    if (session.isPlainTerminal) {
      setTimeout(() => { session._suppressBuffer = false; }, 200);
    }

    // First resize: nudge to force TUI redraw on reattach (skip for plain terminals — causes duplicate prompts)
    if (session.firstResize && !session.isPlainTerminal) {
      session.firstResize = false;
      setTimeout(() => {
        try {
          session.pty.resize(cols + 1, rows);
          setTimeout(() => {
            try { session.pty.resize(cols, rows); } catch {}
          }, 50);
        } catch {}
      }, 50);
    }
  }
});

// --- IPC: close-terminal ---
ipcMain.on('close-terminal', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.rendererAttached = false;
    if (session.exited) {
      activeSessions.delete(sessionId);
    }
  }
});

// Session transitions → session-transitions.js
const sessionTransitions = require('./session-transitions');
sessionTransitions.init({ PROJECTS_DIR, activeSessions, getMainWindow: () => mainWindow, log, rekeyMcpServer });
const { detectSessionTransitions } = sessionTransitions;

// --- fs.watch on projects directory ---
let projectsWatcher = null;

function startProjectsWatcher() {
  if (!fs.existsSync(PROJECTS_DIR)) return;

  const pendingFolders = new Set();
  let debounceTimer = null;

  function flushChanges() {
    debounceTimer = null;
    const folders = new Set(pendingFolders);
    pendingFolders.clear();

    // Folders that have a fork still waiting to be linked to its real session file.
    // Always re-run transition detection for them, even if they didn't fire this
    // cycle: a busy unrelated folder (e.g. an active session writing elsewhere)
    // would otherwise starve the fork's folder and the re-key would never run.
    const forkFolders = new Set();
    for (const s of activeSessions.values()) {
      if (s.forkFrom && !s.realSessionId && !s.exited && s.projectFolder && !folders.has(s.projectFolder)) {
        forkFolders.add(s.projectFolder);
      }
    }

    let changed = false;
    for (const folder of folders) {
      const folderPath = path.join(PROJECTS_DIR, folder);
      if (fs.existsSync(folderPath)) {
        detectSessionTransitions(folder);
        refreshFolder(folder);
      } else {
        deleteCachedFolder(folder);
      }
      changed = true;
    }
    // Detection only (no cache refresh / no forced notify): detectSessionTransitions
    // emits 'session-forked' itself when it matches, which updates the renderer.
    for (const folder of forkFolders) {
      if (fs.existsSync(path.join(PROJECTS_DIR, folder))) detectSessionTransitions(folder);
    }

    if (changed) {
      notifyRendererProjectsChanged();
    }
  }

  try {
    projectsWatcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      // filename is relative, e.g. "folder-name/sessions-index.json" or "folder-name/abc.jsonl"
      const parts = filename.split(path.sep);
      const folder = parts[0];
      if (!folder || folder === '.git') return;

      // Only care about .jsonl changes or top-level folder add/remove
      const basename = parts[parts.length - 1];
      if (parts.length === 1) {
        pendingFolders.add(folder);
      } else if (basename.endsWith('.jsonl')) {
        pendingFolders.add(folder);
      } else {
        return;
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushChanges, 500);
    });

    projectsWatcher.on('error', (err) => {
      console.error('Projects watcher error:', err);
    });
  } catch (err) {
    console.error('Failed to start projects watcher:', err);
  }
}

// --- IPC: app version ---
ipcMain.handle('get-app-version', () => app.getVersion());

// --- IPC: auto-updater (INERT in this fork) ---
// Auto-update is disabled (we build locally from our own repo; the configured
// feed points at upstream doctly releases). These handlers stay registered so a
// stray/regressed caller doesn't crash on a missing handler, but they must never
// touch the updater — invoking one would otherwise check/install the UPSTREAM
// build and overwrite this fork. Inert + loud.
ipcMain.handle('updater-check', () => {
  log.warn('[updater] check invoked but auto-update is disabled in this fork');
  return { available: false, disabled: true };
});
ipcMain.handle('updater-download', () => {
  log.warn('[updater] download invoked but auto-update is disabled in this fork');
  return { disabled: true };
});
ipcMain.handle('updater-install', () => {
  log.warn('[updater] install invoked but auto-update is disabled in this fork');
  return { disabled: true };
});

// --- IPC: delete-worktree ---
// Validated path pattern: <project>/.<segment>/[worktrees/]<name>
// Matches .claude/worktrees/<n>, .claude-worktrees/<n>, .worktrees/<n>
const WORKTREE_PATH_RE = /^(.+?)\/\.(?:claude\/worktrees|claude-worktrees|worktrees)\/([^/]+)\/?$/;

ipcMain.handle('delete-worktree', (_event, worktreePath) => {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    // Normalize trailing slash
    const normalizedPath = worktreePath.replace(/\/$/, '');

    // Validate path matches a known worktree layout
    const match = normalizedPath.match(WORKTREE_PATH_RE);
    if (!match) {
      return resolve({ ok: false, error: 'Path does not match a recognized worktree layout' });
    }
    const parentRepo = match[1];

    // Helper: run git worktree remove, optionally double-force
    function runRemove(doubleForce, callback) {
      const args = ['-C', parentRepo, 'worktree', 'remove', '-f'];
      if (doubleForce) args.push('-f');
      args.push('--', normalizedPath);
      execFile('git', args, (err, _stdout, stderr) => callback(err, stderr));
    }

    runRemove(false, (err, stderr) => {
      if (err && /locked/i.test(stderr || err.message || '')) {
        // Retry with double force for locked worktrees
        runRemove(true, (err2, stderr2) => {
          if (err2) return resolve({ ok: false, error: (stderr2 || err2.message || String(err2)).trim() });
          afterRemove();
        });
      } else if (err) {
        return resolve({ ok: false, error: (stderr || err.message || String(err)).trim() });
      } else {
        afterRemove();
      }
    });

    function afterRemove() {
      // Clean up DB cache: delete all sessions whose projectPath matches worktreePath
      let removed = 0;
      try {
        const allRows = getAllCached();
        for (const row of allRows) {
          if (row.projectPath === normalizedPath) {
            deleteCachedSession(row.sessionId);
            deleteSearchSession(row.sessionId);
            removed++;
          }
        }
      } catch (dbErr) {
        log.warn('[delete-worktree] DB cleanup error:', dbErr.message);
      }

      // Remove from hiddenProjects if present
      try {
        const global = getSetting('global') || {};
        if (Array.isArray(global.hiddenProjects) && global.hiddenProjects.includes(normalizedPath)) {
          global.hiddenProjects = global.hiddenProjects.filter(p => p !== normalizedPath);
          setSetting('global', global);
        }
      } catch {}

      // Also clean up folder meta
      try {
        const folder = encodeProjectPath(normalizedPath);
        deleteCachedFolder(folder);
        deleteSearchFolder(folder);
      } catch {}

      log.info(`[delete-worktree] removed=${normalizedPath} sessions=${removed}`);
      notifyRendererProjectsChanged();
      resolve({ ok: true, removed });
    }
  });
});

// --- App lifecycle ---
// Prevent a second Electron instance from killing active PTY sessions (e.g. when
// the app binary is replaced while running): the second launch would otherwise
// orphan/kill the first instance's node-pty sessions. requestSingleInstanceLock
// keeps a single instance; the second quits and the first window is focused.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Focus the existing window when a second launch is attempted.
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

app.whenReady().then(() => {
  // Set Content Security Policy
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self'"],
      },
    });
  });

  buildMenu();
  createWindow();
  startProjectsWatcher();
  scheduleIpc.ensureScheduleCreatorCommand();

  // Shared runCommand for cron scheduler and "run now" — takes argv, not a shell string
  const { spawn: cpSpawn } = require('child_process');
  function runScheduleCommand(claudeArgv, cwd, name, onDone) {
    const globalSettings = getSetting('global') || {};
    const profileId = globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile;
    const profile = resolveShell(profileId);
    const shell = profile.path;
    const cmd = 'claude ' + quoteArgvForShell(shell, claudeArgv);
    const args = shellArgs(shell, cmd, profile.args || []);

    log.info(`[schedule] Running: ${shell} ${args.join(' ')}`);
    const child = cpSpawn(shell, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...cleanPtyEnv, FORCE_COLOR: '0' },
    });

    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('exit', (code) => {
      if (stderr.trim()) log.error(`[schedule] ${name} stderr:\n${stderr.trim()}`);
      log.info(`[schedule] ${name} finished (exit ${code})`);
      if (code !== 0) {
        // Cron/run-now children aren't tracked in activeSessions, so use the
        // low-level OS notification + a renderer status line rather than the
        // session-keyed notify wrappers (which would no-op).
        const detail = stderr.trim().split('\n').pop() || `exit ${code}`;
        showOsNotification(`Scheduled task "${name}" failed: ${detail}`);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status-update', `Scheduled task "${name}" failed (exit ${code})`, 'error');
      }
      if (onDone) onDone(code);
    });

    child.on('error', (err) => {
      log.error(`[schedule] ${name} error:`, err.message);
      showOsNotification(`Scheduled task "${name}" failed: ${err.message}`);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status-update', `Scheduled task "${name}" failed: ${err.message}`, 'error');
      if (onDone) onDone(-1);
    });
  }

  scheduleIpc.init(log, runScheduleCommand);
  startScheduler(log, runScheduleCommand);

  // Re-index search if FTS table was recreated (e.g. tokenizer config change)
  if (searchFtsRecreated) populateCacheViaWorker();

  // Auto-update is intentionally disabled in this fork. We are built locally from
  // our own repo (no published releases), and the configured feed still points at
  // the upstream doctly releases — an automatic check would surface upstream builds
  // as "updates" and a click could overwrite this fork. So we do NOT schedule any
  // checkForUpdates here. The manual "Check for Updates" UI is also removed; the
  // updater module stays loaded but dormant.

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
} // end requestSingleInstanceLock else-branch

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Shut down all MCP servers
  shutdownAllMcp();

  // Close filesystem watcher
  if (projectsWatcher) {
    projectsWatcher.close();
    projectsWatcher = null;
  }

  // Kill all PTY processes on quit
  for (const [, session] of activeSessions) {
    if (!session.exited) {
      try { session.pty.kill(); } catch {}
    }
  }
});

// Close SQLite after all windows are closed to avoid "connection is not open" errors
app.on('will-quit', () => {
  closeDb();
});
