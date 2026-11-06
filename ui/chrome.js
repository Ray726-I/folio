'use strict';
// Application menus and per-document presentation; the editor owns text/history.
let documentMode = 'reading', documentReadOnly = false;
let documentNavigation = [], documentNavigationIndex = -1, navigatingHistory = false;
function documentWritable() { return focusedPane !== 'companion' && current.active && current.writable !== false && !documentReadOnly && !transitionLocked; }
function sourceCaret(input) {
  const { selectionStart: start, selectionEnd: end, selectionDirection: direction } = input;
  return direction === 'backward' ? { anchor: end, head: start } : { anchor: start, head: end };
}
function restoreSourceCaret() {
  if (documentMode !== 'source' || !editor) return;
  const input = $('document-source'), selection = editor.getSelection?.();
  if (!selection) return;
  const start = Math.max(0, Math.min(selection.anchor, input.value.length));
  const end = Math.max(0, Math.min(selection.head, input.value.length));
  input.setSelectionRange(Math.min(start, end), Math.max(start, end), start > end ? 'backward' : 'forward');
  const line = input.value.slice(0, start).split('\n').length - 1;
  const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20;
  if (line * lineHeight < input.scrollTop || (line + 1) * lineHeight > input.scrollTop + input.clientHeight) {
    input.scrollTop = Math.max(0, line * lineHeight - input.clientHeight / 3);
  }
}
function syncDocumentMode() {
  const protectedFile = current.writable === false;
  root.dataset.documentMode = documentMode;
  const locked = documentMode === 'reading' || !documentWritable();
  if (editor && documentMode === 'source' && !editor.isSource?.()) editor.setSourceOnly?.(true);
  if (editor && documentMode !== 'source' && editor.isSource?.()) editor.setSourceOnly?.(false);
  if (editor && editor.isLocked() !== locked && !transitionLocked) editor.setLocked(locked);
  $('document-source').readOnly = locked || !editor;
  if (documentMode === 'source' && $('document-source').value !== current.content) {
    $('document-source').value = current.content;
  }
  if (documentMode === 'source' && editor?.isSource?.()) restoreSourceCaret();
  $('document-source').hidden = !current.active || documentMode !== 'source';
  $('preview').hidden = current.active && documentMode === 'source';
  const modeButton = $('document-mode-button');
  $('document-mode-label').textContent = documentReadOnly ? 'Read-only' : { reading: 'Read', edit: 'Edit', source: 'Source' }[documentMode];
  const modeLabel = $('document-mode-label').textContent;
  const nextLabel = { reading: 'Read', edit: 'Edit', source: 'Source' }[nextDocumentMode()];
  $('document-mode-group').dataset.mode = documentReadOnly ? 'readonly' : documentMode;
  modeButton.disabled = documentReadOnly;
  modeButton.setAttribute('aria-label', documentReadOnly ? 'Read-only — choose a mode from the menu' : `${modeLabel} — switch to ${nextLabel}`);
  modeButton.title = documentReadOnly ? 'Read-only — choose a mode from the menu' : `${modeLabel} — switch to ${nextLabel}`;
  modeButton.querySelector('use').setAttribute('href', protectedFile || documentReadOnly ? '#i-lock' : documentMode === 'reading' ? '#i-read' : documentMode === 'source' ? '#i-code' : '#i-edit');
  $('filesystem-permission').hidden = !current.active || !protectedFile;
  for (const button of document.querySelectorAll('[data-document-mode]')) {
    button.setAttribute('aria-checked', String(button.dataset.documentMode === documentMode));
    button.disabled = protectedFile && button.dataset.documentMode === 'edit';
    button.title = button.disabled ? 'This file is not writable. Use Save As to create a writable copy.' : '';
  }
  $('lock-document').disabled = protectedFile;
  $('lock-document').setAttribute('aria-checked', String(documentReadOnly || protectedFile));
  $('lock-document').setAttribute('aria-pressed', String(documentReadOnly || protectedFile));
  $('lock-document').setAttribute('aria-label', 'Open as read-only');
  $('lock-document').title = 'Prevent modifications in every mode';
  $('editor-lock-note').hidden = !current.active || !documentReadOnly || protectedFile;
  $('editor-lock-note').textContent = 'Read-only · You can select, copy, follow links and inspect the source. Turn off read-only to make changes.';
  $('replace-one').disabled = $('replace-all').disabled = !documentWritable() || documentMode === 'reading' || !editor;
  document.querySelectorAll('[data-app-action]').forEach(button => {
    const action = button.dataset.appAction;
    if (['save', 'save-as', 'close', 'copy-path', 'rename', 'reveal', 'duplicate', 'html', 'pdf', 'find', 'replace', 'heading', 'top', 'bottom', 'reading', 'undo', 'redo', 'cut', 'copy', 'paste', 'select-all'].includes(action)) button.disabled = !current.active;
    if (['rename', 'reveal', 'copy-path'].includes(action)) button.disabled = !current.path;
    if (['undo', 'redo', 'cut', 'paste', 'replace'].includes(action)) button.disabled = !documentWritable() || documentMode === 'reading' || !editor;
    if (action === 'find') button.disabled = !current.active && !activeFolder;
    if (action === 'back') button.disabled = documentNavigationIndex <= 0;
    if (action === 'forward') button.disabled = documentNavigationIndex >= documentNavigation.length - 1;
  });
}
function nextDocumentMode() {
  const modes = current.writable === false ? ['reading', 'source'] : ['reading', 'edit', 'source'];
  const index = modes.indexOf(documentMode);
  return modes[(index + 1) % modes.length] || 'edit';
}
function cycleDocumentMode() { setDocumentMode(nextDocumentMode()); }
function setDocumentMode(next) {
  if (focusedPane === 'companion') return;
  if (!current.active || transitionLocked || !['reading', 'edit', 'source'].includes(next)) return;
  if (next === 'edit' && current.writable === false) { toast('Filesystem permissions prevent editing. Use Save As to create a writable copy.'); return; }
  if (documentMode === 'source') {
    const input = $('document-source');
    editor?.setSourceSelection?.(sourceCaret(input));
    editor?.checkpoint?.();
  } else {
    editor?.checkpoint(); editor?.captureSelection?.();
  }
  const reader = $('reader-scroll'), source = $('document-source');
  const previous = documentMode === 'source' ? source : reader;
  const range = Math.max(0, previous.scrollHeight - previous.clientHeight);
  const fraction = range ? previous.scrollTop / range : 0;
  const readerTop = reader.scrollTop;
  const crossingSource = (documentMode === 'source') !== (next === 'source');
  const leavingSource = documentMode === 'source' && next !== 'source';
  const enteringSource = documentMode !== 'source' && next === 'source';
  documentMode = next;
  if (enteringSource) editor?.setSourceOnly?.(true);
  if (leavingSource) editor?.setSourceOnly?.(false);
  syncDocumentMode(); closeAllMenus();
  if (next === 'source') source.focus({ preventScroll: true });
  else if (next === 'edit') editor?.focus();
  const target = next === 'source' ? source : reader;
  // Layout is already mounted in both modes. Mapping the scroll fraction is
  // constant-time and avoids reparsing large Markdown documents on each switch.
  const restore = () => { target.scrollTop = crossingSource ? fraction * Math.max(0, target.scrollHeight - target.clientHeight) : readerTop; };
  restore(); requestAnimationFrame(restore);
}
function toggleDocumentReadOnly() {
  if (focusedPane === 'companion') return;
  if (transitionLocked || current.writable === false) return;
  documentReadOnly = !documentReadOnly; syncDocumentMode();
}
function resetDocumentPresentation(next) {
  documentMode = next ?? (current.active && current.writable !== false && preferences.get('openInEditMode', true) !== false ? 'edit' : 'reading');
  documentReadOnly = false;
}
function recordDocumentNavigation(path) {
  if (!path || navigatingHistory || samePath(documentNavigation[documentNavigationIndex] || '', path)) return;
  documentNavigation.splice(documentNavigationIndex + 1); documentNavigation.push(path);
  if (documentNavigation.length > 100) documentNavigation.shift();
  documentNavigationIndex = documentNavigation.length - 1;
}
function navigateDocumentHistory(direction) {
  return enqueue(async () => {
    const target = documentNavigationIndex + direction;
    if (target < 0 || target >= documentNavigation.length) return;
    navigatingHistory = true;
    try { if (await openPath(documentNavigation[target])) documentNavigationIndex = target; }
    finally { navigatingHistory = false; syncDocumentMode(); }
  });
}
function renderRecentMenu() {
  const menu = $('open-recent-menu'); menu.replaceChildren();
  for (const path of preferences.get('recent', [])) {
    const button = document.createElement('button'); button.className = 'menu-item'; button.setAttribute('role', 'menuitem');
    button.textContent = basename(path); button.title = path;
    button.onclick = () => { closeAllMenus(); requestOpen(path); }; menu.append(button);
  }
  if (!menu.children.length) { const text = document.createElement('p'); text.className = 'menu-description'; text.textContent = 'No recent files'; menu.append(text); }
}
let recentMenuCloseTimer;
function closeRecentMenu() {
  clearTimeout(recentMenuCloseTimer);
  const menu = $('open-recent-menu');
  if (menu.contains(document.activeElement)) $('open-recent-button').focus();
  menu.hidden = true;
  $('open-recent-button').setAttribute('aria-expanded', 'false');
}
function positionRecentMenu() {
  const menu = $('open-recent-menu');
  if (menu.hidden) return;
  const parent = $('open-menu').getBoundingClientRect();
  const anchor = $('open-recent-button').getBoundingClientRect();
  if ($('open-menu').hidden || anchor.bottom < parent.top || anchor.top > parent.bottom) { closeRecentMenu(); return; }
  const edge = 8, rightSpace = innerWidth - parent.right - edge + 1, leftSpace = parent.left - edge + 1;
  menu.style.minWidth = '';
  menu.style.maxWidth = '';
  const space = rightSpace >= 160 ? rightSpace : leftSpace >= 160 ? leftSpace : innerWidth - edge * 2;
  menu.style.minWidth = Math.min(240, space) + 'px';
  menu.style.maxWidth = Math.min(320, space) + 'px';
  const bounds = menu.getBoundingClientRect();
  let left = rightSpace >= 160 ? parent.right - 1 : parent.left - bounds.width + 1;
  const top = rightSpace < 160 && leftSpace < 160 ? anchor.bottom : anchor.top - 6;
  menu.style.left = Math.max(edge, Math.min(left, innerWidth - bounds.width - edge)) + 'px';
  menu.style.top = Math.max(edge, Math.min(top, innerHeight - bounds.height - edge)) + 'px';
}
function openRecentMenu(focus = true) {
  clearTimeout(recentMenuCloseTimer);
  if ($('open-recent-menu').hidden) renderRecentMenu();
  $('open-recent-menu').hidden = false;
  $('open-recent-button').setAttribute('aria-expanded', 'true');
  positionRecentMenu();
  if (focus) $('open-recent-menu').querySelector('button')?.focus();
}
// Document preferences: one settings surface for typography, theme, reading
// behaviour and layout. Sliders preview the document live, but the restyle is
// coalesced to one frame because a width or line-height change reflows the
// whole document and a drag can deliver several input events per frame.
const preferenceRanges = {
  'preference-font-size': { key: 'fontSize', fallback: 19, min: 12, max: 40, read: value => `${value}px` },
  'preference-line-height': { key: 'lineHeight', fallback: 1.7, min: 1.2, max: 2.4, read: value => `${Math.round(value * 10) / 10}` },
  'preference-width': { key: 'contentWidth', fallback: 900, min: 480, max: 1400, read: value => `${value}px` },
  'preference-spacing': { key: 'paragraphSpacing', fallback: 1.15, min: .4, max: 2.4, read: value => `${Math.round(value * 100) / 100}em` }
};
let preferenceFrame = 0, preferenceThemeFrame = 0;

