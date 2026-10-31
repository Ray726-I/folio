'use strict';
// Applies persisted appearance before first paint. This must stay a small,
// non-deferred script: theme.js/app.js run later and need DOM state.
(() => {
  const read = key => { try { return JSON.parse(localStorage.getItem(`folio.${key}`)); } catch { return undefined; } };
  const root = document.documentElement;
  const theme = read('theme');
  // 'omarchy' needs native palette data from bootstrap, so it starts on system.
  root.dataset.theme = typeof theme === 'string' && theme && theme !== 'omarchy' ? theme : 'system';
  root.dataset.readingFont = read('readingFont') === 'sans' ? 'sans' : 'serif';
})();
