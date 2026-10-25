'use strict';
let current = { path: null, name: 'Untitled.md', content: '', saved: '', active: false };
let mode = 'read', busy = false, queue = Promise.resolve();
let activeFolder = null, folderEntries = [], folderVisible = true, expandedFolders = new Set();
let fontSize = Math.min(40, Math.max(12, Number(preferences.get('fontSize', 19)) || 19));
let windowZoom = Math.min(2, Math.max(.6, Number(preferences.get('windowZoom', 1)) || 1));
let remoteImages = preferences.get('remoteImages', false) === true;
let readingFont = preferences.get('readingFont', 'serif') === 'sans' ? 'sans' : 'serif';
const legacyOutline = preferences.get('outline', null);
if (preferences.get('outlineWidth', null) === null && typeof legacyOutline === 'number') preferences.set('outlineWidth', legacyOutline);
let outlineVisible = preferences.get('outlineVisible', typeof legacyOutline === 'boolean' ? legacyOutline : false), toastTimer;
let wideLayout = preferences.get('wideLayout', false);
const dirty = () => current.content !== current.saved;
function commandError(error) {
  if (error && typeof error === 'object') return { code: error.code || 'error', message: error.message || String(error) };
  const message = String(error ?? 'Unknown error');
  return { code: message.startsWith('FILE_CHANGED:') ? 'file_changed' : 'error', message: message.replace(/^FILE_CHANGED:\s*/, '') };
}
function errorMessage(error) { return commandError(error).message; }
function icon(name) { const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); node.classList.add('icon'); node.setAttribute('aria-hidden', 'true'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#i-${name}`); node.append(use); return node; }
function toast(message) { $('toast').textContent = errorMessage(message); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
function status(message) { $('app-status').textContent = message; }
function updateTitle() {
  const name = current.active ? current.name : activeFolder?.name || '';
  $('document-name').textContent = name || 'Folio';
  $('document-location').textContent = current.path ? dirname(current.path) : activeFolder?.path || (current.active ? 'Unsaved document' : 'Markdown files and folders');
  $('document-location').title = current.path || activeFolder?.path || '';
  $('dirty-dot').hidden = !dirty();
  $('save').classList.toggle('is-dirty', dirty());
  invoke('set_title', { name, dirty: dirty() }).catch(() => {});
}
function updateStats() {
  const words = current.content.trim().split(/\s+/).filter(Boolean).length;
  $('word-count').textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
  $('reading-time').textContent = `${Math.max(1, Math.ceil(words / 220))} min read`;
}
let statsTimer;
function scheduleStats() { clearTimeout(statsTimer); statsTimer = setTimeout(updateStats, 180); }
function setLineEnding(lineEnding) {
  $('line-ending').hidden = !lineEnding;
  $('line-ending').textContent = lineEnding ? ` · ${lineEnding}` : '';
}
function showDocument() {
  $('welcome').hidden = true; $('document-view').hidden = false; $('statusbar').hidden = false;
  $('home').disabled = false;
  document.querySelectorAll('.document-control').forEach(control => { control.hidden = !current.active; });
  resetHistory(); $('disk-banner').hidden = true; updateTitle(); updateStats(); setOutline(outlineVisible);
  $('folder-empty').hidden = current.active || !activeFolder;
  renderFolderEntries();
}
function showWelcome() {
  $('welcome').hidden = false; $('document-view').hidden = true; $('statusbar').hidden = true;
  $('home').disabled = true;
  $('preview').replaceChildren(); $('folder-empty').hidden = true;
  $('disk-banner').hidden = true; $('find-bar').hidden = true;
  $('outline').hidden = true; $('outline-divider').hidden = true;
  $('file-browser').hidden = true; $('folder-divider').hidden = true; $('folder-toggle').hidden = true;
  document.body.classList.remove('focus-mode');
  document.querySelectorAll('.document-control').forEach(control => { control.hidden = true; });
  updateTitle(); updateStats();
}
function goHome() {
  return enqueue(async () => {
    if ($('document-view').hidden) return;
    if (!(await allowDiscard())) return;
    await invoke('new_document');
    ++renderGeneration;
    previewSnapshot = null; previewBlocks = [];
    current = { path: null, name: 'Untitled.md', content: '', saved: '', active: false };
    activeFolder = null; folderEntries = []; expandedFolders.clear(); folderVisible = true;
    setLineEnding(null);
    mode = 'read'; root.dataset.mode = mode;
    showWelcome(); status('');
  });
}
const narrowDrawers = () => window.matchMedia('(max-width:960px)').matches;
function setOutline(visible, persist = true) {
  outlineVisible = visible;
  if (visible && narrowDrawers() && !$('file-browser').hidden) setFolderVisible(false);
  $('outline').hidden = !visible || !current.active;
  $('outline-divider').hidden = $('outline').hidden;
  $('outline-toggle').setAttribute('aria-pressed', String(visible));
  $('outline-toggle').setAttribute('aria-expanded', String(visible && current.active));
  if (persist) preferences.set('outlineVisible', visible);
}
function setupSidebarResize(sidebarId, dividerId, key, defaultWidth, styleName = key) {
  const sidebar = $(sidebarId), divider = $(dividerId);
  const property = `--${styleName}-sidebar-width`;
  function setWidth(value) {
    const other = sidebarId === 'file-browser' ? $('outline') : $('file-browser');
    const available = window.innerWidth - (other.hidden ? 0 : other.getBoundingClientRect().width) - 320;
    const width = Math.max(200, Math.min(Math.max(200, Math.min(520, available)), value));
    document.body.style.setProperty(property, `${width}px`);
    preferences.set(key, width);
  }
  setWidth(Number(preferences.get(key, defaultWidth)) || defaultWidth);
  divider.addEventListener('pointerdown', event => { event.preventDefault(); divider.setPointerCapture(event.pointerId); divider.classList.add('dragging'); });
  divider.addEventListener('pointermove', event => { if (divider.hasPointerCapture(event.pointerId)) setWidth(event.clientX - sidebar.getBoundingClientRect().left); });
  divider.addEventListener('pointerup', event => { if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId); divider.classList.remove('dragging'); });
  divider.addEventListener('keydown', event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(sidebar.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 20 : -20)); } });
}
setupSidebarResize('file-browser', 'folder-divider', 'folder', 250);
setupSidebarResize('outline', 'outline-divider', 'outlineWidth', 248, 'outline');
async function setMode(next) {
  if (!current.active) return;
  await commitInlineEdit();
  const scroll = $('reader-scroll').scrollTop;
  mode = next === 'read' ? 'read' : 'edit'; root.dataset.mode = mode;
  $('reader-scroll').hidden = false;
  $('read-mode').setAttribute('aria-pressed', String(mode === 'read'));
  $('edit-mode').setAttribute('aria-pressed', String(mode === 'edit'));
  await renderPreview(scroll);
  if (mode === 'edit' && !current.content) beginInlineEdit(editTarget($('preview').firstElementChild, 0));
  if (!$('find-bar').hidden) updateFind();
}
function requestMode(next) { return enqueue(() => setMode(next)); }
function zoomText(delta, reset = false) { fontSize = reset ? 19 : Math.min(40, Math.max(12, fontSize + delta)); root.style.setProperty('--text-size', `${fontSize}px`); preferences.set('fontSize', fontSize); status(`Document text: ${fontSize} px`); }
function zoomWindow(delta, reset = false) { windowZoom = reset ? 1 : Math.min(2, Math.max(.6, Math.round((windowZoom + delta) * 10) / 10)); $('zoom-reset').textContent = `${Math.round(windowZoom * 100)}%`; preferences.set('windowZoom', windowZoom); invoke('set_window_zoom', { scale: windowZoom }).catch(toast); }
function applyReadingFont(font = readingFont, persist = true) {
  readingFont = font === 'sans' ? 'sans' : 'serif';
  root.dataset.readingFont = readingFont;
  if (persist) preferences.set('readingFont', readingFont);
  if ($('command-dialog').open) renderCommands();
}
function toggleReadingFont() { applyReadingFont(readingFont === 'serif' ? 'sans' : 'serif'); }
function toggleRemoteImages() {
  remoteImages = !remoteImages;
  preferences.set('remoteImages', remoteImages);
  previewSnapshot = null;
  status(remoteImages ? 'Remote images will load from the network' : 'Remote images are blocked');
  if (current.active) enqueue(() => renderPreview());
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (selectedTheme === 'system') { updatePreviewPalette(); refreshMermaid(); }
});
// The outline steps aside for the file tree on narrow screens; give it back when there is room.
window.matchMedia('(max-width:960px)').addEventListener('change', event => {
  if (!event.matches && outlineVisible && $('outline').hidden) setOutline(true);
});
function ask(title, message, choices) {
  return new Promise(resolve => {
    const dialog = $('confirm-dialog'); $('confirm-title').textContent = title; $('confirm-message').textContent = message; $('confirm-actions').replaceChildren();
    const finish = value => { dialog.close(); dialog.removeEventListener('cancel', cancel); resolve(value); };
    const cancel = event => { event.preventDefault(); finish('cancel'); };
    dialog.addEventListener('cancel', cancel);
    for (const choice of choices) {
      const button = document.createElement('button'); button.className = `button ${choice.style || ''}`; button.textContent = choice.label; button.onclick = () => finish(choice.value); $('confirm-actions').append(button);
    }
    dialog.showModal(); $('confirm-actions').firstElementChild?.focus();
  });
}
async function allowDiscard() {
  if (current.active && mode === 'edit') await commitInlineEdit();
  if (!dirty()) return true;
  const result = await ask('Save your changes?', `“${current.name}” has changes that haven't been saved.`, [
    { label: 'Cancel', value: 'cancel' }, { label: 'Discard', value: 'discard', style: 'destructive' }, { label: 'Save', value: 'save', style: 'suggested' }
  ]);
  if (result === 'save') return await save() && !dirty();
  return result === 'discard';
}
function enqueue(action) {
  queue = queue.then(async () => {
    busy = true; $('open').disabled = true; $('save').disabled = true;
    try { return await action(); } catch (error) { status(''); toast(error); return false; }
    finally { busy = false; $('open').disabled = false; $('save').disabled = false; }
  });
  return queue;
}
async function openPath(path, confirmed = false) {
  if (!confirmed && !(await allowDiscard())) return false;
  status('Opening…');
  const document = await invoke('open_document', { path });
  ++renderGeneration;
  previewSnapshot = null;
  previewBlocks = [];
  current = { path: document.path, name: document.name, content: document.content, saved: document.content, active: true };
  if (activeFolder && !samePath(document.path, activeFolder.path) && !isWithin(document.path, activeFolder.path)) { activeFolder = null; folderEntries = []; expandedFolders.clear(); }
  if (activeFolder) expandParentsOf(document.path);
  setLineEnding(document.lineEnding || null);
  showDocument(); $('reader-scroll').scrollTop = 0; await setMode('read'); addRecent(current.path); return true;
}
function requestOpen(path) { return enqueue(() => openPath(path)); }
let pickerListing = null, pickerSelection = null;
async function browseTo(path) {
  pickerListing = await invoke('browse_directory', { path }); pickerSelection = null;
  $('open-path').value = pickerListing.path;
  $('open-parent').disabled = !pickerListing.parent;
  $('open-selection-hint').textContent = 'Select a Markdown file or folder';
  $('open-items').replaceChildren();
  for (const entry of pickerListing.entries) {
    const row = document.createElement('button'); row.className = 'file-dialog-item'; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false');
    row.append(icon(entry.directory ? 'open' : 'file'));
    const label = document.createElement('span'); label.textContent = entry.name; row.append(label);
    row.onclick = () => {
      pickerSelection = entry;
      $('open-items').querySelectorAll('.file-dialog-item').forEach(item => item.setAttribute('aria-selected', String(item === row)));
      $('open-selection-hint').textContent = entry.directory ? 'Open selected folder' : 'Open selected Markdown file';
    };
    row.ondblclick = () => entry.directory ? browseTo(entry.path).catch(toast) : confirmOpenPicker();
    $('open-items').append(row);
  }
  if (!pickerListing.entries.length) { const empty = document.createElement('p'); empty.className = 'empty-results'; empty.textContent = 'No Markdown files or folders here'; $('open-items').append(empty); }
}
async function openChooser() {
  try {
    const initial = activeFolder?.path || (current.path ? dirname(current.path) : null);
    await browseTo(initial);
    if (!$('open-dialog').open) $('open-dialog').showModal();
    $('open-items').querySelector('button')?.focus();
  } catch (error) { toast(error); }
}
function confirmOpenPicker() {
  const typed = $('open-path').value.trim();
  const path = pickerSelection?.path || typed || pickerListing?.path;
  $('open-dialog').close();
  if (path) requestOpenLocation(path);
}
function setFolderVisible(visible) {
  folderVisible = visible;
  if (visible && narrowDrawers() && !$('outline').hidden) setOutline(false, false);
  const shown = Boolean(activeFolder && visible);
  $('file-browser').hidden = !shown;
  $('folder-divider').hidden = !shown;
  $('folder-toggle').hidden = !activeFolder;
  $('folder-toggle').setAttribute('aria-pressed', String(shown));
  $('folder-toggle').setAttribute('aria-expanded', String(shown));
}
function expandParentsOf(path) {
  for (const entry of folderEntries) {
    if (entry.directory && isWithin(path, entry.path)) expandedFolders.add(pathKey(entry.path));
  }
}
function entryIsVisible(entry) {
  if (!activeFolder) return false;
  let parent = dirname(entry.path);
  while (parent && !samePath(parent, activeFolder.path) && isWithin(parent, activeFolder.path)) {
    if (!expandedFolders.has(pathKey(parent))) return false;
    const next = dirname(parent);
    if (!next || samePath(next, parent)) break;
    parent = next;
  }
  return true;
}
function renderFolderEntries() {
  setFolderVisible(folderVisible);
  const list = $('folder-items');
  const scrollTop = $('folder-items').scrollTop;
  list.replaceChildren();
  if (!activeFolder) return;
  $('folder-name').textContent = activeFolder.name || activeFolder.path;
  $('folder-name').title = activeFolder.path;
  for (const entry of folderEntries) {
    if (!entryIsVisible(entry)) continue;
    const button = document.createElement('button');
    button.className = `folder-entry${entry.directory ? ' directory' : ''}${samePath(current.path, entry.path) ? ' selected' : ''}`;
    button.style.setProperty('--depth', entry.depth);
    button.title = entry.path;
    if (entry.directory) {
      const expanded = expandedFolders.has(pathKey(entry.path));
      button.setAttribute('aria-expanded', String(expanded));
      const chevron = icon('chevron'); chevron.classList.add('tree-chevron'); button.append(chevron);
      button.append(icon('open'));
      button.onclick = () => { expanded ? expandedFolders.delete(pathKey(entry.path)) : expandedFolders.add(pathKey(entry.path)); renderFolderEntries(); };
    } else {
      const spacer = document.createElement('span'); spacer.className = 'tree-spacer'; button.append(spacer);
      button.append(icon('file'));
      if (samePath(current.path, entry.path)) button.setAttribute('aria-current', 'page');
      button.onclick = () => requestOpen(entry.path);
    }
    const label = document.createElement('span'); label.textContent = entry.name; button.append(label);
    list.append(button);
  }
  if (!folderEntries.length) {
    const empty = document.createElement('div'); empty.className = 'sidebar-empty';
    const title = document.createElement('strong'); title.textContent = 'No Markdown files';
    const hint = document.createElement('span'); hint.textContent = 'Open another folder to browse it.';
    empty.append(title, hint); list.append(empty);
  }
  $('folder-items').scrollTop = scrollTop;
}
async function openFolderPath(path, confirmed = false) {
  if (!confirmed && !(await allowDiscard())) return false;
  // Scan first: if the folder cannot be read, keep the current document intact
  // instead of leaving the backend and UI out of sync.
  const listing = await invoke('open_folder', { path });
  await invoke('new_document');
  ++renderGeneration;
  activeFolder = { path: listing.path, name: listing.name }; folderEntries = listing.entries;
  expandedFolders.clear(); folderVisible = true;
  current = { path: null, name: 'Untitled.md', content: '', saved: '', active: false };
  previewSnapshot = null;
  previewBlocks = [];
  setLineEnding(null);
  mode = 'read'; root.dataset.mode = mode;
  $('reader-scroll').hidden = false;
  showDocument(); $('preview').replaceChildren(); $('reader-scroll').scrollTop = 0; status('');
  $('folder-empty').querySelector('h1').textContent = folderEntries.some(entry => !entry.directory) ? 'Folder opened' : 'No Markdown files';
  $('folder-empty').querySelector('p').textContent = folderEntries.some(entry => !entry.directory) ? 'Choose a Markdown file from the file tree.' : 'This folder has no Markdown files. Open another folder to browse it.';
  const limits = [];
  if (listing.skipped) limits.push(`${listing.skipped} unreadable ${listing.skipped === 1 ? 'entry was' : 'entries were'} skipped`);
  if (listing.truncated) limits.push('only the first 5,000 entries are shown');
  if (limits.length) toast(`Folder opened with limits: ${limits.join('; ')}.`);
  return true;
}
function requestOpenLocation(path) {
  return enqueue(async () => {
    if (await invoke('path_is_directory', { path })) return openFolderPath(path);
    return openPath(path);
  });
}
async function save(saveAs = false, force = false) {
  if (!current.active) return false;
  if (mode === 'edit') await commitInlineEdit();
  const snapshot = current.content;
  status('Saving…');
  try {
    const saved = await invoke('save_document', { content: snapshot, saveAs, force });
    if (!saved) { status(''); return false; }
    current.path = saved.path; current.name = saved.name; current.saved = snapshot; updateTitle(); $('disk-banner').hidden = true; addRecent(current.path); status('Saved');
    if (mode === 'read') await renderPreview();
    return true;
  } catch (error) {
    status('');
    const failure = commandError(error);
    if (failure.code !== 'file_changed') throw new Error(failure.message);
    const choice = await ask('This file changed on disk', 'Another app changed this file. Reload the disk version, or overwrite it with your current document.', [
      { label: 'Cancel', value: 'cancel' }, { label: 'Reload', value: 'reload' }, { label: 'Overwrite', value: 'overwrite', style: 'destructive' }
    ]);
    if (choice === 'overwrite') return save(saveAs, true);
    if (choice === 'reload') { await openPath(current.path, true); return true; }
    return false;
  }
}
function requestSave(saveAs = false) { return enqueue(() => save(saveAs)); }
function newDocument(sample = false) {
  return enqueue(async () => {
    if (!(await allowDiscard())) return;
    await invoke('new_document'); ++renderGeneration;
    previewSnapshot = null;
    previewBlocks = [];
    const content = sample ? SAMPLE : '';
    current = { path: null, name: sample ? 'Welcome.md' : 'Untitled.md', content, saved: content, active: true };
    setLineEnding(null);
    showDocument(); $('reader-scroll').scrollTop = 0; await setMode(sample ? 'read' : 'edit');
  });
}
function addRecent(path) { const recent = preferences.get('recent', []); preferences.set('recent', [path, ...recent.filter(item => !samePath(item, path))].slice(0, 6)); renderRecent(); }
function renderRecent() {
  const recent = preferences.get('recent', []); $('recent-section').hidden = !recent.length; $('recent-files').replaceChildren();
  for (const path of recent.slice(0, 4)) {
    const button = document.createElement('button'); button.className = 'recent-file'; button.append(icon('file'));
    const text = document.createElement('div'), name = document.createElement('strong'), location = document.createElement('small');
    name.textContent = basename(path); location.textContent = dirname(path); text.append(name, location); button.append(text); button.title = path; button.onclick = () => requestOpen(path); $('recent-files').append(button);
  }
}

