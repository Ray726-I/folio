'use strict';
let current = { path: null, name: 'Untitled.md', content: '', saved: '', active: false };
let mode = 'read', busy = false, queue = Promise.resolve();
let activeFolder = null, folderEntries = [], folderVisible = true, expandedFolders = new Set();
let renderedFolder = { path: null, entries: null };
let fontSize = Math.min(40, Math.max(12, Number(preferences.get('fontSize', 19)) || 19));
let windowZoom = Math.min(2, Math.max(.6, Number(preferences.get('windowZoom', 1)) || 1));
let touchpadZoom = preferences.get('touchpadZoom', false) === true;
let nativePlatform = '';
let remoteImages = preferences.get('remoteImages', false) === true;
let readingFont = ['serif', 'sans', 'mono'].includes(preferences.get('readingFont', 'sans')) ? preferences.get('readingFont', 'sans') : 'sans';
const legacyOutline = preferences.get('outline', null);
if (preferences.get('outlineWidth', null) === null && typeof legacyOutline === 'number') preferences.set('outlineWidth', legacyOutline);
let outlineVisible = preferences.get('outlineVisible', typeof legacyOutline === 'boolean' ? legacyOutline : true), toastTimer;
let wideLayout = preferences.get('wideLayout', false);
function filePicker() { const value = preferences.get('filePicker', 'folio'); return value === 'native' ? 'native' : 'folio'; }
function syncOpenAffordance() {
  const native = filePicker() === 'native';
  const open = $('open-file'), label = native ? 'Open a Markdown file (Ctrl+O)' : 'Open a file or folder (Ctrl+O)';
  open.title = label; open.setAttribute('aria-label', label);
  open.querySelector('span').textContent = 'Open File…';
  $('open-folder').hidden = false;
  const fileOption = $('open-file');
  if (fileOption) {
    const fileLabel = 'Open File…';
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
  const owner = focusedDocument();
  syncSaveMachine(owner);
  if (!owner.active) return { text: '', state: 'idle' };
  if (saveMachine.state === 'saving') return { text: 'Saving…', state: 'saving' };
  if (saveMachine.state === 'error') return { text: 'Save failed', state: 'error' };
  if (saveMachine.state === 'paused') return { text: 'Paused', state: 'paused' };
  if (saveMachine.state === 'clean') return { text: 'Saved', state: 'saved' };
  // Compact dirty label: the short "Edited" keeps the indicator footprint
  // near the old Saved width so no wide gap is reserved. The full
  // "Unsaved changes" meaning lives in the accessible name and tooltip.
  return { text: 'Edited', state: 'dirty' };
}
function commandError(error) {
  if (error && typeof error === 'object') return { code: error.code || 'error', message: error.message || String(error) };
  const message = String(error ?? 'Unknown error');
  return { code: message.startsWith('FILE_CHANGED:') ? 'file_changed' : 'error', message: message.replace(/^FILE_CHANGED:\s*/, '') };
}
function errorMessage(error) { return commandError(error).message; }
function icon(name) { const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); node.classList.add('icon'); node.setAttribute('aria-hidden', 'true'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#i-${name}`); node.append(use); return node; }
function fileIconName(path) { return /\.(?:md|markdown|mdown|mdtxt)$/i.test(path || '') ? 'markdown' : 'file'; }
function fileIcon(path) {
  const kind = fileIconName(path);
  const node = icon(kind); node.classList.add('file-kind', `file-kind-${kind}`);
  return node;
}
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
  const owner = focusedDocument(), ownerStatus = owner === current ? saveStatus : owner.saveStatus || owner.view?.saveStatus;
  const name = owner.active ? owner.name : activeFolder?.name || '';
  // Typing calls this on every keystroke. Everything below is derived from
  // these values, so when none of them changed there is nothing to write: the
  // name, dirty flag and save state are stable for the whole typing burst.
  const state = saveState();
  const key = [name, owner.path || activeFolder?.path || '', owner.active ? 1 : 0,
    (owner.content !== owner.saved) ? 1 : 0, state.text, state.state, ownerStatus?.error || '', documentMode, documentReadOnly, owner.writable].join('\u0000');
  if (key === renderedTitleKey) return;
  renderedTitleKey = key;
  syncDocumentMode();
  $('document-name').textContent = name || 'Folio';
  const emblem = document.querySelector('.document-emblem');
  const kind = owner.active ? fileIconName(owner.path || owner.name) : 'folder';
  emblem?.querySelector('use')?.setAttribute('href', `#i-${kind}`);
  emblem?.classList.toggle('file-kind-markdown', kind === 'markdown');
  $('document-location').textContent = owner.path ? owner.path : activeFolder?.path || (owner.active ? 'Unsaved document' : 'Markdown files and folders');
  $('document-location').title = owner.path || activeFolder?.path || '';
  $('dirty-dot').hidden = !(owner.content !== owner.saved);
  const saveButton = $('save'), isDirty = (owner.content !== owner.saved);
  saveButton.classList.toggle('is-dirty', isDirty);
  const saveLabel = !owner.active ? 'Save (Ctrl+S)'
    : isDirty ? `Save (Ctrl+S) — unsaved changes in ${owner.name}` : 'Save (Ctrl+S) — all changes saved';
  saveButton.setAttribute('aria-label', saveLabel);
  saveButton.title = saveLabel;
  saveButton.dataset.state = state.state;
  const saveStateElement = $('save-state');
  saveStateElement.textContent = state.text;
  saveStateElement.dataset.state = state.state;
  // The short "Edited" label still announces the full meaning to assistive
  // technology and hover, so nothing is lost by staying compact.
  const accessibleText = state.state === 'dirty' ? 'Unsaved changes' : state.state === 'paused' ? 'Automatic saving paused' : state.text;
  const stateTitle = state.state === 'error' && ownerStatus?.error ? ownerStatus.error
    : state.state === 'dirty' ? 'Unsaved changes' : state.state === 'paused' ? 'Automatic saving paused — save to review.' : '';
  saveStateElement.title = stateTitle;
  const compactSaveLabel = `Save (Ctrl+S) — ${state.state === 'error' ? `Save failed: ${ownerStatus?.error || ''}` : accessibleText}`;
  saveButton.title = compactSaveLabel;
  saveButton.setAttribute('aria-label', compactSaveLabel);
  saveStateElement.setAttribute('aria-label', state.state === 'error' && ownerStatus?.error ? `Save failed: ${ownerStatus.error}` : `Save state: ${accessibleText || 'no document'}`);
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => sendTitle(name, (owner.content !== owner.saved)), 120);
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
  $('reading-time').textContent = words ? `${Math.max(1, Math.ceil(words / 220))} min read` : '';
  const readingDivider = $('reading-time').previousElementSibling;
  if (readingDivider?.classList.contains('status-divider')) readingDivider.hidden = !words;
}
let statsTimer;
function scheduleStats() { clearTimeout(statsTimer); statsTimer = setTimeout(updateStats, 180); }
function setLineEnding(lineEnding) {
  $('line-ending').hidden = !lineEnding;
  $('line-ending').textContent = lineEnding ? ` · ${lineEnding}` : '';
}
function showDocument() {
  $('welcome').hidden = true; document.querySelector('.headerbar').hidden = false; $('document-tabs').hidden = false; $('document-view').hidden = false; $('statusbar').hidden = false;
  $('home').disabled = false;
  document.querySelectorAll('.document-control').forEach(control => { control.hidden = !current.active; });
  if (!current.active) editorPresentation(false, false, false);
  $('disk-banner').hidden = true; saveStatus = current.saveStatus || null; updateTitle(); updateStats();
  // Opening a file keeps whichever dock mode is open, so picking from the tree
  // does not yank the tree away from under the pointer.
  if (!current.active && activeFolder) setFolderVisible(true);
  else renderNavigationDock();
  syncDockForViewport();
  $('folder-empty').hidden = current.active || !activeFolder;
  syncFolderSelection();
  syncSurfaceMachine();
  syncFindMachine();
}
function showWelcome() {
  editor?.destroy(); editor = null; editorDocument = null; cancelMermaidPending();
  previewMachine.send('IDLE');
  $('welcome').hidden = false; document.querySelector('.headerbar').hidden = true; $('document-view').hidden = true; $('statusbar').hidden = true;
  $('home').disabled = true;
  $('preview').replaceChildren(); $('folder-empty').hidden = true;
  $('disk-banner').hidden = true; $('find-bar').hidden = true;
  $('outline').hidden = true; $('outline-divider').hidden = true;
  $('file-browser').hidden = true; $('folder-divider').hidden = true;
  $('folder-search').hidden = true; $('search-divider').hidden = true; ++grepEpoch;
  document.body.classList.remove('focus-mode');
  document.querySelectorAll('.document-control').forEach(control => { control.hidden = true; });
  editorPresentation(false, false, false);
  modeMachine.sync('reading', { readOnly: false, writable: true, transitioning: Boolean(transitionLocked), companion: false }, 'welcome');
  saveStatus = null; updateTitle(); updateStats();
  syncSurfaceMachine();
  syncFindMachine();
}
function goHome() {
  return enqueue(async () => {
    if ($('document-view').hidden) return;
    if (documents.size) { rememberDocument(); current = { path: null, name: 'Untitled.md', content: '', saved: '', active: false }; showWelcome(); renderTabs(); return; }
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
const narrowDrawers = () => window.matchMedia('(max-width:980px)').matches;
let dockAutoClosed = false;
function syncDocumentChrome() {
  const view = document.getElementById('document-view');
  const reader = document.getElementById('reader-scroll');
  if (!view || !reader || !reader.parentElement) return;
  const height = Math.max(0, reader.getBoundingClientRect().top - view.getBoundingClientRect().top);
  view.style.setProperty('--document-chrome-height', `${Math.ceil(height)}px`);
}
function syncDockForViewport() {
  const narrow = narrowDrawers();
  if (narrow && !dockAutoClosed) {
    if (dockVisible) { dockVisible = false; dockAutoClosed = true; renderNavigationDock(); }
  } else if (!narrow && dockAutoClosed) {
    dockAutoClosed = false; dockVisible = outlineVisible; renderNavigationDock();
  }
  syncDocumentChrome();
}
window.addEventListener('resize', syncDockForViewport);
let dockTab = 'outline', dockVisible = outlineVisible;
function renderNavigationDock() {
  const show = dockVisible && !$('document-view').hidden;
  $('folder-search').hidden = !(show && dockTab === 'search' && activeFolder);
  $('search-divider').hidden = $('folder-search').hidden;
  // Showing the panel must also fill it: resizes and first shows can unhide
  // it without any outline refresh having run (or after one early-returned
  // while hidden), which otherwise leaves a visible "No headings" panel.
  const outlineShouldShow = show && dockTab === 'outline' && current.active;
  const outlineNewlyShown = outlineShouldShow && $('outline').hidden;
  $('outline').hidden = !outlineShouldShow;
  if (outlineNewlyShown && typeof scheduleEditorOutline === 'function') scheduleEditorOutline();
  $('file-browser').hidden = !(show && dockTab === 'files');
  $('outline-divider').hidden = $('outline').hidden;
  $('folder-divider').hidden = $('file-browser').hidden;
  $('dock-open-folder').hidden = Boolean(activeFolder);
  $('folder-refresh').hidden = !activeFolder;
  $('folder-new').hidden = !activeFolder;
  for (const tab of document.querySelectorAll('[data-dock-tab]')) {
    // Contents has nothing to list without a document; keep the rail honest
    // instead of exposing a mode that would open an empty panel.
    const available = tab.dataset.dockTab !== 'outline' || current.active;
    tab.disabled = !available;
    tab.setAttribute('aria-pressed', String(available && show && tab.dataset.dockTab === dockTab));
  }
  syncFindControl();
}
// The rail's search button is an action, not a pane: it opens the in-document
// find bar and keeps its pressed state in step with that bar.
function syncFindControl() {
  const button = document.querySelector('[data-rail-action="find"]');
  if (!button) return;
  button.disabled = !current.active && !activeFolder;
  button.setAttribute('aria-pressed', String(activeFolder ? dockVisible && dockTab === 'search' : !$('find-bar').hidden));
  button.setAttribute('aria-controls', activeFolder ? 'folder-search' : 'find-bar');
  button.setAttribute('aria-label', activeFolder ? 'Search folder contents' : 'Search document');
  button.title = activeFolder ? 'Search folder contents (Ctrl+Shift+F)' : 'Search document (Ctrl+F)';
}
// The rail is the only sidebar control: pressing the active mode closes the
// dock, pressing the other mode switches to it.
function toggleDock(tab) {
  if (tab === 'search') {
    if (dockVisible && dockTab === 'search') { dockVisible = false; renderNavigationDock(); }
    else openFolderSearch();
    return;
  }
  if (dockVisible && dockTab === tab) {
    if (tab === 'outline') setOutline(false);
    else setFolderVisible(false);
  } else if (tab === 'outline') setOutline(true);
  else setFolderVisible(true);
}
function setOutline(visible, persist = true) {
  // Contents needs a document; the rail disables the mode before this runs.
  if (visible && !current.active) return;
  outlineVisible = visible;
  if (visible) { dockTab = 'outline'; dockVisible = true; folderVisible = false; }
  else if (dockTab === 'outline') dockVisible = false;
  renderNavigationDock();
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
    event.preventDefault(); divider.setPointerCapture(event.pointerId); divider.classList.add('dragging'); document.documentElement.classList.add('pane-resizing');
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
    divider.classList.remove('dragging'); document.documentElement.classList.remove('pane-resizing');
    // A pointer gesture must not leave the divider focused: the focus hint on
    // its hairline would otherwise read as a stuck highlight after resizing.
    divider.blur({ preventScroll: true });
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    applyPending();
    preferences.set(key, appliedWidth);
  });
  divider.addEventListener('lostpointercapture', () => { divider.classList.remove('dragging'); document.documentElement.classList.remove('pane-resizing'); });
  divider.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    measureOther();
    applyWidth(sidebar.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 20 : -20));
    preferences.set(key, appliedWidth);
  });
}
setupSidebarResize('file-browser', 'folder-divider', 'dockWidth', 280, 'dock');
setupSidebarResize('outline', 'outline-divider', 'dockWidth', 280, 'dock');
setupSidebarResize('folder-search', 'search-divider', 'dockWidth', 280, 'dock');
// The shell always shows the formatted editor; opening a document only needs
// the editor mounted and the find matches refreshed.
async function refreshEditorSurface() {
  if (!current.active) return;
  editor?.captureSelection?.();
  await renderPreview();
  // Opening a file leaves keyboard focus with the surrounding UI. Editing
  // starts when the user clicks the document or invokes an editing action.
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
function setTextSize(size, { persist = true, anchor = true, announce = true } = {}) {
  // Reflow from a font-size change moves every later line. Keep the block or
  // source line at the top of the reader anchored, so discrete zoom changes
  // and Reset do not throw the reader thousands of pixels away. The slider
  // preview opts out: dragging must not read layout twice per pointer move,
  // and the document settles when the pointer is released.
  const snapshot = anchor ? readerScrollAnchor() : null;
  const previousTop = snapshot?.getBoundingClientRect().top;
  fontSize = Math.min(40, Math.max(12, Math.round(size)));
  root.style.setProperty('--text-size', `${fontSize}px`);
  if (persist) preferences.set('fontSize', fontSize);
  if (announce) status(`Document text: ${fontSize} px`);
  if (snapshot && previousTop !== undefined) $('reader-scroll').scrollTop += snapshot.getBoundingClientRect().top - previousTop;
}
function zoomText(delta, reset = false) { setTextSize(reset ? 19 : fontSize + delta); }
function zoomWindow(delta, reset = false) { windowZoom = reset ? 1 : Math.min(2, Math.max(.6, Math.round((windowZoom + delta) * 10) / 10)); $('zoom-reset').textContent = `${Math.round(windowZoom * 100)}%`; preferences.set('windowZoom', windowZoom); invoke('set_window_zoom', { scale: windowZoom }).catch(toast); }
function setTouchpadZoom(enabled, announce = true) {
  touchpadZoom = nativePlatform === 'linux' && enabled === true;
  preferences.set('touchpadZoom', touchpadZoom);
  $('preference-touchpad-zoom').checked = touchpadZoom;
  invoke('set_touchpad_zoom', { enabled: touchpadZoom }).catch(toast);
  if ($('command-dialog').open) renderCommands();
}
function applyReadingFont(font = readingFont, persist = true) {
  readingFont = ['sans', 'mono'].includes(font) ? font : 'serif';
  root.dataset.readingFont = readingFont;
  if (persist) preferences.set('readingFont', readingFont);
  if ($('command-dialog').open) renderCommands();
}
function toggleReadingFont() { applyReadingFont(readingFont === 'serif' ? 'sans' : 'serif'); }
function toggleRemoteImages() {
  remoteImages = !remoteImages;
  preferences.set('remoteImages', remoteImages);
  previewSnapshot = null; scheduleCompanionRender(0);
  status(remoteImages ? 'Remote images will load from the network' : 'Remote images are blocked');
  if (current.active) editor?.refreshMedia(!remoteImages);
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (selectedTheme === 'system' && updatePreviewPalette()) scheduleDiagramRefresh();
});
// The outline steps aside for the file tree on narrow screens; give it back when there is room.
window.matchMedia('(max-width:640px)').addEventListener('change', event => {
  renderNavigationDock();
});
let confirmQueue = Promise.resolve();
function ask(title, message, choices) {
  const show = () => new Promise(resolve => {
    const dialog = $('confirm-dialog'); $('confirm-title').textContent = title; $('confirm-message').textContent = message; $('confirm-actions').replaceChildren();
    const finish = value => { dialog.close(); dialog.removeEventListener('cancel', cancel); resolve(value); };
    const cancel = event => { event.preventDefault(); finish('cancel'); };
    dialog.addEventListener('cancel', cancel);
    for (const choice of choices) {
      const button = document.createElement('button'); button.className = `button ${choice.style || ''}`; button.textContent = choice.label; button.onclick = () => finish(choice.value); $('confirm-actions').append(button);
    }
    dialog.showModal(); $('confirm-actions').firstElementChild?.focus();
  });
  // The command palette can open over a pending prompt, and a command it runs
  // may ask again. Queue that prompt instead of replacing the actions of the
  // one the user is already answering.
  const result = confirmQueue.then(show, show);
  confirmQueue = result.then(() => {}, () => {});
  return result;
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
    busy = true; $('open-file').disabled = true; $('save').disabled = true;
    try { return await action(); } catch (error) { status(''); toast(error); return false; }
    finally { busy = false; $('open-file').disabled = false; $('save').disabled = false; }
  });
  return queue;
}
async function openPath(path, confirmed = false) {
  const existing = !confirmed && [...documents.values()].find(doc => samePath(doc.path, path));
  if (existing) return activateDocument(existing);
  if (!current.documentId && !confirmed && !(await allowDiscard())) return false;
  status('Opening…');
  // Native open switches backend active-document state before it resolves, so
  // the outgoing document must become immutable before the call starts. Keep
  // the guard through replacement and new-editor mounting, and always release.
  try {
    rememberDocument();
    setTransitionLocked(true);
    const document = await invoke('open_document', { path, reuseExisting: !confirmed });
    if (!confirmed && document.documentId && documents.has(document.documentId)) return activateDocument(documents.get(document.documentId), false);
    ++renderGeneration;
    previewSnapshot = null;
    current = { ...document, saved: document.content, writable: document.writable !== false, active: true };
    const previousVersion = current.documentId && documents.get(current.documentId);
    if (confirmed && previousVersion) { current.revision = Math.max(current.revision || 0, previousVersion.revision || 0); await recoveryWriter.saved(previousVersion, previousVersion.revision || 0); }
    registerDocument(current);
    resetDocumentPresentation(); recordDocumentNavigation(current.path);
    if (!document.documentId && activeFolder && !samePath(document.path, activeFolder.path) && !isWithin(document.path, activeFolder.path)) { activeFolder = null; folderEntries = []; expandedFolders.clear(); }
    if (activeFolder) expandParentsOf(document.path);
    setLineEnding(document.lineEnding || null);
    showDocument(); focusPane('main'); $('reader-scroll').scrollTop = 0; await refreshEditorSurface(); scheduleCompanionRender(0); addRecent(current.path); return true;
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
    row.append(entry.directory ? icon('folder') : fileIcon(entry.name || entry.path));
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
  if (visible) { dockTab = 'files'; dockVisible = true; outlineVisible = false; }
  else if (dockTab === 'files') dockVisible = false;
  renderNavigationDock();
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
  renderNavigationDock();
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
      const folderIcon = icon(expanded ? 'folder-open' : 'folder'); folderIcon.classList.add('tree-folder'); button.append(folderIcon);
      button.onclick = () => { expanded ? expandedFolders.delete(pathKey(entry.path)) : expandedFolders.add(pathKey(entry.path)); renderFolderEntries(); };
    } else {
      const spacer = document.createElement('span'); spacer.className = 'tree-spacer'; button.append(spacer);
      const glyph = fileIcon(entry.name || entry.path); glyph.classList.add('tree-file'); button.append(glyph);
      if (samePath(current.path, entry.path)) button.setAttribute('aria-current', 'page');
      button.onclick = () => requestOpen(entry.path);
    }
    const label = document.createElement('span'); label.textContent = entry.name; button.append(label);
    bindTreeEntry(button, entry);
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
  if (documents.size) { const listing = await invoke('open_folder', { path }); activeFolder = { path: listing.path, name: listing.name }; folderEntries = listing.entries; expandedFolders.clear(); clearFolderSearch(); if ($('document-view').hidden) { showDocument(); await refreshEditorSurface(); } renderFolderEntries(); dockTab = 'files'; dockVisible = true; renderNavigationDock(); return true; }
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
    clearFolderSearch();
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
    $('folder-empty').querySelector('p').textContent = folderEntries.some(entry => !entry.directory) ? 'Open File Explorer (Ctrl+B) or use Quick open (Ctrl+P) to choose a Markdown file.' : 'This folder has no Markdown files. Open another folder to browse it.';
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
async function save(saveAs = false, force = false, owner = current, automatic = false) {
  if (!owner.active || owner.closing) return false;
  if (!saveAs && ((owner === current ? documentReadOnly : owner.view?.readOnly) || owner.writable === false)) { toast('This document is read-only. Use Save As to create a writable copy.'); return false; }
  if (owner === current) editor?.checkpoint();
  const snapshot = owner.content, savedRevision = owner.revision || 0;
  const setSaveStatus = value => { owner.saveStatus = value; if (owner.view) owner.view.saveStatus = value; if (owner === current) saveStatus = value; if (owner === focusedDocument()) updateTitle(); };
  if (owner === current) status('Saving…'); setSaveStatus('saving');
  try {
    const saved = await invoke('save_document', { documentId: owner.documentId, content: snapshot, saveAs, force });
    if (!saved) { setSaveStatus(null); if (owner === current) status(''); return false; }
    owner.path = saved.path; owner.name = saved.name; owner.saved = snapshot; owner.autoSavePaused = false; if (saveAs) { owner.writable = true; if (owner === current) documentReadOnly = false; } await recoveryWriter.saved(owner, savedRevision); renderTabs(); persistWorkspace(); setSaveStatus(null); if (owner !== current) return true; $('disk-banner').hidden = true; addRecent(owner.path); status('Saved');
    await renderPreview();
    return true;
  } catch (error) {
    status('');
    const failure = commandError(error);
    if (automatic) { owner.autoSavePaused = failure.code === 'file_changed'; setSaveStatus({error:failure.message}); if (owner.autoSavePaused) status('Automatic saving paused: file changed on disk. Save to review.'); return false; }
    if (failure.code !== 'file_changed') { setSaveStatus({ error: failure.message }); throw new Error(failure.message); }
    // The conflict is unresolved while the dialog is open: report unsaved
    // changes, never Saving… or Saved, until the user picks an outcome.
    setSaveStatus(null);
    const choice = await ask('This file changed on disk', 'Another app changed this file. Reload the disk version, or overwrite it with your current document.', [
      { label: 'Cancel', value: 'cancel' }, { label: 'Reload', value: 'reload' }, { label: 'Overwrite', value: 'overwrite', style: 'destructive' }
    ]);
    if (choice === 'overwrite') return save(saveAs, true, owner);
    if (choice === 'reload') { await openPath(owner.path, true); return true; }
    return false;
  }
}
const documentSaves = new Map();
function requestSave(saveAs = false) {
  if (transitionLocked) return Promise.resolve(false);
  if (!current.documentId) return enqueue(() => save(saveAs));
  const owner = focusedDocument(), previous = documentSaves.get(owner.documentId);
  const operation = previous ? previous.catch(() => {}).then(() => save(saveAs, false, owner)) : save(saveAs, false, owner);
  documentSaves.set(owner.documentId, operation);
  operation.catch(toast).finally(() => { if (documentSaves.get(owner.documentId) === operation) documentSaves.delete(owner.documentId); });
  return operation;
}
function newDocument(sample = false) {
  return enqueue(async () => {
    if (!current.documentId && !(await allowDiscard())) return;
    // Same protection as Home: the backend document is replaced before the
    // native reset resolves, so reject edits to the outgoing document now and
    // release the temporary guard after the new editor is in place or fails.
    try {
      rememberDocument();
      setTransitionLocked(true);
      const nativeDocument = await invoke('new_document'); ++renderGeneration;
      previewSnapshot = null;
      const content = sample ? SAMPLE : '';
      current = { ...nativeDocument, path: null, name: sample ? 'Welcome.md' : nativeDocument?.documentId ? `Untitled ${++unnamedNumber}.md` : 'Untitled.md', content, saved: sample && nativeDocument?.documentId ? '' : content, writable: true, active: true };
      registerDocument(current); if (dirty()) documentEdited();
      resetDocumentPresentation(sample ? undefined : 'edit');
      setLineEnding(null);
      showDocument(); focusPane('main'); $('reader-scroll').scrollTop = 0; await refreshEditorSurface(); scheduleCompanionRender(0); if (!sample) editor?.focus();
    } finally {
      setTransitionLocked(false);
    }
  });
}
function addRecent(path) { const recent = preferences.get('recent', []); preferences.set('recent', [path, ...recent.filter(item => !samePath(item, path))].slice(0, 6)); renderRecent(); }
function renderRecent() {
  renderRecentMenu();
  const recent = preferences.get('recent', []); $('recent-section').hidden = !recent.length; $('recent-files').replaceChildren();
  for (const path of recent.slice(0, 4)) {
    const button = document.createElement('button'); button.className = 'recent-file'; button.append(fileIcon(path));
    const text = document.createElement('div'), name = document.createElement('strong'), location = document.createElement('small');
    name.textContent = basename(path); location.textContent = dirname(path); text.append(name, location); button.append(text); button.title = path; button.onclick = () => requestOpen(path); $('recent-files').append(button);
  }
}

let commandScope = 'commands', commandRows = [], filteredRows = [], selectedCommand = 0;
function allCommands() {
  const commands = [
    { label: 'Quick open…', icon: 'search', shortcut: 'Ctrl+P', scope: 'files' },
    { label: 'New document', icon: 'plus', shortcut: 'Ctrl+N', action: () => newDocument() },
    { label: 'Open file…', icon: 'file', shortcut: 'Ctrl+O', action: openEntry },
    { label: 'Open folder…', icon: 'folder-open', shortcut: 'Ctrl+Shift+O', detail: 'Open a folder with the selected picker', action: openFolderEntry },
    { label: 'New window', icon: 'file', action: () => invoke('new_window') },
    { label: 'Move tab to new window', icon: 'arrow-right', action: () => enqueue(moveDocumentToNewWindow) },
    { label: 'Recover documents…', icon: 'refresh', action: reviewRecovery },
    { label: 'Reopen closed tab', icon: 'refresh', action: () => enqueue(reopenDocument) },
    { label: 'Welcome screen', icon: 'home', action: goHome },
    { label: 'All documents', icon: 'tab-search', shortcut: 'Ctrl+Shift+A', detail: 'Search open tabs', scope: 'documents' },
    { label: 'Quit', icon: 'close', shortcut: 'Ctrl+Q', action: requestClose }
  ];
  if (current.active) {
    commands.push(
      { label: 'Save', icon: 'save', shortcut: 'Ctrl+S', action: () => requestSave() },
      { label: 'Save as…', icon: 'save', shortcut: 'Ctrl+Shift+S', action: () => requestSave(true) },
      { label: 'Export as HTML…', icon: 'save', action: () => runAppAction('html') },
      { label: 'Export as PDF…', icon: 'file', action: () => runAppAction('pdf') },
      { label: 'Duplicate…', icon: 'file', action: () => runAppAction('duplicate') },
      { label: 'Close file', icon: 'close', shortcut: 'Ctrl+W', action: () => runAppAction('close') }
    );
    if (current.path) commands.push(
      { label: 'Rename…', icon: 'edit', action: () => runAppAction('rename') },
      { label: 'Copy document path', icon: 'file', action: () => runAppAction('copy-path') },
      { label: 'Reveal in file manager', icon: 'folder-open', action: () => runAppAction('reveal') }
    );
  }
  commands.push(
    { label: 'Folio Lab', icon: 'theme', detail: 'Explore optional extras', action: openLab },
    { label: 'Inspect app state', icon: 'view', detail: 'State machines, transitions and violations', action: () => FolioState.openInspector() },
    { label: 'Change theme…', icon: 'theme', detail: 'Choose a color theme', scope: 'themes' },
    { label: filePicker() === 'native' ? 'Use Folio file picker' : 'Use system file picker', icon: 'open', detail: filePicker() === 'native' ? 'Folio dialog with folders and typed paths' : 'System dialog for files and folders', action: toggleFilePicker },
    { label: 'Try a sample document', icon: 'file', action: () => newDocument(true) },
    { label: 'Clear recent files', icon: 'close', action: () => { preferences.set('recent', []); renderRecent(); toast('Recent files cleared'); } }
  );
  if (current.active) commands.push(
    { label: 'Reading mode', icon: 'read', action: () => setDocumentMode('reading') },
    { label: 'Edit mode', icon: 'edit', action: () => setDocumentMode('edit') },
    { label: 'Source mode', icon: 'code', action: () => setDocumentMode('source') },
    { label: 'Inspect Markdown', icon: 'code', action: openSourceSnapshot },
    { label: 'Undo', icon: 'undo', shortcut: 'Ctrl+Z', action: () => enqueue(() => undoRedo()) },
    { label: 'Redo', icon: 'redo', shortcut: 'Ctrl+Shift+Z / Ctrl+Y', action: () => enqueue(() => undoRedo(true)) },
    { label: 'Cut', icon: 'edit', shortcut: 'Ctrl+X', action: () => runAppAction('cut') },
    { label: 'Copy', icon: 'file', shortcut: 'Ctrl+C', action: () => runAppAction('copy') },
    { label: 'Paste', icon: 'plus', shortcut: 'Ctrl+V', action: () => runAppAction('paste') },
    { label: 'Select all', icon: 'check', shortcut: 'Ctrl+A', action: () => runAppAction('select-all') },
    { label: 'Find in document', icon: 'search', shortcut: 'Ctrl+F', action: openFind },
    { label: 'Find and replace', icon: 'search', shortcut: 'Ctrl+H', action: openReplace },
    { label: documentReadOnly ? 'Unlock document' : 'Lock document', icon: documentReadOnly ? 'unlock' : 'lock', action: toggleDocumentReadOnly },
    { label: 'Show reading companion', icon: 'read', action: () => showReadingCompanion() },
    { label: 'Toggle outline', icon: 'outline', action: () => runAppAction('outline') },
    { label: 'Go back', icon: 'arrow-left', action: () => runAppAction('back') },
    { label: 'Go forward', icon: 'arrow-right', action: () => runAppAction('forward') },
    { label: 'Go to heading', icon: 'outline', action: () => runAppAction('heading') },
    { label: 'Go to top', icon: 'arrow-up', action: () => runAppAction('top') },
    { label: 'Go to bottom', icon: 'arrow-down', action: () => runAppAction('bottom') }
  );
  commands.push(
    { label: 'Toggle file explorer', icon: 'folder', shortcut: 'Ctrl+B', action: () => runAppAction('files') },
    { label: 'Search folder contents', icon: 'search', shortcut: 'Ctrl+Shift+F', action: openFolderSearch },
    { label: 'Toggle focus mode', icon: 'focus', action: toggleFocus },
    { label: 'Toggle fullscreen', icon: 'focus', shortcut: 'F11', action: () => runAppAction('fullscreen') },
    { label: remoteImages ? 'Block remote images' : 'Load remote images', icon: 'read', action: toggleRemoteImages },
    { label: readingFont === 'serif' ? 'Use sans-serif reading text' : 'Use serif reading text', icon: 'read', action: toggleReadingFont },
    { label: wideLayout ? 'Use centered document width' : 'Use full document width', icon: wideLayout ? 'width-contract' : 'width-expand', action: toggleDocumentWidth },
    { label: 'Zoom in', icon: 'plus', shortcut: 'Ctrl+=', action: () => zoomWindow(.1) },
    { label: 'Zoom out', icon: 'minus', shortcut: 'Ctrl+-', action: () => zoomWindow(-.1) },
    { label: 'Reset window zoom', icon: 'refresh', shortcut: 'Ctrl+0', action: () => zoomWindow(0, true) },
    { label: 'Increase document text size', icon: 'plus', shortcut: 'Ctrl+Shift+=', action: () => zoomText(1) },
    { label: 'Decrease document text size', icon: 'minus', shortcut: 'Ctrl+Shift+-', action: () => zoomText(-1) },
    { label: 'Reset document text size', icon: 'refresh', shortcut: 'Ctrl+Shift+0', action: () => zoomText(0, true) },
    { label: 'Keyboard shortcuts', icon: 'view', action: () => showHelp(true) },
    { label: 'Documentation', icon: 'file', action: () => runAppAction('documentation') },
    { label: 'Report an issue', icon: 'open', action: () => runAppAction('issue') },
    { label: 'About Folio', icon: 'read', action: () => showHelp() }
  );
  if (nativePlatform === 'linux') commands.push({ label: touchpadZoom ? 'Disable touchpad zoom' : 'Enable touchpad zoom', icon: 'read', detail: 'Allow pinch gestures to zoom the app', action: () => setTouchpadZoom(!touchpadZoom) });
  return commands;
}
function themeCommands() {
  return availableThemes().map(theme => ({
    ...theme,
    label: `Theme: ${theme.label}`,
    selected: theme.id === selectedTheme,
    // Theme changes restyle the whole document; keep them out of the same
    // task as the dismissal so the palette clears the screen first.
    defer: true,
    action: () => applyTheme(theme.id)
  }));
}
// Rows are built once per scope change and reused while typing: each keystroke
// only moves the already-built buttons, instead of recreating every label,
// icon and swatch (which made search feel laggy under WebKit).
function commandRow(command, index) {
  const button = document.createElement('button');
  button.id = `command-${index}`;
  button.type = 'button';
  button.className = 'command-item';
  button.tabIndex = -1;
  button.setAttribute('role', 'option');
  button.setAttribute('aria-selected', 'false');
  if (command.swatch) {
    const swatch = document.createElement('span');
    swatch.className = 'theme-swatch';
    swatch.style.setProperty('--swatch', command.swatch);
    button.append(swatch);
  } else button.append(icon(command.icon));
  const label = document.createElement('span');
  label.className = 'command-label';
  label.textContent = command.label;
  button.append(label);
  if (command.detail) {
    const detail = document.createElement('span');
    detail.className = 'command-detail';
    detail.textContent = command.detail;
    button.append(detail);
  }
  if (command.selected !== undefined) {
    // Theme rows keep a fixed check slot so their descriptions line up
    // whether or not the row is the active theme.
    const check = document.createElement('span');
    check.className = 'command-check';
    if (command.selected) check.append(icon('check'));
    button.append(check);
  }
  if (command.shortcut) {
    const shortcut = document.createElement('span');
    shortcut.className = 'shortcut';
    shortcut.textContent = command.shortcut;
    button.append(shortcut);
  }
  button.onclick = () => executeCommand(filteredRows.findIndex(row => row.element === button));
  return { command, element: button };
}
function buildCommandRows() {
  const list = commandScope === 'themes' ? themeCommands()
    : commandScope === 'files' ? quickOpenCommands()
    : commandScope === 'documents' ? [...documents.values()].map(doc => ({ label: doc.name, detail: doc.path || 'Unsaved document', icon: 'file', action: () => enqueue(() => activateDocument(doc)) }))
    : allCommands();
  commandRows = list.map(commandRow);
}
function updateActiveCommand() {
  filteredRows.forEach((row, index) => {
    const active = index === selectedCommand;
    row.element.classList.toggle('active', active);
    row.element.setAttribute('aria-selected', String(active));
  });
  $('command-search').setAttribute('aria-activedescendant', filteredRows.length ? filteredRows[selectedCommand].element.id : '');
}
function filterCommands() {
  const query = $('command-search').value.trim().toLocaleLowerCase();
  if (!query) filteredRows = commandRows.slice();
  else if (commandScope === 'files') {
    filteredRows = commandRows.map(row => ({row, score: fuzzyFileScore(query, `${row.command.label} ${row.command.detail || ''}`)}))
      .filter(item => item.score >= 0).sort((a,b)=>b.score-a.score).map(item=>item.row);
  } else {
    const scoreField = (value, priority) => {
      if (!value) return -1;
      const text = value.toLocaleLowerCase(), score = fuzzyFileScore(query, text);
      return score < 0 ? -1 : score + priority + (text.includes(query) ? 10000 : 0);
    };
    filteredRows = commandRows.map(row => ({row, score: Math.max(
      scoreField(row.command.label, 1000), scoreField(row.command.shortcut, 800), scoreField(row.command.detail, 0)
    )})).filter(item => item.score >= 0).sort((a,b)=>b.score-a.score).map(item=>item.row);
  }
  selectedCommand = Math.max(0, Math.min(selectedCommand, filteredRows.length - 1));
  $('command-list').replaceChildren(...filteredRows.map(row => row.element));
  $('command-empty').hidden = filteredRows.length > 0;
  $('command-empty').textContent = commandScope === 'files' ? 'No matching files in the open folder or tabs' : commandScope === 'documents' ? 'No open documents' : 'No matching commands';
  $('command-scope').textContent = commandScope === 'files' ? 'Quick open' : commandScope === 'themes' ? 'Appearance' : commandScope === 'documents' ? 'Open documents' : query ? 'Search results' : 'Commands';
  $('palette-hint').hidden = commandScope !== 'themes';
  $('command-results').scrollTop = 0;
  updateActiveCommand();
}
function openCommands(scope = 'commands') {
  closeAllMenus();
  commandScope = scope;
  selectedCommand = 0;
  $('command-search').value = '';
  $('command-search').placeholder = scope === 'files' ? 'Search folder files…' : scope === 'themes' ? 'Search themes…' : scope === 'documents' ? 'Search open documents…' : 'Search commands…';
  buildCommandRows();
  // Opening Appearance lands on the theme that is already applied, so the
  // checked row and the highlighted row agree.
  if (scope === 'themes') selectedCommand = Math.max(0, commandRows.findIndex(row => row.command.id === selectedTheme));
  filterCommands();
  if (!$('command-dialog').open) $('command-dialog').showModal();
  if (scope === 'themes') filteredRows[selectedCommand]?.element.scrollIntoView({ block: 'nearest' });
  $('command-search').focus({ preventScroll: true });
}
function renderCommands() {
  buildCommandRows();
  filterCommands();
}
function executeCommand(index) {
  const row = filteredRows[index];
  if (!row) return;
  // Scope entries (Change theme…) swap the list in place. Closing and
  // reopening the dialog for a submenu flashed the modal and re-entered the
  // top layer on every step.
  if (row.command.scope) { openCommands(row.command.scope); return; }
  const dialog = $('command-dialog');
  const wasOpen = dialog.open;
  if (wasOpen) dialog.close();
  const action = () => Promise.resolve(row.command.action()).catch(toast);
  if (!wasOpen || !row.command.defer) { action(); return; }
  // Paint the dismissal before running expensive commands. A theme change
  // restyles the whole document, and doing that in the same task held the
  // closing palette on screen for the entire restyle.
  let ran = false;
  const run = () => { if (ran) return; ran = true; action(); };
  requestAnimationFrame(() => setTimeout(run, 0));
  setTimeout(run, 120);
}
$('command-search').addEventListener('input', () => { selectedCommand = 0; filterCommands(); });
$('command-dialog').addEventListener('keydown', event => {
  if (event.isComposing) return;
  const focusedOption = event.target.closest?.('.command-item');
  const focusedIndex = focusedOption ? filteredRows.findIndex(row => row.element === focusedOption) : selectedCommand;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); event.stopPropagation();
    if (!filteredRows.length) return;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    selectedCommand = ((focusedIndex < 0 ? selectedCommand : focusedIndex) + step + filteredRows.length) % filteredRows.length;
    updateActiveCommand();
    $('command-search').focus({ preventScroll: true });
    filteredRows[selectedCommand].element.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter') {
    // Let the Back hint activate itself; Enter on any other target selects
    // the highlighted command.
    if (event.target === $('palette-hint')) return;
    event.preventDefault(); executeCommand(focusedIndex);
  } else if (event.key === 'Backspace' && event.target === $('command-search') && !$('command-search').value && commandScope === 'themes') openCommands();
});
$('command-dialog').addEventListener('click', event => { if (event.target === $('command-dialog')) $('command-dialog').close(); });
$('palette-hint').addEventListener('click', () => openCommands());

