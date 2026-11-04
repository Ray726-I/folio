const assert=require('node:assert/strict');
const {openEditor}=require('./editor-browser.cjs');
(async()=>{
 const source='Before.\n\n$$\nE=mc^2\n$$\n\nAfter.\n';
 const s=await openEditor(source);
 try{const {page}=s;
 await page.locator('.math-block .katex-html').waitFor();
 await page.locator('.math-block').click();
 assert.equal(await page.locator('.math-block.ProseMirror-selectednode').count(),0,'plain formula click must not select its atom');
 await page.locator('#reader-scroll').click({position:{x:5,y:5}});
 assert.equal(await page.locator('.math-block.folio-rendered-selected').count(),0,'outside click clears formula paint');
 await page.locator('.math-block').click({modifiers:['Control']});
 assert.equal(await page.locator('.math-block.ProseMirror-selectednode').count(),1,'explicit modified click can still select a formula node');
 await page.locator('#view-menu-button').click();
 assert.equal(await page.locator('.math-block.ProseMirror-selectednode').count(),0,'outside control clears a stored formula node selection');
 assert.equal(await page.locator('.math-block.folio-rendered-selected').count(),0);
 await page.locator('#preferences-close').click();
 await page.locator('#view-menu').waitFor({state:'hidden'});
 await page.locator('.math-block .math-formula').dblclick();await page.locator('.folio-source-edit').waitFor();
 await page.keyboard.press('Escape');
 await page.evaluate(()=>{const p=document.querySelectorAll('.ProseMirror > p');const r=document.createRange();r.setStart(p[0].firstChild,0);r.setEnd(p[1].firstChild,p[1].firstChild.length);window.getSelection().removeAllRanges();window.getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));});
 assert.equal(await page.locator('.math-block.folio-rendered-selected').count(),1,'spanning selection still includes formula');
 await page.locator('#reader-scroll').click({position:{x:5,y:5}});
 await page.waitForFunction(()=>!document.querySelector('.math-block.folio-rendered-selected'));
 assert.equal(await page.evaluate(()=>current.content),source);assert.deepEqual(s.errors,[]);
 }finally{await s.close();}
 console.log('PASS: formula clicks do not create sticky selection; double-click editing and range selections work');
})().catch(e=>{console.error(e);process.exitCode=1;});