let commandScope = 'commands', filteredCommands = [], selectedCommand = 0;
function allCommands() {
  const commands = [
    { label: 'Open file…', icon: 'open', shortcut: 'Ctrl+O', action: openChooser },
    { label: 'New document', icon: 'plus', shortcut: 'Ctrl+N', action: () => newDocument() },
    { label: 'Change theme…', icon: 'theme', action: () => openCommands('themes') },
    { label: 'Try a sample document', icon: 'file', action: () => newDocument(true) },
    { label: 'Clear recent files', icon: 'close', action: () => { preferences.set('recent', []); renderRecent(); toast('Recent files cleared'); } }
  ];
  if (current.active) commands.splice(2, 0,
    { label: 'Save', icon: 'save', shortcut: 'Ctrl+S', action: () => requestSave() },
    { label: 'Save as…', icon: 'save', shortcut: 'Ctrl+Shift+S', action: () => requestSave(true) },
    { label: 'Preview document', icon: 'read', action: () => requestMode('read') },
    { label: 'Edit document', icon: 'edit', action: () => requestMode('edit') },
    { label: 'Undo', icon: 'edit', shortcut: 'Ctrl+Z', action: () => enqueue(() => undoRedo()) },
    { label: 'Redo', icon: 'edit', shortcut: 'Ctrl+Shift+Z / Ctrl+Y', action: () => enqueue(() => undoRedo(true)) },
    { label: 'Find in document', icon: 'search', shortcut: 'Ctrl+F', action: openFind },
    { label: remoteImages ? 'Block remote images' : 'Load remote images', icon: 'read', action: toggleRemoteImages },
    { label: readingFont === 'serif' ? 'Use sans-serif reading text' : 'Use serif reading text', icon: 'read', action: toggleReadingFont },
    { label: 'Toggle outline', icon: 'outline', action: () => setOutline(!outlineVisible) },
    { label: 'Toggle focus mode', icon: 'focus', shortcut: 'F11', action: toggleFocus },
    { label: wideLayout ? 'Use centered document width' : 'Use full document width', icon: wideLayout ? 'width-contract' : 'width-expand', action: toggleDocumentWidth },
    { label: 'Zoom in', icon: 'plus', shortcut: 'Ctrl+=', action: () => zoomWindow(.1) },
    { label: 'Zoom out', icon: 'minus', shortcut: 'Ctrl+-', action: () => zoomWindow(-.1) },
    { label: 'Reset window zoom', icon: 'read', shortcut: 'Ctrl+0', action: () => zoomWindow(0, true) },
    { label: 'Increase document text size', icon: 'plus', shortcut: 'Ctrl+Shift+=', action: () => zoomText(1) },
    { label: 'Decrease document text size', icon: 'minus', shortcut: 'Ctrl+Shift+-', action: () => zoomText(-1) },
    { label: 'Reset document text size', icon: 'read', shortcut: 'Ctrl+Shift+0', action: () => zoomText(0, true) }
  );
  if (activeFolder) commands.splice(2, 0, { label: 'Toggle file tree', icon: 'open', shortcut: 'Ctrl+B', action: () => setFolderVisible(!folderVisible) });
  return commands;
}
function themeCommands() { return availableThemes().map(theme => ({ ...theme, label: `Theme: ${theme.label}`, action: () => applyTheme(theme.id) })); }
function openCommands(scope = 'commands') {
  if ($('confirm-dialog').open) return;
  commandScope = scope; selectedCommand = 0; $('command-search').value = ''; $('command-search').placeholder = scope === 'themes' ? 'Search themes…' : 'Search commands or themes…';
  renderCommands(); if (!$('command-dialog').open) $('command-dialog').showModal(); $('command-search').focus();
}
function renderCommands() {
  const query = $('command-search').value.trim().toLocaleLowerCase();
  const list = commandScope === 'themes' ? themeCommands() : [...allCommands(), ...themeCommands()];
  filteredCommands = list.filter(command => `${command.label} ${command.detail || ''}`.toLocaleLowerCase().includes(query));
  selectedCommand = Math.max(0, Math.min(selectedCommand, filteredCommands.length - 1));
  $('command-scope').textContent = commandScope === 'themes' ? 'Appearance' : query ? 'Search results' : 'Commands';
  $('command-results').replaceChildren();
  if (!filteredCommands.length) { const empty = document.createElement('p'); empty.className = 'empty-results'; empty.textContent = 'No matching commands'; $('command-results').append(empty); }
  filteredCommands.forEach((command, index) => {
    const button = document.createElement('button'); button.id = `command-${index}`; button.className = `command-item${index === selectedCommand ? ' active' : ''}`;
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === selectedCommand)); button.tabIndex = -1;
    if (command.swatch) { const swatch = document.createElement('span'); swatch.className = 'theme-swatch'; swatch.style.setProperty('--swatch', command.swatch); button.append(swatch); }
    else button.append(icon(command.icon));
    const label = document.createElement('span'); label.className = 'command-label'; label.textContent = command.label; button.append(label);
    if (command.id === selectedTheme) button.append(icon('check'));
    else if (command.detail) { const detail = document.createElement('span'); detail.className = 'command-detail'; detail.textContent = command.detail; button.append(detail); }
    if (command.shortcut) { const shortcut = document.createElement('span'); shortcut.className = 'shortcut'; shortcut.textContent = command.shortcut; button.append(shortcut); }
    button.onclick = () => executeCommand(index); $('command-results').append(button);
  });
  $('command-search').setAttribute('aria-activedescendant', filteredCommands.length ? `command-${selectedCommand}` : '');
}
function executeCommand(index) {
  const command = filteredCommands[index]; if (!command) return;
  $('command-dialog').close(); Promise.resolve(command.action()).catch(toast);
}
$('command-search').addEventListener('input', () => { selectedCommand = 0; renderCommands(); });
$('command-search').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); selectedCommand = (selectedCommand + (event.key === 'ArrowDown' ? 1 : -1) + filteredCommands.length) % Math.max(1, filteredCommands.length); renderCommands(); $(`command-${selectedCommand}`)?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter') { event.preventDefault(); executeCommand(selectedCommand); }
  else if (event.key === 'Backspace' && !$('command-search').value && commandScope === 'themes') openCommands();
});
for (const id of ['command-dialog']) $(id).addEventListener('click', event => { const bounds = $(id).getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $(id).close(); });

