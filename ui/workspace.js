'use strict';
const documents = new Map(), closedDocuments = [];
let unnamedNumber = 0;
const recoveryWriter = new RecoveryWriter(invoke, message => {
  const notice = $('recovery-warning'); notice.hidden = false;
  notice.textContent = `Recovery protection is unavailable: ${message}. Keep saving your work.`;
});
function documentEdited(doc = current) {
  if (!doc.documentId) return;
  doc.revision = (doc.revision || 0) + 1;
  if (doc.content !== doc.saved) recoveryWriter.changed(doc);
  else recoveryWriter.saved(doc, doc.revision);
  renderTabs(); persistWorkspace(); if (companionFollows || companionDocument === doc) scheduleCompanionRender(); scheduleAutomaticSave(doc);
}
function rememberDocument() {
  if (!current.documentId) return;
  editor?.checkpoint(); editor?.captureSelection?.();
  current.view = { editor: editor?.captureSession(), mode: documentMode, readOnly: documentReadOnly,
    scroll: $('reader-scroll').scrollTop, sourceScroll: $('document-source').scrollTop,
    outline: outlineEntries.filter(e => outlineCollapsed.has(e.key || e.id)).map(e => e.offset),
    find: $('find-input').value, findOpen: !$('find-bar').hidden, replaceOpen: !$('replace-bar').hidden, findIndex, saveStatus };
  recoveryWriter.flush(current);
}
function registerDocument(doc) {
  if (!doc.documentId) return;
  doc.revision = doc.revision || 0; documents.set(doc.documentId, doc); renderTabs(); persistWorkspace();
}
async function activateDocument(doc, capture = true) {
  if (doc === current) return true;
  let activated = false;
  const wasLocked = transitionLocked;
  try {
  if (capture) rememberDocument();
  outlineFollowSuspended = true;
  setTransitionLocked(true);
  await invoke('activate_document', { documentId: doc.documentId });
  ++renderGeneration; previewSnapshot = null; current = doc;
  documentMode = doc.view?.mode || (doc.writable === false ? 'reading' : 'edit');
  documentReadOnly = doc.view?.readOnly || false;
  setLineEnding(doc.lineEnding || null); showDocument();
  saveStatus = doc.view?.saveStatus || null;
  await refreshEditorSurface();
  for (const entry of outlineEntries) if (doc.view?.outline?.includes(entry.offset)) toggleOutlineEntry(entry, false);
  const findOpen = Boolean(doc.view?.findOpen || doc.view?.replaceOpen);
  $('find-input').value = doc.view?.find || ''; $('find-bar').hidden = !findOpen; $('replace-bar').hidden = !doc.view?.replaceOpen;
  if (findOpen) { updateFind(); findIndex = Number.isInteger(doc.view?.findIndex) ? doc.view.findIndex : -1; }
  syncDocumentChrome(); syncFindMachine(); syncCompanionMachine();
  focusPane('main'); updateTitle();
  renderTabs(); persistWorkspace(); scheduleCompanionRender();
  if (!document.activeElement || document.activeElement === document.body) $('reader-scroll').focus({ preventScroll: true });
  activated = true; return true;
  } finally {
    setTransitionLocked(wasLocked);
    if (activated && current === doc) for (const [element, top] of [[$('reader-scroll'), doc.view?.scroll || 0], [$('document-source'), doc.view?.sourceScroll || 0]]) {
      const behavior = element.style.scrollBehavior; element.style.scrollBehavior = 'auto'; element.scrollTop = top; element.style.scrollBehavior = behavior;
    }
    // The rebuild above passes through cleared content at scroll 0; any spy
    // frame queued in between must not paint that transient state. Resume
    // only once the saved offset is back, then sync the highlight to the
    // settled position instead of waiting for the next scroll event.
    outlineFollowSuspended = false;
    if (activated && current === doc) {
      updateActiveOutline({ instant: true });
      // Restoring while async media (images, diagrams) still settles can
      // clamp short. Re-assert on the next frame so a tall document still
      // lands on its saved offset.
      const reader = $('reader-scroll'), top = doc.view?.scroll || 0;
      requestAnimationFrame(() => { if (current === doc && Math.abs(reader.scrollTop - top) > 1 && top <= reader.scrollHeight - reader.clientHeight) reader.scrollTop = top; });
    }
  }
}
const persistedWorkspaceSignatures = new Map();
function persistWorkspace() {
  const layout = { paths: [...documents.values()].filter(d => d.path && d.content === d.saved).map(d => d.path), activePath: current.path };
  // documentEdited runs on every keystroke. Only the clean-path list and the
  // active path affect the restorable layout, so avoid two synchronous
  // localStorage writes while the user is simply typing in one document.
  const signature = JSON.stringify(layout);
  if (persistedWorkspaceSignatures.get(workspaceWindowLabel) === signature) return;
  persistedWorkspaceSignatures.set(workspaceWindowLabel, signature);
  preferences.set(workspaceWindowLabel === 'main' ? 'workspaceLayout' : `workspaceLayout.${workspaceWindowLabel}`, layout);
  const stored = preferences.get('workspaceWindowLayouts', {}), windows = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  windows[workspaceWindowLabel] = layout; preferences.set('workspaceWindowLayouts', windows);
}
function restorableWorkspaceLayout() {
  const storedMain = preferences.get('workspaceLayout', {}), main = storedMain && typeof storedMain === 'object' && !Array.isArray(storedMain) ? storedMain : {};
  const paths = Array.isArray(main.paths) ? main.paths.filter(path => typeof path === 'string' && path) : [];
  const storedWindows = preferences.get('workspaceWindowLayouts', {}), windows = storedWindows && typeof storedWindows === 'object' && !Array.isArray(storedWindows) ? Object.values(storedWindows) : [];
  for (const layout of windows) for (const path of Array.isArray(layout?.paths) ? layout.paths : []) if (typeof path === 'string' && path && !paths.some(existing => samePath(existing, path))) paths.push(path);
  return { paths, activePath: main.activePath };
}
let renderedTabs = '', tabDrag = null, suppressTabClick = false;
function renderTabs() {
  const strip = $('document-tabs'); if (!strip) return;
  if (tabDrag?.dragging) { tabDrag.needsRender = true; return; }
  strip.hidden = !documents.size && !current.active && !activeFolder; const signature = [...documents.values()].map(d => [d.documentId, d.path, d.name, d.content !== d.saved, d === current]).join('|'); if (signature === renderedTabs) return; renderedTabs = signature; const list = $('tab-list'); list.replaceChildren();
  for (const doc of documents.values()) {
    const tab = document.createElement('button'); tab.className = 'document-tab'; tab.type = 'button'; tab.role = 'tab';
    tab.dataset.documentId = doc.documentId; tab.id = `tab-${doc.documentId}`; tab.setAttribute('aria-controls', 'document-view'); tab.setAttribute('aria-selected', String(doc === current)); tab.tabIndex = doc === current ? 0 : -1;
    tab.title = doc.path || doc.originalPath || doc.name; tab.setAttribute('aria-label', `${doc.name}${doc.content !== doc.saved ? ', unsaved changes' : ''}, ${doc.path || 'unsaved document'}`);
    tab.append(fileIcon(doc.path || doc.name)); const label = document.createElement('span');
    const duplicates = [...documents.values()].filter(d => d.name === doc.name).length > 1;
    label.textContent = doc.name + (duplicates && doc.path ? ` — ${basename(dirname(doc.path))}` : '') + (doc.content !== doc.saved ? ' •' : ''); tab.append(label);
    tab.onclick = event => { if (suppressTabClick) { suppressTabClick = false; event.preventDefault(); return; } enqueue(async () => { if (await activateDocument(doc)) $(`tab-${doc.documentId}`)?.focus({ preventScroll: true }); }); };
    tab.addEventListener('pointerdown', event => beginTabDrag(event, item, doc));
    tab.oncontextmenu = event => { event.preventDefault(); showTabMenu(doc, tab, {x:event.clientX,y:event.clientY}); };
    tab.onkeydown = event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); showTabMenu(doc, tab); return; } if (event.altKey && event.shiftKey && ['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); const sibling = event.key === 'ArrowLeft' ? item.previousElementSibling : item.nextElementSibling; if (sibling) { const boxes = new Map([...list.children].map(child => [child, child.getBoundingClientRect()])); if (event.key === 'ArrowLeft') list.insertBefore(item, sibling); else list.insertBefore(item, sibling.nextElementSibling); animateTabPositions(boxes, list); commitTabOrder(list); tab.focus({preventScroll:true}); } return; } if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const tabs = [...documents.values()]; const i = tabs.indexOf(doc); if (i < 0) return; const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(i + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length]; enqueue(async () => { await activateDocument(next); $( `tab-${next.documentId}`).focus(); }); } };
    const close = document.createElement('button'); close.type = 'button'; close.className = 'tab-close icon-button'; close.title = `Close ${doc.name}`; close.setAttribute('aria-label', close.title); close.append(icon('close'));
    const closeAndFocus = () => {
      const position = [...list.children].indexOf(item);
      enqueue(async () => {
        if (!(await closeWorkspaceDocument(doc))) return;
        const tabs = [...list.querySelectorAll('.document-tab')];
        (tabs[Math.min(position, tabs.length - 1)] || $('new')).focus({ preventScroll: true });
      });
    };
    close.onclick = closeAndFocus;
    const item = document.createElement('div'); item.className = 'tab-item'; item.append(tab, close); item.onauxclick = event => { if(event.button===1){event.preventDefault();closeAndFocus();} }; item.onmousedown = event => {if(event.button===1)event.preventDefault();}; list.append(item); if (doc === current) requestAnimationFrame(() => {
      if (!tab.isConnected) return;
      const bounds = list.getBoundingClientRect(), selected = tab.getBoundingClientRect();
      if (selected.left < bounds.left) list.scrollLeft += selected.left - bounds.left;
      else if (selected.right > bounds.right) list.scrollLeft += selected.right - bounds.right;
    });
  }
}
function animateTabPositions(before, list) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const child of list.children) {
    const previous = before.get(child), now = child.getBoundingClientRect();
    if (previous && previous.left !== now.left && typeof child.animate === 'function') child.animate([{transform:`translateX(${previous.left-now.left}px)`},{transform:'translateX(0)'}], {duration:160,easing:'ease-out'});
  }
}
function commitTabOrder(list) {
  const ordered = [...list.querySelectorAll('.document-tab')].map(tab => documents.get(tab.dataset.documentId)).filter(Boolean);
  if (ordered.length !== documents.size) return;
  documents.clear(); for (const doc of ordered) documents.set(doc.documentId, doc);
  persistWorkspace();
}
function beginTabDrag(event, item, doc) {
  if (event.button !== 0 || tabDrag || event.target.closest('.tab-close')) return;
  event.preventDefault();
  // Cancelling pointerdown suppresses the browser's implicit focus. A clicked
  // tab must still become the keyboard focus so arrow-key tab navigation works.
  item.querySelector('.document-tab')?.focus({ preventScroll: true });
  const list = $('tab-list'), initial = item.getBoundingClientRect();
  const state = { item, doc, list, startX:event.clientX, startY:event.clientY, rect:initial, dragging:false, frame:0, lastX:event.clientX, lastY:event.clientY };
  tabDrag = state;
  const move = e => {
    if (e.pointerId !== event.pointerId) return;
    state.lastX=e.clientX; state.lastY=e.clientY;
    if (!state.dragging && Math.hypot(e.clientX-state.startX,e.clientY-state.startY) < 6) return;
    if (!state.dragging) {
      state.dragging=true; item.classList.add('tab-drag-origin');
      const ghost=item.cloneNode(true); ghost.className='tab-drag-preview'; ghost.setAttribute('aria-hidden','true'); for (const node of ghost.querySelectorAll('[id]')) node.removeAttribute('id'); for (const button of ghost.querySelectorAll('button')) button.tabIndex=-1;
      Object.assign(ghost.style,{left:`${initial.left}px`,top:`${initial.top}px`,width:`${initial.width}px`,height:`${initial.height}px`});
      document.body.append(ghost); state.ghost=ghost; document.documentElement.classList.add('tab-dragging');
    }
    e.preventDefault();
    if (state.frame) return;
    state.frame=requestAnimationFrame(updateDrag);
  };
  const updateDrag = () => {
      state.frame=0; if (!state.dragging) return;
      state.ghost.style.transform=`translate(${state.lastX-state.startX}px, ${state.lastY-state.startY}px)`;
      const pane=document.querySelector('.pane-layout'), paneBounds=pane.getBoundingClientRect();
      state.dropBeside=state.lastX>paneBounds.left+paneBounds.width/2 && state.lastX<paneBounds.right && state.lastY>paneBounds.top && state.lastY<paneBounds.bottom;
      pane.classList.toggle('pane-drop-target',state.dropBeside);
      if(state.dropBeside)return;
      const bounds=list.getBoundingClientRect();
      const direction=state.lastY >= bounds.top-12 && state.lastY <= bounds.bottom+12 ? (state.lastX < bounds.left+24 ? -1 : state.lastX > bounds.right-24 ? 1 : 0) : 0;
      const oldScroll=list.scrollLeft;
      if (direction) list.scrollLeft += direction * 10;
      if (direction && list.scrollLeft !== oldScroll && !state.finishing) state.frame=requestAnimationFrame(updateDrag);
      const others=[...list.children].filter(child => child !== item);
      const before=others.find(child => state.lastX < child.getBoundingClientRect().left + child.getBoundingClientRect().width/2) || null;
      if (before !== item.nextElementSibling && !(before===null && item===list.lastElementChild)) {
        const boxes=new Map([...list.children].map(child=>[child,child.getBoundingClientRect()]));
        list.insertBefore(item,before); animateTabPositions(boxes,list);
      }
  };
  const finish = e => {
    if (e.pointerId !== event.pointerId) return;
    window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',finish); window.removeEventListener('pointercancel',cancel); window.removeEventListener('keydown',escape); window.removeEventListener('blur',blur);
    state.finishing=true;
    if (state.frame) { cancelAnimationFrame(state.frame); state.frame=0; if (!state.canceled) updateDrag(); }
    if (state.dragging) {
      suppressTabClick=true; setTimeout(()=>{suppressTabClick=false;},0);
      item.classList.remove('tab-drag-origin'); document.documentElement.classList.remove('tab-dragging');
      document.querySelector('.pane-layout').classList.remove('pane-drop-target');
      commitTabOrder(list);
      if(state.dropBeside&&!state.canceled)showReadingCompanion(doc,false);
      const target=item.getBoundingClientRect(), ghost=state.ghost;
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && ghost.animate) {
        const animation=ghost.animate([{transform:ghost.style.transform},{transform:`translate(${target.left-initial.left}px, ${target.top-initial.top}px)`}],{duration:160,easing:'ease-out'});
        animation.onfinish=()=>ghost.remove(); animation.oncancel=()=>ghost.remove();
      } else ghost.remove();
    }
    tabDrag=null; if (state.needsRender) { renderedTabs=''; renderTabs(); }
  };
  const cancel = e => { if (e.pointerId!==event.pointerId) return; state.canceled=true; if (state.dragging) { const ordered=[...documents.keys()]; const children=[...list.children]; children.sort((a,b)=>ordered.indexOf(a.querySelector('.document-tab').dataset.documentId)-ordered.indexOf(b.querySelector('.document-tab').dataset.documentId)); children.forEach(child=>list.append(child)); } finish(e); };
  const escape = e => { if (e.key === 'Escape') { e.preventDefault(); cancel({pointerId:event.pointerId}); } };
  const blur = () => cancel({pointerId:event.pointerId});
  window.addEventListener('pointermove',move,{passive:false}); window.addEventListener('pointerup',finish); window.addEventListener('pointercancel',cancel); window.addEventListener('keydown',escape); window.addEventListener('blur',blur);
}

