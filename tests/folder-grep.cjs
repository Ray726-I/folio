const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
 const source = '# Note\n\nNeedle first\nNeedle second\n';
 const session = await openEditor(source);
 const {page} = session;
 try {
  await page.evaluate(async fingerprint => {
   await openFolderPath('/tmp/notes', true); await openPath('/tmp/notes/a.md');
   const base = window.__TAURI__.core.invoke;
   window.grepCalls = 0;
   window.__TAURI__.core.invoke = (command,args) => {
    if(command !== 'search_folder') return base(command,args);
    window.grepCalls++; window.lastGrepArgs=args;
    return Promise.resolve({results:[{path:'/tmp/notes/b.md',name:'b.md',line:3,offset:8,length:12,snippet:'Needle first',fingerprint},{path:'/tmp/notes/b.md',name:'b.md',line:4,offset:21,length:13,snippet:'Needle second',fingerprint}],truncated:false});
   };
  }, createHash('sha256').update(source).digest('hex'));
  await page.keyboard.press('Control+f');
  await page.locator('#find-input').fill('Needle');
  assert.equal(await page.locator('#find-result').textContent(),'1 / 2');
  assert.equal(await page.evaluate(()=>grepCalls),0,'Ctrl+F searches only the open document');
  await page.keyboard.press('Control+Shift+f');
  assert.equal(await page.locator('#folder-search').isVisible(),true);
  assert.equal(await page.locator('#file-browser').isHidden(),true);
  assert.equal(await page.locator('#outline').isHidden(),true);
  await page.locator('#folder-search-input').fill('Needle in:*.md -in:archive/*');
  await page.waitForFunction(()=>window.lastGrepArgs?.query==='Needle' && window.lastGrepArgs.include==='*.md' && window.lastGrepArgs.exclude==='archive/*');
  await page.locator('#folder-search-results .grep-match').first().waitFor();
  await page.locator('#folder-search-input').fill('Needle');
  await page.locator('#folder-search-results .grep-match').nth(1).waitFor();
  await page.locator('#folder-search-results .grep-match').nth(1).click();
  await page.waitForFunction(()=>current.path==='/tmp/notes/b.md'&&!busy);
  assert.equal(await page.locator('#folder-search').isVisible(),true,'results remain available after opening a match');
  assert.equal(await page.evaluate(()=>editor.getSelection().anchor),21,'match jumps to the matching source line');
  await page.evaluate(() => editor.replaceContent('PREFIX PREFIX PREFIX\n' + current.content));
  await page.locator('#folder-search-results .grep-match').nth(1).click();
  await page.waitForFunction(()=>document.getElementById('folder-search-status').textContent.startsWith('Results refreshed'));
  await page.locator('#folder-search-results .grep-match').nth(1).click();
  assert.equal(await page.evaluate(()=>editor.getSelection().anchor),42,'refreshed hits navigate the live unsaved buffer');
  assert.match(await page.evaluate(()=>current.content), /^PREFIX PREFIX PREFIX/);
  assert.deepEqual(await page.evaluate(()=>foldedSearchSpan('İ needle','needle')), {from:2,to:8});
  await page.evaluate(() => editor.undo());
  // Folder search is a literal case-insensitive search. Its result navigation
  // must not inherit the document find bar's case-sensitive option.
  await page.locator('#find-case').click();
  await page.locator('#folder-search-input').fill('needle');
  await page.locator('#folder-search-results .grep-match').first().waitFor();
  await page.locator('#folder-search-results .grep-match').first().click();
  await page.waitForFunction(()=>editor.getSelection().anchor===8);
  assert.equal(await page.evaluate(()=>editor.getSelection().anchor),8,'folder hits navigate case-insensitively even when document Find matches case');
  await page.locator('#find-case').click();
  await page.evaluate(() => {
   window.oldSearchPending = false;
   window.baseGrepInvoke = window.__TAURI__.core.invoke;
   window.__TAURI__.core.invoke = (command,args) => {
    if (command !== 'search_folder') return window.baseGrepInvoke(command,args);
    if (args.query === 'old') { window.oldSearchPending = true; return new Promise(resolve => { window.releaseOldSearch = () => resolve({results:[{path:'/tmp/notes/stale.md',name:'stale.md',line:1,snippet:'old'}]}); }); }
    return Promise.resolve({results:[],truncated:false});
   };
  });
  await page.locator('#folder-search-input').fill('old');
  await page.waitForFunction(()=>oldSearchPending);
  await page.locator('#folder-search-input').fill('new');
  await page.waitForFunction(()=>document.getElementById('folder-search-status').textContent.startsWith('0 matching'));
  await page.evaluate(async()=>{ releaseOldSearch(); await Promise.resolve(); });
  assert.equal(await page.locator('#folder-search-results .grep-match').count(),0,'late replies cannot restore stale results');
  await page.getByRole('button',{name:'Files',exact:true}).click();
  assert.equal(await page.locator('#folder-search').isHidden(),true);
  assert.equal(await page.locator('#file-browser').isVisible(),true);
  await page.evaluate(()=>goHome());
  await page.evaluate(()=>requestOpen('/tmp/test.md'));
  await page.keyboard.press('Control+Shift+f');
  assert.equal(await page.locator('#find-bar').isVisible(),true,'without a folder the shortcut falls back to document Find');
  assert.equal(await page.locator('#folder-search').isHidden(),true);
  await page.evaluate(()=>goHome());
  await page.waitForFunction(()=>!$('welcome').hidden&&!busy);
  await page.evaluate(()=>{activeFolder={path:'/tmp/notes',name:'notes'};folderEntries=[];});
  await page.keyboard.press('Control+Shift+f');
  await page.waitForFunction(()=>!$('folder-search').hidden);
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'folder-search-input','folder search opens the folder surface from Home');
  assert.deepEqual(session.errors,[]);
  console.log('PASS: dedicated content-search sidebar, independent Ctrl+F, match navigation and no-folder fallback');
 }finally{await session.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
