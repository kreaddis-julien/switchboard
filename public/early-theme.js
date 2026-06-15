// Apply saved appearance (auto/light/dark) before first paint to avoid a flash.
// Kept as an external file (not inline) so it complies with the strict CSP
// (script-src 'self'); an inline <script> would be blocked.
try {
  var t = localStorage.getItem('appearance');
  document.documentElement.dataset.theme = (t === 'light' || t === 'dark') ? t : 'auto';
} catch (e) {
  document.documentElement.dataset.theme = 'auto';
}