async function closeWorkspaceDocument(doc = current) {
  if (!doc || doc.closing || (doc !== current && !documents.has(doc.documentId))) return false;
  if (doc === current) rememberDocument();
  await documentSaves.get(doc.documentId);
  if (doc.content !== doc.saved) {
    const choice = await ask('Save your changes?', `“${doc.name}” has changes that haven't been saved.`, [{ label: 'Cancel', value: 'cancel' }, { label: 'Discard', value: 'discard', style: 'destructive' }, { label: 'Save', value: 'save', style: 'suggested' }]);
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      if (!(await save(false, false, doc))) return false;
      // A save conflict can reload the document into a fresh object. Close the
      // live session rather than the stale snapshot, or the reloaded tab would
      // remain active but be removed from the document map.
      doc = documents.get(doc.documentId) || doc;
      if (doc.content !== doc.saved) return false;
    }
  }
  doc.closing = true; const lockActive = doc === current;
  try {
  if (lockActive) setTransitionLocked(true);
  await recoveryWriter.flush(doc);
  await invoke('recovery_saved', { documentId: doc.documentId, revision: doc.revision || 0 });
  await invoke('close_document', { documentId: doc.documentId });
  await recoveryWriter.discard(doc).catch(error => recoveryWriter.warning(String(error?.message || error)));
  if (companionDocument === doc) closeReadingCompanion(); clearTimeout(autoSaveTimers.get(doc.documentId)); autoSaveTimers.delete(doc.documentId);
  // Do not carry the in-flight close flags into the reopen snapshot: save()
  // refuses a document that still looks like it is closing.
  const closed = { ...doc, view: doc.view };
  delete closed.closing; delete closed.transferring;
  closedDocuments.push(closed);
  if (closedDocuments.length > 50) closedDocuments.shift();
  documents.delete(doc.documentId);
  if (doc === current) {
    const next = [...documents.values()].at(-1);
    if (next) await activateDocument(next, false);
    else {
      current = { path: null, name: 'Untitled.md', content: '', saved: '', active: false };
      if (activeFolder) {
        // The old editor is still mounted with the closed document. Clear it
        // before showing the folder-only surface so no stale preview remains.
        editor?.destroy(); editor = null; editorDocument = null; editorPath = null; ++renderGeneration; previewSnapshot = null; documentLimited = false;
        resetDocumentPresentation(); setLineEnding(null);
        await renderPreview();
        showDocument(); await refreshEditorSurface();
        ($('folder-items').querySelector('.folder-entry') || $('folder-new'))?.focus({ preventScroll: true });
      } else showWelcome();
    }
    // Ctrl+W tears down the focused editor. Move focus into the surviving
    // document instead of leaving keyboard users on <body>.
    requestAnimationFrame(() => {
      if (documents.size && (!document.activeElement || document.activeElement === document.body)) $('reader-scroll').focus({ preventScroll: true });
    });
  }
  renderTabs(); persistWorkspace(); return true;
  } catch (error) { if (documents.has(doc.documentId) && doc.content !== doc.saved) { doc.revision = (doc.revision || 0) + 1; recoveryWriter.changed(doc); await recoveryWriter.flush(doc); } throw error; }
  finally { doc.closing = false; if (lockActive) setTransitionLocked(false); }
}
async function reopenDocument() {
  const previous = closedDocuments.pop(); if (!previous) return;
  try {
    const existing = previous.path && [...documents.values()].find(doc => samePath(doc.path, previous.path));
    if (existing) return activateDocument(existing);
    const native = previous.path ? await invoke('open_document', { path: previous.path, reuseExisting: true }) : await invoke('new_document');
    if (!native?.documentId) { closedDocuments.push(previous); return; }
    if (documents.has(native.documentId)) return activateDocument(documents.get(native.documentId));
    if (previous.path && typeof native.content !== 'string') { closedDocuments.push(previous); return; }
    const discarded = previous.content !== previous.saved;
    const content = previous.path ? native.content : discarded ? '' : previous.content;
    const doc = { ...previous, ...native, content, saved: content, view: !discarded && content === previous.content ? previous.view : null, revision: native.revision || 0, active: true };
    registerDocument(doc); await activateDocument(doc);
  } catch (error) {
    // The closed entry is the only copy of an unsaved unnamed buffer. Do not
    // lose it when the native reopen fails; let the user retry.
    closedDocuments.push(previous);
    throw error;
  }
}
async function reviewWindowClose(registerCancel = null, isCancelled = () => false) {
  rememberDocument(); await Promise.allSettled([...documentSaves.values()]); const edited = [...documents.values()].filter(d => d.content !== d.saved);
  if (current.active && !documents.has(current.documentId) && current.content !== current.saved) edited.push(current);
  if (!edited.length) return { approved: !isCancelled(), discards: [] };
  const names = edited.map(doc => doc.name);
  const many = names.length > 1;
  const listed = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
  const choice = await ask('Save changes before closing?',
    many ? `${names.length} documents have unsaved changes: ${listed}.` : `“${names[0]}” has changes that haven't been saved.`,
    [{ label: 'Cancel', value: 'cancel' }, { label: many ? 'Discard all' : 'Discard', value: 'discard', style: 'destructive' }, { label: many ? 'Save all' : 'Save', value: 'save', style: 'suggested' }], registerCancel);
  if (choice === 'cancel' || isCancelled()) return { approved: false, discards: [] };
  if (choice === 'discard') {
    // Make every discarded buffer durable first, but do NOT retire recovery
    // here. The backend retires it only after actual native destruction, so a
    // later failure/cancel/timeout leaves the live dirty document recoverable.
    for (const doc of edited) { if (isCancelled()) return { approved: false, discards: [] }; await recoveryWriter.flush(doc, true); }
    if (isCancelled()) return { approved: false, discards: [] };
    await Promise.all([...documents.values()].map(doc => recoveryWriter.flush(doc, true)));
    if (isCancelled()) return { approved: false, discards: [] };
    return {
      approved: true,
      discards: edited.filter(doc => doc.documentId).map(doc => ({ documentId: doc.documentId }))
    };
  }
  for (const doc of edited) {
    if (isCancelled()) return { approved: false, discards: [] };
    if (!(await save(false, false, doc))) return { approved: false, discards: [] };
    const live = documents.get(doc.documentId) || doc;
    if (live.content !== live.saved) return { approved: false, discards: [] };
  }
  if (isCancelled()) return { approved: false, discards: [] };
  await Promise.all([...documents.values()].map(doc => recoveryWriter.flush(doc, true)));
  return { approved: !isCancelled(), discards: [] };
}

