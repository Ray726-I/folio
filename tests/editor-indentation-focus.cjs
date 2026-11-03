const assert=require('node:assert/strict');
const {openEditor}=require('./editor-browser.cjs');
(async()=>{
 const source='# Above\n\n```js\nfunction run() {\nreturn 1;\n}\n```\n\nBelow.\n';
 const session=await openEditor(source);
 try{
  const {page}=session;
  const at=source.indexOf('return');
  await page.evaluate(at=>{editor.selectRange(at,at,true);editor.focus();},at);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>current.content),source.replace('return','    return'),'Tab indents code instead of navigating to another control');
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('ProseMirror')),true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(()=>current.content),source,'Shift-Tab removes indentation');
  await page.locator('.code-container').dblclick();
  await page.evaluate(at=>{editor.selectRange(at,at,true);editor.focus();},at);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>current.content),source.replace('return','    return'),'Tab works inside shared Markdown source too');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(()=>current.content),source);
  await page.evaluate(([a,b])=>{editor.selectRange(a,b,true);editor.focus();},[source.indexOf('function'),source.indexOf('}')+1]);
  await page.keyboard.press('Tab');
  const indented=source.replace('function','    function').replace('return','    return').replace('\n}', '\n    }');
  assert.equal(await page.evaluate(()=>current.content),indented,'multi-line indent preserves code fences');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(()=>current.content),source,'multi-line outdent restores the source');
  await page.keyboard.press('Shift');
  await page.locator('#reader-scroll').focus();
  assert.equal(await page.locator('#reader-scroll').evaluate(node=>getComputedStyle(node).outlineStyle),'none','document scroller never has the large focus outline');
  await page.locator('#document-mode-button').focus();
  assert.notEqual(await page.locator('#document-mode-button').evaluate(node=>getComputedStyle(node).outlineStyle),'none','keyboard focus on controls remains visible');
  assert.deepEqual(session.errors,[]);
 }finally{await session.close();}
 console.log('PASS: code/source indentation stays in the editor and document focus has no frame');
})().catch(e=>{console.error(e);process.exitCode=1;});
