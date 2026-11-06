const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
 const s = await openEditor('# First\n\nBody\n');
 try {
  const {page} = s;
  await page.evaluate(() => { current.documentId = 'a'; current.revision = 0; registerDocument(current); });
  await page.evaluate(()=>{ preferences.set('workspaceWindowLayouts',{'workspace-old':{paths:['/previous-window.md']}}); });
  assert.equal(await page.evaluate(()=>restorableWorkspaceLayout().paths.includes('/previous-window.md')),true,'clean secondary window paths restore on launch');
  const svgIds = await page.evaluate(()=>{ const root=document.createElement('div');root.innerHTML='<svg id="drawing"><style>#drawing { fill: url(#arrow); }</style><defs><marker id="arrow"/></defs><use href="#arrow"/></svg>';prefixCompanionIds(root);return root.innerHTML; });
  assert.match(svgIds,/#companion-drawing/,'diagram style scopes follow namespaced IDs');
  await page.evaluate(() => showReadingCompanion());
  await page.waitForSelector('#companion-preview h1');
  assert.equal(await page.locator('#companion-preview [contenteditable]').count(), 0);
  assert.match(await page.locator('#companion-preview h1').getAttribute('id'), /^companion-/);
  const renderedDuringBurst = await page.evaluate(async()=>{
   const before=calls.filter(c=>c.command==='render_markdown').length;
   const burst=setInterval(()=>scheduleCompanionRender(),40);
   await new Promise(resolve=>setTimeout(resolve,1250));clearInterval(burst);
   return calls.filter(c=>c.command==='render_markdown').length>before;
  });
  assert.equal(renderedDuringBurst,true,'continuous updates have a bounded preview delay');
  await page.evaluate(() => editor.replaceContent('# Changed\n'));
  await page.locator('#companion-scroll').focus();
  await page.evaluate(() => { const before=current.content; undoRedo(); window.companionUndoPreserved=current.content===before; });
  assert.equal(await page.evaluate(() => window.companionUndoPreserved),true,'companion undo cannot edit the main document');
  await page.locator('#reader-scroll').focus();
  await page.waitForFunction(() => $('companion-preview').textContent.includes('Changed'));
  await page.evaluate(async()=>{
   window.otherDoc={documentId:'b',name:'Other.md',path:'/other.md',content:'other [relative](child.md)',saved:'other [relative](child.md)',active:true,writable:true,revision:0};registerDocument(window.otherDoc);
   showReadingCompanion(window.otherDoc,false);
  });
  await page.waitForFunction(()=>$('companion-preview').textContent.includes('other'));
await page.evaluate(()=>{const original=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=(cmd,args)=>{if(cmd==='resolve_document_link'){window.linkOwner=args.documentId;return Promise.resolve('/tmp/test.md');}return original(cmd,args);};});
  await page.locator('#companion-preview a').click();await page.waitForFunction(()=>!busy);
  assert.equal(await page.evaluate(()=>window.linkOwner),'b','relative links resolve against the companion document');
  await page.locator('#companion-scroll').focus();
  await page.evaluate(()=>{current.content='unsaved primary';updateTitle();});
  assert.equal(await page.locator('#document-name').textContent(),'Other.md','title updates remain routed to focused companion');
  assert.equal(await page.locator('#save-state').textContent(),'Saved','save state belongs to focused document');
  await page.evaluate(()=>{documents.delete('b');showReadingCompanion(current);$('reader-scroll').focus();});
  await page.waitForFunction(()=>$('companion-preview').textContent.includes('unsaved primary'));
  const renderCount = await page.evaluate(() => calls.filter(c=>c.command==='render_markdown').length);
  await page.evaluate(() => applyTheme('dark',false));
  await page.waitForFunction(count=>calls.filter(c=>c.command==='render_markdown').length>count,renderCount,{timeout:2000});
  await page.locator('#companion-scroll').focus(); await page.keyboard.press('Control+w');
  assert.equal(await page.locator('#reading-companion').isVisible(), false);
  assert.equal(await page.evaluate(() => documents.has('a')), true);
  await page.evaluate(() => { preferences.set('autoSaveFiles', true); editor.replaceContent('automatic\n'); });
  await page.waitForFunction(() => window.savedContent === 'automatic\n');
  await page.evaluate(() => { current.path = null; window.savedContent = null; editor.replaceContent('unnamed\n'); });
  await page.waitForTimeout(1300); assert.equal(await page.evaluate(() => window.savedContent), null);
  await page.evaluate(async () => {
   const original=window.__TAURI__.core.invoke;
   window.__TAURI__.core.invoke=(cmd,args)=>cmd==='new_window'?Promise.reject(Error('destination failed')):original(cmd,args);
   try { await moveDocumentToNewWindow(); } catch {}
   window.__TAURI__.core.invoke=original;
  });
  assert.equal(await page.evaluate(() => documents.has('a') && !transitionLocked && !recoveryWriter.state('a').retired),true,'failed transfer retains source ownership and recovery');
  await page.evaluate(async () => {
   current.path='/tmp/test.md';
   const original=window.__TAURI__.core.invoke; window.saveAttempts=0;
   window.__TAURI__.core.invoke=(cmd,args)=> { if(cmd==='save_document') { ++window.saveAttempts; return Promise.reject({code:'file_changed',message:'changed externally'}); } return original(cmd,args); };
   editor.replaceContent('conflict'); window.restoreSaveInvoke=()=>{window.__TAURI__.core.invoke=original;};
  });
  await page.waitForFunction(()=>current.autoSavePaused===true);
  assert.equal(await page.locator('#confirm-dialog').evaluate(n=>n.open),false,'automatic conflicts never open a dialog');
  await page.evaluate(()=>editor.replaceContent('later conflict'));await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(()=>window.saveAttempts),1,'conflict pauses later automatic writes');
  await page.evaluate(async()=>{window.restoreSaveInvoke();await requestSave();current.path=null;editor.replaceContent('unnamed\n');});
  const moved = await page.evaluate(async () => {
   const original = window.__TAURI__.core.invoke;
   window.__TAURI__.core.invoke = async (cmd, args) => { if (cmd === 'new_window') { window.transferSession = args.session; return 'workspace-other'; } return original(cmd,args); };
   await moveDocumentToNewWindow(); return {present:documents.has('a'), snapshot:window.transferSession, retired:recoveryWriter.state('a').retired};
  });
  assert.equal(moved.present, false); assert.equal(moved.snapshot.content, 'unnamed\n'); assert.equal(moved.retired,true);
  assert.deepEqual(s.errors, []);
  console.log('reading companion, autosave and window transfer passed');
 } finally { await s.close(); }
 const destination = await openEditor('ignored', {width:1180,height:900}, {defaultMode:true,bootstrap:{windowLabel:'workspace-destination',paths:[],platform:'linux',theme:null,pendingTransfer:{token:'transfer-token',document:{documentId:'transferred',active:true,path:null,name:'Moved.md',content:'moved source',saved:'',writable:true,revision:4,view:{mode:'source',readOnly:true,find:'moved',findOpen:true,findIndex:0,editor:{content:'moved source',history:[],future:[],selection:{anchor:3,head:3},sourceOnly:true,locked:true}}}}}});
 try {
  assert.deepEqual(await destination.page.evaluate(()=>({id:current.documentId,mode:documentMode,locked:documentReadOnly,caret:$('document-source').selectionStart})),{id:'transferred',mode:'source',locked:true,caret:3});
  assert.equal(await destination.page.locator('#find-bar').isVisible(),true,'transfer restores open find view');
  assert.equal(await destination.page.locator('#find-input').inputValue(),'moved');
  assert.equal(await destination.page.evaluate(()=>calls.some(c=>c.command==='activate_document')),false);
  assert.equal(await destination.page.evaluate(()=>calls.some(c=>c.command==='recovery_list')),false);
  assert.equal(await destination.page.evaluate(()=>calls.some(c=>c.command==='finish_window_transfer'&&c.args.token==='transfer-token')),true);
  assert.deepEqual(destination.errors,[]);
 } finally {await destination.close();}
})().catch(e => {console.error(e);process.exitCode=1;});
