'use strict';
// Application menus and per-document presentation; the editor owns text/history.
let documentMode = 'reading', documentReadOnly = false;
let documentNavigation = [], documentNavigationIndex = -1, navigatingHistory = false;
function documentWritable() { return current.active && current.writable !== false && !documentReadOnly && !transitionLocked; }
function syncDocumentMode() {
  const protectedFile = current.writable === false;
  root.dataset.documentMode = documentMode;
  const locked = documentMode === 'reading' || !documentWritable();
  if (editor && editor.isLocked() !== locked && !transitionLocked) editor.setLocked(locked);
  $('document-source').readOnly = locked || !editor;
  if (documentMode === 'source' && $('document-source').value !== current.content) $('document-source').value = current.content;
  $('document-source').hidden = !current.active || documentMode !== 'source';
  $('preview').hidden = current.active && documentMode === 'source';
  $('document-mode-label').textContent = documentReadOnly ? 'Read-only' : { reading: 'Reading mode', edit: 'Edit mode', source: 'Source mode' }[documentMode];
  const modeLabel = $('document-mode-label').textContent;
  $('document-mode-button').setAttribute('aria-label', `${modeLabel} — Switch document mode`);
  $('document-mode-button').title = `${modeLabel} — Switch document mode`;
  $('document-mode-button').querySelector('use').setAttribute('href', protectedFile || documentReadOnly ? '#i-lock' : documentMode === 'reading' ? '#i-read' : documentMode === 'source' ? '#i-code' : '#i-edit');
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
  $('format-tools').hidden = !formatToolbarVisible || !current.active || documentMode !== 'edit';
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
function setDocumentMode(next) {
  if (!current.active || transitionLocked || !['reading', 'edit', 'source'].includes(next)) return;
  if (next === 'edit' && current.writable === false) { toast('Filesystem permissions prevent editing. Use Save As to create a writable copy.'); return; }
  editor?.checkpoint(); editor?.captureSelection?.();
  const reader = $('reader-scroll'), source = $('document-source');
  const previous = documentMode === 'source' ? source : reader;
  const range = Math.max(0, previous.scrollHeight - previous.clientHeight);
  const fraction = range ? previous.scrollTop / range : 0;
  const readerTop = reader.scrollTop;
  const crossingSource = (documentMode === 'source') !== (next === 'source');
  documentMode = next; syncDocumentMode(); closeAllMenus();
  if (next === 'source') source.focus({ preventScroll: true });
  else if (next === 'edit') editor?.focus();
  const target = next === 'source' ? source : reader;
  // Layout is already mounted in both modes. Mapping the scroll fraction is
  // constant-time and avoids reparsing large Markdown documents on each switch.
  const restore = () => { target.scrollTop = crossingSource ? fraction * Math.max(0, target.scrollHeight - target.clientHeight) : readerTop; };
  restore(); requestAnimationFrame(restore);
}
function toggleDocumentReadOnly() {
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
function applyDocumentPreferences() {
  $('preference-open-edit').checked = preferences.get('openInEditMode', true) !== false;
  $('preference-touchpad-zoom-row').hidden = nativePlatform !== 'linux';
  $('preference-touchpad-zoom').checked = touchpadZoom;
  const number = (key, fallback, min, max) => Math.min(max, Math.max(min, Number(preferences.get(key, fallback)) || fallback));
  const lineHeight = number('lineHeight', 1.7, 1.2, 2.4), spacing = number('paragraphSpacing', 1.15, .4, 2.4), width = number('contentWidth', 900, 480, 1400);
  root.style.setProperty('--document-line-height', lineHeight);
  root.style.setProperty('--document-paragraph-spacing', `${spacing}em`);
  if (preferences.get('contentWidth', null) !== null) root.style.setProperty('--preferred-reading-width', `${width}px`);
  else root.style.removeProperty('--preferred-reading-width');
  for (const [id, value] of [['font', readingFont], ['font-size', fontSize], ['line-height', lineHeight], ['width', width], ['spacing', spacing], ['theme', selectedTheme]]) $('preference-' + id).value = value;
  for (const name of ['tasks', 'tables', 'code']) {
    const on = preferences.get('render-' + name, true) !== false;
    $('preference-' + name).checked = on; root.toggleAttribute('data-plain-' + name, !on);
  }
  for (const [id, value] of [['font-size', `${fontSize}px`], ['line-height', lineHeight], ['width', `${width}px`], ['spacing', `${spacing}em`]]) $('preference-' + id + '-value').value = value;
}
function showHelp(shortcuts = false) {
  $('help-title').textContent = shortcuts ? 'Keyboard Shortcuts' : 'About Folio';
  const content = $('help-content'); content.replaceChildren();
  if (shortcuts) {
    const table = document.createElement('table');
    for (const [label, key] of [['Open File', 'Ctrl+O'], ['Open Folder', 'Ctrl+Shift+O'], ['New document', 'Ctrl+N'], ['Save / Save As', 'Ctrl+S / Ctrl+Shift+S'], ['Undo / Redo', 'Ctrl+Z / Ctrl+Shift+Z'], ['Cut / Copy / Paste', 'Ctrl+X / Ctrl+C / Ctrl+V'], ['Select All', 'Ctrl+A'], ['Find / Replace', 'Ctrl+F / Ctrl+H'], ['Search folder contents', 'Ctrl+Shift+F'], ['File Explorer', 'Ctrl+B'], ['Bold in Edit mode', 'Ctrl+B (in document)'], ['Command window', 'Ctrl+Shift+P'], ['Fullscreen', 'F11'], ['Zoom in / out / reset', 'Ctrl++ / Ctrl+- / Ctrl+0'], ['Document text size', 'Ctrl+Shift++ / Ctrl+Shift+- / Ctrl+Shift+0'], ['Close File / Quit', 'Ctrl+W / Ctrl+Q']]) {
      const row = table.insertRow(); row.insertCell().textContent = label; row.insertCell().textContent = key;
    }
    content.append(table); const note = document.createElement('p'); note.textContent = 'On macOS, use Command in place of Ctrl. Escape exits focus mode.'; content.append(note);
  } else { const p = document.createElement('p'); p.textContent = 'Folio 0.1.0 · A quiet place for Markdown. Read, edit and keep your files on your own disk. Built with Rust and Tauri. MIT licensed.'; content.append(p); }
  $('help-dialog').showModal(); $('help-close').focus();
}
async function editClipboard(action) {
  if (!current.active) return;
  if (documentMode === 'source') {
    const input = $('document-source'); input.focus();
    if (action === 'select-all') { input.select(); return; }
    const { selectionStart: from, selectionEnd: to } = input;
    const owner = current, snapshot = input.value;
    if (action === 'copy' || action === 'cut') {
      await navigator.clipboard.writeText(input.value.slice(from, to));
      if (action === 'cut' && owner === current && snapshot === input.value && documentMode === 'source' && documentWritable() && !input.readOnly) { input.setRangeText('', from, to, 'end'); input.dispatchEvent(new Event('input')); }
    } else if (action === 'paste' && !input.readOnly) {
      const text = await navigator.clipboard.readText();
      if (owner !== current || snapshot !== input.value || !documentWritable() || documentMode !== 'source') return;
      input.setRangeText(text, from, to, 'end'); input.dispatchEvent(new Event('input'));
    }
    return;
  }
  editor?.focus();
  if (action === 'select-all') { editor?.selectRange(0, current.content.length); return; }
  if (action === 'paste') {
    const owner = current, text = await navigator.clipboard.readText();
    if (owner !== current || !documentWritable() || documentMode !== 'edit') return;
    editor?.focus(); document.execCommand('insertText', false, text);
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
  const actions = {
    open: openEntry, folder: openFolderEntry, new: () => newDocument(), home: goHome,
    commands: openCommands, save: () => requestSave(), 'save-as': () => requestSave(true), close: closeDocument, quit: requestClose,
    undo: () => { undoRedo(); syncDocumentMode(); }, redo: () => { undoRedo(true); syncDocumentMode(); },
    cut: () => editClipboard('cut'), copy: () => editClipboard('copy'), paste: () => editClipboard('paste'), 'select-all': () => editClipboard('select-all'),
    find: openFind, 'folder-search': openFolderSearch, replace: openReplace, files: () => toggleDock('files'), outline: () => toggleDock('outline'),
    reading: () => setDocumentMode(documentMode === 'reading' ? 'edit' : 'reading'), focus: toggleFocus, fullscreen: () => invoke('toggle_fullscreen'),
    'zoom-in': () => zoomWindow(.1), 'zoom-out': () => zoomWindow(-.1), 'zoom-reset': () => zoomWindow(0, true),
    back: () => navigateDocumentHistory(-1), forward: () => navigateDocumentHistory(1),
    heading: () => { setOutline(true); $('outline-items').querySelector('button')?.focus(); },
    top: () => { const scroller = $(documentMode === 'source' ? 'document-source' : 'reader-scroll'); scroller.scrollTop = 0; }, bottom: () => { const scroller = $(documentMode === 'source' ? 'document-source' : 'reader-scroll'); scroller.scrollTop = scroller.scrollHeight; },
    shortcuts: () => showHelp(true), about: () => showHelp(),
    documentation: () => invoke('open_link', { url: 'https://github.com/Ray726-I/folio#readme' }),
    issue: () => invoke('open_link', { url: 'https://github.com/Ray726-I/folio/issues' }),
    'copy-path': () => navigator.clipboard.writeText(current.path).then(() => status('Document path copied')),
    reveal: () => invoke('reveal_document'), rename: renameDocument,
    duplicate: () => enqueue(async () => { const path = await invoke('duplicate_document', { content: current.content }); if (path) status(`Duplicated to ${path}`); }),
    html: () => enqueue(async () => { const path = await invoke('export_html', { content: current.content }); if (path) status(`Exported to ${path}`); }),
    pdf: () => { status('Choose a PDF destination in the print dialog'); window.print(); }
  };
  try { Promise.resolve(actions[action]?.()).catch(toast); } catch (error) { toast(error); }
}
function closeDocument() {
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
  const owner = current, name = await editValue({ title: 'Rename document', value: current.name });
  if (name === null || name === current.name || owner !== current) return;
  return enqueue(async () => {
    if (owner !== current) return;
    const saved = await invoke('rename_document', { name });
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
  setupMenu('document-mode-button', 'document-mode-menu'); setupMenu('document-more-button', 'document-more-menu');
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
  $('document-source').addEventListener('input', () => {
    if (!documentWritable() || documentMode !== 'source' || !editor) { $('document-source').value = current.content; return; }
    editor.replaceContent($('document-source').value);
    if ($('document-source').value !== current.content) $('document-source').value = current.content;
  });
  $('document-source').addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); undoRedo(event.key.toLowerCase() === 'y' || event.shiftKey); syncDocumentMode(); }
  });
  $('replace-one').onclick = () => replaceMatches(false); $('replace-all').onclick = () => replaceMatches(true);
  $('help-close').onclick = () => $('help-dialog').close();
  $('preference-open-edit').onchange = event => preferences.set('openInEditMode', event.target.checked);
  $('preference-touchpad-zoom').onchange = event => setTouchpadZoom(event.target.checked);
  const themeSelect = $('preference-theme');
  for (const theme of availableThemes()) { const option = document.createElement('option'); option.value = theme.id; option.textContent = theme.id === 'paper' ? 'Light · Adwaita' : theme.id === 'graphite' ? 'Dark · Adwaita' : theme.label; themeSelect.append(option); }
  themeSelect.onchange = () => applyTheme(themeSelect.value);
  $('preference-font').onchange = event => applyReadingFont(event.target.value);
  $('preference-font-size').oninput = event => { const value = Number(event.target.value); if (value >= 12 && value <= 40) { zoomText(value - fontSize); $('preference-font-size-value').value = `${fontSize}px`; } };
  for (const [id, key, min, max] of [['line-height', 'lineHeight', 1.2, 2.4], ['spacing', 'paragraphSpacing', .4, 2.4], ['width', 'contentWidth', 480, 1400]]) $('preference-' + id).oninput = event => {
    const value = Number(event.target.value); if (value >= min && value <= max) { preferences.set(key, value); applyDocumentPreferences(); }
  };
  for (const name of ['tasks', 'tables', 'code']) $('preference-' + name).onchange = event => { preferences.set('render-' + name, event.target.checked); applyDocumentPreferences(); };
  $('preferences-reset').onclick = () => {
    for (const key of ['openInEditMode', 'lineHeight', 'paragraphSpacing', 'contentWidth', 'headingStyle', 'render-tasks', 'render-tables', 'render-code']) preferences.set(key, null);
    zoomText(0, true); setTouchpadZoom(false, false); applyReadingFont('sans'); applyTheme('system'); setDocumentWidth(false); applyDocumentPreferences();
  };
  $('view-menu-button').addEventListener('click', applyDocumentPreferences);
  applyDocumentPreferences(); syncDocumentMode();
}