let matches = [], findIndex = -1;
function openFind() { if (!current.active) return; if (inlineEdit) { enqueue(async () => { await commitInlineEdit(); openFind(); }); return; } $('find-bar').hidden = false; $('find-input').focus(); $('find-input').select(); updateFind(); }
function clearHighlights() { $('preview').querySelectorAll('mark[data-find]').forEach(mark => mark.replaceWith(document.createTextNode(mark.textContent))); $('preview').normalize(); }
function updateFind() {
  clearHighlights(); matches = []; findIndex = -1;
  const query = $('find-input').value.toLocaleLowerCase();
  if (!query) { $('find-result').textContent = ''; return; }
  {
    const walker = document.createTreeWalker($('preview'), NodeFilter.SHOW_TEXT), nodes = []; while (walker.nextNode()) { if (!walker.currentNode.parentElement?.closest('.mermaid-host,.katex,textarea,[hidden]')) nodes.push(walker.currentNode); }
    for (const node of nodes) {
      const text = node.nodeValue, lower = text.toLocaleLowerCase(); let cursor = 0, position = lower.indexOf(query);
      if (position === -1) continue;
      const fragment = document.createDocumentFragment();
      while (position !== -1 && matches.length < 2000) { fragment.append(document.createTextNode(text.slice(cursor, position))); const mark = document.createElement('mark'); mark.dataset.find = ''; mark.textContent = text.slice(position, position + query.length); fragment.append(mark); matches.push(mark); cursor = position + query.length; position = lower.indexOf(query, cursor); }
      fragment.append(document.createTextNode(text.slice(cursor))); node.replaceWith(fragment);
    }
  }
  if (matches.length) nextFind(1); else $('find-result').textContent = 'No matches';
}
function nextFind(direction) {
  if (!matches.length) return; findIndex = (findIndex + direction + matches.length) % matches.length;
  matches.forEach(mark => mark.classList.remove('find-active')); matches[findIndex].classList.add('find-active'); matches[findIndex].scrollIntoView({ block: 'center' });
  $('find-result').textContent = `${findIndex + 1} / ${matches.length}`;
}
function closeFind() { $('find-bar').hidden = true; clearHighlights(); $('reader-scroll').focus(); }
function toggleFocus() { document.body.classList.toggle('focus-mode'); }
function setDocumentWidth(full, persist = true) {
  const anchor = current.active ? previewElementForBlock(previewBlockAtViewportTop()) : null;
  const previousTop = anchor?.getBoundingClientRect().top;
  wideLayout = Boolean(full);
  root.dataset.documentWidth = wideLayout ? 'full' : 'centered';
  const button = $('width-toggle');
  const label = wideLayout ? 'Use centered document width' : 'Use full document width';
  button.setAttribute('aria-pressed', String(wideLayout));
  button.setAttribute('aria-label', label);
  button.title = label;
  button.querySelector('use').setAttribute('href', wideLayout ? '#i-width-contract' : '#i-width-expand');
  if (anchor && previousTop !== undefined) $('reader-scroll').scrollTop += anchor.getBoundingClientRect().top - previousTop;
  if (persist) preferences.set('wideLayout', wideLayout);
}
function toggleDocumentWidth() { setDocumentWidth(!wideLayout); }

