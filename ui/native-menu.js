'use strict';
// The Rust menu is app-wide on macOS. Only the focused webview publishes its
// state, and the backend checks focus again before installing it.
let nativeMenuTimer = 0;
let nativeMenuReady = false;
function nativeMenuTextInput() {
  const input = document.activeElement;
  return input && input.id !== 'document-source' && input.matches?.('textarea:not([readonly]):not([disabled]), input:not([readonly]):not([disabled]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="submit"])') ? input : null;
}
function nativeMenuState() {
  const enabled = {};
  for (const button of document.querySelectorAll('[data-app-action]')) {
    const action = button.dataset.appAction;
    // Some actions appear in more than one place; either usable control is enough.
    enabled[action] = Boolean(enabled[action] || !button.disabled);
  }
  const picker = document.getElementById('picker-toggle');
  enabled['picker-toggle'] = Boolean(picker && !picker.disabled);
  if (nativeMenuTextInput()) enabled.undo = enabled.redo = true;
  const recent = preferences.get('recent', []);
  return { enabled, pickerNative: preferences.get('filePicker', 'folio') === 'native', recent: Array.isArray(recent) ? recent.filter(path => typeof path === 'string' && path).slice(0, 20) : [] };
}
async function syncNativeMenu() {
  if (!nativeMenuReady) return;
  try {
    const installed = await invoke('sync_native_menu', { state: nativeMenuState() });
    if (installed === true) { const bar = document.getElementById('app-menubar'); if (bar) bar.hidden = true; }
    return installed === true;
  } catch (error) { console.error('Could not update native menu', error); return false; }
}
function scheduleNativeMenuSync() {
  if (!nativeMenuReady) return;
  clearTimeout(nativeMenuTimer);
  nativeMenuTimer = setTimeout(syncNativeMenu, 0);
}
async function initializeNativeMenu() {
  if (!window.__TAURI__ || !['macos', 'darwin'].includes(String(nativePlatform).toLowerCase())) return;
  try { await listen('native-menu-action', event => {
    const action = event.payload;
    if (typeof action !== 'string' || document.hasFocus?.() === false) return;
    const dialogs = [...document.querySelectorAll('dialog[open]')];
    const input = nativeMenuTextInput();
    // Focus belongs to the active modal; dialogs underneath it need not contain
    // the focused input when the user has stacked separate dialogs.
    if ((action === 'undo' || action === 'redo') && input && (!dialogs.length || dialogs.some(dialog => dialog.contains(input)))) {
      document.execCommand(action); return;
    }
    if (dialogs.length) {
      const commands = document.getElementById('command-dialog');
      if (action === 'commands' && dialogs.includes(commands) && (dialogs.length === 1 || commands.contains(document.activeElement))) commands.close();
      else if (action === 'commands' && !commands.open && nativeMenuState().enabled.commands) runAppAction('commands');
      return;
    }
    const state = nativeMenuState();
    if (action.startsWith('recent:')) {
      const path = action.slice(7);
      if (state.recent.includes(path)) requestOpen(path);
    } else if (action === 'preferences') openPreferencesPanel();
    else if (action === 'picker-toggle' && state.enabled[action]) { toggleFilePicker(); scheduleNativeMenuSync(); }
    else if (action !== 'quit' && state.enabled[action] === true) runAppAction(action);
  }); } catch (error) { console.error('Could not listen for native menu actions', error); return; }
  nativeMenuReady = true;
  const bar = document.getElementById('app-menubar');
  if (typeof MutationObserver !== 'undefined' && bar) {
    new MutationObserver(scheduleNativeMenuSync).observe(bar, { subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-checked', 'aria-label'] });
  }
  window.addEventListener?.('focus', scheduleNativeMenuSync);
  document.addEventListener?.('focusin', scheduleNativeMenuSync);
  document.addEventListener?.('focusout', scheduleNativeMenuSync);
  await syncNativeMenu();
}
