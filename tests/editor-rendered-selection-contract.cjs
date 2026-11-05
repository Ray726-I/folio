const { openMarkdown } = require('./editor-test-actions.cjs');
const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async()=>{
 const source = '## Start\n\n> Quoted **bold** text.\n\n```mermaid\ngraph TD;\nA-->B;\n```\n\n$$\nE=mc^2\n$$\n\n- First\n- Second\n\n## End\n';
 const session = await openEditor(source);
 try {
  const {page}=session;
  await page.locator('.mermaid-host svg').waitFor();
  await page.locator('.math-block .katex-html').waitFor();
  await page.locator('.mermaid-host svg').click();
  assert.equal(await page.locator('.folio-source-edit').count(),0,'single click keeps diagram rendered');
  await openMarkdown(page.locator('.mermaid-host svg'));
  assert.equal(await page.locator('.folio-source-edit').count(),1,'context menu reveals diagram Markdown');
  await page.keyboard.press('Escape');
  await openMarkdown(page.locator('blockquote'));
  assert.equal(await page.locator('.folio-source-edit').textContent(),'> Quoted **bold** text.');
  await page.keyboard.press('Escape');
  for (const selector of ['.math-block', 'ul']) {
   await openMarkdown(page.locator(selector));
   assert.equal(await page.locator('.folio-source-edit').count(), 1, selector + ' reveals Markdown from the context menu');
   await page.keyboard.press('Escape');
   assert.equal(await page.evaluate(()=>current.content), source);
  }
  const copy = await page.evaluate(()=>{
   const headings=document.querySelectorAll('.ProseMirror h2');
   const range=document.createRange();range.setStart(headings[0].firstChild,0);range.setEnd(headings[1].firstChild,headings[1].firstChild.length);
   window.getSelection().removeAllRanges();window.getSelection().addRange(range);
   document.dispatchEvent(new Event('selectionchange'));
   const data=new DataTransfer();document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}));
   return {text:data.getData('text/plain'),html:data.getData('text/html'),diagramSelected:document.querySelector('.mermaid-host').classList.contains('folio-rendered-selected'),sourceShown:!!document.querySelector('.folio-source-edit')};
  });
  assert.equal(copy.text,source,'copy returns complete original Markdown including diagram and formula fences');
  assert.equal(copy.diagramSelected,true,'rendered diagram has a selection indicator');
  assert.equal(copy.sourceShown,false,'selecting rendered diagram never opens Markdown');
  assert.equal(await page.evaluate(()=>current.content),source,'all selection and view changes are zero-write');
  await page.locator('.math-block .math-formula').click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.folio-source-edit').count(), 0, 'formula single click keeps rendered view');
  assert.equal(await page.evaluate(()=>current.content), source);
  await page.evaluate(markdown => {
   editor.replaceContent(''); editor.focus(); editor.selectRange(0,0,true);
   const data=new DataTransfer();data.setData('text/plain',markdown);
   document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
  },copy.text);
  assert.equal(await page.evaluate(()=>current.content),source,'pasting copied Markdown preserves fences and formatting exactly');
  assert.deepEqual(session.errors,[]);
 }finally{await session.close();}
 console.log('PASS: context-menu editing, rendered diagram selection, exact Markdown copy and zero-write view changes');
})().catch(e=>{console.error(e);process.exitCode=1;});
