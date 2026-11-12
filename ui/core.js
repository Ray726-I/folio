'use strict';
const $ = id => document.getElementById(id);
const invoke = (command, args = {}) => {
  const api = window.__TAURI__?.core?.invoke;
  return typeof api === 'function' ? api.call(window.__TAURI__.core, command, args) : Promise.reject(new Error('Open Folio from your app menu to enable file access.'));
};
const listen = (event, callback) => {
  const api = window.__TAURI__?.event?.listen;
  return typeof api === 'function' ? api.call(window.__TAURI__.event, event, callback) : Promise.reject(new Error('Open Folio from your app menu to enable file access.'));
};
const root = document.documentElement;
function updateCompactHeader() {
  const screenWidth = window.screen?.availWidth || window.screen?.width || window.innerWidth;
  root.toggleAttribute('data-compact-modes', window.innerWidth < screenWidth * 0.67);
  root.toggleAttribute('data-compact-saved', window.innerWidth < screenWidth * 0.55);
}
window.addEventListener('resize', updateCompactHeader);
updateCompactHeader();
const header = document.querySelector('.headerbar');
const headerSides = [header.querySelector('.header-start'), header.querySelector('.header-end')];
function updateHeaderTitleSpace() {
  const width = Math.max(...headerSides.map(side => side.getBoundingClientRect().width));
  header.style.setProperty('--header-side-reserve', `${Math.ceil(width + 18)}px`);
}
const headerObserver = new ResizeObserver(updateHeaderTitleSpace);
headerSides.forEach(side => headerObserver.observe(side));
window.addEventListener('resize', updateHeaderTitleSpace);
updateHeaderTitleSpace();
const { basename, dirname, isWithin, pathKey, samePath, setPlatform } = window.FolioPaths;
const preferences = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(`folio.${key}`)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`folio.${key}`, JSON.stringify(value)); } catch {} }
};

// Native dialogs move focus back to the document body for one Tab stop after
// the last control in some webviews. Keep keyboard focus inside the topmost
// modal for every dialog, including ones created at runtime.
function modalDialog() {
  const open = [...document.querySelectorAll('dialog[open]')];
  if (!open.length) return null;
  // A palette can open above Help or a confirmation; the active dialog, not
  // DOM order, is the one that owns Tab.
  const active = document.activeElement?.closest?.('dialog[open]');
  return active && open.includes(active) ? active : open[open.length - 1];
}
document.addEventListener('keydown', event => {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
  const dialog = modalDialog();
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]')]
    .filter(element => element.tabIndex >= 0 && !element.hidden && element.getClientRects().length && !element.closest('[hidden]'));
  if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
  const first = focusable[0], last = focusable[focusable.length - 1], active = document.activeElement;
  if (!dialog.contains(active)) { event.preventDefault(); first.focus(); return; }
  if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
}, true);

// Native dialogs try to restore focus to the element that opened them. When
// that element was a menu row it is now hidden, so the browser leaves focus on
// <body>. Remember the last useful surface focus outside menus and dialogs and
// use it when the dialog closes without a real restoration target.
let lastDialogReturnFocus = null;
document.addEventListener('focusin', event => {
  const target = event.target;
  if (!(target instanceof Element) || target === document.body) return;
  if (target.closest('dialog[open], .menu')) return;
  lastDialogReturnFocus = target;
}, true);
document.addEventListener('toggle', event => {
  const dialog = event.target;
  if (!(dialog instanceof HTMLDialogElement)) return;
  if (dialog.open) { if (typeof closeEditorPopups === 'function') closeEditorPopups(); return; }
  requestAnimationFrame(() => {
    if (document.querySelector('dialog[open]')) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const previous = lastDialogReturnFocus;
    if (previous?.isConnected && !previous.hidden && previous.getClientRects().length) { previous.focus({ preventScroll: true }); return; }
    const target = !$('document-view')?.hidden
      ? (typeof documentMode !== 'undefined' && documentMode === 'source' && !$('document-source')?.hidden ? $('document-source') : $('reader-scroll'))
      : !$('welcome')?.hidden ? $('welcome-open') : null;
    target?.focus({ preventScroll: true });
  });
}, true);
