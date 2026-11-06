'use strict';
// A reading companion owns DOM and render jobs, never an editor or document history.
let companionDocument = null, companionFollows = false, focusedPane = 'main', companionTimer = 0, companionGeneration = 0;
let paneComposing = false, workspaceWindowLabel = 'main', companionAbort = null, companionMaxTimer = 0;
const autoSaveTimers = new Map();
function focusedDocument() { return focusedPane === 'companion' && companionDocument ? companionDocument : current; }
function focusPane(pane) {
  focusedPane = pane; $('document-view').dataset.focusedPane = pane;
  $('reading-companion').setAttribute('aria-label', `Reading companion${pane === 'companion' ? ', focused' : ''}`);
  syncDocumentMode();
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
  companionDocument = doc; companionFollows = follows;
  $('reading-companion').hidden = false; $('pane-divider').hidden = false;
  $('document-view').classList.add('has-companion'); scheduleCompanionRender(0);
  if ($('document-view').classList.contains('pane-narrow')) { focusPane('companion'); $('companion-scroll').focus(); }
}
function closeReadingCompanion() {
  clearTimeout(companionTimer); clearTimeout(companionMaxTimer); companionMaxTimer = 0; ++companionGeneration; companionAbort?.abort(); cancelMermaidPending('companion');
  companionDocument = null; $('reading-companion').hidden = true; $('pane-divider').hidden = true;
  $('document-view').classList.remove('has-companion'); focusPane('main'); $('reader-scroll').focus();
}
function scheduleCompanionRender(delay = 180) {
  if (!companionDocument) return;
  if (companionFollows) companionDocument = current;
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
  $('companion-name').textContent = doc.name;
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
  try {
    doc.transferring = true; setTransitionLocked(true); clearTimeout(autoSaveTimers.get(doc.documentId));
    await documentSaves.get(doc.documentId); await recoveryWriter.flush(doc);
    const session = JSON.parse(JSON.stringify(doc)); delete session.transferring; delete session.closing;
    await invoke('new_window',{documentId:doc.documentId,session});
    recoveryWriter.state(doc.documentId).retired = true; documents.delete(doc.documentId);
    if (companionDocument === doc) closeReadingCompanion();
    if (doc === current) { const next = [...documents.values()].at(-1); if (next) await activateDocument(next,false); else { current = {path:null,name:'Untitled.md',content:'',saved:'',active:false}; showWelcome(); } }
    renderTabs(); persistWorkspace(); return true;
  } finally { doc.transferring = false; setTransitionLocked(false); if (documents.has(doc.documentId)) scheduleAutomaticSave(doc); }
}
async function mountTransferredDocument({ token, document: captured }) {
  setTransitionLocked(true);
  try {
    current = captured; current.active = true; registerDocument(current);
    documentMode = current.view?.mode || 'edit'; documentReadOnly = current.view?.readOnly || false;
    setLineEnding(current.lineEnding || null); showDocument(); await refreshEditorSurface();
    for (const entry of outlineEntries) if (current.view?.outline?.includes(entry.offset)) toggleOutlineEntry(entry, false);
    $('reader-scroll').scrollTop = current.view?.scroll || 0;
    $('document-source').scrollTop = current.view?.sourceScroll || 0;
    $('find-input').value = current.view?.find || ''; $('find-bar').hidden = !current.view?.findOpen;
    if (current.view?.findOpen) { updateFind(); findIndex = current.view.findIndex; }
    await invoke('finish_window_transfer', { token, documentId: current.documentId });
  } finally { setTransitionLocked(false); }
  scheduleAutomaticSave(current);
}
function initializePanes() {
  const main = $('reader-scroll'), parent = main.parentElement;
  const split = document.createElement('div'); split.className = 'pane-layout'; main.before(split); split.append(main);
  const divider = document.createElement('div'); divider.id='pane-divider'; divider.role='separator'; divider.tabIndex=0; divider.hidden=true; divider.setAttribute('aria-label','Resize reading panes'); divider.setAttribute('aria-orientation','vertical'); divider.setAttribute('aria-valuemin','25'); divider.setAttribute('aria-valuemax','75');
  const reader = document.createElement('section'); reader.id='reading-companion'; reader.hidden=true;
  reader.innerHTML='<header class="companion-head"><strong id="companion-name"></strong><button id="companion-edit" class="text-button">Edit in main pane</button><label><input id="companion-sync" type="checkbox">Sync scroll</label><button id="companion-close" class="text-button" aria-label="Close reading companion">Close</button></header><div id="companion-find" hidden><input type="search" aria-label="Find in reading companion"><span role="status"></span></div><div id="companion-scroll" class="companion-reader-scroll" tabindex="0" aria-label="Reading companion document"><article id="companion-preview" class="markdown"></article></div>';
  split.append(divider,reader);
  new ResizeObserver(entries => $('document-view').classList.toggle('pane-narrow', entries[0].contentRect.width < 720)).observe(split);
  let ratio=50; const resize = value => { ratio=Math.min(75,Math.max(25,value)); split.style.setProperty('--pane-ratio',ratio+'%'); divider.setAttribute('aria-valuenow',ratio); }; resize(50);
  divider.onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();resize(e.key==='Home'?25:e.key==='End'?75:ratio+(e.key==='ArrowLeft'?-5:5));}};
  divider.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();divider.setPointerCapture(e.pointerId);document.documentElement.classList.add('pane-resizing');};
  const endResize=()=>document.documentElement.classList.remove('pane-resizing');
  divider.addEventListener('lostpointercapture',endResize); divider.addEventListener('pointercancel',endResize); window.addEventListener('blur',endResize); divider.onpointermove=e=>{if(divider.hasPointerCapture(e.pointerId)){const b=split.getBoundingClientRect();resize((e.clientX-b.left)/b.width*100);}};
  main.addEventListener('focusin',()=>focusPane('main')); main.addEventListener('pointerdown',()=>{if(focusedPane!=='main')focusPane('main');});
  reader.addEventListener('focusin',()=>{if(focusedPane!=='companion')focusPane('companion');}); reader.addEventListener('pointerdown',()=>{if(focusedPane!=='companion')focusPane('companion');});
  $('companion-close').onclick=closeReadingCompanion;
  $('companion-edit').onclick=()=>enqueue(async()=>{const doc=companionDocument, previous=current; await activateDocument(doc); companionFollows=false; companionDocument=previous; scheduleCompanionRender(0);focusPane('main');editor?.focus();});
  $('companion-find').querySelector('input').oninput=e=>{const query=e.target.value.toLowerCase();const nodes=[...$('companion-preview').querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,pre,td')].filter(n=>query&&n.textContent.toLowerCase().includes(query));$('companion-find').querySelector('span').textContent=`${nodes.length} matching blocks`;nodes[0]?.scrollIntoView({block:'center'});};
  reader.onclick=e=>{const anchor=e.target.closest('a');if(anchor){e.preventDefault();if(anchor.getAttribute('href')?.startsWith('#'))document.getElementById(anchor.getAttribute('href').slice(1))?.scrollIntoView();else { const href = anchor.getAttribute('href'); if (/^(https?:|mailto:)/i.test(href)) invoke('open_link', {url:href}).catch(toast); else { const doc = companionDocument; enqueue(async () => { const path = await invoke('resolve_document_link', {documentId:doc.documentId,link:href}); await openPath(path); }); } }}};
  main.addEventListener('scroll',()=>{if(!$('companion-sync').checked||!companionFollows)return; const line=main.getBoundingClientRect().top; const node=[...$('preview').querySelectorAll('[data-sourcepos]')].find(n=>n.getBoundingClientRect().bottom>line);const match=node&&[...$('companion-preview').querySelectorAll('[data-sourcepos]')].find(n=>n.dataset.sourcepos===node.dataset.sourcepos);if(match)$('companion-scroll').scrollTop+=match.getBoundingClientRect().top-$('companion-scroll').getBoundingClientRect().top;},{passive:true});
  document.addEventListener('compositionstart',()=>{paneComposing=true;},true); document.addEventListener('compositionend',()=>{paneComposing=false;scheduleAutomaticSave(current);},true);
  document.addEventListener('keydown',e=>{if(focusedPane!=='companion'||!(e.ctrlKey||e.metaKey)||e.altKey)return;const key=e.key.toLowerCase();if(['f','w','s','z','y','b','i','h','x','v'].includes(key)){e.preventDefault();e.stopImmediatePropagation();if(key==='f')openCompanionFind();if(key==='w')closeReadingCompanion();if(key==='s')requestSave(e.shiftKey);}},true);
}
function openCompanionFind() { $('companion-find').hidden=false;$('companion-find').querySelector('input').focus(); }