let matches = [], findIndex = -1, findSource = null;
function openFind() {
  if (focusedPane === 'companion') return openCompanionFind();
  if (!current.active) return;
  $('find-bar').hidden = false;
  findMachine.send('FIND');
  syncDocumentChrome(); $('find-input').focus(); $('find-input').select(); updateFind(); syncFindControl();
}
function clearHighlights() { editor?.clearHighlight?.(); }
function documentSearchPattern(query) {
  const enabled=id=>$(id)?.getAttribute('aria-pressed')==='true';
  let pattern=enabled('find-regex')?query:query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if(enabled('find-word'))pattern=`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
  return new RegExp(pattern,enabled('find-case')?'gu':'giu');
}
function findMatches(query) {
  const result=[]; if(!query)return result;
  let search;try{search=documentSearchPattern(query);}catch{return result;}
  let match;
  while((match=search.exec(current.content))&&result.length<2000){
    result.push({from:match.index,to:match.index+match[0].length});
    if(!match[0].length){const point=current.content.codePointAt(search.lastIndex);search.lastIndex+=point>0xffff?2:1;}
  }
  return result;
}
function findCountLabel(count) { return count >= 2000 ? '2,000+' : String(count); }
function updateFind() {
  const query = $('find-input').value;
  try { if(query)documentSearchPattern(query); $('find-input').removeAttribute('aria-invalid'); } catch { matches=[];findIndex=-1;$('find-input').setAttribute('aria-invalid','true');$('find-result').textContent='Invalid regular expression';clearHighlights();syncFindMachine();return; }
  matches = findMatches(query); findIndex = -1; findSource = current.content;
  if (!query) { $('find-result').textContent = ''; clearHighlights(); syncFindMachine(); return; }
  if (matches.length) nextFind(1);
  else { $('find-result').textContent = 'No matches'; clearHighlights(); syncFindMachine(); }
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
  syncFindMachine();
}
function revealSourceMatch(match) {
  const input = $('document-source');
  input.setSelectionRange(match.from, match.to);
  const line = current.content.slice(0, match.from).split('\n').length - 1;
  const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20;
  if (line * lineHeight < input.scrollTop || (line + 1) * lineHeight > input.scrollTop + input.clientHeight) {
    input.scrollTop = Math.max(0, line * lineHeight - input.clientHeight / 3);
  }
}
function nextFind(direction) {
  const query = $('find-input').value;
  if (!query) { matches = []; findIndex = -1; $('find-result').textContent = ''; clearHighlights(); syncFindMachine(); return; }
  if (findSource !== current.content) refreshFindOffsets(direction);
  if (!matches.length) { findIndex = -1; $('find-result').textContent = 'No matches'; clearHighlights(); syncFindMachine(); return; }
  findIndex = (findIndex + direction + matches.length) % matches.length;
  const match = matches[findIndex];
  // Focus stays in the find field: the editor selection is revealed without
  // stealing the caret, and a mirrored highlight keeps the hit visible while
  // the input owns focus.
  if (documentMode === 'source') revealSourceMatch(match);
  else editor?.selectRange(match.from, match.to, false);
  editor?.highlightRange?.(match.from, match.to);
  $('find-result').textContent = `${findIndex + 1} / ${findCountLabel(matches.length)}`;
  syncFindMachine();
}
let findRefreshTimer = 0;
function refreshFindAfterEdit() {
  if ($('find-bar').hidden) return;
  const query = $('find-input').value;
  if (!query) return;
  const previous = matches[findIndex];
  const anchor = previous ? previous.from : Math.max(0, editor?.getSelection()?.head ?? 0);
  matches = findMatches(query); findSource = current.content;
  if (!matches.length) { findIndex = -1; $('find-result').textContent = 'No matches'; clearHighlights(); syncFindMachine(); return; }
  let index = matches.findIndex(match => match.from >= anchor);
  if (index < 0) index = matches.length - 1;
  findIndex = index;
  editor?.highlightRange?.(matches[findIndex].from, matches[findIndex].to);
  $('find-result').textContent = `${findIndex + 1} / ${findCountLabel(matches.length)}`;
  syncFindMachine();
}
function scheduleFindRefresh() {
  if ($('find-bar').hidden) return;
  clearTimeout(findRefreshTimer);
  findRefreshTimer = setTimeout(refreshFindAfterEdit, 140);
}
function closeFind() {
  findMachine.send('CLOSE');
  $('find-bar').hidden = true; $('replace-bar').hidden = true; syncDocumentChrome(); clearHighlights();
  if (documentMode === 'source') $('document-source').focus();
  else editor?.focus();
  syncFindControl(); syncFindMachine();
}
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
function closeAllMenus(returnFocus = false) {
  for (const id of ['open-menu', 'view-menu', 'folio-menu', 'edit-menu', 'application-view-menu', 'go-menu', 'help-menu', 'document-mode-menu', 'document-more-menu', 'open-recent-menu', 'tree-menu']) {
    const menu = $(id);
    if (menu && !menu.hidden) {
      // Read focus before hiding: hiding a menu whose container itself holds
      // focus moves focus to the body, and the trigger would never get it back.
      const hadFocus = returnFocus && menu.contains(document.activeElement);
      const trigger = document.querySelector(`[aria-controls="${id}"]`);
      menu.hidden = true;
      trigger?.setAttribute('aria-expanded', 'false');
      if (hadFocus) trigger?.focus();
    }
  }
  if ([...document.querySelectorAll('.menu')].some(menu => !menu.hidden)) syncMenuMachine();
  else menuMachine.send('CLOSE');
}
function setupMenu(triggerId, menuId) {
  const trigger = $(triggerId), menu = $(menuId);
  if (!trigger || !menu) return;
  const items = () => [...menu.querySelectorAll('.menu-item:not([hidden]):not(:disabled)')].filter(item => item.closest('[role=menu]') === menu);
  function openMenu(pointerOpen = false) {
    const wasHidden = menu.hidden;
    closeAllMenus();
    if (!wasHidden) return;
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    menuMachine.send('OPEN', { id: menuId, pointer: pointerOpen });
    // A pointer-opened menu takes focus itself. Focusing the first row would
    // paint a focus ring on an item the pointer is nowhere near; hover is the
    // only state a pointer user should see until they move. Keyboard opens
    // still land on the first item so arrows, Home and End start from it.
    if (pointerOpen) { menu.tabIndex = -1; menu.focus({ preventScroll: true }); }
    else (menu.querySelector('input,select') || items()[0])?.focus();
  }
  // A keyboard activation (Enter/Space) also fires click, but with detail 0.
  trigger.addEventListener('click', event => { event.stopPropagation(); menu.hidden ? openMenu(event.detail > 0) : closeAllMenus(true); });
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && menu.hidden) { event.preventDefault(); openMenu(); }
    else if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); closeAllMenus(true); }
  });
  menu.addEventListener('keydown', event => {
    if (event.target.matches('input,select,summary') && event.key !== 'Escape') return;
    const list = items();
    const current = list.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeAllMenus(true); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); list[(current + 1 + list.length) % list.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); list[(current - 1 + list.length) % list.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); list[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); list[list.length - 1]?.focus(); }
    else if (event.key === 'Tab') { closeAllMenus(); }
  });
  menu.addEventListener('click', event => {
    if (!event.target.closest('.menu-item') || event.target.closest('#open-recent-button')) return;
    setTimeout(() => {
      const dialogOpen = ['open-dialog', 'source-dialog', 'command-dialog', 'confirm-dialog', 'editor-action-dialog', 'help-dialog', 'state-inspector'].some(id => $(id)?.open);
      const triggerForMenu = document.querySelector(`[aria-controls="${menuId}"]`);
      menu.hidden = true;
      triggerForMenu?.setAttribute('aria-expanded', 'false');
      if (!dialogOpen && menu.contains(document.activeElement)) triggerForMenu?.focus();
    }, 0);
  });
}
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.menu') && !event.target.closest('[aria-haspopup]')) closeAllMenus();
});

// The document preferences panel owns its own open/close behaviour; every
// other popup is still a menu.

$('home').onclick = goHome;
$('open-file').onclick = $('welcome-open').onclick = openEntry;
$('open-file').onclick = openEntry;
$('open-folder').onclick = openFolderEntry;
$('picker-toggle').onclick = () => { toggleFilePicker(); };
$('open-file').addEventListener('keydown', event => {
  if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); $('menu-file-button').click(); }
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
initializeFileTree();
$('folder-close').onclick = () => setFolderVisible(false);
for (const tab of document.querySelectorAll('[data-dock-tab]')) {
  tab.addEventListener('click', () => toggleDock(tab.dataset.dockTab));
}
document.querySelector('[data-rail-action="find"]').addEventListener('click', () => {
  if (activeFolder) { toggleDock('search'); return; }
  if ($('find-bar').hidden) openFind();
  else closeFind();
});
$('dock-open-folder').onclick = openFolderEntry;
$('folder-refresh').onclick = () => activeFolder && enqueue(async () => { const listing = await invoke('open_folder', { path: activeFolder.path }); activeFolder = { path: listing.path, name: listing.name }; folderEntries = listing.entries; renderFolderEntries(); });
$('new').onclick = () => newDocument(); $('sample').onclick = () => newDocument(true);
$('save').onclick = () => requestSave();
$('outline-close').onclick = () => setOutline(false);
$('width-toggle').onclick = toggleDocumentWidth;
$('zoom-in').onclick = () => zoomWindow(.1); $('zoom-out').onclick = () => zoomWindow(-.1); $('zoom-reset').onclick = () => zoomWindow(0, true);
$('reload').onclick = () => { const owner = current; return enqueue(async () => { if (owner !== current || !owner.path || !(await allowDiscard())) return false; return openPath(owner.path, true); }); }; $('dismiss-disk').onclick = () => { $('disk-banner').hidden = true; };
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
  else enqueue(async () => { const path = await invoke('resolve_document_link', { documentId: current.documentId, link: href }); await openPath(path); });
}
// Images pasted or dropped into a document are saved beside its Markdown file
// and inserted as a Markdown image link. Clipboard screenshots arrive either
// as a File item or, in some webviews, as an HTML data URL; both are accepted.
const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const CLIPBOARD_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
function isImagePath(path) { return IMAGE_PATH.test(String(path || '')); }
function imageCanBeAdded() {
  return Boolean(current.active && current.path && current.writable !== false && !documentReadOnly && !transitionLocked && editor && focusedPane !== 'companion');
}
function imageReadonlyMessage() {
  if (!current.path) return 'Save the document before adding images.';
  if (!editor) return 'This document cannot be edited here; images cannot be inserted.';
  if (documentReadOnly) return 'Turn off read-only before adding images.';
  return 'Filesystem permissions prevent adding images beside this document.';
}
function imageDropInsertion() {
  if (documentMode === 'source') return sourceCaret($('document-source'));
  if ($('preview').contains(document.activeElement)) return editor?.getSelection?.() || { anchor: current.content.length, head: current.content.length };
  return { anchor: current.content.length, head: current.content.length };
}
function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || ''), comma = value.indexOf(',');
      if (comma < 0) reject(new Error('The pasted image could not be read.'));
      else resolve(value.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('The pasted image could not be read.'));
    reader.readAsDataURL(file);
  });
}
function clipboardImagePayload(event) {
  const data = event.clipboardData;
  if (!data) return null;
  let text = '';
  try { text = data.getData('text/plain'); } catch {}
  if (text) return null;
  const items = Array.from(data.items || []);
  for (const item of items) {
    if (item.kind === 'file' && CLIPBOARD_IMAGE_TYPES.has(String(item.type).toLowerCase())) {
      const file = item.getAsFile();
      if (file) return { file, mime: String(file.type || 'image/png').toLowerCase() };
    }
  }
  for (const file of Array.from(data.files || [])) {
    if (CLIPBOARD_IMAGE_TYPES.has(String(file.type).toLowerCase())) return { file, mime: String(file.type || 'image/png').toLowerCase() };
  }
  // Some native webviews expose an image copied from another app only as an
  // HTML data URL. Keep that path narrow: the first raster image only.
  let html = '';
  try { html = data.getData('text/html'); } catch {}
  const match = /<img\b[^>]*\bsrc\s*=\s*["'](data:image\/(png|jpe?g|gif|webp);base64,([^"']+))["']/i.exec(html || '');
  if (!match) return null;
  const mime = `image/${match[2].toLowerCase()}`;
  return { data: match[3], mime, size: Math.floor(match[3].length * 3 / 4) };
}
function insertSourceImageMarkdown(markdown, selection) {
  const input = $('document-source');
  const length = input.value.length;
  const anchor = Math.max(0, Math.min(Number(selection?.anchor ?? length), length));
  const head = Math.max(0, Math.min(Number(selection?.head ?? length), length));
  const from = Math.min(anchor, head), to = Math.max(anchor, head);
  editor.setSourceSelection?.({ anchor: from, head: to });
  editor.checkpoint?.();
  input.focus();
  input.setSelectionRange(from, to);
  input.setRangeText(markdown, from, to, 'end');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: markdown }));
  return true;
}
function insertImageMarkdown(markdown, selection) {
  if (documentMode === 'source' && editor) return insertSourceImageMarkdown(markdown, selection);
  if (documentMode === 'reading') setDocumentMode('edit');
  if (!editor) return false;
  const length = current.content.length;
  const anchor = Math.max(0, Math.min(Number(selection?.anchor ?? length), length));
  const head = Math.max(0, Math.min(Number(selection?.head ?? length), length));
  return Boolean(editor.insertMarkdown?.(markdown, { anchor, head }));
}
async function saveClipboardImage(payload, selection) {
  const owner = current;
  const data = payload.file ? await readFileBase64(payload.file) : payload.data;
  const size = payload.file ? payload.file.size : payload.size;
  if (size > MAX_PASTED_IMAGE_BYTES) throw new Error("The pasted image exceeds Folio's 10 MB image limit.");
  const documentPath = owner.path;
  const saved = await invoke('save_pasted_image', { documentId: owner.documentId, data, mime: payload.mime });
  if (owner !== current || !current.active) return true;
  if (current.path !== documentPath) throw new Error('The document moved while the image was saving, so no link was inserted.');
  if (!saved || typeof saved.name !== 'string' || !saved.name) throw new Error('The image could not be saved beside the document.');
  if (!insertImageMarkdown(`![](${saved.name})`, selection)) throw new Error('The image was saved, but its Markdown could not be inserted.');
  status('Image added beside the document');
  return true;
}
async function importDroppedImage(path, selection) {
  const owner = current, documentPath = owner.path;
  const saved = await invoke('import_document_image', { documentId: owner.documentId, path });
  if (owner !== current || !current.active) return true;
  if (current.path !== documentPath) throw new Error('The document moved while the image was saving, so no link was inserted.');
  if (!saved || typeof saved.name !== 'string' || !saved.name) throw new Error('The image could not be saved beside the document.');
  if (!insertImageMarkdown(`![](${saved.name})`, selection)) throw new Error('The image was saved, but its Markdown could not be inserted.');
  status('Image added beside the document');
  return true;
}
async function addDroppedPaths(paths) {
  const images = [], others = [];
  for (const path of paths || []) (isImagePath(path) ? images : others).push(path);
  if (images.length) {
    if (!current.active) toast('Open a Markdown document before dropping an image.');
    else if (!imageCanBeAdded()) toast(imageReadonlyMessage());
    else {
      let insertion;
      if (documentMode === 'reading') {
        // Dropping while reading is an explicit insertion request. Edit mode
        // restores its last caret, which may be anywhere; append the image
        // rather than silently splicing it into an old selection.
        setDocumentMode('edit');
        insertion = { anchor: current.content.length, head: current.content.length };
      } else {
        insertion = imageDropInsertion();
      }
      for (const path of images) {
        try { await importDroppedImage(path, insertion); }
        catch (error) { toast(error); break; }
        insertion = imageDropInsertion();
      }
    }
  }
  for (const path of others) requestOpenLocation(path);
}
function updateDropOverlay(paths) {
  const imageOnly = paths.length > 0 && paths.every(isImagePath);
  const add = imageOnly && current.active && imageCanBeAdded();
  $('drop-overlay').querySelector('h2').textContent = add ? 'Drop to add image' : 'Drop to open';
  $('drop-overlay').querySelector('p').textContent = add ? 'Saves beside the document and inserts a Markdown image link.' : 'One Markdown file. No setup.';
}
document.addEventListener('paste', event => {
  if (event.defaultPrevented || !current.active) return;
  const target = event.target;
  const inSource = target === $('document-source') || target?.closest?.('#document-source');
  const inPreview = target?.closest?.('#preview');
  const readingSurface = documentMode === 'reading' && (target === document.body || target === document.documentElement || target?.closest?.('#reader-scroll'));
  if (!inSource && !inPreview && !readingSurface) return;
  const payload = clipboardImagePayload(event);
  if (!payload) return;
  event.preventDefault();
  event.stopPropagation();
  if (!imageCanBeAdded()) { toast(imageReadonlyMessage()); return; }
  if (!CLIPBOARD_IMAGE_TYPES.has(payload.mime)) { toast('Paste a PNG, JPEG, GIF, or WebP image.'); return; }
  const selection = inSource ? sourceCaret($('document-source'))
    : documentMode === 'reading' ? { anchor: current.content.length, head: current.content.length }
    : editor?.getSelection?.() || { anchor: current.content.length, head: current.content.length };
  if (documentMode === 'reading') setDocumentMode('edit');
  void saveClipboardImage(payload, selection).catch(toast);
}, true);

// ProseMirror's macOS keymap handles Ctrl+H as deletion before the
// document-level Replace shortcut can run. Keep Folio's shortcut consistent
// while the formatted editor has focus.
document.addEventListener('keydown', event => {
  if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
      event.key.toLowerCase() === 'h' && event.target.closest?.('#preview .ProseMirror') &&
      !event.target.closest('input,textarea') && !$('editor-action-dialog').open) {
    event.preventDefault();
    event.stopPropagation();
    openReplace();
  }
}, true);
// Capture application-wide shortcuts before inputs and editor widgets can stop
// key events. A native window must still be focused to receive these events.
window.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return;
  const key = event.key.toLowerCase();
  let action;
  if (event.shiftKey && key === 'p') action = () => $('command-dialog').open ? $('command-dialog').close() : openCommands();
  else if (event.code === 'Equal' || event.code === 'NumpadAdd' || key === '+' || key === '=') action = () => event.shiftKey ? zoomText(1) : zoomWindow(.1);
  else if (event.code === 'Minus' || event.code === 'NumpadSubtract' || key === '-' || key === '_') action = () => event.shiftKey ? zoomText(-1) : zoomWindow(-.1);
  else if (event.code === 'Digit0' || event.code === 'Numpad0' || key === '0') action = () => event.shiftKey ? zoomText(0, true) : zoomWindow(0, true);
  if (!action) return;
  event.preventDefault(); event.stopPropagation(); action();
}, true);
document.addEventListener('keydown', event => {
  const control = event.ctrlKey || event.metaKey;
  if (control && !event.altKey && event.shiftKey && event.key.toLowerCase() === 'a') { event.preventDefault(); openCommands('documents'); return; }
  if (event.defaultPrevented) return;
  if ($('recovery-dialog').open || $('help-dialog').open || $('command-dialog').open || $('confirm-dialog').open || $('open-dialog').open || $('source-dialog').open || $('editor-action-dialog').open || $('state-inspector')?.open) return;
  if (event.key === 'Escape') {
    if (!$('find-bar').hidden) closeFind();
    else if (document.body.classList.contains('focus-mode')) document.body.classList.remove('focus-mode');
    else if (narrowDrawers() && dockVisible && document.activeElement?.closest?.('.navigation-rail,#outline,#file-browser,#folder-search')) {
      dockVisible = false; renderNavigationDock();
      document.querySelector(`[data-dock-tab="${dockTab}"]`)?.focus();
    }
    return;
  }
  if (event.key === 'F11') { event.preventDefault(); invoke('toggle_fullscreen').catch(toast); return; }
  if (event.key === 'F6' && companionDocument) { event.preventDefault(); const pane=focusedPane==='main'?'companion':'main'; focusPane(pane); $(pane==='main'?'reader-scroll':'companion-scroll').focus(); return; }
  if (!control) return;
  const key = event.key.toLowerCase();
  if (!event.altKey && !event.shiftKey && key === 'p') { event.preventDefault(); openCommands('files'); return; }
  if (!event.altKey && !event.shiftKey && ['1','2','3'].includes(key) && current.active) { event.preventDefault(); setDocumentMode({1:'reading',2:'edit',3:'source'}[key]); return; }
  if (!event.altKey && key === '\\' && current.active) { event.preventDefault(); companionDocument ? closeReadingCompanion() : showReadingCompanion(); return; }
  if (key === 't') { event.preventDefault(); event.shiftKey ? enqueue(reopenDocument) : newDocument(); return; }
  if (event.ctrlKey && key === 'tab' && documents.size) { event.preventDefault(); const tabs = [...documents.values()], index = tabs.indexOf(current); enqueue(() => activateDocument(tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length])); return; }
  if (key === 'a' && !event.altKey && !event.shiftKey && !event.isComposing &&
      current.active && (editor || documentMode === 'source') &&
      !event.target.matches('input,textarea,select') && !event.target.isContentEditable) {
    event.preventDefault();
    void editClipboard('select-all');
    return;
  }
  if (key === 'z' || key === 'y') {
    if (event.target.matches('input,textarea')) return;
    event.preventDefault(); enqueue(() => undoRedo(key === 'y' || event.shiftKey));
  }
  else if (key === 'o') { event.preventDefault(); event.shiftKey ? openFolderEntry() : openEntry(); }
  else if (key === 'b' && editor && (event.target.closest?.('#preview .ProseMirror') || event.target.closest?.('#preview'))) { event.preventDefault(); editor.command('bold'); }
  else if (key === 'b' && !event.target.closest?.('#preview .ProseMirror')) { event.preventDefault(); toggleDock('files'); }
  else if (key === 'n') { event.preventDefault(); newDocument(); }
  else if (key === 's') { event.preventDefault(); requestSave(event.shiftKey); }
  else if (key === 'f') { event.preventDefault(); event.shiftKey ? openFolderSearch() : openFind(); }
  else if (key === 'h') { event.preventDefault(); openReplace(); }
  else if (key === 'w') { event.preventDefault(); closeDocument(); }
  else if (key === 'q') { event.preventDefault(); requestClose(); }
});
async function requestClose() { return enqueue(async () => {
  const protectWorkspace = documents.size > 0;
  try { if (protectWorkspace) setTransitionLocked(true); if (protectWorkspace ? await reviewWindowClose() : await allowDiscard()) await invoke('close_window'); }
  catch (error) { for (const doc of documents.values()) if (doc.content !== doc.saved) { doc.revision = (doc.revision || 0) + 1; recoveryWriter.changed(doc); await recoveryWriter.flush(doc); } throw error; }
  finally { if (protectWorkspace) setTransitionLocked(false); }
}); }

const SAMPLE = `# A quiet place for your words

Folio opens **individual Markdown files**. Read comfortably, edit directly, and save right back to disk. Use the document dropdown to choose **Read**, **Edit**, or **Source**. Turn on **Open as read-only** to protect the file in every mode.

## Make yourself at home

Use the dock to search, browse headings and open files. Press **Ctrl+Shift+P** for the command window. Search for a theme and press Enter to apply it.

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
  initializePanes(); initializeChrome(); initializeFolderSearch();
  $('all-documents').onclick = () => { closeAllMenus(); $('document-more-button').focus(); openCommands('documents'); };
  zoomText(0); zoomWindow(0); renderRecent(); setDocumentWidth(wideLayout, false);
  syncOpenAffordance();
  applyTheme(selectedTheme, false); applyReadingFont(readingFont, false);
  if (!window.__TAURI__) { toast('Open Folio from your app menu to enable file access.'); return; }
  await Promise.all([
    listen('request-close', requestClose),
    listen('open-files', event => { for (const path of event.payload) requestOpenLocation(path); }),
    listen('system-theme', event => { omarchy = event.payload; if (selectedTheme === 'omarchy') applyTheme('omarchy', false); else if ($('command-dialog').open) renderCommands(); })
  ]);
  const state = await invoke('bootstrap'); setPlatform(state.platform); nativePlatform = state.platform; omarchy = state.theme;
  if (preferences.get('theme', null) === null && omarchy) selectedTheme = 'omarchy';
  applyTheme(selectedTheme, false);
  syncDockForViewport();
  setTouchpadZoom(touchpadZoom, false);
  if (omarchy && !$('preference-theme').querySelector('[value=omarchy]')) { const option = document.createElement('option'); option.value = 'omarchy'; option.textContent = 'Omarchy'; $('preference-theme').append(option); }
  applyDocumentPreferences();
  await invoke('ready').catch(() => {});
  workspaceWindowLabel = state.windowLabel || 'main';
  const startupLayout = workspaceWindowLabel === 'main' && preferences.get('restoreSession', true) ? restorableWorkspaceLayout() : {};
  if (state.pendingTransfer) await mountTransferredDocument(state.pendingTransfer);
  else if (workspaceWindowLabel === 'main') await reviewRecovery();
  const layout = startupLayout;
  for (const path of state.paths || []) requestOpenLocation(path);
  for (const path of layout.paths || []) enqueue(async () => { if ([...documents.values()].some(doc => samePath(doc.path || doc.originalPath, path))) return; await openPath(path); });
  if (layout.activePath) enqueue(async () => { const doc = [...documents.values()].find(d => samePath(d.path, layout.activePath)); if (doc) await activateDocument(doc); });
  await window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(event => {
    const type = event.payload.type, paths = event.payload.paths || [];
    if (type === 'enter') updateDropOverlay(paths);
    $('drop-overlay').hidden = type !== 'over' && type !== 'enter';
    if (type === 'drop') { $('drop-overlay').hidden = true; void addDroppedPaths(paths).catch(toast); }
  });
  const idle = window.requestIdleCallback || (callback => setTimeout(callback, 200));
  idle(() => {
    loadAsset('vendor/editor/editor.js').catch(() => {});
    loadAsset('vendor/editor/editor.css', true).catch(() => {});
  });
  setInterval(async () => {
    if (!current.path || busy || document.hidden) return;
    const path = current.path;
    try { const changed = await invoke('document_changed', { documentId: current.documentId }); if (path === current.path) $('disk-banner').hidden = !changed; } catch {}
  }, 3000);
  requestAnimationFrame(() => requestAnimationFrame(() => { invoke('ready').catch(() => {}); }));
}
start().catch(error => { toast(error); console.error(error); });
