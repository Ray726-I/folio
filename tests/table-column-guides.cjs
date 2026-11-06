const assert = require('node:assert/strict');
const {openEditor} = require('./editor-browser.cjs');
(async()=>{
 const source='Before\n\n| A | B | C |\n| --- | --- | --- |\n| one | two | three |\n\nAfter\n';
 const s=await openEditor(source);
 try {const {page}=s, table=page.locator('#preview table'), cell=table.locator('td').nth(1);
  await page.mouse.move(0,0);await page.locator('#preview p').first().click();
  const border=()=>cell.evaluate(el=>getComputedStyle(el).boxShadow);
  assert.equal(await border(),'none','column guides are hidden at rest');
  await cell.hover();await page.waitForTimeout(1200);assert.equal(await border(),'none','hover does not reveal guides');
  await page.mouse.move(0,0);
  await cell.click();await page.mouse.move(0,0);assert.notEqual(await border(),'none','caret in table reveals guides');
  await page.keyboard.type('x'); await page.keyboard.press('Control+z'); await page.waitForFunction(source=>current.content===source,source);
  await page.locator('#preview p').first().click();await page.waitForFunction(()=>getComputedStyle(document.querySelector('#preview td:nth-child(2)')).boxShadow==='none');
  assert.equal(await page.evaluate(()=>current.content),source,'guides never change Markdown');
  assert.deepEqual(s.errors,[]);console.log('PASS: table caret alone reveals column guides without editing content');
 }finally{await s.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
