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
    settingsViewerTitle.textContent = (isProject ? t('set.title_project') : t('set.title')) + shortName;

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
      return `<label class="settings-use-global"><input type="checkbox" data-field="${fieldName}" class="use-global-cb" ${useGlobal ? 'checked' : ''}> ${escapeHtml(t('set.use_global'))}</label>`;
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
    const showSubagentSessionsValue = fieldValue('showSubagentSessions', true);
    const soundNotificationsValue = fieldValue('soundNotifications', true);
    const systemNotificationsValue = fieldValue('systemNotifications', true);
    const mcpEmulationValue = fieldValue('mcpEmulation', true);
    const shellProfileValue = fieldValue('shellProfile', 'auto');
    const languageValue = fieldValue('language', 'en');

    // Working copy of the (global-only) re-bindable keyboard shortcuts.
    let scShortcuts = normalizeShortcuts(isProject ? null : current.shortcuts);
    const scIsMac = typeof isMac !== 'undefined' ? isMac : /Mac|iPhone|iPad/.test(navigator.platform);

    let shellProfiles = [];
    try { shellProfiles = await window.api.getShellProfiles(); } catch (e) { console.warn('[settings] shell profiles unavailable', e); }

    const toggle = (id, on, dis = '') => `<label class="settings-toggle"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${dis}><span class="settings-toggle-slider"></span></label>`;

    // ---- CLI category (both scopes) ----
    const cliPane = `<div class="settings-pane" data-cat="cli">
      ${row(t('set.perm_mode'), t('set.perm_mode_d'),
        `<select class="settings-select" id="sv-perm-mode" ${fieldDisabled('permissionMode')}>
          <option value="">${escapeHtml(t('set.perm_default_none'))}</option>
          <option value="acceptEdits" ${permModeValue === 'acceptEdits' ? 'selected' : ''}>${escapeHtml(t('perm.accept'))}</option>
          <option value="plan" ${permModeValue === 'plan' ? 'selected' : ''}>${escapeHtml(t('perm.plan'))}</option>
          <option value="dontAsk" ${permModeValue === 'dontAsk' ? 'selected' : ''}>${escapeHtml(t('perm.dont_ask'))}</option>
          <option value="bypassPermissions" ${permModeValue === 'bypassPermissions' ? 'selected' : ''}>${escapeHtml(t('perm.bypass'))}</option>
        </select>`, useGlobalCheckbox('permissionMode'))}
      ${row(t('set.worktree'), t('set.worktree_d'), toggle('sv-worktree', worktreeValue, fieldDisabled('worktree')), useGlobalCheckbox('worktree'))}
      ${row(t('set.worktree_name'), t('set.worktree_name_d'),
        `<input type="text" class="settings-input" id="sv-worktree-name" placeholder="auto" value="${escapeHtml(worktreeNameValue)}" ${fieldDisabled('worktreeName')} style="width:140px">`, useGlobalCheckbox('worktreeName'))}
      ${row(t('set.chrome'), t('set.chrome_d'), toggle('sv-chrome', chromeValue, fieldDisabled('chrome')), useGlobalCheckbox('chrome'))}
      ${row(t('set.add_dirs'), t('set.add_dirs_d'),
        `<input type="text" class="settings-input" id="sv-add-dirs" placeholder="${escapeHtml(t('dlg.adddirs_ph'))}" value="${escapeHtml(addDirsValue)}" ${fieldDisabled('addDirs')}>`, useGlobalCheckbox('addDirs'))}
      ${row(t('set.prelaunch'), t('set.prelaunch_d'),
        `<input type="text" class="settings-input" id="sv-pre-launch" placeholder="${escapeHtml(t('dlg.prelaunch_ph'))}" value="${escapeHtml(preLaunchValue)}" ${fieldDisabled('preLaunchCmd')}>`, useGlobalCheckbox('preLaunchCmd'))}
    </div>`;

    let nav, panes;

    if (isProject) {
      nav = [
        { cat: 'cli', label: t('set.cat.cli') },
        { cat: 'project', label: t('set.cat.project') },
      ];
      const currentGroup = (globalSettings.projectGroups || {})[projectPath] || '';
      panes = cliPane + `<div class="settings-pane" data-cat="project">
        ${row(t('set.group'), t('set.group_d'),
          `<input type="text" class="settings-input" id="sv-project-group" placeholder="${escapeHtml(t('set.ph_group'))}" value="${escapeHtml(currentGroup)}" style="width:160px">`)}
        ${row(t('set.proj_folder'), t('set.proj_folder_d'),
          `<button class="settings-relocate-btn" id="sv-relocate-btn">${escapeHtml(t('set.relocate'))}</button>`)}
        ${row(t('set.hide_project'), t('set.hide_project_d'),
          `<button class="settings-remove-btn" id="sv-remove-btn">${escapeHtml(t('set.hide_project'))}</button>`)}
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
            <option value="visible" ${placement[a.key] === 'visible' ? 'selected' : ''}>${escapeHtml(t('set.toolbar'))}</option>
            <option value="popover" ${placement[a.key] !== 'visible' ? 'selected' : ''}>${escapeHtml(t('set.in_popover'))}</option>
          </select>
        </div>`).join('');

      nav = [
        { cat: 'general', label: t('set.cat.general') },
        { cat: 'notifications', label: t('set.cat.notifications') },
        { cat: 'sessions', label: t('set.cat.sessions') },
        { cat: 'sidebar', label: t('set.cat.sidebar') },
        { cat: 'toolbar', label: t('set.cat.toolbar') },
        { cat: 'cli', label: t('set.cat.cli') },
        { cat: 'about', label: t('set.cat.about') },
      ];
      panes = `
        <div class="settings-pane" data-cat="general">
          ${row(t('settings.language'), t('settings.language_hint'),
            `<select class="settings-select" id="sv-language">
              <option value="en" ${languageValue === 'en' ? 'selected' : ''}>${escapeHtml(t('lang.en'))}</option>
              <option value="fr" ${languageValue === 'fr' ? 'selected' : ''}>${escapeHtml(t('lang.fr'))}</option>
            </select>`)}
          ${row(t('set.appearance'), t('set.appearance_d'),
            `<select class="settings-select" id="sv-appearance">
              <option value="auto" ${appearanceValue === 'auto' ? 'selected' : ''}>${escapeHtml(t('set.opt.auto_system'))}</option>
              <option value="light" ${appearanceValue === 'light' ? 'selected' : ''}>${escapeHtml(t('set.opt.light'))}</option>
              <option value="dark" ${appearanceValue === 'dark' ? 'selected' : ''}>${escapeHtml(t('set.opt.dark'))}</option>
            </select>`)}
          ${row(t('set.term_theme'), t('set.term_theme_d'),
            `<select class="settings-select" id="sv-terminal-theme">
              ${Object.entries(TERMINAL_THEMES).map(([key, t]) => `<option value="${key}" ${themeValue === key ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
            </select>`)}
          ${row(t('set.shell'), t('set.shell_d'),
            `<select class="settings-select" id="sv-shell-profile">
              <option value="auto" ${shellProfileValue === 'auto' ? 'selected' : ''}>${escapeHtml(t('set.opt.auto_detect'))}</option>
              ${shellProfiles.map((p) => `<option value="${escapeHtml(p.id)}" ${shellProfileValue === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
            </select>`)}
          ${SHORTCUT_DEFS.map((def) => row(def.label, def.description,
            `<button class="settings-shortcut-btn" id="sv-sc-${def.id}" data-sc-id="${def.id}">${escapeHtml(formatBinding(def.id, scIsMac, scShortcuts))}</button>`)).join('')}
          <div class="settings-pane-hint">${escapeHtml(t('set.shortcut_hint', { mod1: scIsMac ? 'Cmd' : 'Ctrl', mod2: scIsMac ? 'Option' : 'Alt' }))}</div>
        </div>

        <div class="settings-pane" data-cat="notifications">
          ${row(t('set.sound'), t('set.sound_d'), toggle('sv-sound-notif', soundNotificationsValue))}
          ${row(t('set.system_notif'), t('set.system_notif_d'), toggle('sv-system-notif', systemNotificationsValue))}
        </div>

        <div class="settings-pane" data-cat="sessions">
          ${row(t('set.max_visible'), t('set.max_visible_d'),
            `<input type="number" class="settings-input settings-input-compact" id="sv-visible-count" min="1" max="100" value="${visCountValue}">`)}
          ${row(t('set.max_age'), t('set.max_age_d'),
            `<input type="number" class="settings-input settings-input-compact" id="sv-max-age" min="1" max="365" value="${maxAgeValue}">`)}
          ${row(t('set.ide'), t('set.ide_d'), toggle('sv-mcp-emulation', mcpEmulationValue))}
        </div>

        <div class="settings-pane" data-cat="sidebar">
          ${row(t('set.show_plans'), t('set.show_plans_d'), toggle('sv-show-plans', showPlansTabValue))}
          ${row(t('set.show_memory'), t('set.show_memory_d'), toggle('sv-show-memory', showMemoryTabValue))}
          ${row(t('set.show_stats'), t('set.show_stats_d'), toggle('sv-show-stats', showStatsTabValue))}
          ${row(t('set.show_subagents'), t('set.show_subagents_d'), toggle('sv-show-subagents', showSubagentSessionsValue))}
          <div class="settings-field settings-field-block">
            <div class="settings-field-info">
              <span class="settings-label">${escapeHtml(t('set.hidden_folders'))}</span>
              <div class="settings-description">${escapeHtml(t('set.hidden_folders_d'))}</div>
            </div>
            <div class="settings-hidden-list" id="sv-hidden-projects"></div>
          </div>
        </div>

        <div class="settings-pane" data-cat="toolbar">
          <div class="settings-pane-hint">${escapeHtml(t('set.toolbar_hint'))}</div>
          <div class="toolbar-config-list" id="sv-toolbar-list">${toolbarRows}</div>
        </div>

        ${cliPane}

        <div class="settings-pane" data-cat="about">
          ${row(t('set.version'), '<span id="sv-current-version"></span>', '')}
          ${row(t('set.autoupdate'), t('set.autoupdate_d'), `<span class="settings-muted">${escapeHtml(t('set.off'))}</span>`)}
        </div>`;
    }

    settingsViewerBody.innerHTML = `
      <div class="settings-shell">
        <nav class="settings-nav">
          ${nav.map((n, i) => `<button class="settings-nav-item${i === 0 ? ' active' : ''}" data-cat="${n.cat}">${n.label}</button>`).join('')}
          <div class="settings-nav-spacer"></div>
          <button class="settings-nav-done" id="sv-done-btn">${escapeHtml(t('set.done'))}</button>
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

    // --- Keyboard shortcut rebinding (global only) ---
    // Capture listeners live on the button element itself (not on document), so
    // they can never leak app-wide: losing focus (incl. the viewer being closed
    // by any path) fires blur -> stops capture, and re-opening replaces the body.
    let capturingBtn = null;
    function stopShortcutCapture() {
      if (capturingBtn) {
        capturingBtn.classList.remove('capturing');
        capturingBtn.textContent = formatBinding(capturingBtn.dataset.scId, scIsMac, scShortcuts);
        capturingBtn = null;
      }
    }
    settingsViewerBody.querySelectorAll('.settings-shortcut-btn').forEach((btn) => {
      const id = btn.dataset.scId;
      const def = SHORTCUT_DEFS.find((d) => d.id === id);
      btn.addEventListener('click', () => {
        // Clicking the button that is already capturing resets it to default.
        if (capturingBtn === btn) {
          scShortcuts = { ...scShortcuts, [id]: normalizeShortcuts(null)[id] };
          stopShortcutCapture();
          btn.blur();
          return;
        }
        stopShortcutCapture();
        capturingBtn = btn;
        btn.classList.add('capturing');
        btn.textContent = 'Press keys…';
        btn.focus();
      });
      btn.addEventListener('keydown', (e) => {
        if (capturingBtn !== btn) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { stopShortcutCapture(); btn.blur(); return; }
        const binding = captureBinding(e, def, scIsMac);
        if (!binding) return; // chord incomplete — keep listening
        scShortcuts = { ...scShortcuts, [id]: binding };
        stopShortcutCapture();
        btn.blur();
      });
      btn.addEventListener('blur', () => { if (capturingBtn === btn) stopShortcutCapture(); });
    });

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
        if (q('sv-language')) settings.language = q('sv-language').value || 'en';
        if (q('sv-appearance')) settings.appearance = q('sv-appearance').value || 'auto';
        if (q('sv-terminal-theme')) settings.terminalTheme = q('sv-terminal-theme').value || 'auto';
        if (q('sv-shell-profile')) settings.shellProfile = q('sv-shell-profile').value || 'auto';
        if (q('sv-sound-notif')) settings.soundNotifications = q('sv-sound-notif').checked;
        if (q('sv-system-notif')) settings.systemNotifications = q('sv-system-notif').checked;
        if (q('sv-visible-count')) settings.visibleSessionCount = Math.min(100, Math.max(1, parseInt(q('sv-visible-count').value) || 10));
        if (q('sv-max-age')) settings.sessionMaxAgeDays = Math.min(365, Math.max(1, parseInt(q('sv-max-age').value) || 3));
        if (q('sv-mcp-emulation')) settings.mcpEmulation = q('sv-mcp-emulation').checked;
        if (q('sv-show-plans')) settings.showPlansTab = q('sv-show-plans').checked;
        if (q('sv-show-memory')) settings.showMemoryTab = q('sv-show-memory').checked;
        if (q('sv-show-stats')) settings.showStatsTab = q('sv-show-stats').checked;
        if (q('sv-show-subagents')) settings.showSubagentSessions = q('sv-show-subagents').checked;
        // Toolbar placement + custom order (row order in the draggable list)
        const tbList = q('sv-toolbar-list');
        if (tbList) {
          const rows = [...tbList.querySelectorAll('.toolbar-config-row')];
          settings.toolbarOrder = rows.map((r) => r.dataset.action);
          const placement = {};
          tbList.querySelectorAll('[data-toolbar-action]').forEach((s) => { placement[s.dataset.toolbarAction] = s.value; });
          settings.toolbarIcons = placement;
        }
        settings.shortcuts = scShortcuts;
      }
      stopShortcutCapture();

      try {
        await window.api.setSetting(settingsKey, settings);
      } catch (e) {
        // Never show "Saved" on a write that didn't happen (settings are
        // security-relevant, e.g. permissionMode). Surface the failure instead.
        console.error('[settings] save failed', e);
        flashSaveError();
        return;
      }

      // Language change needs a full reload so every view re-renders translated.
      // Keep the i18n localStorage mirror in sync so load-time strings rebuild in
      // the new language on the very next load (no double reload).
      if (!isProject && settings.language && settings.language !== languageValue) {
        try { localStorage.setItem('sb-language', settings.language); } catch {}
        window.location.reload();
        return;
      }

      if (!isProject) {
        if (settings.visibleSessionCount && typeof window._setVisibleSessionCount === 'function') window._setVisibleSessionCount(settings.visibleSessionCount);
        if (settings.sessionMaxAgeDays && typeof window._setSessionMaxAge === 'function') window._setSessionMaxAge(settings.sessionMaxAgeDays);
        if (settings.terminalTheme && typeof window._applyTerminalTheme === 'function') window._applyTerminalTheme(settings.terminalTheme);
        if (settings.shortcuts && typeof window._applyShortcuts === 'function') window._applyShortcuts(settings.shortcuts);
        if (typeof window._applyAppearance === 'function') window._applyAppearance(settings.appearance);
        if (typeof window._setSoundNotifications === 'function') window._setSoundNotifications(settings.soundNotifications);
        if (typeof window._setSystemNotifications === 'function') window._setSystemNotifications(settings.systemNotifications);
        if (typeof window._setShowSubagentSessions === 'function') window._setShowSubagentSessions(settings.showSubagentSessions);
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
      if (el.id === 'sv-project-group') return; // handled separately (writes projectGroups, not the settings blob)
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

    // Hidden folders management (global scope)
    const hiddenList = q('sv-hidden-projects');
    if (hiddenList) {
      const renderHidden = async () => {
        let hidden = [];
        try { hidden = await window.api.getHiddenProjects(); } catch (e) { console.warn('[settings] hidden projects', e); }
        if (!hidden || !hidden.length) { hiddenList.innerHTML = '<div class="settings-hidden-empty">No hidden folders.</div>'; return; }
        hiddenList.innerHTML = '';
        for (const p of hidden) {
          const r = document.createElement('div');
          r.className = 'settings-hidden-row';
          const name = document.createElement('span');
          name.className = 'settings-hidden-path';
          name.textContent = p.split('/').filter(Boolean).slice(-2).join('/') || p;
          name.title = p;
          const btn = document.createElement('button');
          btn.className = 'settings-hidden-unhide';
          btn.textContent = 'Unhide';
          btn.onclick = async () => {
            try { await window.api.unhideProject(p); flashSaved(); if (typeof loadProjects === 'function') loadProjects(); }
            catch (e) { console.error('[settings] unhide failed', e); flashSaveError(); }
            renderHidden();
          };
          r.appendChild(name);
          r.appendChild(btn);
          hiddenList.appendChild(r);
        }
      };
      renderHidden();
    }

    // Version string
    const verEl = q('sv-current-version');
    if (verEl) window.api.getAppVersion().then((v) => { verEl.textContent = `v${v}`; });

    // Project group (writes global.projectGroups, debounced) + relocate (#35)
    const groupInput = q('sv-project-group');
    if (groupInput) {
      let gt = null;
      groupInput.addEventListener('input', () => {
        clearTimeout(gt);
        gt = setTimeout(async () => {
          try { await window.api.setProjectGroup(projectPath, groupInput.value); flashSaved(); if (typeof loadProjects === 'function') loadProjects(); }
          catch (e) { console.error('[settings] set group failed', e); flashSaveError(); }
        }, 400);
      });
    }
    const relocateBtn = q('sv-relocate-btn');
    if (relocateBtn) {
      relocateBtn.addEventListener('click', async () => {
        const dir = await window.api.browseFolder();
        if (!dir) return;
        try { await window.api.remapProject(projectPath, dir); flashSaved(); if (typeof loadProjects === 'function') loadProjects(); }
        catch (e) { console.error('[settings] relocate failed', e); flashSaveError(); }
      });
    }

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