// Application quit is sequential: the backend targets one window at a time
// through the ordinary request-close review. A window remains locked from that
// review through its actual destruction; only cancel/error/timeout unlocks it.
let quitCloseState = null;
// A normal accepted close keeps ownership/lock until native destruction too;
// unlike quit there is no sequence token, but it must block further lifecycle
// actions and autosave while the asynchronous destroy is pending.
let windowCloseOwned = false;

function abortQuitClose(state = quitCloseState) {
  if (!state || quitCloseState !== state) return false;
  quitCloseState = null;
  if (state.locked) setTransitionLocked(false);
  return true;
}

async function closeForQuit(token) {
  if (quitCloseState) return false; // the backend serializes one window per token
  if (busy || transitionLocked) {
    // A normal close/open/new transition already owns this window. Do not
    // layer a quit review over it; the backend must stop the sequence.
    await invoke('quit_window_cancel', { token }).catch(() => {});
    return false;
  }
  const state = { token, locked: false, cancelled: false };
  quitCloseState = state;
  const protectWorkspace = documents.size > 0;
  let review = { approved: false, discards: [] };
  try {
    if (protectWorkspace) { setTransitionLocked(true); state.locked = true; }
    review = protectWorkspace ? await reviewWindowClose(cancel => { state.cancelDialog = cancel; }, () => state.cancelled) : { approved: await allowDiscard(), discards: [] };
  } catch (error) {
    await ensureDirtyRecovery();
    abortQuitClose(state);
    await invoke('quit_window_cancel', { token }).catch(() => {});
    toast(error);
    return false;
  }
  if (state.cancelled) return false; // cancelQuitClose owns recovery rewrite + unlock
  if (!review.approved) {
    await ensureDirtyRecovery();
    abortQuitClose(state);
    await invoke('quit_window_cancel', { token }).catch(() => {});
    return false;
  }
  const args = { quitToken: token };
  if (review.discards.length) args.discardRecovery = review.discards;
  try {
    await invoke('close_window', args);
    // The backend advances only after this window's native Destroyed event.
    // Keep the lock/token until then; the process is about to remove this view.
    return true;
  } catch (error) {
    await ensureDirtyRecovery();
    abortQuitClose(state);
    await invoke('quit_window_cancel', { token }).catch(() => {});
    toast(error);
    return false;
  }
}

