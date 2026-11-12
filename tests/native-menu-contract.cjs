const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('ui/native-menu.js', 'utf8');
const html = fs.readFileSync('ui/index.html', 'utf8');
const menuMarkup = html.split('<nav id="app-menubar"')[1].split('</nav>')[0];
const menuSource = fs.readFileSync('src/native_menu.rs', 'utf8');
const nativeActions = new Set([...menuSource.matchAll(/\(\s*"([a-z-]+)"\s*,/g)].map(match => match[1]));
assert.match(menuSource, /add\(app,\s*&folio,\s*state,\s*"about"/, 'native Folio menu includes About');
assert.match(menuSource, /"folio:quit"/, 'native Folio menu includes guarded Quit');
assert.match(menuSource, /app\.emit_to\(label,\s*"native-menu-action",\s*action\)/, 'Tauri dispatch targets only the selected window label, never broadcasts');
assert.match(menuSource, /Submenu::with_id\(app,\s*(?:tauri::menu::)?WINDOW_SUBMENU_ID/, 'Window uses the Tauri/AppKit reserved role');
assert.match(menuSource, /Submenu::with_id\(app,\s*(?:tauri::menu::)?HELP_SUBMENU_ID/, 'Help uses the Tauri/AppKit reserved role');
assert.match(menuSource, /"picker-toggle"[\s\S]*?"Use Folio File Picker"[\s\S]*?"Use System File Picker"/, 'native File menu exposes both picker choices');
assert.doesNotMatch(menuSource, /"new-window",\s*"New Window",\s*Some\("Cmd\+Shift\+N"\)/, 'New Window does not claim the webview new-document shortcut');
for (const role of ['cut', 'copy', 'paste', 'select-all']) {
  assert(menuSource.includes(`PredefinedMenuItem::${role.replace('-', '_')}`), `native menu has ${role} role`);
}
for (const role of ['about', 'quit', 'cut', 'copy', 'paste', 'select-all']) nativeActions.add(role);
for (const match of menuMarkup.matchAll(/data-app-action="([^"]+)"/g)) {
  assert(nativeActions.has(match[1]), `native menu must include ${match[1]}`);
}
const handlers = {};
const calls = [];
const buttons = [{ dataset: { appAction: 'save' }, disabled: true }, { dataset: { appAction: 'open' }, disabled: false }, { dataset: { appAction: 'about' }, disabled: false }, { dataset: { appAction: 'undo' }, disabled: false }, { dataset: { appAction: 'redo' }, disabled: false }, { dataset: { appAction: 'commands' }, disabled: false }];
let modal = false;
let active = null;
const commandDialog = { close: () => calls.push(['close-commands']) };
let installed = false;
let picker = 'folio';
const bar = { hidden: false };
const context = {
  nativePlatform: 'macos', window: { __TAURI__: {} },
  document: { querySelector: () => modal || null, querySelectorAll: selector => selector === 'dialog[open]' ? (modal ? [modal] : []) : buttons, getElementById: id => id === 'command-dialog' ? commandDialog : bar, get activeElement() { return active; }, execCommand: action => calls.push(['input-history', action]) },
  preferences: { get: key => key === 'filePicker' ? picker : ['/one.md', '/two.md'] },
  listen: async (name, handler) => { handlers[name] = handler; },
  invoke: async (name, args) => { calls.push([name, args]); return installed; },
  runAppAction: action => calls.push(['action', action]),
  requestOpen: path => calls.push(['open', path]),
  openPreferencesPanel: () => calls.push(['preferences']),
  toggleFilePicker: () => { picker = picker === 'native' ? 'folio' : 'native'; calls.push(['picker', picker]); },
  setTimeout, clearTimeout,
};
vm.runInNewContext(source, context);
(async () => {
  await context.initializeNativeMenu();
  assert.equal(bar.hidden, false, 'unfocused window must keep its in-window menu');
  installed = true;
  await context.syncNativeMenu();
  assert.equal(bar.hidden, true, 'only a successful installation hides the in-window menu');
  assert.equal(calls[0][0], 'sync_native_menu');
  assert.equal(calls[0][1].state.enabled.save, false);
  assert.equal(calls[0][1].state.enabled.open, true);
  assert.equal(calls[0][1].state.enabled.about, true, 'About remains available in the native app menu');
  assert.equal(calls[0][1].state.pickerNative, false);
  handlers['native-menu-action']({ payload: 'picker-toggle' });
  assert.equal(picker, 'native');
  assert.equal(context.nativeMenuState().pickerNative, true);
  handlers['native-menu-action']({ payload: 'picker-toggle' });
  assert.equal(picker, 'folio');
  handlers['native-menu-action']({ payload: 'save' });
  assert(!calls.some(call => call[0] === 'action' && call[1] === 'save'));
  handlers['native-menu-action']({ payload: 'open' });
  assert(calls.some(call => call[0] === 'action' && call[1] === 'open'));
  handlers['native-menu-action']({ payload: 'recent:/two.md' });
  assert(calls.some(call => call[0] === 'open' && call[1] === '/two.md'));
  modal = true;
  handlers['native-menu-action']({ payload: 'open' });
  assert.equal(calls.filter(call => call[0] === 'action').length, 1);
  modal = false;
  active = { matches: selector => selector.includes('input') };
  handlers['native-menu-action']({ payload: 'undo' });
  handlers['native-menu-action']({ payload: 'redo' });
  assert.deepEqual(calls.filter(call => call[0] === 'input-history'), [['input-history', 'undo'], ['input-history', 'redo']], 'native undo/redo stays in focused text inputs');
  assert(!calls.some(call => call[0] === 'action' && ['undo', 'redo'].includes(call[1])));
  active = null; modal = commandDialog;
  handlers['native-menu-action']({ payload: 'commands' });
  assert(calls.some(call => call[0] === 'close-commands'), 'native command shortcut closes the open command dialog');
  console.log('native menu frontend contract passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
