// --- Utility functions (shared across renderer modules) ---

// Mirror Claude CLI's project-folder naming. Must stay in sync with
// encode-project-path.js (main process). Reverse-engineered from claude CLI 2.1.126.
function encodeProjectPath(projectPath) {
  const sanitized = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= 200) return sanitized;
  let h = 0;
  for (let i = 0; i < projectPath.length; i++) {
    h = (h << 5) - h + projectPath.charCodeAt(i) | 0;
  }
  return sanitized.slice(0, 200) + '-' + Math.abs(h).toString(36);
}

function cleanDisplayName(name) {
  if (!name) return name;
  const prefix = 'Implement the following plan:';
  if (name.startsWith(prefix)) name = name.slice(prefix.length).trim();
  // Strip XML/HTML-like tags (e.g. <command>, </message>, <system-reminder>)
  name = name.replace(/<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?\/?>/g, ' ');
  // Collapse multiple spaces and trim
  name = name.replace(/\s+/g, ' ').trim();
  return name;
}

function formatDate(date) {
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return t('time.just_now');
  if (mins < 60) return t('time.mins', { n: mins });
  if (hours < 24) return t('time.hours', { n: hours });
  if (days < 7) return t('time.days', { n: days });
  const locale = (window.I18N && window.I18N.lang === 'fr') ? 'fr-FR' : 'en-US';
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function shellEscape(path) {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

// Sanitize then set innerHTML via DOMPurify (bundled with codemirror-bundle.js).
// Falls back to textContent if DOMPurify hasn't loaded, so we never render
// unsanitized HTML. Used by the Agent Teams view to render plan markdown.
function safeSetHtml(el, html) {
  if (!el) return;
  const src = String(html ?? '');
  if (window.DOMPurify) {
    el.innerHTML = window.DOMPurify.sanitize(src, { USE_PROFILES: { html: true } });
  } else {
    el.textContent = src;
  }
}