function cancelQuitClose(token) {
  const state = quitCloseState;
  if (!state || state.token !== token) return;
  state.cancelled = true;
  const cancel = state.cancelDialog;
  state.cancelDialog = null;
  // Resolve an open native dialog as Cancel so its caller cannot fall through
  // to close_window after the token was invalidated.
  if (cancel) cancel();
  // Keep the window locked until a fresh recovery revision is durable; the
  // cancelled review must not leave visible dirty work unprotected.
  return (async () => {
    try { await ensureDirtyRecovery(); }
    finally { abortQuitClose(state); }
  })();
}

async function ensureDirtyRecovery() {
  const dirty = [...documents.values()].filter(doc => doc.content !== doc.saved);
  if (current.active && !documents.has(current.documentId) && current.content !== current.saved) dirty.push(current);
  for (const doc of dirty) {
    doc.revision = (doc.revision || 0) + 1;
    recoveryWriter.changed(doc);
    await recoveryWriter.flush(doc);
  }
}

async function reviewRecovery() {
  const dialog = $('recovery-dialog');
  if (dialog.open) return;
  let drafts; try { drafts = await invoke('recovery_list'); const warnings = await invoke('recovery_warnings'); if (Array.isArray(warnings) && warnings.length) recoveryWriter.warning(warnings.map(w => w.message).join(' ')); } catch { return; }
  if (Array.isArray(drafts)) drafts = drafts.filter(draft => draft && typeof draft === 'object' && !documents.has(draft.documentId));
  if (!Array.isArray(drafts) || !drafts.length) return;
  const rows = $('recovery-rows'); rows.replaceChildren();
  for (const draft of drafts) {
    const row = document.createElement('label'), check = document.createElement('input'); check.type = 'checkbox'; check.checked = true; check.value = draft.documentId;
    const text = document.createElement('span'); text.textContent = `${draft.name}\n${draft.originalPath || 'Unsaved document'}\n${new Date(draft.snapshotTime).toLocaleString()}`; row.append(check, text); rows.append(row);
  }
  $('recovery-not-now').onclick = () => dialog.close();
  $('recovery-restore').onclick = async () => { const ids = [...rows.querySelectorAll('input:checked')].map(c => c.value); dialog.close(); await enqueue(async () => { for (const documentId of ids) { const restored = await invoke('recovery_restore', { documentId }); if (!restored?.documentId || typeof restored.content !== 'string') continue; const doc = { ...restored, saved: typeof restored.saved === 'string' ? restored.saved : null, active: true }; if (documents.has(documentId)) { await activateDocument(documents.get(documentId)); continue; } registerDocument(doc); await activateDocument(doc); } }); };
  $('recovery-discard').onclick = async () => { const ids = [...rows.querySelectorAll('input:checked')].map(c => c.value); dialog.close(); if (!ids.length) return; if (await ask('Discard unfinished work?', 'The selected recovery copies will be permanently removed.', [{ label: 'Cancel', value: 'cancel' }, { label: 'Discard', value: 'discard', style: 'destructive' }]) === 'discard') { try { for (const documentId of ids) await recoveryWriter.discard({ documentId }); } catch (error) { toast(error); } } else await reviewRecovery(); };
  return new Promise(resolve => { dialog.addEventListener('close', resolve, { once: true }); dialog.showModal(); $('recovery-not-now').focus(); });
}

