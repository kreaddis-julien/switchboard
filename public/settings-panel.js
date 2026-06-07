// Settings panel component — category nav (left) + panes (right), auto-save.
// Manages the global and project settings viewer UI.

(function () {
  const settingsViewer = document.getElementById('settings-viewer');
  const settingsViewerTitle = document.getElementById('settings-viewer-title');
  const settingsViewerBody = document.getElementById('settings-viewer-body');

  function closeSettingsViewer() {
    settingsViewer.style.display = 'none';
    const terminalArea = document.getElementById('terminal-area');
    const terminalHeader = document.getElementById('terminal-header');
    const placeholder = document.getElementById('placeholder');
    const gridViewActive = localStorage.getItem('gridViewActive') === '1';
    const activeSessionId = sessionStorage.getItem('activeSessionId') || null;
    if (activeSessionId && window._openSessions && window._openSessions.has(activeSessionId)) {
      terminalArea.style.display = '';
      terminalHeader.style.display = '';
    } else if (gridViewActive) {
      terminalArea.style.display = '';
    } else {
      placeholder.style.display = '';
    }
  }

  const row = (label, desc, control, ug = '') =>
    `<div class="settings-field">
      <div class="settings-field-info">
        <div class="settings-field-header"><span class="settings-label">${label}</span>${ug}</div>
        ${desc ? `<div class="settings-description">${desc}</div>` : ''}
      </div>
      <div class="settings-field-control">${control}</div>
    </div>`;

  async function openSettingsViewer(scope, projectPath) {
    const isProject = scope === 'project';
    const settingsKey = isProject ? 'project:' + projectPath : 'global';
    const current = (await window.api.getSetting(settingsKey)) || {};
    const globalSettings = isProject ? ((await window.api.getSetting('global')) || {}) : {};

    const shortName = isProject
      ? projectPath.split('/').filter(Boolean).slice(-2).join('/')
      : 'Global';
    settingsViewerTitle.textContent = (isProject ? 'Project Settings — ' : 'Settings — ') + shortName;

    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('terminal-area').style.display = 'none';
    document.getElementById('plan-viewer').style.display = 'none';
    document.getElementById('stats-viewer').style.display = 'none';
    document.getElementById('memory-viewer').style.display = 'none';
    document.getElementById('jsonl-viewer').style.display = 'none';
    settingsViewer.style.display = 'flex';

    const useGlobalCheckbox = (fieldName) => {
      if (!isProject) return '';
      const useGlobal = current[fieldName] === undefined || current[fieldName] === null;
      return `<label class="settings-use-global"><input type="checkbox" data-field="${fieldName}" class="use-global-cb" ${useGlobal ? 'checked' : ''}> Use global default</label>`;
    };
    const fieldValue = (fieldName, fallback) => {
      if (isProject && (current[fieldName] === undefined || current[fieldName] === null)) {
        return globalSettings[fieldName] !== undefined ? globalSettings[fieldName] : fallback;
      }
      return current[fieldName] !== undefined ? current[fieldName] : fallback;
    };
    const fieldDisabled = (fieldName) => {
      if (!isProject) return '';
      return (current[fieldName] === undefined || current[fieldName] === null) ? 'disabled' : '';
    };

    const permModeValue = fieldValue('permissionMode', '');
    const worktreeValue = fieldValue('worktree', false);
    const worktreeNameValue = fieldValue('worktreeName', '');
    const chromeValue = fieldValue('chrome', false);
    const preLaunchValue = fieldValue('preLaunchCmd', '');
    const addDirsValue = fieldValue('addDirs', '');
    const visCountValue = fieldValue('visibleSessionCount', 10);
    const maxAgeValue = fieldValue('sessionMaxAgeDays', 3);
    const themeValue = fieldValue('terminalTheme', 'auto');
    const appearanceValue = fieldValue('appearance', 'auto');
    const showPlansTabValue = fieldValue('showPlansTab', true);
    const showMemoryTabValue = fieldValue('showMemoryTab', true);
    const showStatsTabValue = fieldValue('showStatsTab', true);
    const soundNotificationsValue = fieldValue('soundNotifications', true);
    const systemNotificationsValue = fieldValue('systemNotifications', true);
    const openReadOnlyValue = fieldValue('openSessionsReadOnly', true);
    const mcpEmulationValue = fieldValue('mcpEmulation', true);
    const shellProfileValue = fieldValue('shellProfile', 'auto');

    let shellProfiles = [];
    try { shellProfiles = await window.api.getShellProfiles(); } catch (e) { console.warn('[settings] shell profiles unavailable', e); }

    const toggle = (id, on, dis = '') => `<label class="settings-toggle"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${dis}><span class="settings-toggle-slider"></span></label>`;

    // ---- CLI category (both scopes) ----
    const cliPane = `<div class="settings-pane" data-cat="cli">
      ${row('Permission Mode', 'Permission mode passed to the <code>claude</code> command',
        `<select class="settings-select" id="sv-perm-mode" ${fieldDisabled('permissionMode')}>
          <option value="">Default (none)</option>
          <option value="acceptEdits" ${permModeValue === 'acceptEdits' ? 'selected' : ''}>Accept Edits</option>
          <option value="plan" ${permModeValue === 'plan' ? 'selected' : ''}>Plan Mode</option>
          <option value="dontAsk" ${permModeValue === 'dontAsk' ? 'selected' : ''}>Don't Ask</option>
          <option value="bypassPermissions" ${permModeValue === 'bypassPermissions' ? 'selected' : ''}>Bypass</option>
        </select>`, useGlobalCheckbox('permissionMode'))}
      ${row('Worktree', 'Enable worktree for new sessions', toggle('sv-worktree', worktreeValue, fieldDisabled('worktree')), useGlobalCheckbox('worktree'))}
      ${row('Worktree Name', 'Custom name for worktree branches',
        `<input type="text" class="settings-input" id="sv-worktree-name" placeholder="auto" value="${escapeHtml(worktreeNameValue)}" ${fieldDisabled('worktreeName')} style="width:140px">`, useGlobalCheckbox('worktreeName'))}
      ${row('Chrome', 'Enable Chrome browser automation', toggle('sv-chrome', chromeValue, fieldDisabled('chrome')), useGlobalCheckbox('chrome'))}
      ${row('Additional Directories', 'Extra directories to include in Claude sessions',
        `<input type="text" class="settings-input" id="sv-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(addDirsValue)}" ${fieldDisabled('addDirs')}>`, useGlobalCheckbox('addDirs'))}
      ${row('Pre-launch Command', 'Prepended to the claude command (e.g. "aws-vault exec profile --")',
        `<input type="text" class="settings-input" id="sv-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(preLaunchValue)}" ${fieldDisabled('preLaunchCmd')}>`, useGlobalCheckbox('preLaunchCmd'))}
    </div>`;

    let nav, panes;

    if (isProject) {
      nav = [
        { cat: 'cli', label: 'Claude CLI' },
        { cat: 'project', label: 'Project' },
      ];
      panes = cliPane + `<div class="settings-pane" data-cat="project">
        ${row('Hide Project', 'Hides this project from the sidebar. Session files are not deleted.',
          '<button class="settings-remove-btn" id="sv-remove-btn">Hide Project</button>')}
      </div>`;
    } else {
      // Toolbar category: a draggable, re-orderable list with a placement select per action.
      const actions = window._toolbarActions || [];
      const placement = { ...(window._toolbarDefault || {}), ...(current.toolbarIcons || {}) };
      const order = current.toolbarOrder;
      const orderedActions = (Array.isArray(order) && order.length)
        ? order.map((k) => actions.find((a) => a.key === k)).filter(Boolean).concat(actions.filter((a) => !order.includes(a.key)))
        : actions;
      const toolbarRows = orderedActions.map((a) =>
        `<div class="toolbar-config-row" draggable="true" data-action="${a.key}">
          <span class="toolbar-drag-handle" title="Drag to reorder">⠿</span>
          <span class="toolbar-config-label">${a.label}</span>
          <select class="settings-select toolbar-place-select" data-toolbar-action="${a.key}">
            <option value="visible" ${placement[a.key] === 'visible' ? 'selected' : ''}>Toolbar</option>
            <option value="popover" ${placement[a.key] !== 'visible' ? 'selected' : ''}>In popover</option>
          </select>
        </div>`).join('');

      nav = [
        { cat: 'general', label: 'General' },
        { cat: 'notifications', label: 'Notifications' },
        { cat: 'sessions', label: 'Sessions' },
        { cat: 'sidebar', label: 'Sidebar' },
        { cat: 'toolbar', label: 'Toolbar' },
        { cat: 'cli', label: 'Claude CLI' },
        { cat: 'about', label: 'About' },
      ];
      panes = `
        <div class="settings-pane" data-cat="general">
          ${row('Appearance', 'App theme. Auto follows the macOS appearance (incl. automatic light/dark).',
            `<select class="settings-select" id="sv-appearance">
              <option value="auto" ${appearanceValue === 'auto' ? 'selected' : ''}>Auto (system)</option>
              <option value="light" ${appearanceValue === 'light' ? 'selected' : ''}>Light</option>
              <option value="dark" ${appearanceValue === 'dark' ? 'selected' : ''}>Dark</option>
            </select>`)}
          ${row('Terminal Theme', 'Color theme for terminal sessions',
            `<select class="settings-select" id="sv-terminal-theme">
              ${Object.entries(TERMINAL_THEMES).map(([key, t]) => `<option value="${key}" ${themeValue === key ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
            </select>`)}
          ${row('Shell Profile', 'Shell used for terminal and Claude sessions. Changes take effect for new sessions only.',
            `<select class="settings-select" id="sv-shell-profile">
              <option value="auto" ${shellProfileValue === 'auto' ? 'selected' : ''}>Auto (detect)</option>
              ${shellProfiles.map((p) => `<option value="${escapeHtml(p.id)}" ${shellProfileValue === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
            </select>`)}
        </div>

        <div class="settings-pane" data-cat="notifications">
          ${row('Sound Notifications', 'Play a chime when a non-focused session finishes a run or needs your attention', toggle('sv-sound-notif', soundNotificationsValue))}
          ${row('System Notifications', 'macOS Notification Center alert (click to focus the session) + a dock badge counting sessions that need attention', toggle('sv-system-notif', systemNotificationsValue))}
        </div>

        <div class="settings-pane" data-cat="sessions">
          ${row('Open Sessions Read-Only', 'Clicking a dormant session opens its transcript (read-only). Use "Resume" in the ⋯ menu, or double-click, to attach a terminal', toggle('sv-open-readonly', openReadOnlyValue))}
          ${row('Max Visible Sessions', 'Show up to this many sessions before collapsing the rest behind "+N older"',
            `<input type="number" class="settings-input settings-input-compact" id="sv-visible-count" min="1" max="100" value="${visCountValue}">`)}
          ${row('Session Max Age (days)', 'Projects whose newest session is older than this auto-collapse in the sidebar',
            `<input type="number" class="settings-input settings-input-compact" id="sv-max-age" min="1" max="365" value="${maxAgeValue}">`)}
          ${row('IDE Emulation', 'Emulate an IDE so Claude can open files and diffs in a side panel. Disable to use your own IDE instead. New sessions only.', toggle('sv-mcp-emulation', mcpEmulationValue))}
        </div>

        <div class="settings-pane" data-cat="sidebar">
          ${row('Show Plans Tab', 'Show the Plans tab in the sidebar', toggle('sv-show-plans', showPlansTabValue))}
          ${row('Show Agent Files Tab', 'Show the Agent Files (memory) tab in the sidebar', toggle('sv-show-memory', showMemoryTabValue))}
          ${row('Show Stats Tab', 'Show the Stats tab in the sidebar', toggle('sv-show-stats', showStatsTabValue))}
        </div>

        <div class="settings-pane" data-cat="toolbar">
          <div class="settings-pane-hint">Drag to reorder. Choose whether each action sits in the toolbar or behind the "more" (⋯) popover.</div>
          <div class="toolbar-config-list" id="sv-toolbar-list">${toolbarRows}</div>
        </div>

        ${cliPane}

        <div class="settings-pane" data-cat="about">
          ${row('Version', '<span id="sv-current-version"></span>', '')}
          ${row('Auto-update', 'Disabled in this fork — it is built locally from your own repo, so there are no releases to update from.', '<span class="settings-muted">Off</span>')}
        </div>`;
    }

    settingsViewerBody.innerHTML = `
      <div class="settings-shell">
        <nav class="settings-nav">
          ${nav.map((n, i) => `<button class="settings-nav-item${i === 0 ? ' active' : ''}" data-cat="${n.cat}">${n.label}</button>`).join('')}
          <div class="settings-nav-spacer"></div>
          <button class="settings-nav-done" id="sv-done-btn">Done</button>
        </nav>
        <div class="settings-panes" data-active="${nav[0].cat}">
          ${panes}
          <div class="settings-saved-indicator" id="sv-saved">Saved</div>
        </div>
      </div>`;

    // --- Category switching ---
    const panesWrap = settingsViewerBody.querySelector('.settings-panes');
    const showCat = (cat) => {
      panesWrap.dataset.active = cat;
      settingsViewerBody.querySelectorAll('.settings-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.cat === cat));
      settingsViewerBody.querySelectorAll('.settings-pane').forEach((p) => p.classList.toggle('active', p.dataset.cat === cat));
    };
    settingsViewerBody.querySelectorAll('.settings-nav-item').forEach((b) => b.addEventListener('click', () => showCat(b.dataset.cat)));
    showCat(nav[0].cat);

    // --- Saved indicator ---
    const savedEl = settingsViewerBody.querySelector('#sv-saved');
    let savedTimer = null;
    const flashSaved = () => {
      if (!savedEl) return;
      savedEl.textContent = 'Saved';
      savedEl.classList.remove('error');
      savedEl.classList.add('show');
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => savedEl.classList.remove('show'), 1200);
    };
    const flashSaveError = () => {
      if (!savedEl) return;
      savedEl.textContent = 'Save failed';
      savedEl.classList.add('show', 'error');
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => savedEl.classList.remove('show'), 3000);
    };

    const q = (id) => settingsViewerBody.querySelector('#' + id);

    // --- Auto-save ---
    async function saveSettings() {
      let settings = isProject ? {} : { ...((await window.api.getSetting('global')) || {}) };
      const cliReaders = {
        permissionMode: () => q('sv-perm-mode')?.value || null,
        worktree: () => q('sv-worktree')?.checked,
        worktreeName: () => (q('sv-worktree-name')?.value || '').trim(),
        chrome: () => q('sv-chrome')?.checked,
        preLaunchCmd: () => (q('sv-pre-launch')?.value || '').trim(),
        addDirs: () => (q('sv-add-dirs')?.value || '').trim(),
      };

      if (isProject) {
        // Only persist CLI fields whose "use global" is unchecked.
        settingsViewerBody.querySelectorAll('.use-global-cb').forEach((cb) => {
          const f = cb.dataset.field;
          if (!cb.checked && cliReaders[f]) settings[f] = cliReaders[f]();
        });
      } else {
        for (const f in cliReaders) settings[f] = cliReaders[f]();
        if (q('sv-appearance')) settings.appearance = q('sv-appearance').value || 'auto';
        if (q('sv-terminal-theme')) settings.terminalTheme = q('sv-terminal-theme').value || 'auto';
        if (q('sv-shell-profile')) settings.shellProfile = q('sv-shell-profile').value || 'auto';
        if (q('sv-sound-notif')) settings.soundNotifications = q('sv-sound-notif').checked;
        if (q('sv-system-notif')) settings.systemNotifications = q('sv-system-notif').checked;
        if (q('sv-open-readonly')) settings.openSessionsReadOnly = q('sv-open-readonly').checked;
        if (q('sv-visible-count')) settings.visibleSessionCount = Math.min(100, Math.max(1, parseInt(q('sv-visible-count').value) || 10));
        if (q('sv-max-age')) settings.sessionMaxAgeDays = Math.min(365, Math.max(1, parseInt(q('sv-max-age').value) || 3));
        if (q('sv-mcp-emulation')) settings.mcpEmulation = q('sv-mcp-emulation').checked;
        if (q('sv-show-plans')) settings.showPlansTab = q('sv-show-plans').checked;
        if (q('sv-show-memory')) settings.showMemoryTab = q('sv-show-memory').checked;
        if (q('sv-show-stats')) settings.showStatsTab = q('sv-show-stats').checked;
        // Toolbar placement + custom order (row order in the draggable list)
        const tbList = q('sv-toolbar-list');
        if (tbList) {
          const rows = [...tbList.querySelectorAll('.toolbar-config-row')];
          settings.toolbarOrder = rows.map((r) => r.dataset.action);
          const placement = {};
          tbList.querySelectorAll('[data-toolbar-action]').forEach((s) => { placement[s.dataset.toolbarAction] = s.value; });
          settings.toolbarIcons = placement;
        }
      }

      try {
        await window.api.setSetting(settingsKey, settings);
      } catch (e) {
        // Never show "Saved" on a write that didn't happen (settings are
        // security-relevant, e.g. permissionMode). Surface the failure instead.
        console.error('[settings] save failed', e);
        flashSaveError();
        return;
      }

      if (!isProject) {
        if (settings.visibleSessionCount && typeof window._setVisibleSessionCount === 'function') window._setVisibleSessionCount(settings.visibleSessionCount);
        if (settings.sessionMaxAgeDays && typeof window._setSessionMaxAge === 'function') window._setSessionMaxAge(settings.sessionMaxAgeDays);
        if (settings.terminalTheme && typeof window._applyTerminalTheme === 'function') window._applyTerminalTheme(settings.terminalTheme);
        if (typeof window._applyAppearance === 'function') window._applyAppearance(settings.appearance);
        if (typeof window._setSoundNotifications === 'function') window._setSoundNotifications(settings.soundNotifications);
        if (typeof window._setSystemNotifications === 'function') window._setSystemNotifications(settings.systemNotifications);
        if (typeof window._setOpenSessionsReadOnly === 'function') window._setOpenSessionsReadOnly(settings.openSessionsReadOnly);
        if (settings.toolbarIcons && typeof window._applyToolbarLayout === 'function') window._applyToolbarLayout(settings.toolbarIcons, settings.toolbarOrder);
        if (typeof window._applyTabVisibility === 'function') window._applyTabVisibility(settings);
        if (typeof refreshSidebar === 'function') refreshSidebar();
      }
      flashSaved();
    }

    // Debounced trigger (immediate for toggles/selects, debounced for typing).
    // Saves are serialized on a promise chain so two in-flight saves can't
    // interleave their read-modify-write of the global settings blob.
    let debTimer = null, saveChain = Promise.resolve();
    const runSave = () => { saveChain = saveChain.then(saveSettings).catch((e) => console.error('[settings] save error', e)); };
    const triggerSave = (immediate) => {
      clearTimeout(debTimer);
      if (immediate) runSave();
      else debTimer = setTimeout(runSave, 350);
    };

    settingsViewerBody.querySelectorAll('.settings-pane input, .settings-pane select').forEach((el) => {
      if (el.classList.contains('use-global-cb')) {
        const map = { permissionMode: 'sv-perm-mode', worktree: 'sv-worktree', worktreeName: 'sv-worktree-name', chrome: 'sv-chrome', preLaunchCmd: 'sv-pre-launch', addDirs: 'sv-add-dirs' };
        el.addEventListener('change', () => {
          const input = q(map[el.dataset.field]);
          if (input) input.disabled = el.checked;
          triggerSave(true);
        });
        return;
      }
      const typing = el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number');
      el.addEventListener(typing ? 'input' : 'change', () => triggerSave(!typing));
    });

    // --- Toolbar list: drag to reorder ---
    const tbList = q('sv-toolbar-list');
    if (tbList) {
      let dragEl = null;
      const dragAfter = (y) => {
        const rows = [...tbList.querySelectorAll('.toolbar-config-row:not(.dragging)')];
        let best = { offset: -Infinity, el: null };
        for (const child of rows) {
          const box = child.getBoundingClientRect();
          const offset = y - box.top - box.height / 2;
          if (offset < 0 && offset > best.offset) best = { offset, el: child };
        }
        return best.el;
      };
      tbList.querySelectorAll('.toolbar-config-row').forEach((rowEl) => {
        rowEl.addEventListener('dragstart', (e) => {
          // Let the placement <select> stay usable — don't start a drag from it.
          if (e.target.closest('select')) { e.preventDefault(); return; }
          dragEl = rowEl;
          rowEl.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
        });
        rowEl.addEventListener('dragend', () => {
          rowEl.classList.remove('dragging');
          dragEl = null;
          triggerSave(true);
        });
      });
      tbList.addEventListener('dragover', (e) => {
        if (!dragEl) return;
        e.preventDefault();
        const after = dragAfter(e.clientY);
        if (after == null) tbList.appendChild(dragEl);
        else tbList.insertBefore(dragEl, after);
      });
    }

    // Done / close
    q('sv-done-btn')?.addEventListener('click', () => { runSave(); closeSettingsViewer(); });

    // Version string
    const verEl = q('sv-current-version');
    if (verEl) window.api.getAppVersion().then((v) => { verEl.textContent = `v${v}`; });

    // Hide project
    const removeBtn = q('sv-remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', async () => {
        if (!confirm(`Hide project "${shortName}" from Switchboard?\n\nThis hides the project from the sidebar. Your session files are not deleted.`)) return;
        await window.api.removeProject(projectPath);
        settingsViewer.style.display = 'none';
        document.getElementById('placeholder').style.display = 'flex';
        if (typeof loadProjects === 'function') loadProjects();
      });
    }
  }

  // Close on Escape while the settings viewer is visible.
  document.addEventListener('keydown', (e) => {
    // Don't close the settings viewer if a modal (tag editor / bookmarks) is up —
    // those are appended to document.body, so check there.
    if (e.key === 'Escape' && settingsViewer.style.display !== 'none' && !document.body.querySelector('.sb-modal-overlay')) {
      closeSettingsViewer();
    }
  });

  window.openSettingsViewer = openSettingsViewer;
  window.closeSettingsViewer = closeSettingsViewer;
})();
