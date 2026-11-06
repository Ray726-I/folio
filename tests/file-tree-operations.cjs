const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
 const s = await openEditor('initial\n');
 try {
  const { page } = s;
  await page.evaluate(async () => {
   const original = window.__TAURI__.core.invoke; let serial = 0;
   window.treeEntries = [
    { path:'/work/a.md', name:'a.md', directory:false, depth:0 },
    { path:'/work/b.md', name:'b.md', directory:false, depth:0 },
    { path:'/work/notes', name:'notes', directory:true, depth:0 },
    { path:'/work/notes/c.md', name:'c.md', directory:false, depth:1 }
   ];
   window.operationCalls = [];
   window.__TAURI__.core.invoke = async (cmd, args = {}) => {
    if (cmd === 'open_folder') return { path:'/work', name:'work', entries:treeEntries.map(e => ({...e})) };
    if (cmd === 'open_document') return { documentId:`tree-${++serial}`, path:args.path, name:args.path.split('/').pop(), content:`disk ${args.path}\n`, writable:true };
    if (cmd === 'file_operation') {
     operationCalls.push(args);
     if (window.failOperation) throw new Error(window.failOperation);
     if (window.holdOperation) await new Promise(resolve => window.releaseOperation = resolve);
     const oldPath = args.path, directory = treeEntries.find(e => e.path === oldPath)?.directory || args.action === 'new-folder';
     if (args.action === 'trash') treeEntries = treeEntries.filter(e => e.path !== oldPath && !e.path.startsWith(oldPath + '/'));
     else if (args.action === 'move' || args.action === 'rename') treeEntries = treeEntries.map(e => e.path === oldPath || e.path.startsWith(oldPath + '/') ? {...e, path:args.destination + e.path.slice(oldPath.length), name:e.path === oldPath ? args.destination.split('/').pop() : e.name} : e);
     else { const path = args.destination || (args.action === 'duplicate' ? oldPath.replace('.md',' copy.md') : oldPath); treeEntries.push({path, name:path.split('/').pop(), directory, depth:0}); }
     const path = args.action === 'trash' ? null : args.destination || (args.action === 'duplicate' ? oldPath.replace('.md',' copy.md') : oldPath);
     const affected = [...documents.values()].filter(d => d.path === oldPath || directory && d.path?.startsWith(oldPath + '/'));
     return { path, oldPath, directory, documents:['rename','move','trash'].includes(args.action) ? affected.map(d => ({documentId:d.documentId,path:path && path + d.path.slice(oldPath.length),name:path ? (path + d.path.slice(oldPath.length)).split('/').pop() : d.name})) : [] };
    }
    if (/^(activate_document|close_document|recovery_|reveal_path)/.test(cmd)) { calls.push({command:cmd,args}); return cmd === 'recovery_list' ? [] : null; }
    return original(cmd,args);
   };
   await requestOpen('/work/a.md'); await openFolderPath('/work');
  });
  const row = path => page.locator(`.folder-entry[data-path="${path}"]`);
  const menuAction = async (path, label) => { await row(path).click({button:'right'}); await page.locator('#tree-menu').getByRole('menuitem',{name:label,exact:true}).click(); };
  // Context operations belong to the clicked row even while another document is active.
  await row('/work/b.md').click({button:'right'});
  assert.equal(await page.locator('#tree-menu[role=menu]').count(), 1, 'explorer exposes a contextual operations menu');
  await page.locator('#tree-menu').getByRole('menuitem',{name:'Rename',exact:true}).click();
  assert.deepEqual(await page.locator('#tree-name-input').evaluate(e => [e.value,e.selectionStart,e.selectionEnd]), ['b.md',0,1]);
  await page.fill('#tree-name-input','renamed.md');
  await page.evaluate(() => window.failOperation = 'A file with this name already exists');
  await page.keyboard.press('Enter'); await page.waitForSelector('#tree-name-error:not(:empty)');
  assert.equal(await page.inputValue('#tree-name-input'),'renamed.md');
  assert.match(await page.locator('#tree-name-error').innerText(),/already exists/);
  await page.evaluate(() => window.failOperation = null); await page.keyboard.press('Enter');
  await page.waitForSelector('.folder-entry[data-path="/work/renamed.md"]');
  assert.equal(await page.evaluate(() => current.path),'/work/a.md');
  assert.equal(await page.locator('#folder-new use').getAttribute('href'), '#i-plus');
  assert.equal(await page.locator('#folder-new').getAttribute('aria-label'), 'New file or folder');
  await page.click('#folder-new'); await page.locator('#tree-menu').getByRole('menuitem',{name:'New file',exact:true}).click();
  assert.deepEqual(await page.locator('#tree-name-input').evaluate(e => [e.selectionStart,e.selectionEnd]), [0,8], 'new files select the stem');
  await page.fill('#tree-name-input','new note'); await page.keyboard.press('Enter');
  await page.waitForSelector('.folder-entry[data-path="/work/new note.md"]');
  await page.click('#folder-new'); await page.locator('#tree-menu').getByRole('menuitem',{name:'New folder',exact:true}).click();
  await page.fill('#tree-name-input','Arbitrary folder'); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#tree-name-input').count(),0);
  await page.evaluate(() => { editor.replaceContent('unsaved A'); window.originalEditor = editor; });
  await menuAction('/work/a.md','Duplicate');
  await page.waitForFunction(() => operationCalls.at(-1)?.action === 'duplicate');
  assert.equal(await page.evaluate(() => Object.hasOwn(operationCalls.at(-1),'content')),false,'ordinary duplicate copies disk');
  await menuAction('/work/a.md','Duplicate current edits');
  await page.waitForFunction(() => operationCalls.at(-1)?.content === 'unsaved A');
  await menuAction('/work/a.md','Rename'); await page.fill('#tree-name-input','alpha.md'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => current.path === '/work/alpha.md');
  assert.equal(await page.evaluate(() => editor === originalEditor),true,'tree operations retain editor/history');
  assert.equal(await page.evaluate(() => current.content),'unsaved A');
  assert.match(await page.locator('[role=tab][aria-selected=true]').innerText(),/alpha/);
  assert.equal(await page.evaluate(() => preferences.get('recent',[]).includes('/work/a.md')),false,'recent paths follow renamed files');
  await menuAction('/work/alpha.md','Move to…');
  await page.fill('#tree-move-path','/work/notes'); await page.click('#tree-move-confirm');
  await page.waitForFunction(() => current.path === '/work/notes/alpha.md');
  await page.evaluate(async () => { await requestOpen('/work/notes/c.md'); await requestOpen('/work/notes/alpha.md'); });
  await menuAction('/work/notes','Move to Trash');
  await page.waitForSelector('#confirm-dialog[open]');
  await page.getByRole('button',{name:'Keep as unnamed',exact:true}).click();
  await page.waitForFunction(() => $('confirm-title').textContent === 'Move to Trash?');
  await page.evaluate(() => window.failOperation = 'Trash unavailable');
  await page.getByRole('button',{name:'Move to Trash',exact:true}).click();
  await page.waitForFunction(() => !busy);
  assert.equal(await page.evaluate(() => current.path),'/work/notes/alpha.md','failed trash preserves live paths');
  assert.equal(await page.evaluate(() => current.content),'unsaved A');
  assert.equal(await page.evaluate(() => [...documents.values()].some(d => d.path === '/work/notes/c.md')),true,'failed trash keeps clean descendant sessions');
  await page.evaluate(() => { window.failOperation = null; window.holdOperation = true; });
  await menuAction('/work/notes','Move to Trash');
  await page.waitForSelector('#confirm-dialog[open]'); await page.getByRole('button',{name:'Keep as unnamed',exact:true}).click();
  await page.waitForFunction(() => $('confirm-title').textContent === 'Move to Trash?');
  await page.getByRole('button',{name:'Move to Trash',exact:true}).click();
  await page.waitForFunction(() => !!window.releaseOperation);
  assert.equal(await page.evaluate(() => { const before = current.content; editor.replaceContent('late edit'); return current.content === before; }),true);
  assert.equal(await page.evaluate(() => current.path),'/work/notes/alpha.md','session detaches only after trash success');
  await page.evaluate(() => window.releaseOperation()); await page.waitForFunction(() => !busy);
  assert.equal(await page.evaluate(() => current.path),null);
  assert.equal(await page.evaluate(() => current.content),'unsaved A');
  assert.equal(await page.evaluate(() => documents.has(current.documentId)),true);
  assert.equal(await page.evaluate(() => [...documents.values()].some(d => d.name === 'c.md')),false,'clean descendant closes after success without dirty prompts');
  assert.equal(await page.evaluate(() => recoveryWriter.state(current.documentId).retired),false,'kept unnamed work stays recoverable');
  // Cleanup storage failure after successful native trash must still replace the closed tab.
  await page.evaluate(async () => {
   window.holdOperation = false;
   await requestOpen('/work/renamed.md');
   window.trashedCleanId = current.documentId;
   const original = window.__TAURI__.core.invoke;
   window.__TAURI__.core.invoke = (cmd, args) => cmd === 'recovery_discard' && args.documentId === window.trashedCleanId
    ? Promise.reject(new Error('Recovery storage unavailable')) : original(cmd, args);
  });
  await menuAction('/work/renamed.md','Move to Trash');
  await page.waitForSelector('#confirm-dialog[open]');
  await page.getByRole('button',{name:'Move to Trash',exact:true}).click();
  await page.waitForFunction(() => !busy);
  assert.equal(await page.evaluate(() => current.documentId !== trashedCleanId && documents.has(current.documentId)),true,'cleanup failure still replaces native-closed active session');
  assert.equal(await row('/work/renamed.md').count(),0,'cleanup failure still refreshes the tree');
  assert.equal(await page.evaluate(() => editorDocument === current),true,'editor follows the remaining live document');
  assert.match(await page.locator('#recovery-warning').innerText(),/Recovery storage unavailable/);
  // A captured Save As may move a document out of the target before trash commits.
  await page.evaluate(async () => {
   await requestOpen('/work/new note.md');
   window.savedOutsideId = current.documentId;
   editor.replaceContent('preserved outside the workspace');
   const original = window.__TAURI__.core.invoke;
   window.__TAURI__.core.invoke = (cmd, args) => cmd === 'save_document' && args.documentId === window.savedOutsideId
    ? new Promise(resolve => window.releaseOutsideSave = () => resolve({path:'/elsewhere/preserved.md',name:'preserved.md'})) : original(cmd, args);
   void requestSave(true);
  });
  await page.waitForFunction(() => !!window.releaseOutsideSave);
  await menuAction('/work/new note.md','Move to Trash');
  await page.waitForFunction(() => transitionLocked);
  assert.equal(await page.locator('#confirm-dialog').evaluate(d => d.open),false,'trash waits for captured Save As before reviewing affected sessions');
  await page.evaluate(() => window.releaseOutsideSave());
  await page.waitForFunction(() => $('confirm-dialog').open && $('confirm-title').textContent === 'Move to Trash?');
  await page.getByRole('button',{name:'Move to Trash',exact:true}).click();
  await page.waitForFunction(() => !busy);
  assert.deepEqual(await page.evaluate(() => ({live:documents.has(savedOutsideId),id:current.documentId,path:current.path,content:current.content,retired:recoveryWriter.state(savedOutsideId).retired})),
   {live:true,id:await page.evaluate(() => savedOutsideId),path:'/elsewhere/preserved.md',content:'preserved outside the workspace',retired:false},'Save As outside the trashed target stays live with saved provenance');
  assert.equal(await page.evaluate(() => calls.some(c => c.command === 'close_document' && c.args.documentId === savedOutsideId)),false,'native unaffected document is not closed');
  const retainedCursor = await page.evaluate(async () => {
   documentNavigation = ['/work/history-a.md','/work/history-b.md','/work/history-c.md']; documentNavigationIndex = 1;
   await applyTreeResult({oldPath:'/work/history-a.md',path:null,directory:false,documents:[]});
   return {paths:documentNavigation,index:documentNavigationIndex,selected:documentNavigation[documentNavigationIndex]};
  });
  assert.deepEqual(retainedCursor,{paths:['/work/history-b.md','/work/history-c.md'],index:0,selected:'/work/history-b.md'},'removing earlier history retains the current navigation entry');
  assert.deepEqual(s.errors,[]);
  await page.screenshot({path:'/tmp/folio-file-tree-operations.png'});
  console.log('Explorer clicked targets, inline collision/cancel, creation, disk/buffer duplicates, move and guarded trash passed');
 } finally { await s.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
