'use strict';
// A reading companion owns DOM and render jobs, never an editor or document history.
let companionDocument = null, companionFollows = false, focusedPane = 'main', companionTimer = 0, companionGeneration = 0;
let paneComposing = false, workspaceWindowLabel = 'main', companionAbort = null, companionMaxTimer = 0;
let companionSyncFrame = 0, companionSyncPositions = [], companionSyncLineStarts = [], companionSyncContent = null;
const autoSaveTimers = new Map();
function focusedDocument() { return focusedPane === 'companion' && companionDocument ? companionDocument : current; }
function focusPane(pane) {
  focusedPane = pane; $('document-view').dataset.focusedPane = pane;
  companionMachine.update({ focused: pane === 'companion' }, 'focus');
  $('reading-companion').setAttribute('aria-label', `Reading companion${pane === 'companion' ? ', focused' : ''}`);
  syncDocumentMode();
  if (typeof syncDocumentChrome === 'function') syncDocumentChrome();
  if (typeof syncFindControl === 'function') syncFindControl();
  renderedTitleKey = null; updateTitle();
  if (pane === 'companion') refreshCompanionOutline(); else scheduleEditorOutline();
}
function refreshCompanionOutline() {
  $('outline-items').replaceChildren();
  const headings = $('companion-preview').querySelectorAll('h1,h2,h3,h4,h5,h6');
  for (const heading of headings) { const button = document.createElement('button'); button.className = 'outline-link'; button.textContent = heading.textContent; button.onclick = () => heading.scrollIntoView({block:'start'}); $('outline-items').append(button); }
  $('outline-count').textContent = `${headings.length} ${headings.length === 1 ? 'heading' : 'headings'}`;
}
function showReadingCompanion(doc = current, follows = doc === current) {
  if (!doc.active) return;
  if (typeof closeEditorPopups === 'function') closeEditorPopups();
  if ($('document-view').hidden && typeof showDocument === 'function') showDocument();
  companionDocument = doc; companionFollows = follows;
  companionMachine.send(follows ? 'FOLLOW' : 'PIN', { documentId: doc.documentId || null });
  updateCompanionSyncControl();
  $('reading-companion').hidden = false; $('pane-divider').hidden = false;
  $('document-view').classList.add('has-companion'); scheduleCompanionRender(0);
  if ($('document-view').classList.contains('pane-narrow')) { focusPane('companion'); $('companion-scroll').focus(); }
}
function closeReadingCompanion() {
  clearTimeout(companionTimer); clearTimeout(companionMaxTimer); companionMaxTimer = 0; ++companionGeneration; companionAbort?.abort(); cancelMermaidPending('companion');
  companionMachine.send('CLOSE');
  companionDocument = null; cancelAnimationFrame(companionSyncFrame); companionSyncFrame = 0; updateCompanionSyncControl();
  $('companion-find').hidden = true; $('companion-find').querySelector('input').value = ''; $('companion-find').querySelector('span').textContent = ''; if(typeof syncFindControl==='function')syncFindControl();
  $('reading-companion').hidden = true; $('pane-divider').hidden = true;
  $('document-view').classList.remove('has-companion'); focusPane('main'); $('reader-scroll').focus();
  // The companion borrows the outline list for its own items; rebuild the
  // document rows now rather than leaving them stale until the next debounce.
  if (typeof refreshEditorOutline === 'function') refreshEditorOutline();
  syncCompanionMachine();
}
function scheduleCompanionRender(delay = 180) {
  if (!companionDocument) { syncCompanionMachine(); return; }
  if (companionFollows) companionDocument = current;
  syncCompanionMachine();
  updateCompanionSyncControl();
  ++companionGeneration;
  const run = () => { clearTimeout(companionTimer); clearTimeout(companionMaxTimer); companionTimer = companionMaxTimer = 0; renderReadingCompanion().catch(toast); };
  clearTimeout(companionTimer); companionTimer = setTimeout(run, delay);
  if (!companionMaxTimer) companionMaxTimer = setTimeout(run, 1000);
}
function prefixCompanionIds(root) {
  const ids = [...root.querySelectorAll('[id]')].map(element => element.id);
  for (const element of root.querySelectorAll('[id]')) element.id = 'companion-' + element.id;
  for (const style of root.querySelectorAll('style')) { for (const id of ids.sort((a,b)=>b.length-a.length)) style.textContent = style.textContent.split('#' + id).join('#companion-' + id); }
  for (const anchor of root.querySelectorAll('[href^="#"]')) anchor.setAttribute('href', '#companion-' + anchor.getAttribute('href').slice(1));
  for (const element of root.querySelectorAll('*')) for (const attribute of [...element.attributes]) { if (attribute.value.includes('url(#')) element.setAttribute(attribute.name, attribute.value.replace(/url\(#([^)]+)\)/g,'url(#companion-$1)')); }
}
async function renderReadingCompanion() {
  if (companionFollows) companionDocument = current;
  syncCompanionMachine();
  const doc = companionDocument; if (!doc?.active) return;
  const generation = ++companionGeneration, revision = doc.revision, content = doc.content, theme = diagramThemeRevision;
  const valid = () => generation === companionGeneration && companionDocument === doc && doc.revision === revision && doc.content === content && theme === diagramThemeRevision;
  companionAbort?.abort(); companionAbort = new AbortController(); const signal = companionAbort.signal;
  cancelMermaidPending('companion');
  const result = await invoke('render_markdown', {documentId:doc.documentId,content,remoteImages});
  if (!valid()) return;
  const root = $('companion-preview'), scroll = $('companion-scroll');
  const anchor = [...root.querySelectorAll('[data-sourcepos]')].find(n => n.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top);
  const position = anchor?.dataset.sourcepos, offset = anchor ? anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top : 0, top = scroll.scrollTop;
  root.innerHTML = typeof result === 'string' ? result : result.html || ''; prefixCompanionIds(root);
  companionSyncPositions = [...root.querySelectorAll('p[data-sourcepos],h1[data-sourcepos],h2[data-sourcepos],h3[data-sourcepos],h4[data-sourcepos],h5[data-sourcepos],h6[data-sourcepos],pre[data-sourcepos],li[data-sourcepos],table[data-sourcepos]')].map(node => ({ node, line: parseInt(node.dataset.sourcepos, 10) })).filter(entry => Number.isFinite(entry.line)).sort((a,b) => a.line - b.line);
  $('companion-name').textContent = doc.name;
  // A pinned/following companion can switch documents while its find bar is
  // open. Re-run the query against the new blocks so the count and jump are
  // not left over from the previous document.
  const companionFind = $('companion-find');
  if (companionFind && !companionFind.hidden) {
    const input = companionFind.querySelector('input');
    if (input.value) input.dispatchEvent(new Event('input'));
    else companionFind.querySelector('span').textContent = '';
  }
  const replacement = position && [...root.querySelectorAll('[data-sourcepos]')].find(n => n.dataset.sourcepos === position);
  scroll.scrollTop = replacement ? scroll.scrollTop + replacement.getBoundingClientRect().top - scroll.getBoundingClientRect().top - offset : top;
  if (root.querySelector('[data-math-style]')) { await loadKatex(); if (!valid()) return; for (const node of root.querySelectorAll('[data-math-style]')) window.katex.render(node.textContent,node,{displayMode:node.dataset.mathStyle==='display',throwOnError:false}); }
  for (const code of root.querySelectorAll('pre > code.language-mermaid')) {
    if (!valid()) return; const source = code.textContent;
    const host = document.createElement('div'); host.className = 'mermaid-host';
    let outcome; try { if (!mermaidSourceTooLarge(source)) ({result:outcome} = await requestMermaidRender(source, signal, 'companion')); } catch {}
    if (!valid() || !code.isConnected) return;
    if (outcome?.ok && outcome.sanitized && outcome.svg) { showDiagramSvg(host,outcome.svg); prefixCompanionIds(host); }
    else showMermaidFallback(host,source,outcome?.error?.code === 'unsupported_external_images');
    code.parentElement.replaceWith(host);
  }
  if (focusedPane === 'companion') focusPane('companion');
  scheduleCompanionSync();
}
function scheduleAutomaticSave(doc) {
  clearTimeout(autoSaveTimers.get(doc.documentId)); autoSaveTimers.delete(doc.documentId);
  if (!preferences.get('autoSaveFiles', false) || !doc.documentId || !doc.path || doc.content === doc.saved || doc.autoSavePaused) return;
  autoSaveTimers.set(doc.documentId,setTimeout(() => {
    autoSaveTimers.delete(doc.documentId);
    if (paneComposing || transitionLocked) { scheduleAutomaticSave(doc); return; }
    if (!documents.has(doc.documentId) || doc.closing || doc.transferring || !doc.path || doc.writable === false || (doc === current ? documentReadOnly : doc.view?.readOnly) || doc.autoSavePaused || !preferences.get('autoSaveFiles',false)) return;
    const previous = documentSaves.get(doc.documentId);
    const operation = (previous || Promise.resolve()).catch(() => {}).then(() => { if (transitionLocked || paneComposing || doc.closing || doc.transferring || !documents.has(doc.documentId) || doc.autoSavePaused || doc.writable === false || (doc === current ? documentReadOnly : doc.view?.readOnly) || !preferences.get('autoSaveFiles',false)) return false; return save(false,false,doc,true); });
    documentSaves.set(doc.documentId, operation);
    operation.catch(() => {}).finally(() => { if (documentSaves.get(doc.documentId) === operation) documentSaves.delete(doc.documentId); });
  },1000));
}
async function moveDocumentToNewWindow(doc = focusedDocument()) {
  if (!doc.documentId || transitionLocked) return false;
  if (doc === current) rememberDocument();
  const wasLocked = transitionLocked;
  try {
    doc.transferring = true; setTransitionLocked(true); clearTimeout(autoSaveTimers.get(doc.documentId)); autoSaveTimers.delete(doc.documentId);
    await documentSaves.get(doc.documentId); await recoveryWriter.flush(doc);
    const session = JSON.parse(JSON.stringify(doc)); delete session.transferring; delete session.closing;
    await invoke('new_window',{documentId:doc.documentId,session});
    recoveryWriter.state(doc.documentId).retired = true; documents.delete(doc.documentId);
    if (companionDocument === doc) closeReadingCompanion();
    if (doc === current) {
      const next = [...documents.values()].at(-1);
      if (next) await activateDocument(next,false);
      else {
        current = {path:null,name:'Untitled.md',content:'',saved:'',active:false};
        if (activeFolder) {
          editor?.destroy(); editor = null; editorDocument = null; editorPath = null; ++renderGeneration; previewSnapshot = null; documentLimited = false;
          resetDocumentPresentation(); setLineEnding(null);
          await renderPreview();
          showDocument(); await refreshEditorSurface();
          ($('folder-items').querySelector('.folder-entry') || $('folder-new'))?.focus({ preventScroll: true });
        } else showWelcome();
      }
    }
    renderTabs(); persistWorkspace(); return true;
  } finally { doc.transferring = false; setTransitionLocked(wasLocked); if (documents.has(doc.documentId)) scheduleAutomaticSave(doc); }
}
async function mountTransferredDocument({ token, document: captured }) {
  if (!captured || typeof captured !== 'object' || typeof captured.content !== 'string') throw new Error('The transferred document could not be opened.');
  const wasLocked = transitionLocked;
  setTransitionLocked(true);
  outlineFollowSuspended = true;
  try {
    current = captured; current.active = true; registerDocument(current);
    documentMode = current.view?.mode || (current.writable === false ? 'reading' : 'edit'); documentReadOnly = current.view?.readOnly || false;
    setLineEnding(current.lineEnding || null); showDocument(); await refreshEditorSurface();
    for (const entry of outlineEntries) if (current.view?.outline?.includes(entry.offset)) toggleOutlineEntry(entry, false);
    $('reader-scroll').scrollTop = current.view?.scroll || 0;
    $('document-source').scrollTop = current.view?.sourceScroll || 0;
    const findOpen = Boolean(current.view?.findOpen || current.view?.replaceOpen);
    $('find-input').value = current.view?.find || ''; $('find-bar').hidden = !findOpen; $('replace-bar').hidden = !current.view?.replaceOpen;
    if (findOpen) { updateFind(); findIndex = Number.isInteger(current.view?.findIndex) ? current.view.findIndex : -1; }
    syncDocumentChrome(); syncFindMachine(); syncCompanionMachine(); if (typeof syncFindControl === 'function') syncFindControl();
    await invoke('finish_window_transfer', { token, documentId: current.documentId });
  } finally { setTransitionLocked(wasLocked); outlineFollowSuspended = false; updateActiveOutline({ instant: true }); }
  if (!document.activeElement || document.activeElement === document.body) $('reader-scroll').focus({ preventScroll: true });
  scheduleAutomaticSave(current);
}
function initializePanes() {
  const main = $('reader-scroll'), parent = main.parentElement;
  const split = document.createElement('div'); split.className = 'pane-layout'; main.before(split); split.append(main);
  const divider = document.createElement('div'); divider.id='pane-divider'; divider.role='separator'; divider.tabIndex=0; divider.hidden=true; divider.setAttribute('aria-label','Resize reading panes'); divider.setAttribute('aria-orientation','vertical'); divider.setAttribute('aria-valuemin','25'); divider.setAttribute('aria-valuemax','75');
  const reader = document.createElement('section'); reader.id='reading-companion'; reader.hidden=true;
  reader.innerHTML='<header class="companion-head"><strong id="companion-name"></strong><button id="companion-edit" class="text-button" title="Open this document in the main pane">Edit in main pane</button><label id="companion-sync-control"><input id="companion-sync" type="checkbox"><span>Sync scroll</span></label><button id="companion-close" class="icon-button tiny" aria-label="Close reading companion" title="Close reading companion"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button></header><div id="companion-find" hidden><input type="search" aria-label="Find in reading companion"><span role="status"></span><button id="companion-find-close" class="icon-button tiny" aria-label="Close companion find" title="Close companion find"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button></div><div id="companion-scroll" class="companion-reader-scroll" tabindex="0" aria-label="Reading companion document"><article id="companion-preview" class="markdown"></article></div>';
  split.append(divider,reader);
  new ResizeObserver(entries => $('document-view').classList.toggle('pane-narrow', entries[0].contentRect.width < 720)).observe(split);
  let ratio=50; const resize = value => { ratio=Math.min(75,Math.max(25,value)); split.style.setProperty('--pane-ratio',ratio+'%'); divider.setAttribute('aria-valuenow',ratio); }; resize(50);
  divider.onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();resize(e.key==='Home'?25:e.key==='End'?75:ratio+(e.key==='ArrowLeft'?-5:5));}};
  divider.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();divider.setPointerCapture(e.pointerId);document.documentElement.classList.add('pane-resizing');};
  const endResize=()=>document.documentElement.classList.remove('pane-resizing');
  divider.addEventListener('lostpointercapture',endResize); divider.addEventListener('pointercancel',endResize); window.addEventListener('blur',endResize); divider.onpointermove=e=>{if(divider.hasPointerCapture(e.pointerId)){const b=split.getBoundingClientRect();resize((e.clientX-b.left)/b.width*100);}};
  main.addEventListener('focusin',()=>focusPane('main')); main.addEventListener('pointerdown',()=>{if(focusedPane!=='main')focusPane('main');});
  reader.addEventListener('focusin', event => { if (!event.target.closest('#companion-sync-control') && focusedPane !== 'companion') focusPane('companion'); });
  reader.addEventListener('pointerdown', event => { if (!event.target.closest('#companion-sync-control') && focusedPane !== 'companion') focusPane('companion'); });
  $('companion-close').onclick=closeReadingCompanion;
  $('companion-edit').onclick=()=>enqueue(async()=>{
    const doc=companionDocument, previous=current;
    await activateDocument(doc);
    companionFollows=false;
    if (!previous.active) closeReadingCompanion();
    else { companionDocument=previous; syncCompanionMachine(); updateCompanionSyncControl(); scheduleCompanionRender(0); }
    focusPane('main'); editor?.focus();
  });
  $('companion-find-close').onclick=()=>closeCompanionFind(true);
  $('companion-find').querySelector('input').oninput=e=>{const query=e.target.value.toLowerCase();const nodes=[...$('companion-preview').querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,pre,td')].filter(n=>query&&n.textContent.toLowerCase().includes(query));$('companion-find').querySelector('span').textContent=`${nodes.length} matching blocks`;nodes[0]?.scrollIntoView({block:'center'});};
  reader.onclick=e=>{const anchor=e.target.closest('a');if(anchor){e.preventDefault();if(anchor.getAttribute('href')?.startsWith('#'))document.getElementById(anchor.getAttribute('href').slice(1))?.scrollIntoView();else { const href = anchor.getAttribute('href'); if (/^(https?:|mailto:)/i.test(href)) invoke('open_link', {url:href}).catch(toast); else { const doc = companionDocument; enqueue(async () => { const path = await invoke('resolve_document_link', {documentId:doc.documentId,link:href}); await openPath(path); }); } }}};
  main.addEventListener('scroll', scheduleCompanionSync, { passive: true });
  $('document-source').addEventListener('scroll', scheduleCompanionSync, { passive: true });
  $('companion-sync').addEventListener('change', scheduleCompanionSync);
  document.addEventListener('compositionstart',()=>{paneComposing=true;},true); document.addEventListener('compositionend',()=>{paneComposing=false;scheduleAutomaticSave(current);},true);
  document.addEventListener('keydown',e=>{
    // A modal dialog owns the keyboard, so companion chords must not close the
    // companion, open its find bar, or save the document beneath it.
    if(document.querySelector('dialog[open]'))return;
    if(focusedPane==='companion'&&e.key==='Escape'&&!$('companion-find').hidden&&!document.querySelector('.menu:not([hidden])')){e.preventDefault();e.stopPropagation();closeCompanionFind(true);return;}
    if(focusedPane!=='companion'||!(e.ctrlKey||e.metaKey)||e.altKey)return;const key=e.key.toLowerCase();
    const target=e.target, editing=target?.matches?.('input,textarea,select')||target?.isContentEditable;
    if(editing){
      // Text fields keep their native editing chords; only app-level
      // navigation/save shortcuts are claimed while the caret is in them.
      if(!['f','h','w','s'].includes(key))return;
    } else if(!['f','w','s','z','y','b','i','h','x','v'].includes(key))return;
    e.preventDefault();e.stopImmediatePropagation();
    if(key==='f'||key==='h')openCompanionFind();
    if(key==='w')closeReadingCompanion();
    if(key==='s')requestSave(e.shiftKey);
  },true);
}
function openCompanionFind() { $('companion-find').hidden=false;$('companion-find').querySelector('input').focus(); if(typeof syncFindControl==='function')syncFindControl(); }
function closeCompanionFind(focusCompanion = focusedPane === 'companion') {
  $('companion-find').hidden = true;
  if (focusCompanion) $('companion-scroll').focus();
  if (typeof syncFindControl === 'function') syncFindControl();
}

// The formatted editor uses ProseMirror DOM, not renderer source-position attributes.
// Map its visible position back to Markdown, then align the companion's nearest block.
function updateCompanionSyncControl() {
  const control = $('companion-sync-control');
  if (!control) return;
  const sameDocument = Boolean(companionDocument && companionDocument === current);
  control.hidden = !sameDocument;
  if (!sameDocument) $('companion-sync').checked = false;
}
function scheduleCompanionSync() {
  if (companionSyncFrame || !$('companion-sync')?.checked || !companionDocument || companionDocument !== current) return;
  companionSyncFrame = requestAnimationFrame(() => { companionSyncFrame = 0; syncCompanionScroll(); });
}
function syncCompanionScroll() {
  if (!$('companion-sync').checked || companionDocument !== current) return;
  const main = $('reader-scroll'), preview = $('companion-scroll');
  const source = $('document-source');
  let line;
  if (documentMode === 'source') {
    const height = parseFloat(getComputedStyle(source).lineHeight) || 24;
    line = Math.floor(source.scrollTop / height) + 1;
  } else {
    const bounds = main.getBoundingClientRect();
    const offset = editor?.sourceAtCoords?.({ left: bounds.left + bounds.width / 2, top: bounds.top + 16 });
    if (offset != null) {
      if (companionSyncContent !== current.content) { companionSyncContent = current.content; companionSyncLineStarts = lineStartsFor(current.content); }
      let low = 0, high = companionSyncLineStarts.length;
      while (low < high) { const mid = (low + high) >>> 1; if (companionSyncLineStarts[mid] <= offset) low = mid + 1; else high = mid; }
      line = Math.max(1, low);
    }
  }
  if (line && companionSyncPositions.length) {
    let low = 0, high = companionSyncPositions.length;
    while (low < high) { const mid = (low + high) >>> 1; if (companionSyncPositions[mid].line <= line) low = mid + 1; else high = mid; }
    const match = companionSyncPositions[Math.max(0, low - 1)]?.node;
    if (match?.isConnected) { preview.scrollTop += match.getBoundingClientRect().top - preview.getBoundingClientRect().top; return; }
  }
  // Fallback for a document without source-mapped blocks or an unmounted editor.
  const scroller = documentMode === 'source' ? source : main;
  const range = scroller.scrollHeight - scroller.clientHeight;
  preview.scrollTop = range > 0 ? scroller.scrollTop / range * (preview.scrollHeight - preview.clientHeight) : 0;
}
