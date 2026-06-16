// Session tags + transcript bookmarks. Renderer-only, persisted in localStorage.
// Hooks (all optional, guarded at call sites):
//   window._decorateSessionItem(item, session)  -> sidebar.js rebind loop
//   window._decorateJsonlEntry(el, entry, session) + window._jsonlAfterRender(sessionId) -> jsonl-viewer
//   window._openBookmarks()                      -> filters button / Cmd+B
(function () {
  const TAGS_KEY = 'sb-session-tags';        // { [sessionId]: [tag,...] }
  const BM_KEY = 'sb-bookmarks';             // [ { sessionId, uuid, preview, ts } ]

  const read = (k, fallback) => {
    try { return JSON.parse(localStorage.getItem(k)) || fallback; }
    catch (e) { console.warn('[bookmarks-tags] corrupt %s, resetting', k, e); return fallback; }
  };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.error('[bookmarks-tags] persist failed', e); } };

  // ---------------- Tags ----------------
  function getTags(sessionId) { return (read(TAGS_KEY, {})[sessionId]) || []; }
  function setTags(sessionId, tags) {
    const all = read(TAGS_KEY, {});
    const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    if (clean.length) all[sessionId] = clean; else delete all[sessionId];
    write(TAGS_KEY, all);
  }

  function sessionLabel(session) {
    try { return (typeof cleanDisplayName === 'function' ? cleanDisplayName(session.name || session.aiTitle || session.summary) : '') || session.sessionId.slice(0, 8); }
    catch { return session.sessionId.slice(0, 8); }
  }

  function editTagsDialog(session) {
    const overlay = document.createElement('div');
    overlay.className = 'sb-modal-overlay';
    overlay.innerHTML =
      '<div class="sb-modal">' +
      '  <div class="sb-modal-title">Tags</div>' +
      '  <div class="sb-modal-sub"></div>' +
      '  <input type="text" class="sb-modal-input" placeholder="' + escapeHtml(t('bm.tags_ph')) + '" spellcheck="false" />' +
      '  <div class="sb-modal-actions"><button class="sb-modal-cancel">Cancel</button><button class="sb-modal-ok">Save</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.sb-modal-sub').textContent = sessionLabel(session);
    const input = overlay.querySelector('.sb-modal-input');
    input.value = getTags(session.sessionId).join(', ');
    const close = () => overlay.remove();
    const save = () => { setTags(session.sessionId, input.value.split(',')); close(); if (typeof refreshSidebar === 'function') refreshSidebar(); };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.sb-modal-cancel').onclick = close;
    overlay.querySelector('.sb-modal-ok').onclick = save;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') close(); });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  // Inject tag chips + a "Tags…" menu action into a sidebar session item.
  window._decorateSessionItem = (item, session) => {
    const tags = getTags(session.sessionId);
    let chips = item.querySelector('.session-tags');
    if (tags.length) {
      if (!chips) {
        chips = document.createElement('div');
        chips.className = 'session-tags';
        const info = item.querySelector('.session-info') || item;
        info.appendChild(chips);
      }
      chips.innerHTML = tags.map((t) => '<span class="session-tag"></span>').join('');
      chips.querySelectorAll('.session-tag').forEach((el, i) => { el.textContent = tags[i]; });
    } else if (chips) {
      chips.remove();
    }
    // Add a Tags action to the actions menu (once).
    const actions = item.querySelector('.session-actions');
    if (actions && !actions.querySelector('.session-tags-btn')) {
      const btn = document.createElement('button');
      btn.className = 'session-tags-btn';
      btn.title = t('bm.edit_tags');
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg><span class="session-menu-label">Tags</span>';
      btn.onclick = (e) => { e.stopPropagation(); editTagsDialog(session); };
      // Placer Tags dans le groupe "organiser" (juste avant Archive), pas tout en bas.
      const archiveBtn = actions.querySelector('.session-archive-btn');
      if (archiveBtn) actions.insertBefore(btn, archiveBtn); else actions.appendChild(btn);
    }
  };

  // ---------------- Bookmarks ----------------
  function getBookmarks() { return read(BM_KEY, []); }
  function isBookmarked(sessionId, uuid) { return getBookmarks().some((b) => b.sessionId === sessionId && b.uuid === uuid); }
  function toggleBookmark(entryMeta) {
    const list = getBookmarks();
    const idx = list.findIndex((b) => b.sessionId === entryMeta.sessionId && b.uuid === entryMeta.uuid);
    if (idx >= 0) list.splice(idx, 1); else list.unshift(entryMeta);
    write(BM_KEY, list);
    return idx < 0; // true if now bookmarked
  }

  function entryPreview(entry) {
    const msg = entry.message;
    let text = typeof msg === 'string' ? msg
      : (typeof msg?.content === 'string' ? msg.content
        : (Array.isArray(msg?.content) ? (msg.content.find((b) => b.type === 'text')?.text || '') : ''));
    text = String(text).replace(/\s+/g, ' ').trim();
    const role = entry.type === 'assistant' || msg?.role === 'assistant' ? 'Claude' : 'You';
    return (role + ': ' + (text || '(no text)')).slice(0, 100);
  }

  let pendingScroll = null;

  // Add a bookmark toggle to a rendered top-level jsonl entry.
  window._decorateJsonlEntry = (el, entry, session) => {
    const uuid = entry && entry.uuid;
    if (!uuid) return;
    el.dataset.uuid = uuid;
    el.classList.add('jsonl-bookmarkable');
    const sessionId = session.sessionId;
    const btn = document.createElement('button');
    btn.className = 'jsonl-bookmark-btn';
    btn.title = t('bm.bookmark');
    const paint = () => btn.classList.toggle('on', isBookmarked(sessionId, uuid));
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
    btn.onclick = (e) => {
      e.stopPropagation();
      toggleBookmark({ sessionId, uuid, preview: entryPreview(entry), ts: Date.now() });
      paint();
    };
    paint();
    el.appendChild(btn);
  };

  // After a transcript renders, jump to a pending bookmark target if any.
  window._jsonlAfterRender = (sessionId) => {
    if (!pendingScroll || pendingScroll.sessionId !== sessionId) return;
    const target = pendingScroll.uuid; pendingScroll = null;
    const body = document.getElementById('jsonl-viewer-body');
    const el = body && body.querySelector('.jsonl-bookmarkable[data-uuid="' + target + '"]');
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('jsonl-bookmark-flash');
      setTimeout(() => el.classList.remove('jsonl-bookmark-flash'), 1500);
    }
  };

  // Bookmarks overlay (Cmd+B / filters button).
  let open = false, overlay = null;
  function openBookmarks() {
    const list = getBookmarks();
    overlay = document.createElement('div');
    overlay.className = 'sb-modal-overlay';
    overlay.innerHTML = '<div class="sb-modal sb-bookmarks"><div class="sb-modal-title">Bookmarks</div><div class="sb-bm-list"></div></div>';
    document.body.appendChild(overlay);
    open = true;
    const listEl = overlay.querySelector('.sb-bm-list');
    const close = () => { overlay.remove(); open = false; };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    if (!list.length) {
      listEl.innerHTML = '<div class="sb-bm-empty">No bookmarks yet. Open a transcript and click the flag on a message.</div>';
      return;
    }
    list.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'sb-bm-row';
      const session = (typeof sessionMap !== 'undefined') ? sessionMap.get(b.sessionId) : null;
      const proj = session ? (session.projectPath || '').split('/').filter(Boolean).pop() : '';
      row.innerHTML = '<div class="sb-bm-preview"></div><div class="sb-bm-meta"></div>';
      row.querySelector('.sb-bm-preview').textContent = b.preview || '(message)';
      row.querySelector('.sb-bm-meta').textContent = proj || b.sessionId.slice(0, 8);
      row.onclick = () => {
        close();
        if (session && typeof showJsonlViewer === 'function') {
          pendingScroll = { sessionId: b.sessionId, uuid: b.uuid };
          showJsonlViewer(session);
        }
      };
      const del = document.createElement('button');
      del.className = 'sb-bm-del';
      del.title = t('bm.remove');
      del.textContent = '×';
      del.onclick = (e) => { e.stopPropagation(); toggleBookmark(b); row.remove(); if (!getBookmarks().length) listEl.innerHTML = '<div class="sb-bm-empty">No bookmarks.</div>'; };
      row.appendChild(del);
      listEl.appendChild(row);
    });
  }
  window._openBookmarks = () => {
    if (open) { if (overlay) overlay.remove(); overlay = null; open = false; }
    else openBookmarks();
  };

  window.addEventListener('keydown', (e) => {
    if (e._handled) return; // let a focused terminal keep Ctrl+B (readline)
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      window._openBookmarks();
    }
  });
})();
