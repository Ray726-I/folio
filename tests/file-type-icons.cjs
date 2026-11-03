const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async()=>{
 const session=await openEditor('# Notes\n\nText.\n',{width:1100,height:760});
 try{
  const {page}=session;
  const folder='/tmp/folio-icons';
  const listing={path:folder,name:'Project notes',entries:[
   {path:folder+'/research',name:'research',directory:true,depth:0},
   {path:folder+'/research/design.md',name:'design.md',directory:false,depth:1},
   {path:folder+'/README.md',name:'README.md',directory:false,depth:0},
   {path:folder+'/Meeting.MARKDOWN',name:'Meeting.MARKDOWN',directory:false,depth:0},
   {path:folder+'/notes.txt',name:'notes.txt',directory:false,depth:0},
   {path:'/tmp/test.md',name:'test.md',directory:false,depth:0}
  ],truncated:false,skipped:0};
  await session.holdFolder(folder,listing);
  await page.evaluate(path=>{window.folderOpen=openFolderPath(path);},folder);
  await page.waitForFunction(path=>folderGateState(path)?.pending,folder);
  await session.releaseFolder(folder);await page.evaluate(()=>window.folderOpen);
  const dir=page.locator('.folder-entry.directory');
  assert.equal(await dir.locator('.tree-folder use').getAttribute('href'),'#i-folder');
  await dir.click();
  assert.equal(await dir.locator('.tree-folder use').getAttribute('href'),'#i-folder-open');
  for(const name of ['README.md','Meeting.MARKDOWN','design.md']) {
   assert.equal(await page.locator('.folder-entry').filter({hasText:name}).locator('.tree-file use').getAttribute('href'),'#i-markdown');
  }
  assert.equal(await page.locator('.folder-entry').filter({hasText:'notes.txt'}).locator('.tree-file use').getAttribute('href'),'#i-file','future file types retain generic identity');
  assert.equal(await page.locator('.document-emblem use').getAttribute('href'),'#i-folder','folder-only header uses folder identity');
  await page.locator('.folder-entry').filter({hasText:'README.md'}).click();
  await page.waitForFunction(path=>current.path===path,folder+'/README.md');
  assert.equal(await page.locator('.document-emblem use').getAttribute('href'),'#i-markdown');
  const files=page.locator('[data-dock-tab="files"]');
  if(await files.getAttribute('aria-pressed')!=='true') await files.click();
  for(const theme of ['paper','graphite']) {
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   await page.locator('#file-browser').screenshot({path:`/tmp/folio-file-icons-${theme}.png`});
  }
  assert.deepEqual(session.errors,[]);
 }finally{await session.close();}
 console.log('PASS: distinct folder states, Markdown file identities and generic fallback across explorer/header');
})().catch(e=>{console.error(e);process.exitCode=1;});
