// Command palette / quick session switcher (Cmd/Ctrl+K).
// Fuzzy-jump to any known session by name or project. Reads app.js globals
// (sessionMap, activePtyIds, openSession) and utils.js (cleanDisplayName).
(function () {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  let overlay, input, list, entries = [], filtered = [], selected = 0, open = false;

  function build() {
    overlay = document.createElement('div');
    overlay.id = 'cmd-palette';
    overlay.innerHTML =
      '<div class="cmdp-box">' +
      '  <input type="text" class="cmdp-input" placeholder="Jump to session…" spellcheck="false" />' +
      '  <div class="cmdp-list"></div>' +
      '  <div class="cmdp-hint"><span><b>↑↓</b> navigate</span><span><b>↵</b> open</span><span><b>esc</b> close</span></div>' +
      '</div>';
    document.body.appendChild(overlay);
    input = overlay.querySelector('.cmdp-input');
    list = overlay.querySelector('.cmdp-list');

    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    input.addEventListener('input', () => { selected = 0; filter(); });
    input.addEventListener('keydown', onKey);
  }

  function collect() {
    const out = [];
    const map = (typeof sessionMap !== 'undefined') ? sessionMap : null;
    if (!map) return out;
    for (const s of map.values()) {
      if (!s || !s.sessionId) continue;
      if (s.archived) continue;
      const proj = (s.projectPath || '').split('/').filter(Boolean).pop() || '';
      // cleanDisplayName attend une CHAINE (name), pas l'objet session.
      const raw = s.name || s.aiTitle || s.summary || '';
      let name = '';
      try { name = (typeof cleanDisplayName === 'function' ? cleanDisplayName(raw) : raw) || ''; } catch { name = raw; }
      if (!name) name = s.sessionId.slice(0, 8);
      const running = (typeof activePtyIds !== 'undefined') && activePtyIds.has(s.sessionId);
      out.push({
        session: s, name: String(name).trim(), project: proj, running,
        modified: new Date(s.modified || 0).getTime(), hay: (name + ' ' + proj).toLowerCase(),
      });
    }
    return out;
  }

  // Subsequence fuzzy score: lower is better; -1 = no match.
  function score(hay, q) {
    if (!q) return 0;
    let hi = 0, qi = 0, gaps = 0, last = -1;
    while (hi < hay.length && qi < q.length) {
      if (hay[hi] === q[qi]) { if (last >= 0) gaps += hi - last - 1; last = hi; qi++; }
      hi++;
    }
    return qi === q.length ? gaps : -1;
  }

  function filter() {
    const q = input.value.trim().toLowerCase();
    filtered = entries
      .map((e) => ({ e, s: score(e.hay, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => (b.e.running - a.e.running) || (a.s - b.s) || (b.e.modified - a.e.modified))
      .slice(0, 50)
      .map((x) => x.e);
    if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);
    render();
  }

  function render() {
    list.innerHTML = '';
    filtered.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'cmdp-row' + (i === selected ? ' sel' : '');
      row.innerHTML =
        '<span class="cmdp-dot' + (e.running ? ' running' : '') + '"></span>' +
        '<span class="cmdp-name"></span>' +
        '<span class="cmdp-proj"></span>';
      row.querySelector('.cmdp-name').textContent = e.name;
      row.querySelector('.cmdp-proj').textContent = e.project;
      row.addEventListener('mousemove', () => { if (selected !== i) { selected = i; render(); } });
      row.addEventListener('click', () => choose(i));
      list.appendChild(row);
    });
    const sel = list.querySelector('.cmdp-row.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function choose(i) {
    const e = filtered[i];
    close();
    if (e && typeof openSession === 'function') openSession(e.session);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (filtered.length) { selected = (selected + 1) % filtered.length; render(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (filtered.length) { selected = (selected - 1 + filtered.length) % filtered.length; render(); } }
    else if (e.key === 'Enter') { e.preventDefault(); choose(selected); }
  }

  function show() {
    if (!overlay) build();
    entries = collect();
    selected = 0;
    input.value = '';
    filter();
    overlay.classList.add('visible');
    open = true;
    setTimeout(() => input.focus(), 0);
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove('visible');
    open = false;
  }

  window.addEventListener('keydown', (e) => {
    if (e._handled) return; // let a focused terminal keep Ctrl+K
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      open ? close() : show();
    }
  });

  window._toggleCommandPalette = () => (open ? close() : show());
})();
