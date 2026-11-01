'use strict';
let current = { path: null, name: 'Untitled.md', content: '', saved: '', active: false };
let mode = 'read', busy = false, queue = Promise.resolve();
let activeFolder = null, folderEntries = [], folderVisible = true, expandedFolders = new Set();
let renderedFolder = { path: null, entries: null };
let fontSize = Math.min(40, Math.max(12, Number(preferences.get('fontSize', 19)) || 19));
let windowZoom = Math.min(2, Math.max(.6, Number(preferences.get('windowZoom', 1)) || 1));
let remoteImages = preferences.get('remoteImages', false) === true;
let readingFont = preferences.get('readingFont', 'serif') === 'sans' ? 'sans' : 'serif';
const legacyOutline = preferences.get('outline', null);
if (preferences.get('outlineWidth', null) === null && typeof legacyOutline === 'number') preferences.set('outlineWidth', legacyOutline);
let outlineVisible = preferences.get('outlineVisible', typeof legacyOutline === 'boolean' ? legacyOutline : false), toastTimer;
let wideLayout = preferences.get('wideLayout', false);
let formatToolbarVisible = preferences.get('formatToolbarVisible', true);
function filePicker() { const value = preferences.get('filePicker', 'folio'); return value === 'native' ? 'native' : 'folio'; }
function syncOpenAffordance() {
  const native = filePicker() === 'native';
  const open = $('open'), label = native ? 'Open a Markdown file (Ctrl+O)' : 'Open a file or folder (Ctrl+O)';
  open.title = label; open.setAttribute('aria-label', label);
  open.querySelector('use').setAttribute('href', native ? '#i-file' : '#i-open');
  open.querySelector('span').textContent = native ? 'Open file' : 'Open';
  $('open-folder').hidden = !native;
  const fileOption = $('open-file');
  if (fileOption) {
    const fileLabel = native ? 'Open file…' : 'Open file or folder…';
    fileOption.querySelector('.menu-text').textContent = fileLabel;
    fileOption.setAttribute('aria-label', fileLabel.replace('…', '') + ' (Ctrl+O)');
  }
  const pickerOption = $('picker-toggle');
  if (pickerOption) {
    const pickerLabel = native ? 'Use Folio file picker' : 'Use system file picker';
    pickerOption.querySelector('.menu-text').textContent = pickerLabel;
    pickerOption.setAttribute('aria-label', pickerLabel);
  }
}
function setFilePicker(next) {
  const value = next === 'native' ? 'native' : 'folio';
  preferences.set('filePicker', value);
  syncOpenAffordance();
  status(value === 'native' ? 'System file picker enabled' : 'Folio file picker enabled');
}
function toggleFilePicker() { setFilePicker(filePicker() === 'native' ? 'folio' : 'native'); }
let nativePickActive = false;
const dirty = () => current.content !== current.saved;
// Persistent save indicator state: null when it should mirror dirty/clean,
// 'saving' while a save is in flight, or { error } after a rejected save
// until the next save attempt. Rendered visibly by updateTitle().
let saveStatus = null;
function saveState() {
  if (!current.active) return { text: '', state: 'idle' };
  if (saveStatus === 'saving') return { text: 'Saving…', state: 'saving' };
  if (saveStatus && saveStatus.error) return { text: 'Save failed', state: 'error' };
  // Compact dirty label: the short "Edited" keeps the indicator footprint
  // near the old Saved width so no wide gap is reserved. The full
  // "Unsaved changes" meaning lives in the accessible name and tooltip.
  return dirty() ? { text: 'Edited', state: 'dirty' } : { text: 'Saved', state: 'saved' };
}
function commandError(error) {
  if (error && typeof error === 'object') return { code: error.code || 'error', message: error.message || String(error) };
  const message = String(error ?? 'Unknown error');
  return { code: message.startsWith('FILE_CHANGED:') ? 'file_changed' : 'error', message: message.replace(/^FILE_CHANGED:\s*/, '') };
}
function errorMessage(error) { return commandError(error).message; }
function icon(name) { const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); node.classList.add('icon'); node.setAttribute('aria-hidden', 'true'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#i-${name}`); node.append(use); return node; }
function toast(message) { $('toast').textContent = errorMessage(message); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
function status(message) { $('app-status').textContent = message; }
let titleTimer = 0, lastSentTitle = { name: null, dirty: null };
function sendTitle(name, dirty) {
  if (lastSentTitle.name === name && lastSentTitle.dirty === dirty) return;
  lastSentTitle = { name, dirty };
  invoke('set_title', { name, dirty }).catch(() => {});
}
let renderedTitleKey = null;
function updateTitle() {
  const name = current.active ? current.name : activeFolder?.name || '';
  // Typing calls this on every keystroke. Everything below is derived from
  // these values, so when none of them changed there is nothing to write: the
  // name, dirty flag and save state are stable for the whole typing burst.
  const state = saveState();
  const key = [name, current.path || activeFolder?.path || '', current.active ? 1 : 0,
    dirty() ? 1 : 0, state.text, state.state, saveStatus?.error || ''].join('\u0000');
  if (key === renderedTitleKey) return;
  renderedTitleKey = key;
  $('document-name').textContent = name || 'Folio';
  $('document-location').textContent = current.path ? dirname(current.path) : activeFolder?.path || (current.active ? 'Unsaved document' : 'Markdown files and folders');
  $('document-location').title = current.path || activeFolder?.path || '';
  $('dirty-dot').hidden = !dirty();
  const saveButton = $('save'), isDirty = dirty();
  saveButton.classList.toggle('is-dirty', isDirty);
  const saveLabel = !current.active ? 'Save (Ctrl+S)'
    : isDirty ? `Save (Ctrl+S) — unsaved changes in ${current.name}` : 'Save (Ctrl+S) — all changes saved';
  saveButton.setAttribute('aria-label', saveLabel);
  saveButton.title = saveLabel;
  const saveStateElement = $('save-state');
  saveStateElement.textContent = state.text;
  saveStateElement.dataset.state = state.state;
  // The short "Edited" label still announces the full meaning to assistive
  // technology and hover, so nothing is lost by staying compact.
  const accessibleText = state.state === 'dirty' ? 'Unsaved changes' : state.text;
  const stateTitle = state.state === 'error' && saveStatus?.error ? saveStatus.error
    : state.state === 'dirty' ? 'Unsaved changes' : '';
  saveStateElement.title = stateTitle;
  saveStateElement.setAttribute('aria-label', state.state === 'error' && saveStatus?.error ? `Save failed: ${saveStatus.error}` : `Save state: ${accessibleText || 'no document'}`);
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => sendTitle(name, dirty()), 120);
}
function countWords(text) {
  let words = 0, inWord = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const space = code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0x1680
      || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
      || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
    if (space) inWord = false;
    else if (!inWord) { inWord = true; words++; }
  }
  return words;
}
function updateStats() {
  const words = countWords(current.content);
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
  setFormatToolbarVisible(formatToolbarVisible, false);
  if (!current.active) editorPresentation(false, false, false);
  $('disk-banner').hidden = true; saveStatus = null; updateTitle(); updateStats(); setOutline(outlineVisible);
  $('folder-empty').hidden = current.active || !activeFolder;
  syncFolderSelection();
}
function showWelcome() {
  editor?.destroy(); editor = null; editorDocument = null; cancelMermaidPending();
  $('welcome').hidden = false; $('document-view').hidden = true; $('statusbar').hidden = true;
  $('home').disabled = true;
  $('preview').replaceChildren(); $('folder-empty').hidden = true;
  $('disk-banner').hidden = true; $('find-bar').hidden = true;
  $('outline').hidden = true; $('outline-divider').hidden = true;
  $('file-browser').hidden = true; $('folder-divider').hidden = true; $('folder-toggle').hidden = true;
  document.body.classList.remove('focus-mode');
  document.querySelectorAll('.document-control').forEach(control => { control.hidden = true; });
  setFormatToolbarVisible(formatToolbarVisible, false); editorPresentation(false, false, false);
  saveStatus = null; updateTitle(); updateStats();
}
function goHome() {
  return enqueue(async () => {
    if ($('document-view').hidden) return;
    if (!(await allowDiscard())) return;
    // Native new_document resets backend state before it resolves, so the
    // outgoing document must be immutable as soon as departure is approved.
    // Keep the guard through teardown and release it on every exit.
    try {
      setTransitionLocked(true);
      await invoke('new_document');
      ++renderGeneration;
      previewSnapshot = null;
      current = { path: null, name: 'Untitled.md', content: '', saved: '', active: false };
      activeFolder = null; folderEntries = []; expandedFolders.clear(); folderVisible = true;
      setLineEnding(null);
      mode = 'read'; root.dataset.mode = mode;
      showWelcome(); status('');
    } finally {
      setTransitionLocked(false);
    }
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
  if (visible && !$('outline').hidden && typeof refreshEditorOutline === 'function') refreshEditorOutline();
}
function setupSidebarResize(sidebarId, dividerId, key, defaultWidth, styleName = key) {
  const sidebar = $(sidebarId), divider = $(dividerId);
  const property = `--${styleName}-sidebar-width`;
  let otherWidth = 0, dragLeft = 0, pendingX = null, frame = 0, appliedWidth = 0;
  const otherSidebar = () => (sidebarId === 'file-browser' ? $('outline') : $('file-browser'));
  // Layout only: clamps against the last measured sibling width and writes the
  // CSS variable. Callers own measurement and persistence.
  function applyWidth(value) {
    const other = otherSidebar();
    const available = window.innerWidth - (other.hidden ? 0 : otherWidth) - 320;
    const width = Math.max(200, Math.min(Math.max(200, Math.min(520, available)), value));
    document.body.style.setProperty(property, `${width}px`);
    appliedWidth = width;
  }
  function measureOther() { const other = otherSidebar(); otherWidth = other.hidden ? 0 : other.getBoundingClientRect().width; }
  function applyPending() {
    if (pendingX === null) return;
    const x = pendingX;
    pendingX = null;
    applyWidth(x - dragLeft);
  }
  measureOther();
  applyWidth(Number(preferences.get(key, defaultWidth)) || defaultWidth);
  // Keep the resolved startup width on record so the default survives the
  // first launch; drags persist once per gesture instead of per move.
  preferences.set(key, appliedWidth);
  divider.addEventListener('pointerdown', event => {
    event.preventDefault(); divider.setPointerCapture(event.pointerId); divider.classList.add('dragging');
    // Layout is read once per gesture; pointermove then only reads the pointer.
    measureOther(); dragLeft = sidebar.getBoundingClientRect().left;
  });
  divider.addEventListener('pointermove', event => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    pendingX = event.clientX;
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; applyPending(); });
  });
  divider.addEventListener('pointerup', event => {
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
    divider.classList.remove('dragging');
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    applyPending();
    preferences.set(key, appliedWidth);
  });
  divider.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    measureOther();
    applyWidth(sidebar.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 20 : -20));
    preferences.set(key, appliedWidth);
  });
}
setupSidebarResize('file-browser', 'folder-divider', 'folder', 250);
setupSidebarResize('outline', 'outline-divider', 'outlineWidth', 248, 'outline');
// The shell always shows the formatted editor; opening a document only needs
// the editor mounted and the find matches refreshed.
async function refreshEditorSurface() {
  if (!current.active) return;
  editor?.captureSelection?.();
  await renderPreview();
  // Opening a document puts the caret in the editor. Without this the page
  // has no focused editing host, and a native drag that crosses into a
  // rendered block collapses instead of spanning it.
  editor?.focus();
  if (!$('find-bar').hidden) updateFind();
}
function readerScrollAnchor() {
  if (!current.active) return null;
  const scroller = $('reader-scroll');
  if (!scroller || scroller.hidden) return null;
  const box = scroller.getBoundingClientRect();
  // The reader centers its text column, so probing from the scroller's own
  // edge would land in the side gutter and resolve to the scroller itself.
  const column = $('preview').getBoundingClientRect();
  const left = Math.max(box.left, column.left);
  const x = Math.max(left + 1, Math.min(left + 64, box.right - 1));
  const y = Math.min(box.top + 24, box.bottom - 1);
  // Padding above the first block and the gaps between blocks are hit-test
  // dead zones, so probe a short way down the same line before falling back.
  for (const offset of [0, 16, 32, 48]) {
    const hit = document.elementFromPoint(x, Math.min(y + offset, box.bottom - 1));
    if (!hit) continue;
    const block = hit.closest('.ProseMirror > *');
    if (block) return block;
  }
  return $('preview').querySelector('.ProseMirror > *') || null;
}
function zoomText(delta, reset = false) {
  // Reflow from a font-size change moves every later line. Keep the block or
  // source line at the top of the reader anchored, so zooming text does not
  // throw the reader thousands of pixels away.
  const anchor = readerScrollAnchor();
  const previousTop = anchor?.getBoundingClientRect().top;
  fontSize = reset ? 19 : Math.min(40, Math.max(12, fontSize + delta));
  root.style.setProperty('--text-size', `${fontSize}px`);
  preferences.set('fontSize', fontSize);
  status(`Document text: ${fontSize} px`);
  if (anchor && previousTop !== undefined) $('reader-scroll').scrollTop += anchor.getBoundingClientRect().top - previousTop;
}
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
  if (current.active) editor?.refreshMedia(!remoteImages);
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (selectedTheme === 'system') { updatePreviewPalette(); refreshMermaid(); editor?.refreshMedia(); }
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
  // Native open switches backend active-document state before it resolves, so
  // the outgoing document must become immutable before the call starts. Keep
  // the guard through replacement and new-editor mounting, and always release.
  try {
    setTransitionLocked(true);
    const document = await invoke('open_document', { path });
    ++renderGeneration;
    previewSnapshot = null;
    current = { path: document.path, name: document.name, content: document.content, saved: document.content, active: true };
    if (activeFolder && !samePath(document.path, activeFolder.path) && !isWithin(document.path, activeFolder.path)) { activeFolder = null; folderEntries = []; expandedFolders.clear(); }
    if (activeFolder) expandParentsOf(document.path);
    setLineEnding(document.lineEnding || null);
    showDocument(); $('reader-scroll').scrollTop = 0; await refreshEditorSurface(); addRecent(current.path); return true;
  } finally {
    setTransitionLocked(false);
  }
}
function requestOpen(path) { return enqueue(() => openPath(path)); }
let pickerListing = null, pickerSelection = null;
function pickerHint(base) {
  const suffix = pickerListing?.truncated ? ' · Folder listing was limited; some entries are not shown' : '';
  $('open-selection-hint').textContent = base + suffix;
}
async function browseTo(path) {
  const restoreFocus = $('open-items').contains(document.activeElement);
  pickerListing = await invoke('browse_directory', { path }); pickerSelection = null;
  $('open-path').value = pickerListing.path;
  $('open-parent').disabled = !pickerListing.parent;
  pickerHint('Select a Markdown file or folder');
  $('open-items').replaceChildren();
  for (const entry of pickerListing.entries) {
    const row = document.createElement('button'); row.className = 'file-dialog-item'; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false');
    row.__folioPickerEntry = entry;
    row.append(icon(entry.directory ? 'open' : 'file'));
    const label = document.createElement('span'); label.textContent = entry.name; row.append(label);
    row.onclick = () => selectPickerRow(row);
    row.ondblclick = () => entry.directory ? browseTo(entry.path).catch(toast) : confirmOpenPicker();
    $('open-items').append(row);
  }
  if (!pickerListing.entries.length) { const empty = document.createElement('p'); empty.className = 'empty-results'; empty.textContent = 'No Markdown files or folders here'; $('open-items').append(empty); }
  if (restoreFocus) $('open-items').querySelector('.file-dialog-item')?.focus();
}
function selectPickerRow(row) {
  const entry = row?.__folioPickerEntry;
  if (!entry) return;
  pickerSelection = entry;
  $('open-items').querySelectorAll('.file-dialog-item').forEach(item => item.setAttribute('aria-selected', String(item === row)));
  pickerHint(entry.directory ? 'Open selected folder' : 'Open selected Markdown file');
}
$('open-items').addEventListener('keydown', event => {
  const rows = [...$('open-items').querySelectorAll('.file-dialog-item')];
  if (!rows.length) return;
  const currentRow = document.activeElement?.closest?.('.file-dialog-item');
  const index = rows.indexOf(currentRow);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    const next = event.key === 'Home' ? rows[0]
      : event.key === 'End' ? rows[rows.length - 1]
      : index < 0 ? (event.key === 'ArrowUp' ? rows[rows.length - 1] : rows[0])
      : rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length];
    selectPickerRow(next); next.focus(); next.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter' && currentRow) {
    event.preventDefault();
    selectPickerRow(currentRow);
    if (currentRow.__folioPickerEntry?.directory) browseTo(currentRow.__folioPickerEntry.path).catch(toast);
    else confirmOpenPicker();
  }
});
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
function openEntry() {
  closeAllMenus();
  if (filePicker() === 'native') return openNative('file');
  return openChooser();
}
function openFolderEntry() {
  closeAllMenus();
  if (filePicker() === 'native') return openNative('folder');
  return openChooser();
}
async function openNative(kind) {
  if (nativePickActive) return false;
  nativePickActive = true;
  return enqueue(async () => {
    try {
      const start = activeFolder?.path || (current.path ? dirname(current.path) : null);
      let picked = null;
      try {
        picked = await invoke('pick_open_target', { kind, start });
      } catch (error) { status(''); toast(error); return false; }
      if (picked === null || picked === undefined) { status(''); return false; }
      if (typeof picked !== 'object' || Array.isArray(picked) || typeof picked.path !== 'string' || !picked.path || (picked.kind !== 'file' && picked.kind !== 'folder')) {
        status('');
        toast('The system picker returned an unexpected result.');
        return false;
      }
      if (picked.kind === 'folder') return openFolderPath(picked.path);
      return openPath(picked.path);
    } finally { nativePickActive = false; }
  });
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
  let expanded = false;
  for (const entry of folderEntries) {
    if (entry.directory && isWithin(path, entry.path)) {
      const key = pathKey(entry.path);
      if (!expandedFolders.has(key)) { expandedFolders.add(key); expanded = true; }
    }
  }
  // Revealing a document inside a collapsed directory is a tree change, so the
  // selection sync must rebuild instead of only moving the highlight.
  if (expanded) renderedFolder = { path: null, entries: null };
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
  const previousFocus = document.activeElement?.closest?.('.folder-entry')?.dataset.path || null;
  list.replaceChildren();
  if (!activeFolder) { renderedFolder = { path: null, entries: folderEntries }; return; }
  $('folder-name').textContent = activeFolder.name || activeFolder.path;
  $('folder-name').title = activeFolder.path;
  for (const entry of folderEntries) {
    if (!entryIsVisible(entry)) continue;
    const button = document.createElement('button');
    button.className = `folder-entry${entry.directory ? ' directory' : ''}${samePath(current.path, entry.path) ? ' selected' : ''}`;
    button.style.setProperty('--depth', entry.depth);
    button.title = entry.path;
    button.dataset.path = entry.path;
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
  // Expansion re-renders the tree from scratch. Restore focus to the same
  // entry so keyboard users are not dropped back onto <body> after Enter.
  if (previousFocus) {
    const target = [...list.querySelectorAll('.folder-entry')].find(button => button.dataset.path === previousFocus);
    if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); }
  }
  renderedFolder = { path: activeFolder?.path || null, entries: folderEntries };
}
function syncFolderSelection() {
  const path = activeFolder?.path || null;
  if (!renderedFolder || renderedFolder.path !== path || renderedFolder.entries !== folderEntries) { renderFolderEntries(); return; }
  for (const button of $('folder-items').querySelectorAll('.folder-entry[data-path]')) {
    const selected = !button.classList.contains('directory') && samePath(current.path, button.dataset.path);
    button.classList.toggle('selected', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}
async function openFolderPath(path, confirmed = false) {
  if (!confirmed && !(await allowDiscard())) return false;
  // The scan and the backend document reset are asynchronous, so protect the
  // outgoing document as soon as departure is approved. Otherwise typing during
  // a slow scan is accepted into a document that is about to be replaced.
  // Keep the guard through folder adoption and rendering, and release it on
  // every exit; a failed scan leaves the current document intact.
  try {
    setTransitionLocked(true);
    // Scan first: if the folder cannot be read, keep the current document intact
    // instead of leaving the backend and UI out of sync.
    const listing = await invoke('open_folder', { path });
    await invoke('new_document');
    ++renderGeneration;
    activeFolder = { path: listing.path, name: listing.name }; folderEntries = listing.entries;
    expandedFolders.clear(); folderVisible = true;
    current = { path: null, name: 'Untitled.md', content: '', saved: '', active: false };
    previewSnapshot = null;
    setLineEnding(null);
    mode = 'read'; root.dataset.mode = mode;
    $('reader-scroll').hidden = false;
    // Tear down the previous document's editor before showDocument() builds the
    // outline and folder view, so no stale content or headings survive.
    await renderPreview();
    showDocument(); $('reader-scroll').scrollTop = 0; status('');
    $('folder-empty').querySelector('h1').textContent = folderEntries.some(entry => !entry.directory) ? 'Folder opened' : 'No Markdown files';
    $('folder-empty').querySelector('p').textContent = folderEntries.some(entry => !entry.directory) ? 'Choose a Markdown file from the file tree.' : 'This folder has no Markdown files. Open another folder to browse it.';
    const limits = [];
    if (listing.skipped) limits.push(`${listing.skipped} unreadable ${listing.skipped === 1 ? 'entry was' : 'entries were'} skipped`);
    if (listing.truncated) limits.push('only the first 5,000 entries are shown');
    if (limits.length) toast(`Folder opened with limits: ${limits.join('; ')}.`);
    return true;
  } finally {
    setTransitionLocked(false);
  }
}
function requestOpenLocation(path) {
  return enqueue(async () => {
    if (await invoke('path_is_directory', { path })) return openFolderPath(path);
    return openPath(path);
  });
}
async function save(saveAs = false, force = false) {
  if (!current.active) return false;
  editor?.checkpoint();
  const snapshot = current.content;
  status('Saving…'); saveStatus = 'saving'; updateTitle();
  try {
    const saved = await invoke('save_document', { content: snapshot, saveAs, force });
    if (!saved) { saveStatus = null; status(''); updateTitle(); return false; }
    current.path = saved.path; current.name = saved.name; current.saved = snapshot; saveStatus = null; updateTitle(); $('disk-banner').hidden = true; addRecent(current.path); status('Saved');
    await renderPreview();
    return true;
  } catch (error) {
    status('');
    const failure = commandError(error);
    if (failure.code !== 'file_changed') { saveStatus = { error: failure.message }; updateTitle(); throw new Error(failure.message); }
    // The conflict is unresolved while the dialog is open: report unsaved
    // changes, never Saving… or Saved, until the user picks an outcome.
    saveStatus = null; updateTitle();
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
    // Same protection as Home: the backend document is replaced before the
    // native reset resolves, so reject edits to the outgoing document now and
    // release the temporary guard after the new editor is in place or fails.
    try {
      setTransitionLocked(true);
      await invoke('new_document'); ++renderGeneration;
      previewSnapshot = null;
      const content = sample ? SAMPLE : '';
      current = { path: null, name: sample ? 'Welcome.md' : 'Untitled.md', content, saved: content, active: true };
      setLineEnding(null);
      showDocument(); $('reader-scroll').scrollTop = 0; await refreshEditorSurface(); if (!sample) editor?.focus();
    } finally {
      setTransitionLocked(false);
    }
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
    { label: 'Open file…', icon: 'open', shortcut: 'Ctrl+O', action: openEntry },
    { label: 'Open folder…', icon: 'open', detail: 'Open a folder with the selected picker', action: openFolderEntry },
    { label: 'New document', icon: 'plus', shortcut: 'Ctrl+N', action: () => newDocument() },
    { label: 'Change theme…', icon: 'theme', action: () => openCommands('themes') },
    { label: filePicker() === 'native' ? 'Use Folio file picker' : 'Use system file picker', icon: 'open', detail: filePicker() === 'native' ? 'Folio dialog with folders and typed paths' : 'System dialog for files and folders', action: toggleFilePicker },
    { label: 'Try a sample document', icon: 'file', action: () => newDocument(true) },
    { label: 'Clear recent files', icon: 'close', action: () => { preferences.set('recent', []); renderRecent(); toast('Recent files cleared'); } }
  ];
  if (current.active) commands.splice(2, 0,
    { label: 'Save', icon: 'save', shortcut: 'Ctrl+S', action: () => requestSave() },
    { label: 'Save as…', icon: 'save', shortcut: 'Ctrl+Shift+S', action: () => requestSave(true) },
    { label: editor?.isLocked() ? 'Unlock document' : 'Lock document', icon: 'read', action: () => editor?.setLocked(!editor.isLocked()) },
    { label: 'Source snapshot', icon: 'file', action: openSourceSnapshot },
    { label: 'Undo', icon: 'edit', shortcut: 'Ctrl+Z', action: () => enqueue(() => undoRedo()) },
    { label: 'Redo', icon: 'edit', shortcut: 'Ctrl+Shift+Z / Ctrl+Y', action: () => enqueue(() => undoRedo(true)) },
    { label: 'Find in document', icon: 'search', shortcut: 'Ctrl+F', action: openFind },
    { label: remoteImages ? 'Block remote images' : 'Load remote images', icon: 'read', action: toggleRemoteImages },
    { label: readingFont === 'serif' ? 'Use sans-serif reading text' : 'Use serif reading text', icon: 'read', action: toggleReadingFont },
    { label: 'Toggle outline', icon: 'outline', action: () => setOutline(!outlineVisible) },
    { label: 'Toggle focus mode', icon: 'focus', shortcut: 'F11', action: toggleFocus },
    { label: wideLayout ? 'Use centered document width' : 'Use full document width', icon: wideLayout ? 'width-contract' : 'width-expand', action: toggleDocumentWidth },
    { label: formatToolbarVisible ? 'Hide formatting toolbar' : 'Show formatting toolbar', icon: 'format', action: () => setFormatToolbarVisible(!formatToolbarVisible) },
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

let matches = [], findIndex = -1, findSource = null;
function openFind() { if (!current.active) return; $('find-bar').hidden = false; $('find-input').focus(); $('find-input').select(); updateFind(); }
function clearHighlights() { editor?.clearHighlight?.(); }
function findMatches(query) {
  const result = [];
  if (!query) return result;
  const search = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'); let match;
  while ((match = search.exec(current.content)) && result.length < 2000) result.push({ from: match.index, to: match.index + match[0].length });
  return result;
}
function updateFind() {
  const query = $('find-input').value;
  matches = findMatches(query); findIndex = -1; findSource = current.content;
  if (!query) { $('find-result').textContent = ''; clearHighlights(); return; }
  if (matches.length) nextFind(1);
  else { $('find-result').textContent = 'No matches'; clearHighlights(); }
}
function refreshFindOffsets(direction) {
  // Edits can shift every match. Recompute from the live content before the
  // next jump instead of selecting through stale byte offsets, then resume
  // from the caret so a prefix edit lands on the nearest real hit.
  const anchor = Math.max(0, editor?.getSelection()?.head ?? 0);
  matches = findMatches($('find-input').value); findSource = current.content;
  if (direction > 0) {
    const first = matches.findIndex(match => match.from >= anchor);
    findIndex = first < 0 ? -1 : first - 1;
  } else {
    let last = -1;
    matches.forEach((match, index) => { if (match.to <= anchor) last = index; });
    findIndex = last < 0 ? 0 : last + 1;
  }
}
function nextFind(direction) {
  const query = $('find-input').value;
  if (!query) { matches = []; findIndex = -1; $('find-result').textContent = ''; clearHighlights(); return; }
  if (findSource !== current.content) refreshFindOffsets(direction);
  if (!matches.length) { findIndex = -1; $('find-result').textContent = 'No matches'; clearHighlights(); return; }
  findIndex = (findIndex + direction + matches.length) % matches.length;
  const match = matches[findIndex];
  // Focus stays in the find field: the editor selection is revealed without
  // stealing the caret, and a mirrored highlight keeps the hit visible while
  // the input owns focus.
  editor?.selectRange(match.from, match.to, false);
  editor?.highlightRange?.(match.from, match.to);
  $('find-result').textContent = `${findIndex + 1} / ${matches.length}`;
}
function closeFind() { $('find-bar').hidden = true; clearHighlights(); editor?.focus(); }
function toggleFocus() { document.body.classList.toggle('focus-mode'); }
function setDocumentWidth(full, persist = true) {
  // Anchor on what the reader is actually looking at, not on the first block.
  const anchor = current.active ? readerScrollAnchor() : null;
  const previousTop = anchor?.getBoundingClientRect().top;
  wideLayout = Boolean(full);
  root.dataset.documentWidth = wideLayout ? 'full' : 'centered';
  const button = $('width-toggle');
  const label = wideLayout ? 'Use centered document width' : 'Use full document width';
  button.setAttribute('aria-pressed', String(wideLayout));
  button.setAttribute('aria-label', label);
  button.title = label;
  button.querySelector('use').setAttribute('href', wideLayout ? '#i-width-contract' : '#i-width-expand');
  const menuText = button.querySelector('.menu-text');
  if (menuText) menuText.textContent = wideLayout ? 'Centered document width' : 'Full document width';
  if (anchor && previousTop !== undefined) $('reader-scroll').scrollTop += anchor.getBoundingClientRect().top - previousTop;
  if (persist) preferences.set('wideLayout', wideLayout);
}
function toggleDocumentWidth() { setDocumentWidth(!wideLayout); }
function setFormatToolbarVisible(visible, persist = true) {
  formatToolbarVisible = visible !== false;
  $('format-tools').hidden = !formatToolbarVisible || !current.active;
  const button = $('format-toggle');
  button.setAttribute('aria-pressed', String(formatToolbarVisible));
  button.setAttribute('aria-expanded', String(formatToolbarVisible));
  const label = formatToolbarVisible ? 'Hide formatting toolbar' : 'Show formatting toolbar';
  button.setAttribute('aria-label', label);
  button.title = label;
  if (persist) preferences.set('formatToolbarVisible', formatToolbarVisible);
}

function closeAllMenus(returnFocus = false) {
  for (const id of ['open-menu', 'view-menu']) {
    const menu = $(id);
    if (menu && !menu.hidden) {
      menu.hidden = true;
      const trigger = document.querySelector(`[aria-controls="${id}"]`);
      trigger?.setAttribute('aria-expanded', 'false');
      if (returnFocus && menu.contains(document.activeElement)) trigger?.focus();
    }
  }
}
function setupMenu(triggerId, menuId) {
  const trigger = $(triggerId), menu = $(menuId);
  if (!trigger || !menu) return;
  const items = () => [...menu.querySelectorAll('.menu-item:not([hidden])')];
  function openMenu() {
    const wasHidden = menu.hidden;
    closeAllMenus();
    if (!wasHidden) return;
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    items()[0]?.focus();
  }
  trigger.addEventListener('click', event => { event.stopPropagation(); menu.hidden ? openMenu() : closeAllMenus(true); });
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && menu.hidden) { event.preventDefault(); openMenu(); }
    else if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); closeAllMenus(true); }
  });
  menu.addEventListener('keydown', event => {
    const list = items();
    const current = list.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); closeAllMenus(true); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); list[(current + 1 + list.length) % list.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); list[(current - 1 + list.length) % list.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); list[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); list[list.length - 1]?.focus(); }
    else if (event.key === 'Tab') { closeAllMenus(); }
  });
  menu.addEventListener('click', event => {
    if (!event.target.closest('.menu-item')) return;
    setTimeout(() => {
      const dialogOpen = ['open-dialog', 'source-dialog', 'command-dialog', 'confirm-dialog', 'editor-action-dialog'].some(id => $(id)?.open);
      const triggerForMenu = document.querySelector(`[aria-controls="${menuId}"]`);
      menu.hidden = true;
      triggerForMenu?.setAttribute('aria-expanded', 'false');
      if (!dialogOpen && menu.contains(document.activeElement)) triggerForMenu?.focus();
    }, 0);
  });
}
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.menu') && !event.target.closest('[aria-controls="open-menu"],[aria-controls="view-menu"]')) closeAllMenus();
});
setupMenu('open-chevron', 'open-menu');
setupMenu('view-menu-button', 'view-menu');

