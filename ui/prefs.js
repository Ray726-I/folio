'use strict';
// Applies persisted appearance before first paint. This must stay a small,
// non-deferred script: theme.js/app.js run later and need DOM state.
(() => {
  const read = key => { try { return JSON.parse(localStorage.getItem(`folio.${key}`)); } catch { return undefined; } };
  const root = document.documentElement;
  const theme = read('theme');
  // 'omarchy' needs native palette data from bootstrap, so it starts on system.
  const retroEnabled = read('labRetroEnabled') ?? theme === 'retro-terminal';
  if (retroEnabled) {
    const style = document.createElement('link');
    style.id = 'lab-retro-style'; style.rel = 'stylesheet'; style.href = 'retro-terminal.css';
    document.head.append(style);
  }
  root.dataset.theme = typeof theme === 'string' && theme && theme !== 'omarchy' && (theme !== 'retro-terminal' || retroEnabled) ? theme : 'system';
  root.dataset.readingFont = ['serif', 'sans', 'mono'].includes(read('readingFont')) ? read('readingFont') : 'sans';
})();