function preferenceNumber(key, fallback, min, max) {
  const stored = preferences.get(key, null), value = Number(stored);
  return stored !== null && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
// The readout and the filled part of the track are painted from the range's
// own snapped value, so the number always agrees with the thumb.
function paintPreferenceRange(id) {
  const input = $(id), value = Number(input.value), min = Number(input.min), max = Number(input.max);
  $(id + '-value').value = preferenceRanges[id].read(value);
  input.style.setProperty('--preference-fill', `${max > min ? ((value - min) / (max - min)) * 100 : 0}%`);
}
function scheduleDocumentPreferences() {
  if (!preferenceFrame) preferenceFrame = requestAnimationFrame(applyDocumentPreferences);
}
function applyDocumentPreferences() {
  if (preferenceFrame) { cancelAnimationFrame(preferenceFrame); preferenceFrame = 0; }
  $('preference-auto-save').checked = preferences.get('autoSaveFiles', false) === true;
  $('preference-restore-session').checked = preferences.get('restoreSession', true) !== false;
  $('preference-open-edit').checked = preferences.get('openInEditMode', true) !== false;
  $('preference-touchpad-zoom-row').hidden = nativePlatform !== 'linux';
  $('preference-touchpad-zoom').checked = touchpadZoom;
  for (const [id, spec] of Object.entries(preferenceRanges)) {
    const input = $(id);
    input.value = String(id === 'preference-font-size' ? fontSize : preferenceNumber(spec.key, spec.fallback, spec.min, spec.max));
    paintPreferenceRange(id);
    const applied = Number(input.value);
    if (id === 'preference-line-height') root.style.setProperty('--document-line-height', applied);
    else if (id === 'preference-spacing') root.style.setProperty('--document-paragraph-spacing', `${applied}em`);
    else if (id === 'preference-width') {
      if (preferences.get(spec.key, null) !== null) root.style.setProperty('--preferred-reading-width', `${applied}px`);
      else root.style.removeProperty('--preferred-reading-width');
    }
  }
  $('preference-font').value = readingFont;
  $('preference-theme').value = availableThemes().some(theme => theme.id === selectedTheme) ? selectedTheme : root.dataset.theme;
  for (const name of ['tasks', 'tables', 'code']) {
    const on = preferences.get('render-' + name, true) !== false;
    $('preference-' + name).checked = on; root.toggleAttribute('data-plain-' + name, !on);
  }
}
function preferencesFocusables() {
  return [...$('view-menu').querySelectorAll('button,select,input,summary')]
    .filter(element => !element.disabled && element.offsetParent !== null && !element.closest('.preference-disclosure:not([open])'));
}
// The panel is fixed, not positioned by CSS: it is taller than a menu and must
// stay inside the window on narrow or short screens, so its place is computed
// from the trigger and re-clamped when the panel or the window changes size.
function positionPreferencesPanel() {
  const menu = $('view-menu');
  if (menu.hidden) return;
  const anchor = $('view-menu-button').getBoundingClientRect();
  const width = menu.offsetWidth, height = menu.offsetHeight, edge = 8;
  const left = Math.max(edge, Math.min(anchor.right - width, innerWidth - width - edge));
  let top = anchor.bottom + 8;
  if (top + height + edge > innerHeight) top = Math.max(edge, innerHeight - height - edge);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}
function openPreferencesPanel() {
  const menu = $('view-menu');
  if (!menu.hidden) return;
  closeAllMenus();
  applyDocumentPreferences();
  menu.hidden = false;
  positionPreferencesPanel();
  $('view-menu-button').setAttribute('aria-expanded', 'true');
  $('preference-font').focus();
}
function closePreferencesPanel(returnFocus = false) {
  const menu = $('view-menu');
  if (menu.hidden) return;
  const restore = returnFocus && menu.contains(document.activeElement);
  menu.hidden = true;
  $('view-menu-button').setAttribute('aria-expanded', 'false');
  if (restore) $('view-menu-button').focus();
}
function initializePreferencesPanel() {
  const menu = $('view-menu'), trigger = $('view-menu-button');
  trigger.addEventListener('click', event => {
    event.stopPropagation();
    menu.hidden ? openPreferencesPanel() : closePreferencesPanel(true);
  });
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && menu.hidden) { event.preventDefault(); openPreferencesPanel(); }
    else if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); closePreferencesPanel(true); }
  });
  $('preferences-close').onclick = () => closePreferencesPanel(true);
  window.addEventListener('resize', positionPreferencesPanel);
  // Opening the rendering disclosure grows the panel; keep it on screen.
  new ResizeObserver(positionPreferencesPanel).observe(menu);
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePreferencesPanel(true); return; }
    if (event.key !== 'Tab') return;
    const controls = preferencesFocusables(), index = controls.indexOf(document.activeElement);
    if (index === -1) return;
    if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0].focus(); }
    else if (event.shiftKey && index === 0) { event.preventDefault(); controls[controls.length - 1].focus(); }
  });
  for (const [id, spec] of Object.entries(preferenceRanges)) {
    const input = $(id);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      paintPreferenceRange(id);
      preferences.set(spec.key, value);
      // Font size owns the document-wide text-size variable and skips the
      // restyle frame; it must not also queue a second document-wide pass.
      if (id === 'preference-font-size') setTextSize(value, { persist: false, anchor: false, announce: false });
      else scheduleDocumentPreferences();
    });
    input.addEventListener('change', () => {
      if (id === 'preference-font-size') { preferences.set('fontSize', fontSize); status(`Document text: ${fontSize} px`); }
      applyDocumentPreferences();
    });
  }
  $('preference-auto-save').onchange = event => { preferences.set('autoSaveFiles', event.target.checked); for (const doc of documents.values()) scheduleAutomaticSave(doc); };
  $('preference-restore-session').onchange = event => preferences.set('restoreSession', event.target.checked);
  $('preference-open-edit').onchange = event => preferences.set('openInEditMode', event.target.checked);
  $('preference-touchpad-zoom').onchange = event => setTouchpadZoom(event.target.checked);
  for (const name of ['tasks', 'tables', 'code']) $('preference-' + name).onchange = event => { preferences.set('render-' + name, event.target.checked); applyDocumentPreferences(); };
  $('preference-font').onchange = event => applyReadingFont(event.target.value);
  // A theme switch recolours every node in the window. Let the select paint
  // its new value first, then apply the palette.
  $('preference-theme').onchange = event => {
    const id = event.target.value;
    if (preferenceThemeFrame) cancelAnimationFrame(preferenceThemeFrame);
    preferenceThemeFrame = requestAnimationFrame(() => {
      preferenceThemeFrame = 0;
      if (id !== selectedTheme) applyTheme(id);
    });
  };
  $('preferences-reset').onclick = () => {
    for (const key of ['openInEditMode', 'lineHeight', 'paragraphSpacing', 'contentWidth', 'headingStyle', 'render-tasks', 'render-tables', 'render-code']) preferences.set(key, null);
    zoomText(0, true); setTouchpadZoom(false, false); applyReadingFont('sans'); applyTheme('system');
    setDocumentWidth(false); applyDocumentPreferences();
  };
}