$('home').onclick = goHome;
$('open').onclick = $('welcome-open').onclick = openEntry;
$('open-file').onclick = openEntry;
$('open-folder').onclick = openFolderEntry;
$('picker-toggle').onclick = () => { toggleFilePicker(); };
$('open').addEventListener('keydown', event => {
  if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); $('open-chevron').click(); }
});
$('open-parent').onclick = () => pickerListing?.parent && browseTo(pickerListing.parent).catch(toast);
$('open-go').onclick = () => browseTo($('open-path').value.trim()).catch(toast);
$('open-path').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); browseTo($('open-path').value.trim()).catch(toast); } };
$('open-path').addEventListener('input', () => {
  pickerSelection = null;
  $('open-items').querySelectorAll('.file-dialog-item').forEach(item => item.setAttribute('aria-selected', 'false'));
  pickerHint('Select a Markdown file or folder');
});
$('open-dialog').addEventListener('keydown', event => { if (event.altKey && event.key === 'ArrowLeft' && pickerListing?.parent) { event.preventDefault(); browseTo(pickerListing.parent).catch(toast); } });
$('open-confirm').onclick = confirmOpenPicker;
$('open-cancel').onclick = $('open-dialog-close').onclick = () => $('open-dialog').close();
$('folder-close').onclick = () => setFolderVisible(false);
$('folder-toggle').onclick = () => setFolderVisible(!folderVisible);
$('folder-refresh').onclick = () => activeFolder && enqueue(async () => { const listing = await invoke('open_folder', { path: activeFolder.path }); activeFolder = { path: listing.path, name: listing.name }; folderEntries = listing.entries; renderFolderEntries(); });
$('new').onclick = () => newDocument(); $('sample').onclick = () => newDocument(true);
$('save').onclick = () => requestSave();
$('palette-open').onclick = () => openCommands(); $('outline-toggle').onclick = () => setOutline(!outlineVisible); $('outline-close').onclick = () => setOutline(false);
$('width-toggle').onclick = toggleDocumentWidth;
$('format-toggle').onclick = () => setFormatToolbarVisible(!formatToolbarVisible);
$('format-toolbar-close').onclick = () => {
  setFormatToolbarVisible(false);
  $('view-menu-button').focus();
};
$('zoom-in').onclick = () => zoomWindow(.1); $('zoom-out').onclick = () => zoomWindow(-.1); $('zoom-reset').onclick = () => zoomWindow(0, true);
$('reload').onclick = () => requestOpen(current.path); $('dismiss-disk').onclick = () => { $('disk-banner').hidden = true; };
$('find-input').oninput = updateFind; $('find-next').onclick = () => nextFind(1); $('find-previous').onclick = () => nextFind(-1); $('find-close').onclick = closeFind;
$('find-input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); nextFind(event.shiftKey ? -1 : 1); } };
function followPreviewLink(anchor) {
  const href = anchor.getAttribute('href'); if (!href) return;
  if (href.startsWith('#')) {
    let id; try { id = decodeURIComponent(href.slice(1)); } catch { return; }
    const heading = outlineEntries.find(entry => entry.id === id || entry.id === `doc-${id}`);
    if (heading) { editor?.selectRange(heading.offset); heading.element?.scrollIntoView({ block: 'start' }); }
    else document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }
  else if (/^(https?:|mailto:)/i.test(href)) invoke('open_link', { url: href }).catch(toast);
  else enqueue(async () => { const path = await invoke('resolve_document_link', { link: href }); await openPath(path); });
}
document.addEventListener('keydown', event => {
  const control = event.ctrlKey || event.metaKey;
  if (control && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); $('command-dialog').open ? $('command-dialog').close() : openCommands(); return; }
  if (event.defaultPrevented) return;
  if ($('command-dialog').open || $('confirm-dialog').open || $('open-dialog').open || $('source-dialog').open || $('editor-action-dialog').open) return;
  if (event.key === 'Escape') { if (!$('find-bar').hidden) closeFind(); else document.body.classList.remove('focus-mode'); return; }
  if (event.key === 'F11') { event.preventDefault(); if (current.active) toggleFocus(); return; }
  if (!control) return;
  const key = event.key.toLowerCase();
  if (key === 'z' || key === 'y') {
    if (event.target.matches('input,textarea')) return;
    event.preventDefault(); enqueue(() => undoRedo(key === 'y' || event.shiftKey));
  }
  else if (event.code === 'Equal' || key === '+' || key === '=') { event.preventDefault(); event.shiftKey ? zoomText(1) : zoomWindow(.1); }
  else if (event.code === 'Minus' || key === '-' || key === '_') { event.preventDefault(); event.shiftKey ? zoomText(-1) : zoomWindow(-.1); }
  else if (key === '0') { event.preventDefault(); event.shiftKey ? zoomText(0, true) : zoomWindow(0, true); }
  else if (key === 'o') { event.preventDefault(); openEntry(); }
  else if (key === 'b' && editor && (event.target.closest?.('#preview .ProseMirror') || event.target.closest?.('#preview'))) { event.preventDefault(); editor.command('bold'); }
  else if (key === 'b' && activeFolder && !event.target.closest?.('#preview .ProseMirror')) { event.preventDefault(); setFolderVisible(!folderVisible); }
  else if (key === 'n') { event.preventDefault(); newDocument(); }
  else if (key === 's') { event.preventDefault(); requestSave(event.shiftKey); }
  else if (key === 'f') { event.preventDefault(); openFind(); }
  else if (key === 'w') { event.preventDefault(); requestClose(); }
});
async function requestClose() { return enqueue(async () => { if (await allowDiscard()) await invoke('close_window'); }); }

