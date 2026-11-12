'use strict';
// Explorer actions carry the entry captured at invocation, independent of the active tab.
let treeMenuOrigin = null, treeNameForm = null;
function workspaceEntry(path) {
  return activeFolder && (samePath(path, activeFolder.path) || isWithin(path, activeFolder.path))
    ? folderEntries.find(entry => samePath(entry.path, path)) || { path, name: basename(path), directory: false, depth: 0 } : null;
}
function treeRow(path) { return [...$('folder-items').querySelectorAll('.folder-entry')].find(row => samePath(row.dataset.path, path)); }
function treeJoin(parent, name) { return parent.replace(/[\\/]$/, '') + (parent.includes('\\') ? '\\' : '/') + name; }
function treeAffected(entry) { return [...documents.values()].filter(doc => samePath(doc.path, entry.path) || entry.directory && isWithin(doc.path, entry.path)); }
function closeTreeMenu(restore = false) {
  const menu = $('tree-menu'); if (!menu) return;
  menu.hidden = true; $('folder-new').setAttribute('aria-expanded', 'false');
  if (restore) treeMenuOrigin?.focus({ preventScroll: true });
}
function showTreeMenu(entry, origin, point, newOnly = false) {
  if (!activeFolder || transitionLocked) return;
  closeAllMenus(); closeTreeMenu(); treeMenuOrigin = origin;
  const menu = $('tree-menu'); menu.replaceChildren(); menu.hidden = false;
  const parent = entry.directory ? entry.path : dirname(entry.path);
  const actions = [['New file', () => editTreeName('new-file', { path: parent, directory: true })], ['New folder', () => editTreeName('new-folder', { path: parent, directory: true })]];
  if (!newOnly && !entry.directory) actions.length=0;
  if (!newOnly) {
    actions.push(['Rename', () => editTreeName('rename', entry)], ['Duplicate', () => enqueue(() => performTreeOperation('duplicate', entry))]);
    const doc = [...documents.values()].find(doc => samePath(doc.path, entry.path) && doc.content !== doc.saved);
    if (doc && !entry.directory) actions.push(['Duplicate current edits', () => { const content = doc.content; return enqueue(() => performTreeOperation('duplicate', entry, null, content)); }]);
    actions.push(['Move to…', () => moveTreeEntry(entry)], ['Move to Trash', () => enqueue(() => trashTreeEntry(entry))],
      ['Copy path', () => navigator.clipboard.writeText(entry.path).catch(toast)], ['Reveal', () => invoke('reveal_path', { path: entry.path }).catch(toast)]);
  }
  for (const [label, action] of actions) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'menu-item'; button.role = 'menuitem'; button.setAttribute('aria-label',label);
    button.append(icon(({Rename:'edit',Duplicate:'file','Duplicate current edits':'file','Move to…':'folder','Move to Trash':'close','Copy path':'file',Reveal:'folder-open','New file':'plus','New folder':'folder'})[label]||'file'));
    const text=document.createElement('span');text.className='menu-text';text.textContent=label;button.append(text);
    if(label==='Move to Trash')button.classList.add('destructive');
    if(label==='Rename'){const hint=document.createElement('span');hint.className='menu-hint';hint.textContent='F2';button.append(hint);}
    button.onclick = () => { closeTreeMenu(true); Promise.resolve(action()).catch(toast); }; menu.append(button);
  }
  const box = origin.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(point?.x ?? box.left, innerWidth - 270))}px`;
  menu.style.top = `${Math.max(8, Math.min(point?.y ?? box.bottom, innerHeight - menu.offsetHeight - 8))}px`;
  if (newOnly) $('folder-new').setAttribute('aria-expanded', 'true');
  menu.firstElementChild?.focus();
}
function bindTreeEntry(button, entry) {
  button.addEventListener('contextmenu', event => { event.preventDefault(); button.focus({ preventScroll: true }); showTreeMenu({ ...entry }, button, { x: event.clientX, y: event.clientY }); });
  button.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); showTreeMenu({ ...entry }, button); }
    if (event.key === 'F2') { event.preventDefault(); editTreeName('rename', { ...entry }); }
  });
}
function editTreeName(action, entry) {
  if (transitionLocked) return;
  treeNameForm?.remove();
  const rename = action === 'rename', folder = action === 'new-folder';
  if (!rename && !samePath(entry.path, activeFolder.path)) { expandedFolders.add(pathKey(entry.path)); renderFolderEntries(); }
  const row = treeRow(entry.path), form = document.createElement('form'); form.className = 'tree-name-form'; treeNameForm = form;
  const label = document.createElement('label'); label.htmlFor = 'tree-name-input'; label.textContent = rename ? 'Rename' : folder ? 'New folder' : 'New file';
  const input = document.createElement('input'); input.id = 'tree-name-input'; input.value = rename ? entry.name : folder ? 'New folder' : 'Untitled.md'; input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('aria-describedby', 'tree-name-error');
  const error = document.createElement('p'); error.id = 'tree-name-error'; error.role = 'alert';
  form.append(label, input, error);
  const finish = path => { form.remove(); if (treeNameForm === form) treeNameForm = null; (treeRow(path || entry.path) || $('folder-new')).focus({ preventScroll: true }); };
  form.onkeydown = event => { event.stopPropagation(); if (event.key === 'Escape' && !input.disabled) { event.preventDefault(); finish(); } };
  form.onsubmit = event => {
    event.preventDefault(); if (input.disabled) return;
    let name = input.value.trim();
    if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f]/.test(name)) { error.textContent = 'Enter a name without slashes or control characters.'; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
    if (!rename && !folder && !/\.(md|markdown|mdown|mdtxt)$/i.test(name)) name += '.md';
    if (rename && name === entry.name) { finish(); return; }
    const destination = treeJoin(rename ? dirname(entry.path) : entry.path, name);
    input.disabled = true; error.textContent = '';
    enqueue(async () => {
      try { const result = await performTreeOperation(action, rename ? entry : { ...entry, path: destination }, rename ? destination : null); finish(result?.path); }
      catch (failure) { input.disabled = false; error.textContent = errorMessage(failure); input.setAttribute('aria-invalid', 'true'); input.focus(); }
    });
  };
  if (row) row.after(form); else $('folder-items').prepend(form);
  input.focus(); const dot = input.value.lastIndexOf('.'); input.setSelectionRange(0, !folder && !(rename && entry.directory) && dot > 0 ? dot : input.value.length);
}
async function refreshTreeEntries(focusPath) {
  if (!activeFolder) return;
  const scrollTop = $('folder-items').scrollTop;
  const listing = await invoke('open_folder', { path: activeFolder.path }); if (!listing || !Array.isArray(listing.entries)) throw new Error('The folder could not be read.'); folderEntries = listing.entries;
  renderFolderEntries(); syncFolderSelection();
  if (focusPath) treeRow(focusPath)?.focus({ preventScroll: true });
  $('folder-items').scrollTop = scrollTop;
}
function remapTreePath(path, result) {
  if (!path || !result.oldPath) return path;
  return samePath(path, result.oldPath) || result.directory && isWithin(path, result.oldPath)
    ? result.path && result.path + path.slice(result.oldPath.length) : path;
}
async function applyTreeResult(result) {
  if (!result) return;
  for (const update of Array.isArray(result.documents) ? result.documents : []) {
    const doc = documents.get(update.documentId); if (!doc) continue;
    doc.path = update.path; doc.name = update.name || basename(update.path || doc.path);
    if (doc.originalPath) doc.originalPath = remapTreePath(doc.originalPath, result);
    if (doc.content !== doc.saved) { doc.revision = (doc.revision || 0) + 1; recoveryWriter.changed(doc); await recoveryWriter.flush(doc); }
  }
  const storedRecent = preferences.get('recent', []), recent = Array.isArray(storedRecent) ? storedRecent : [];
  preferences.set('recent', [...new Set(recent.map(path => remapTreePath(path, result)).filter(path => typeof path === 'string' && path))]); renderRecent();
  const mappedNavigation = documentNavigation.map(path => remapTreePath(path, result));
  // Filtering earlier deleted entries must not advance the cursor to a later
  // entry. Count retained visits through the old cursor, including repeated paths.
  const retainedThroughCursor = mappedNavigation.slice(0, documentNavigationIndex + 1).filter(Boolean).length;
  documentNavigation = mappedNavigation.filter(Boolean);
  documentNavigationIndex = documentNavigation.length && documentNavigationIndex >= 0 ? Math.max(0, retainedThroughCursor - 1) : -1;
  for (const doc of closedDocuments) { doc.path = remapTreePath(doc.path, result); if (doc.path) doc.name = basename(doc.path); doc.originalPath = remapTreePath(doc.originalPath, result); }
  const expanded = [...expandedFolders]; expandedFolders.clear();
  for (const key of expanded) { const path = remapTreePath(key, result); if (path) expandedFolders.add(pathKey(path)); }
  if (current.active && editorPath !== current.path) { editorPath = current.path; editor?.refreshMedia(); }
  renderTabs(); persistWorkspace(); updateTitle();
  if (current.path) addRecent(current.path);
  // A pinned/following companion may show a renamed or moved document. Its
  // header name and relative media are part of the render, so refresh it.
  if (typeof scheduleCompanionRender === 'function' && companionDocument && (companionDocument === current || documents.has(companionDocument.documentId))) scheduleCompanionRender(0);
}
async function performTreeOperation(action, entry, destination = null, content) {
  const changing = action === 'rename' || action === 'move';
  try {
    if (changing) { setTransitionLocked(true); await Promise.all(treeAffected(entry).map(doc => documentSaves.get(doc.documentId))); }
    const args = { action, path: entry.path, destination }; if (content !== undefined) args.content = content;
    const result = await invoke('file_operation', args);
    if (changing) await applyTreeResult(result);
    await refreshTreeEntries(result?.path); status(action === 'duplicate' ? 'Copy created' : 'Files updated'); return result;
  } finally { if (changing) setTransitionLocked(false); }
}
function moveTreeEntry(entry) {
  const dialog = $('tree-move-dialog'), input = $('tree-move-path'), error = $('tree-move-error');
  if (dialog.open) return;
  input.value = dirname(entry.path); $('tree-move-title').textContent = `Move “${entry.name}”`; error.textContent = '';
  $('tree-move-cancel').onclick = () => dialog.close();
  $('tree-move-form').onsubmit = event => {
    event.preventDefault(); const parent = input.value.trim();
    if (!parent || !(samePath(parent, activeFolder.path) || isWithin(parent, activeFolder.path))) { error.textContent = 'Choose a folder inside the open workspace.'; return; }
    $('tree-move-confirm').disabled = true;
    enqueue(async () => { try { await performTreeOperation('move', entry, treeJoin(parent, entry.name)); dialog.close(); } catch (failure) { error.textContent = errorMessage(failure); input.focus(); } finally { $('tree-move-confirm').disabled = false; } });
  };
  dialog.showModal(); input.focus(); input.select();
}
async function trashTreeEntry(entry) {
  const kept = new Set();
  // Keep paths and sessions unchanged until native trash succeeds. Lock edits while
  // resolving snapshots, including saves that were already captured by another tab.
  setTransitionLocked(true);
  try {
    // Save As may move any captured session into or out of this subtree. Wait
    // for captured saves before computing the sessions requiring review.
    await Promise.all([...documentSaves.values()]);
    for (const doc of treeAffected(entry)) {
      if (doc.content === doc.saved) continue;
      const choice = await ask('Keep your changes?', `“${doc.name}” has unsaved changes.`, [{ label: 'Cancel', value: 'cancel' }, { label: 'Keep as unnamed', value: 'keep' }, { label: 'Save', value: 'save', style: 'suggested' }]);
      if (choice === 'cancel') return false;
      if (choice === 'save') {
        if (!(await save(false, false, doc))) return false;
        const live = documents.get(doc.documentId) || doc;
        if (live.content !== live.saved) return false;
      }
      else kept.add(doc.documentId);
    }
    if (await ask('Move to Trash?', `Move “${entry.name}”${entry.directory ? ' and its contents' : ''} to Trash?`, [{ label: 'Cancel', value: 'cancel' }, { label: 'Move to Trash', value: 'trash', style: 'destructive' }]) !== 'trash') return false;
    const result = await invoke('file_operation', { action: 'trash', path: entry.path, destination: null });
    if (!result || typeof result !== 'object') throw new Error('The file could not be moved to Trash.');
    // Native reports the sessions actually detached at commit. Earlier review
    // membership is not authority to close a session whose path has changed.
    for (const update of Array.isArray(result.documents) ? result.documents : []) {
      const doc = documents.get(update.documentId); if (!doc) continue;
      const oldPath = doc.path;
      if (kept.has(doc.documentId)) {
        doc.path = null; doc.originalPath = oldPath; doc.name = `Untitled ${++unnamedNumber}.md`; doc.saved = null;
        doc.revision = (doc.revision || 0) + 1; recoveryWriter.changed(doc); await recoveryWriter.flush(doc);
      } else {
        // Native trash has committed. Close clean sessions without a second prompt.
        doc.path = null; doc.closing = true;
        try { await invoke('close_document', { documentId: doc.documentId }); documents.delete(doc.documentId); await recoveryWriter.discard(doc).catch(error => recoveryWriter.warning(errorMessage(error))); }
        finally { doc.closing = false; }
      }
    }
    // Kept drafts have their own new identity labels; do not overwrite these with
    // the detached metadata returned for the former on-disk sessions.
    await applyTreeResult({ ...result, documents: [] });
    if (current.documentId && !documents.has(current.documentId)) {
      const next = [...documents.values()].at(-1);
      if (next) await activateDocument(next, false);
      else { ++renderGeneration; current = { path: null, name: 'Untitled.md', content: '', saved: '', active: false }; previewSnapshot = null; editor?.destroy(); editor = null; editorDocument = null; editorPath = null; documentLimited = false; resetDocumentPresentation(); setLineEnding(null); if (activeFolder) { await renderPreview(); showDocument(); await refreshEditorSurface(); } else showWelcome(); }
    }
    // A pinned companion may point at a session that Trash just detached or
    // closed. Do not leave it rendering a document that no longer exists.
    if (companionDocument && companionDocument !== current && !documents.has(companionDocument.documentId)) closeReadingCompanion();
    renderTabs(); persistWorkspace(); updateTitle(); await refreshTreeEntries(); status('Moved to Trash');
    if (!document.activeElement || document.activeElement === document.body) ($('folder-items').querySelector('.folder-entry') || $('reader-scroll'))?.focus({ preventScroll: true });
    return true;
  } finally { setTransitionLocked(false); }
}
function initializeFileTree() {
  $('folder-new').onclick = event => { event.stopPropagation(); if (!$('tree-menu').hidden) closeTreeMenu(true); else if (activeFolder) showTreeMenu({ ...activeFolder, directory: true }, $('folder-new'), null, true); };
  $('tree-menu').onkeydown = event => {
    event.stopPropagation(); const items = [...$('tree-menu').querySelectorAll('button')], index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); closeTreeMenu(true); }
    else if (event.key === 'Tab') { closeTreeMenu(); treeMenuOrigin?.focus({ preventScroll: true }); }
    if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) { event.preventDefault(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
  };
  $('folder-items').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const rows = [...$('folder-items').querySelectorAll('.folder-entry')];
    const index = rows.indexOf(document.activeElement?.closest?.('.folder-entry'));
    if (index < 0) return;
    event.preventDefault();
    const row = rows[index];
    if (event.key === 'Home') { rows[0]?.focus(); return; }
    if (event.key === 'End') { rows.at(-1)?.focus(); return; }
    if (event.key === 'ArrowDown') { rows[Math.min(index + 1, rows.length - 1)]?.focus(); return; }
    if (event.key === 'ArrowUp') { rows[Math.max(index - 1, 0)]?.focus(); return; }
    const entry = folderEntries.find(item => samePath(item.path, row.dataset.path));
    if (!entry) return;
    if (event.key === 'ArrowRight') {
      if (!entry.directory) return;
      if (row.getAttribute('aria-expanded') !== 'true') {
        expandedFolders.add(pathKey(entry.path)); renderFolderEntries();
        const next = [...$('folder-items').querySelectorAll('.folder-entry')];
        const at = next.findIndex(item => samePath(item.dataset.path, entry.path));
        (next[at + 1] || next[at])?.focus();
      } else {
        const child = rows[index + 1];
        if (child && isWithin(child.dataset.path, entry.path)) child.focus();
      }
    } else if (entry.directory && row.getAttribute('aria-expanded') === 'true') {
      expandedFolders.delete(pathKey(entry.path)); renderFolderEntries(); treeRow(entry.path)?.focus();
    } else treeRow(dirname(entry.path))?.focus();
  });
  document.addEventListener('pointerdown', event => { if (!event.target.closest('#tree-menu,#folder-new')) closeTreeMenu(); });
  window.addEventListener('resize', () => closeTreeMenu(true));
}