$('preview').addEventListener('change', event => {
  const checkbox = event.target.closest('input[type="checkbox"][data-task-index]');
  if (!checkbox || mode !== 'edit') return;
  const taskIndex = Number(checkbox.dataset.taskIndex), checked = checkbox.checked;
  enqueue(async () => {
    await commitInlineEdit();
    changeContent(await invoke('set_task_checked', { content: current.content, taskIndex, checked }));
    await renderPreview();
  });
});
$('home').onclick = goHome;
$('open').onclick = $('welcome-open').onclick = openChooser;
$('open-parent').onclick = () => pickerListing?.parent && browseTo(pickerListing.parent).catch(toast);
$('open-go').onclick = () => browseTo($('open-path').value.trim()).catch(toast);
$('open-path').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); browseTo($('open-path').value.trim()).catch(toast); } };
$('open-dialog').addEventListener('keydown', event => { if (event.altKey && event.key === 'ArrowLeft' && pickerListing?.parent) { event.preventDefault(); browseTo(pickerListing.parent).catch(toast); } });
$('open-confirm').onclick = confirmOpenPicker;
$('open-cancel').onclick = $('open-dialog-close').onclick = () => $('open-dialog').close();
$('folder-close').onclick = () => setFolderVisible(false);
$('folder-toggle').onclick = () => setFolderVisible(!folderVisible);
$('folder-refresh').onclick = () => activeFolder && enqueue(async () => { const listing = await invoke('open_folder', { path: activeFolder.path }); activeFolder = { path: listing.path, name: listing.name }; folderEntries = listing.entries; renderFolderEntries(); });
$('new').onclick = () => newDocument(); $('sample').onclick = () => newDocument(true);
$('read-mode').onclick = () => requestMode('read'); $('edit-mode').onclick = () => requestMode('edit'); $('save').onclick = () => requestSave();
$('palette-open').onclick = () => openCommands(); $('outline-toggle').onclick = () => setOutline(!outlineVisible); $('outline-close').onclick = () => setOutline(false);
$('width-toggle').onclick = toggleDocumentWidth;
$('zoom-in').onclick = () => zoomWindow(.1); $('zoom-out').onclick = () => zoomWindow(-.1); $('zoom-reset').onclick = () => zoomWindow(0, true);
$('reload').onclick = () => requestOpen(current.path); $('dismiss-disk').onclick = () => { $('disk-banner').hidden = true; };
$('find-input').oninput = updateFind; $('find-next').onclick = () => nextFind(1); $('find-previous').onclick = () => nextFind(-1); $('find-close').onclick = closeFind;
$('find-input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); nextFind(event.shiftKey ? -1 : 1); } };
function followPreviewLink(anchor) {
  const href = anchor.getAttribute('href'); if (!href) return;
  if (href.startsWith('#')) { let id; try { id = decodeURIComponent(href.slice(1)); } catch { return; } document.getElementById(id)?.scrollIntoView({ block: 'start' }); }
  else if (/^(https?:|mailto:)/i.test(href)) invoke('open_link', { url: href }).catch(toast);
  else enqueue(async () => { const path = await invoke('resolve_document_link', { link: href }); await openPath(path); });
}
$('preview').addEventListener('click', event => {
  const anchor = event.target.closest('a');
  if (mode === 'edit') {
    if (anchor) event.preventDefault();
    if (event.target.closest('input,button,textarea')) return;
    if (inlineEdit || busy) return;
    beginInlineEdit(editTarget(event.target, event.clientY));
    return;
  }
  if (!anchor) return;
  event.preventDefault();
  followPreviewLink(anchor);
});
$('preview').addEventListener('auxclick', event => {
  if (event.button !== 1) return;
  const anchor = event.target.closest('a');
  if (!anchor) return;
  event.preventDefault();
  if (mode === 'read') followPreviewLink(anchor);
});
$('preview').addEventListener('dragstart', event => { if (event.target.closest('a')) event.preventDefault(); });
document.addEventListener('pointerdown', event => {
  if (!inlineEdit || event.target === inlineEdit.textarea || event.target.closest('dialog,#find-bar')) return;
  const checkbox = event.target.closest('input[type="checkbox"][data-task-index]');
  if (checkbox) {
    event.preventDefault();
    const taskIndex = Number(checkbox.dataset.taskIndex), checked = !checkbox.checked;
    enqueue(async () => {
      await commitInlineEdit();
      changeContent(await invoke('set_task_checked', { content: current.content, taskIndex, checked }));
      await renderPreview();
    });
    return;
  }
  if (event.target.closest('#preview') && !event.target.closest('input,button')) {
    event.preventDefault();
    const x = event.clientX, y = event.clientY;
    enqueue(async () => { await commitInlineEdit(); const target = document.elementFromPoint(x, y); if (target?.closest('#preview')) beginInlineEdit(editTarget(target, y)); });
  } else enqueue(commitInlineEdit);
});
$('preview').addEventListener('keydown', event => {
  if (mode === 'edit' && event.key === 'Enter' && !event.target.matches('textarea,input')) {
    event.preventDefault(); beginInlineEdit(editTarget(event.target, event.target.getBoundingClientRect().top + 10));
  }
});
document.addEventListener('keydown', event => {
  const control = event.ctrlKey || event.metaKey;
  if (control && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); $('command-dialog').open ? $('command-dialog').close() : openCommands(); return; }
  if ($('command-dialog').open || $('confirm-dialog').open || $('open-dialog').open) return;
  if (event.key === 'Escape') { if (!$('find-bar').hidden) closeFind(); else document.body.classList.remove('focus-mode'); return; }
  if (event.key === 'F11') { event.preventDefault(); if (current.active) toggleFocus(); return; }
  if (!control) return;
  const key = event.key.toLowerCase();
  if (key === 'z' || key === 'y') {
    if (event.target.matches('input')) return;
    event.preventDefault(); enqueue(() => undoRedo(key === 'y' || event.shiftKey));
  }
  else if (event.code === 'Equal' || key === '+' || key === '=') { event.preventDefault(); event.shiftKey ? zoomText(1) : zoomWindow(.1); }
  else if (event.code === 'Minus' || key === '-' || key === '_') { event.preventDefault(); event.shiftKey ? zoomText(-1) : zoomWindow(-.1); }
  else if (key === '0') { event.preventDefault(); event.shiftKey ? zoomText(0, true) : zoomWindow(0, true); }
  else if (key === 'o') { event.preventDefault(); openChooser(); }
  else if (key === 'b' && activeFolder) { event.preventDefault(); setFolderVisible(!folderVisible); }
  else if (key === 'n') { event.preventDefault(); newDocument(); }
  else if (key === 's') { event.preventDefault(); requestSave(event.shiftKey); }
  else if (key === 'e') { event.preventDefault(); enqueue(() => setMode(mode === 'read' ? 'edit' : 'read')); }
  else if (key === 'f') { event.preventDefault(); openFind(); }
  else if (key === 'w') { event.preventDefault(); requestClose(); }
});
async function requestClose() { return enqueue(async () => { if (await allowDiscard()) await invoke('close_window'); }); }