function showHelp(shortcuts = false) {
  $('help-title').textContent = shortcuts ? 'Keyboard Shortcuts' : 'About Folio';
  $('help-dialog').classList.toggle('shortcuts', shortcuts);
  const content = $('help-content'); content.replaceChildren();
  if (shortcuts) {
    const table = document.createElement('table');
    for (const [label, key] of [['Open File', 'Ctrl+O'], ['Open Folder', 'Ctrl+Shift+O'], ['New document', 'Ctrl+N'], ['Save / Save As', 'Ctrl+S / Ctrl+Shift+S'], ['Undo / Redo', 'Ctrl+Z / Ctrl+Shift+Z'], ['Cut / Copy / Paste', 'Ctrl+X / Ctrl+C / Ctrl+V'], ['Select All', 'Ctrl+A'], ['Find / Replace', 'Ctrl+F / Ctrl+H'], ['Search folder contents', 'Ctrl+Shift+F'], ['File Explorer', 'Ctrl+B'], ['Bold in Edit mode', 'Ctrl+B (in document)'], ['Command window', 'Ctrl+Shift+P'], ['All documents (search open tabs)', 'Ctrl+Shift+A'], ['Fullscreen', 'F11'], ['Zoom in / out / reset', 'Ctrl++ / Ctrl+- / Ctrl+0'], ['Document text size', 'Ctrl+Shift++ / Ctrl+Shift+- / Ctrl+Shift+0'], ['Close File / Quit', 'Ctrl+W / Ctrl+Q']]) {
      const row = table.insertRow(); row.insertCell().textContent = label; row.insertCell().textContent = key;
    }
    content.append(table); const note = document.createElement('p'); note.textContent = 'On macOS, use Command in place of Ctrl. Escape exits focus mode.'; content.append(note);
  } else { const p = document.createElement('p'); p.textContent = 'Folio 0.1.0 · A quiet place for Markdown. Read, edit and keep your files on your own disk. Built with Rust and Tauri. MIT licensed.'; content.append(p); }
  $('help-dialog').showModal(); $('help-close').focus();
}
async function editClipboard(action) {
  if (focusedPane === 'companion') { if (action === 'copy') return navigator.clipboard.writeText(window.getSelection()?.toString() || ''); if (action === 'select-all') { const range=document.createRange(); range.selectNodeContents($('companion-preview')); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); } return; }
  if (!current.active) return;
  if (documentMode === 'source') {
    const input = $('document-source'); input.focus();
    if (action === 'select-all') { input.select(); return; }
    const { selectionStart: from, selectionEnd: to } = input;
    editor?.setSourceSelection?.(sourceCaret(input));
    const owner = current, snapshot = input.value;
    if (action === 'copy' || action === 'cut') {
      await navigator.clipboard.writeText(input.value.slice(from, to));
      if (action === 'cut' && owner === current && snapshot === input.value && documentMode === 'source' && documentWritable() && !input.readOnly) { input.setRangeText('', from, to, 'end'); input.dispatchEvent(new InputEvent('input', { inputType: 'deleteByCut' })); }
    } else if (action === 'paste' && !input.readOnly) {
      const text = await navigator.clipboard.readText();
      if (owner !== current || snapshot !== input.value || !documentWritable() || documentMode !== 'source') return;
      input.setRangeText(text, from, to, 'end'); input.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste' }));
    }
    return;
  }
  editor?.focus();
  if (action === 'select-all') { editor?.selectAll(); return; }
  if (action === 'paste') {
    const owner = current, text = await navigator.clipboard.readText();
    if (owner !== current || !documentWritable() || documentMode !== 'edit') return;
    const surface = $('preview').querySelector('.ProseMirror');
    if (!surface || !text) return;
    editor?.focus();
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    surface.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  } else document.execCommand(action);
}
function openReplace() { openFind(); $('replace-bar').hidden = false; syncDocumentMode(); }
function replaceMatches(all) {
  if (!documentWritable() || documentMode === 'reading' || !editor) return;
  const query = $('find-input').value, replacement = $('replace-input').value;
  if (!query) return;
  let next;
  if (all) next = current.content.replace(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), () => replacement);
  else {
    if (findSource !== current.content) updateFind();
    const match = matches[Math.max(0, findIndex)]; if (!match) return;
    next = current.content.slice(0, match.from) + replacement + current.content.slice(match.to);
  }
  editor.replaceContent(next); syncDocumentMode(); updateFind();
}
function jumpToSource(offset) {
  if (documentMode === 'source') { const input = $('document-source'); input.focus(); input.setSelectionRange(offset, offset); const line = current.content.slice(0, offset).split('\n').length - 1; input.scrollTop = Math.max(0, line * parseFloat(getComputedStyle(input).lineHeight) - input.clientHeight / 3); }
  else editor?.selectRange(offset);
}
function runAppAction(action) {
  closeAllMenus();
  if (focusedPane === 'companion') { if (action === 'find') return openCompanionFind(); if (action === 'close') return closeReadingCompanion(); if (['undo','redo','cut','paste','replace','reading','rename','duplicate'].includes(action)) return; }
  const actions = {
    open: openEntry, folder: openFolderEntry, new: () => newDocument(), home: goHome,
    'new-window': () => invoke('new_window'), 'move-window': () => enqueue(moveDocumentToNewWindow), companion: () => showReadingCompanion(), recovery: reviewRecovery, commands: openCommands, save: () => requestSave(), 'save-as': () => requestSave(true), close: closeDocument, quit: requestClose,
    undo: () => { undoRedo(); syncDocumentMode(); }, redo: () => { undoRedo(true); syncDocumentMode(); },
    cut: () => editClipboard('cut'), copy: () => editClipboard('copy'), paste: () => editClipboard('paste'), 'select-all': () => editClipboard('select-all'),
    find: openFind, 'folder-search': openFolderSearch, replace: openReplace, files: () => toggleDock('files'), outline: () => toggleDock('outline'),
    reading: () => setDocumentMode(documentMode === 'reading' ? 'edit' : 'reading'), focus: toggleFocus, fullscreen: () => invoke('toggle_fullscreen'),
    'zoom-in': () => zoomWindow(.1), 'zoom-out': () => zoomWindow(-.1), 'zoom-reset': () => zoomWindow(0, true),
    back: () => navigateDocumentHistory(-1), forward: () => navigateDocumentHistory(1),
    heading: () => { if (focusedPane === 'companion') focusPane('companion'); setOutline(true); $('outline-items').querySelector('button')?.focus(); },
    top: () => { const scroller = $(focusedPane === 'companion' ? 'companion-scroll' : documentMode === 'source' ? 'document-source' : 'reader-scroll'); scroller.scrollTop = 0; }, bottom: () => { const scroller = $(focusedPane === 'companion' ? 'companion-scroll' : documentMode === 'source' ? 'document-source' : 'reader-scroll'); scroller.scrollTop = scroller.scrollHeight; },
    shortcuts: () => showHelp(true), about: () => showHelp(),
    documentation: () => invoke('open_link', { url: 'https://github.com/Ray726-I/folio#readme' }),
    issue: () => invoke('open_link', { url: 'https://github.com/Ray726-I/folio/issues' }),
    'copy-path': () => navigator.clipboard.writeText(current.path).then(() => status('Document path copied')),
    reveal: () => invoke('reveal_document', { documentId: current.documentId }), rename: renameDocument,
    duplicate: () => { const entry = workspaceEntry(current.path); if (entry) return enqueue(() => performTreeOperation('duplicate', entry)); return enqueue(async () => { const path = await invoke('duplicate_document', { documentId: current.documentId, content: current.content }); if (path) status(`Duplicated to ${path}`); }); },
    html: () => enqueue(async () => { const path = await invoke('export_html', { documentId: current.documentId, content: current.content }); if (path) status(`Exported to ${path}`); }),
    pdf: () => { status('Choose a PDF destination in the print dialog'); window.print(); }
  };
  try { Promise.resolve(actions[action]?.()).catch(toast); } catch (error) { toast(error); }
}
function closeDocument() {
  if (focusedPane === 'companion') return closeReadingCompanion();
  if (current.documentId) return enqueue(() => closeWorkspaceDocument());
  return enqueue(async () => {
    if (!current.active || !(await allowDiscard())) return false;
    try {
      setTransitionLocked(true); await invoke('new_document'); ++renderGeneration; previewSnapshot = null;
      current = { path: null, name: 'Untitled.md', content: '', saved: '', active: false };
      editor?.destroy(); editor = null; editorDocument = null; resetDocumentPresentation(); setLineEnding(null);
      if (activeFolder) { showDocument(); await refreshEditorSurface(); } else showWelcome();
      syncDocumentMode(); status(''); return true;
    } finally { setTransitionLocked(false); }
  });
}
async function renameDocument() {
  if (!current.path) return;
  const entry = workspaceEntry(current.path);
  if (entry) { dockTab = 'files'; dockVisible = true; expandParentsOf(entry.path); renderFolderEntries(); return editTreeName('rename', entry); }
  const owner = current, name = await editValue({ title: 'Rename document', value: current.name });
  if (name === null || name === current.name || owner !== current) return;
  return enqueue(async () => {
    if (owner !== current) return;
    const saved = await invoke('rename_document', { documentId: current.documentId, name });
    if (!saved) return;
    const oldPath = current.path; current.path = saved.path; current.name = saved.name;
    documentNavigation = documentNavigation.map(path => samePath(path, oldPath) ? saved.path : path);
    editorPath = current.path; editor?.refreshMedia(); updateTitle(); addRecent(current.path);
    if (activeFolder) { const listing = await invoke('open_folder', { path: activeFolder.path }); folderEntries = listing.entries; renderFolderEntries(); syncFolderSelection(); }
    status('Document renamed');
  });
}
function initializeChrome() {
  for (const id of ['file', 'edit', 'view', 'go', 'help']) setupMenu('menu-' + id + '-button', id === 'file' ? 'open-menu' : id === 'view' ? 'application-view-menu' : id + '-menu');
  $('document-mode-button').onclick = cycleDocumentMode;
  setupMenu('document-mode-menu-button', 'document-mode-menu'); setupMenu('document-more-button', 'document-more-menu');
  $('lock-document').onclick = toggleDocumentReadOnly;
  document.querySelectorAll('[data-document-mode]').forEach(button => button.onclick = () => setDocumentMode(button.dataset.documentMode));
  document.querySelectorAll('[data-app-action]').forEach(button => button.onclick = () => runAppAction(button.dataset.appAction));
  $('open-recent-button').onclick = event => { event.stopPropagation(); openRecentMenu(); };
  const recentGroup = $('open-recent-button').parentElement;
  recentGroup.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') openRecentMenu(false); });
  recentGroup.addEventListener('pointerleave', () => { recentMenuCloseTimer = setTimeout(closeRecentMenu, 160); });
  $('open-menu').addEventListener('pointerover', event => { if (event.target.closest('.menu-item') && !recentGroup.contains(event.target)) closeRecentMenu(); });
  $('open-menu').addEventListener('focusin', event => { if (!recentGroup.contains(event.target)) closeRecentMenu(); });
  $('open-menu').addEventListener('scroll', positionRecentMenu);
  window.addEventListener('resize', positionRecentMenu);
  $('open-recent-button').onkeydown = event => { if (event.key === 'ArrowRight') { event.stopPropagation(); event.preventDefault(); openRecentMenu(); } };
  $('open-recent-menu').onkeydown = event => {
    event.stopPropagation();
    const buttons = [...$('open-recent-menu').querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowLeft' || event.key === 'Escape') { event.preventDefault(); closeRecentMenu(); $('open-recent-button').focus(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus(); }
    else if (event.key === 'Tab') closeAllMenus();
  };
  const triggers = [...document.querySelectorAll('.menubar-button')];
  $('app-menubar').addEventListener('keydown', event => {
    if (!['ArrowRight', 'ArrowLeft'].includes(event.key) || event.defaultPrevented || event.target.closest('#open-recent-menu')) return;
    event.preventDefault(); const currentGroup = event.target.closest('.app-menu-group'), index = triggers.indexOf(currentGroup?.querySelector('.menubar-button'));
    const next = triggers[(index + (event.key === 'ArrowRight' ? 1 : -1) + triggers.length) % triggers.length];
    const open = currentGroup && !currentGroup.querySelector('.menu').hidden;
    closeAllMenus(); next.focus(); if (open) next.click();
  });
  $('app-menubar').addEventListener('pointerover', event => { const next = event.target.closest('.menubar-button'); if (next && next.getAttribute('aria-expanded') !== 'true' && triggers.some(button => button.getAttribute('aria-expanded') === 'true')) next.click(); });
  let sourceBeforeInput = null, sourceInputType = 'insertText';
  const syncSourceSelection = () => {
    if (documentMode !== 'source' || !editor) return null;
    const input = $('document-source');
    const selection = sourceCaret(input);
    editor.setSourceSelection?.(selection);
    return selection;
  };
  $('document-source').addEventListener('beforeinput', event => {
    sourceBeforeInput = syncSourceSelection() || { anchor: $('document-source').selectionStart, head: $('document-source').selectionEnd };
    sourceInputType = event.inputType || 'insertText';
  });
  $('document-source').addEventListener('input', event => {
    const input = $('document-source');
    if (!documentWritable() || documentMode !== 'source' || !editor) { input.value = current.content; return; }
    const before = sourceBeforeInput;
    const typing = ['insertText', 'insertCompositionText', 'deleteContentBackward', 'deleteContentForward'].includes(event.inputType || sourceInputType);
    sourceBeforeInput = null;
    sourceInputType = 'insertText';
    editor.replaceSource(input.value, sourceCaret(input), typing, before || undefined);
    if (input.value !== current.content) input.value = current.content;
  });
  for (const event of ['select', 'click', 'keyup']) $('document-source').addEventListener(event, syncSourceSelection);
  $('document-source').addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); undoRedo(event.key.toLowerCase() === 'y' || event.shiftKey); syncDocumentMode(); }
  });
  $('replace-one').onclick = () => replaceMatches(false); $('replace-all').onclick = () => replaceMatches(true);
  $('help-close').onclick = () => $('help-dialog').close();
  const themeSelect = $('preference-theme');
  for (const theme of availableThemes()) { const option = document.createElement('option'); option.value = theme.id; option.textContent = theme.label; themeSelect.append(option); }
  initializePreferencesPanel();
  applyDocumentPreferences(); syncDocumentMode();
}