const SAMPLE = `# A quiet place for your words

Folio opens **individual Markdown files**. Read comfortably, edit directly, and save right back to disk. Use the **Formatted** / **Markdown** switch for local syntax, **Lock** to protect against edits, and **Source** to inspect the exact Markdown.

## Make yourself at home

Use the search button in the header, or **Ctrl+Shift+P**, to open the command window. Search for a theme and press Enter to apply it.

> [!NOTE]
> When Omarchy is detected, choose the **Omarchy** theme to follow your current desktop palette automatically.

## A few useful shortcuts

| Action | Shortcut |
| :--- | :--- |
| Open a file or folder | Ctrl+O |
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
  zoomText(0); zoomWindow(0); renderRecent(); setDocumentWidth(wideLayout, false); setFormatToolbarVisible(formatToolbarVisible, false);
  syncOpenAffordance();
  applyTheme(selectedTheme, false); applyReadingFont(readingFont, false);
  if (!window.__TAURI__) { toast('Open Folio from your app menu to enable file access.'); return; }
  await Promise.all([
    listen('request-close', requestClose),
    listen('open-files', event => { for (const path of event.payload) requestOpenLocation(path); }),
    listen('system-theme', event => { omarchy = event.payload; if (selectedTheme === 'omarchy') applyTheme('omarchy', false); else if ($('command-dialog').open) renderCommands(); })
  ]);
  const state = await invoke('bootstrap'); setPlatform(state.platform); omarchy = state.theme;
  if (preferences.get('theme', null) === null && omarchy) selectedTheme = 'omarchy';
  applyTheme(selectedTheme, false);
  for (const path of state.paths) requestOpenLocation(path);
  await window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(event => {
    const type = event.payload.type; $('drop-overlay').hidden = type !== 'over' && type !== 'enter';
    if (type === 'drop') { $('drop-overlay').hidden = true; for (const path of event.payload.paths) requestOpenLocation(path); }
  });
  const idle = window.requestIdleCallback || (callback => setTimeout(callback, 200));
  idle(() => {
    loadAsset('vendor/editor/editor.js').catch(() => {});
    loadAsset('vendor/editor/editor.css', true).catch(() => {});
  });
  setInterval(async () => {
    if (!current.path || busy || document.hidden) return;
    const path = current.path;
    try { const changed = await invoke('document_changed'); if (path === current.path) $('disk-banner').hidden = !changed; } catch {}
  }, 3000);
  requestAnimationFrame(() => requestAnimationFrame(() => { invoke('ready').catch(() => {}); }));
}
start().catch(error => { toast(error); console.error(error); });
