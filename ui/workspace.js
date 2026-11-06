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
    find: $('find-input').value, findOpen: !$('find-bar').hidden, findIndex, saveStatus };
  recoveryWriter.flush(current);
}
function registerDocument(doc) {
  if (!doc.documentId) return;
  doc.revision = doc.revision || 0; documents.set(doc.documentId, doc); renderTabs(); persistWorkspace();
}
async function activateDocument(doc, capture = true) {
  if (doc === current) return true;
  try {
  setTransitionLocked(true);
  if (capture) rememberDocument();
  await invoke('activate_document', { documentId: doc.documentId });
  ++renderGeneration; previewSnapshot = null; current = doc;
  documentMode = doc.view?.mode || (doc.writable === false ? 'reading' : 'edit');
  documentReadOnly = doc.view?.readOnly || false;
  setLineEnding(doc.lineEnding || null); showDocument();
  saveStatus = doc.view?.saveStatus || null;
  await refreshEditorSurface();
  for (const entry of outlineEntries) if (doc.view?.outline?.includes(entry.offset)) toggleOutlineEntry(entry, false);
  $('reader-scroll').scrollTop = doc.view?.scroll || 0;
  $('document-source').scrollTop = doc.view?.sourceScroll || 0;
  $('find-input').value = doc.view?.find || ''; $('find-bar').hidden = !doc.view?.findOpen;
  if (doc.view?.findOpen) { updateFind(); findIndex = doc.view.findIndex; }
  focusPane('main'); updateTitle(); renderTabs(); persistWorkspace(); scheduleCompanionRender(); return true;
  } finally { setTransitionLocked(false); }
}
function persistWorkspace() {
  const layout = { paths: [...documents.values()].filter(d => d.path && d.content === d.saved).map(d => d.path), activePath: current.path };
  preferences.set(workspaceWindowLabel === 'main' ? 'workspaceLayout' : `workspaceLayout.${workspaceWindowLabel}`, layout);
  const windows = preferences.get('workspaceWindowLayouts', {});
  windows[workspaceWindowLabel] = layout; preferences.set('workspaceWindowLayouts', windows);
}
function restorableWorkspaceLayout() {
  const main = preferences.get('workspaceLayout', {}), paths = [...(main.paths || [])];
  for (const layout of Object.values(preferences.get('workspaceWindowLayouts', {}))) for (const path of layout.paths || []) if (!paths.some(existing => samePath(existing, path))) paths.push(path);
  return { paths, activePath: main.activePath };
}
function syncTabOverflow() {
  const list = $('tab-list'), button = $('all-documents');
  if (!list || !button) return;
  const available = list.clientWidth + (button.hidden ? 0 : button.getBoundingClientRect().width);
  button.hidden = list.scrollWidth <= available + 1;
}
new ResizeObserver(syncTabOverflow).observe($('tab-list'));
let renderedTabs = '';
function renderTabs() {
  const strip = $('document-tabs'); if (!strip) return;
  strip.hidden = !documents.size && !current.active && !activeFolder; const signature = [...documents.values()].map(d => [d.documentId, d.path, d.name, d.content !== d.saved, d === current]).join('|'); if (signature === renderedTabs) return; renderedTabs = signature; const list = $('tab-list'); list.replaceChildren();
  requestAnimationFrame(syncTabOverflow);
  for (const doc of documents.values()) {
    const tab = document.createElement('button'); tab.className = 'document-tab'; tab.type = 'button'; tab.role = 'tab';
    tab.id = `tab-${doc.documentId}`; tab.setAttribute('aria-controls', 'document-view'); tab.setAttribute('aria-selected', String(doc === current)); tab.tabIndex = doc === current ? 0 : -1;
    tab.title = doc.path || doc.originalPath || doc.name; tab.setAttribute('aria-label', `${doc.name}${doc.content !== doc.saved ? ', unsaved changes' : ''}, ${doc.path || 'unsaved document'}`);
    tab.append(fileIcon(doc.path || doc.name)); const label = document.createElement('span');
    const duplicates = [...documents.values()].filter(d => d.name === doc.name).length > 1;
    label.textContent = doc.name + (duplicates && doc.path ? ` — ${basename(dirname(doc.path))}` : '') + (doc.content !== doc.saved ? ' •' : ''); tab.append(label);
    tab.onclick = () => enqueue(() => activateDocument(doc));
    tab.oncontextmenu = event => { event.preventDefault(); const menu=$('tab-context-menu') || document.body.appendChild(Object.assign(document.createElement('div'),{id:'tab-context-menu',className:'menu'})); menu.replaceChildren(); menu.role='menu'; menu.style.cssText=`position:fixed;left:${Math.min(event.clientX,innerWidth-240)}px;top:${event.clientY}px;z-index:1000`; for (const [label,action] of [['Open beside',()=>showReadingCompanion(doc,false)],['Move tab to new window',()=>enqueue(()=>moveDocumentToNewWindow(doc))]]) { const button=document.createElement('button');button.className='menu-item';button.role='menuitem';button.textContent=label;button.onclick=()=>{menu.hidden=true;action();};menu.append(button); } menu.hidden=false;menu.firstChild.focus(); };
    tab.onkeydown = event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const tabs = [...documents.values()]; const i = tabs.indexOf(doc); const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(i + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length]; enqueue(async () => { await activateDocument(next); $( `tab-${next.documentId}`).focus(); }); } };
    const close = document.createElement('button'); close.type = 'button'; close.className = 'tab-close icon-button'; close.title = `Close ${doc.name}`; close.setAttribute('aria-label', close.title); close.append(icon('close')); close.onclick = () => enqueue(() => closeWorkspaceDocument(doc));
    const item = document.createElement('div'); item.className = 'tab-item'; item.append(tab, close); list.append(item); if (doc === current) requestAnimationFrame(() => tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }
}
async function closeWorkspaceDocument(doc = current) {
  if (doc === current) rememberDocument();
  await documentSaves.get(doc.documentId);
  if (doc.content !== doc.saved) {
    const choice = await ask('Save your changes?', `“${doc.name}” has changes that haven't been saved.`, [{ label: 'Cancel', value: 'cancel' }, { label: 'Discard', value: 'discard', style: 'destructive' }, { label: 'Save', value: 'save', style: 'suggested' }]);
    if (choice === 'cancel') return false;
    if (choice === 'save' && (!(await save(false, false, doc)) || doc.content !== doc.saved)) return false;
  }
  doc.closing = true; const lockActive = doc === current;
  try {
  if (lockActive) setTransitionLocked(true);
  await recoveryWriter.flush(doc);
  await invoke('recovery_saved', { documentId: doc.documentId, revision: doc.revision || 0 });
  await invoke('close_document', { documentId: doc.documentId });
  await recoveryWriter.discard(doc).catch(error => recoveryWriter.warning(String(error?.message || error)));
  if (companionDocument === doc) closeReadingCompanion(); clearTimeout(autoSaveTimers.get(doc.documentId));
  closedDocuments.push({ ...doc, view: doc.view }); documents.delete(doc.documentId);
  if (doc === current) {
    const next = [...documents.values()].at(-1);
    if (next) await activateDocument(next, false);
    else { current = { path: null, name: 'Untitled.md', content: '', saved: '', active: false }; showWelcome(); }
  }
  renderTabs(); persistWorkspace(); return true;
  } catch (error) { if (documents.has(doc.documentId) && doc.content !== doc.saved) { doc.revision = (doc.revision || 0) + 1; recoveryWriter.changed(doc); await recoveryWriter.flush(doc); } throw error; }
  finally { doc.closing = false; if (lockActive) setTransitionLocked(false); }
}
async function reopenDocument() {
  const previous = closedDocuments.pop(); if (!previous) return;
  const existing = previous.path && [...documents.values()].find(doc => samePath(doc.path, previous.path));
  if (existing) return activateDocument(existing);
  const native = previous.path ? await invoke('open_document', { path: previous.path, reuseExisting: true }) : await invoke('new_document'); if (!native?.documentId) return;
  if (documents.has(native.documentId)) return activateDocument(documents.get(native.documentId));
  const discarded = previous.content !== previous.saved;
  const content = previous.path ? native.content : discarded ? '' : previous.content;
  const doc = { ...previous, ...native, content, saved: content, view: !discarded && content === previous.content ? previous.view : null, revision: native.revision || 0, active: true };
  registerDocument(doc); await activateDocument(doc);
}
async function reviewWindowClose() {
  rememberDocument(); await Promise.allSettled([...documentSaves.values()]); const edited = [...documents.values()].filter(d => d.content !== d.saved);
  if (!edited.length) return true;
  const dialog = $('workspace-close-dialog'), rows = $('workspace-close-rows'); rows.replaceChildren();
  for (const doc of edited) { const row = document.createElement('label'); row.textContent = doc.name; const select = document.createElement('select'); select.setAttribute('aria-label', `Action for ${doc.name}`); for (const [value, text] of [['save', 'Save'], ['discard', 'Discard']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); } row.append(select); rows.append(row); }
  const proceed = await new Promise(resolve => { const finish = value => { dialog.close(); resolve(value); }; $('workspace-close-cancel').onclick = () => finish(false); $('workspace-close-confirm').onclick = () => finish(true); dialog.oncancel = event => { event.preventDefault(); finish(false); }; dialog.showModal(); $('workspace-close-cancel').focus(); });
  if (!proceed) return false;
  const choices = [...rows.querySelectorAll('select')].map(s => s.value);
  for (let i = 0; i < edited.length; i++) if (choices[i] === 'save' && (!(await save(false, false, edited[i])) || edited[i].content !== edited[i].saved)) return false;
  if ([...documents.values()].some(doc => doc.content !== doc.saved && !(edited.includes(doc) && choices[edited.indexOf(doc)] === 'discard'))) return false;
  for (let i = 0; i < edited.length; i++) if (choices[i] === 'discard') { await recoveryWriter.flush(edited[i]); await invoke('recovery_saved', { documentId: edited[i].documentId, revision: edited[i].revision || 0 }); }
  await Promise.all([...documents.values()].map(doc => recoveryWriter.flush(doc))); return true;
}
async function reviewRecovery() {
  let drafts; try { drafts = await invoke('recovery_list'); const warnings = await invoke('recovery_warnings'); if (Array.isArray(warnings) && warnings.length) recoveryWriter.warning(warnings.map(w => w.message).join(' ')); } catch { return; }
  if (Array.isArray(drafts)) drafts = drafts.filter(draft => !documents.has(draft.documentId));
  if (!Array.isArray(drafts) || !drafts.length) return;
  const dialog = $('recovery-dialog'), rows = $('recovery-rows'); rows.replaceChildren();
  for (const draft of drafts) {
    const row = document.createElement('label'), check = document.createElement('input'); check.type = 'checkbox'; check.checked = true; check.value = draft.documentId;
    const text = document.createElement('span'); text.textContent = `${draft.name}\n${draft.originalPath || 'Unsaved document'}\n${new Date(draft.snapshotTime).toLocaleString()}`; row.append(check, text); rows.append(row);
  }
  $('recovery-not-now').onclick = () => dialog.close();
  $('recovery-restore').onclick = async () => { const ids = [...rows.querySelectorAll('input:checked')].map(c => c.value); dialog.close(); await enqueue(async () => { for (const documentId of ids) { const restored = await invoke('recovery_restore', { documentId }); if (!restored?.documentId) continue; const doc = { ...restored, saved: restored.saved ?? null, active: true }; if (documents.has(documentId)) { await activateDocument(documents.get(documentId)); continue; } registerDocument(doc); await activateDocument(doc); } }); };
  $('recovery-discard').onclick = async () => { const ids = [...rows.querySelectorAll('input:checked')].map(c => c.value); dialog.close(); if (!ids.length) return; if (await ask('Discard unfinished work?', 'The selected recovery copies will be permanently removed.', [{ label: 'Cancel', value: 'cancel' }, { label: 'Discard', value: 'discard', style: 'destructive' }]) === 'discard') { for (const documentId of ids) await recoveryWriter.discard({ documentId }); } else await reviewRecovery(); };
  return new Promise(resolve => { dialog.addEventListener('close', resolve, { once: true }); dialog.showModal(); $('recovery-not-now').focus(); });
}