function showTabMenu(doc, origin, point) {
  closeAllMenus();
  const menu=$('tab-context-menu') || document.body.appendChild(Object.assign(document.createElement('div'),{id:'tab-context-menu',className:'menu'}));
  menu.replaceChildren(); menu.role='menu'; menu.setAttribute('aria-label',`Actions for ${doc.name}`);
  const close=()=>{menu.hidden=true;origin.focus({preventScroll:true});};
  for(const [label, action] of [['Open beside',()=>showReadingCompanion(doc,false)],['Move tab to new window',()=>enqueue(()=>moveDocumentToNewWindow(doc))]]) {
    const button=document.createElement('button'); button.className='menu-item'; button.role='menuitem'; button.textContent=label;
    button.onclick=()=>{close();Promise.resolve(action()).catch(toast);};menu.append(button);
  }
  menu.hidden=false; const box=origin.getBoundingClientRect();
  menu.style.left=`${Math.max(8,Math.min(point?.x??box.left,innerWidth-248))}px`;
  menu.style.top=`${Math.max(8,Math.min(point?.y??box.bottom,innerHeight-menu.offsetHeight-8))}px`;
  menu.onkeydown=event=>{const buttons=[...menu.querySelectorAll('button')],i=buttons.indexOf(document.activeElement);if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();}else if(event.key==='Tab'){menu.hidden=true;origin.focus({preventScroll:true});}};
  menu.firstChild.focus();
}
document.addEventListener('pointerdown',event=>{const menu=$('tab-context-menu');if(menu&&!menu.contains(event.target))menu.hidden=true;});