const SAMPLE = `# A quiet place for your words

Folio opens **individual Markdown files**. Read comfortably, switch to editing when you need to, and save right back to disk.

## Make yourself at home

Use the search button in the header, or **Ctrl+Shift+P**, to open the command window. Search for a theme and press Enter to apply it.

> [!NOTE]
> When Omarchy is detected, choose the **Omarchy** theme to follow your current desktop palette automatically.

## A few useful shortcuts

| Action | Shortcut |
| :--- | :--- |
| Open a file or folder | Ctrl+O |
| Read or edit | Ctrl+E |
| Save | Ctrl+S |
| Zoom the whole app | Ctrl+= / Ctrl+- |
| Change document text size | Ctrl+Shift+= / Ctrl+Shift+- |
| Reset app zoom | Ctrl+0 |

## Plain text, beautifully rendered

- [x] Tables, task lists, and footnotes
- [x] Code with syntax highlighting
- [x] Links and local images
- [ ] Your next idea

\`\`\`rust
fn main() {
    let message = "Hello, Folio!";
    println!("{message}");
}
\`\`\`

Your files stay yours. This sample is just a starting point.[^1]

[^1]: Editing this sample and pressing Ctrl+S lets you save your own copy.
`;

async function start() {
  zoomText(0); zoomWindow(0); renderRecent(); setDocumentWidth(wideLayout, false);
  if (!window.__TAURI__) { toast('Open Folio from your app menu to enable file access.'); return; }
  await listen('request-close', requestClose);
  await listen('open-files', event => { for (const path of event.payload) requestOpenLocation(path); });
  await listen('system-theme', event => { omarchy = event.payload; if (selectedTheme === 'omarchy') applyTheme('omarchy', false); else if ($('command-dialog').open) renderCommands(); });
  applyReadingFont(readingFont, false);
  const state = await invoke('bootstrap'); setPlatform(state.platform); omarchy = state.theme;
  if (preferences.get('theme', null) === null && omarchy) selectedTheme = 'omarchy';
  applyTheme(selectedTheme, false);
  for (const path of state.paths) requestOpenLocation(path);
  await window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(event => {
    const type = event.payload.type; $('drop-overlay').hidden = type !== 'over' && type !== 'enter';
    if (type === 'drop') { $('drop-overlay').hidden = true; for (const path of event.payload.paths) requestOpenLocation(path); }
  });
  setInterval(async () => {
    if (!current.path || busy || document.hidden) return;
    const path = current.path;
    try { const changed = await invoke('document_changed'); if (path === current.path) $('disk-banner').hidden = !changed; } catch {}
  }, 3000);
}
start().catch(error => { toast(error); console.error(error); });
