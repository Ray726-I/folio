const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
 const source = '# Demo\n\n$$\na^2+b^2=c^2\n$$\n\n| First | Second |\n| --- | --- |\n| One | Two |\n';
 const session = await openEditor(source);
 try {
  const {page}=session;
  for (const [selector, kind, text] of [['.math-block','math','a'], ['.tableWrapper','table','First']]) {
   const host=page.locator(`#preview ${selector}`).first();
   if (kind === 'math') await host.locator('.katex-html').waitFor();
   const action=host.getByRole('button',{name:`Expand ${kind}`});
   await action.waitFor({timeout:5000});
   assert.equal(await action.evaluate(el=>getComputedStyle(el).opacity),'0');
   await host.hover(); assert.equal(await action.evaluate(el=>getComputedStyle(el).opacity),kind === 'table' ? '0' : '1');
   if (kind === 'table') { await action.hover(); assert.equal(await action.evaluate(el=>getComputedStyle(el).opacity),'1'); }
   await action.focus(); await page.keyboard.press('Enter');
   const dialog=page.getByRole('dialog',{name:`Expanded ${kind}`}); await dialog.waitFor();
   if (kind === 'math') {
    assert.ok(parseInt(await dialog.locator('.diagram-viewer-zoom').textContent()) >= 150, 'math opens enlarged');
    const dimensions = await dialog.locator('.diagram-viewer-viewport').evaluate(el => ({ client:el.clientWidth, scroll:el.scrollWidth }));
    assert.ok(dimensions.scroll <= dimensions.client + 1, `a short equation must not overflow: ${JSON.stringify(dimensions)}`);
    const styling = await dialog.locator('.diagram-viewer-scaled').evaluate(el => ({transform:getComputedStyle(el).transform, overflow:getComputedStyle(el.querySelector('.katex-display')).overflowX}));
    assert.equal(styling.transform, 'none', 'math is enlarged without scaling a rendered layer');
    assert.equal(styling.overflow, 'visible', 'math does not have a nested horizontal scrollbar');
   }
   assert.ok((await dialog.locator('.diagram-viewer-canvas').innerText()).includes(text), `${kind} is rendered`);
   const fontBefore = kind === 'math' ? await dialog.locator('.katex-html').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)) : 0;
   await dialog.getByRole('button',{name:'Zoom in'}).click();
   if (kind === 'math') assert.ok(await dialog.locator('.katex-html').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)) > fontBefore, 'zoom increases the actual formula font size');
   await dialog.getByRole('button',{name:`Fit ${kind}`}).click();
   await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
   assert.equal(await action.evaluate(el=>document.activeElement===el),true,'focus returns to control');
   assert.equal(await page.evaluate(()=>current.content),source,'viewer leaves document unchanged');
  }
  const table = page.locator('#preview .tableWrapper').first();
  await table.hover(); await table.getByRole('button',{name:'Expand table'}).click();
  const tableDialog = page.getByRole('dialog',{name:'Expanded table'}); await tableDialog.waitFor();
  await tableDialog.getByRole('button',{name:'Close table'}).click(); await tableDialog.waitFor({state:'hidden'});
  await page.locator('#preview td').first().click(); await page.keyboard.press('End'); await page.keyboard.type('!');
  assert.match(await page.evaluate(()=>current.content), /One!/,'table remains editable after expansion');
  assert.deepEqual(session.errors,[]);
  console.log('PASS: math and table expansion preserves editor content and supports zoom and keyboard');
 } finally {await session.close();}
 const wideSource = '| Process | Arrival time | CPU burst | Priority | Waiting time | Turnaround time | Response time | Explanation |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| P1 | 0 ms | 12 ms | 2 | 8 ms | 20 ms | 0 ms | A long explanation checks horizontal scrolling in narrow windows |\n';
 const wideSession=await openEditor(wideSource, {width:1500,height:800});
 try {
  const {page}=wideSession;
  await page.getByRole('button',{name:'Expand table'}).click();
  const dialog=page.getByRole('dialog',{name:'Expanded table'}); await dialog.waitFor();
  const sizes=await dialog.locator('table').evaluate(table=>({display:getComputedStyle(table).display, scroll:table.scrollWidth, client:table.clientWidth, width:table.getBoundingClientRect().width, viewport:table.closest('.diagram-viewer-viewport').clientWidth}));
  assert.equal(sizes.display, 'table', 'expanded table uses a real table layout');
  assert.ok(sizes.scroll <= sizes.client+1, `the expanded table has no internal scrollbar: ${JSON.stringify(sizes)}`);
  assert.ok(sizes.width > sizes.viewport*.8, `the table makes use of the expanded view: ${JSON.stringify(sizes)}`);
  assert.ok(await dialog.locator('.diagram-viewer-viewport').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'a table that fits does not scroll horizontally');
  assert.equal(await dialog.locator('th').last().innerText(), 'Explanation', 'the final column is visible');
 } finally {await wideSession.close();}
 const tallSource = '| Name | Value |\n| --- | --- |\n' + Array.from({length:60},(_,index)=>`| Row ${index} | Value |\n`).join('');
 const tallSession=await openEditor(tallSource, {width:1100,height:700});
 try {
  const {page}=tallSession; await page.getByRole('button',{name:'Expand table'}).click();
  const dialog=page.getByRole('dialog',{name:'Expanded table'}); await dialog.waitFor();
  assert.equal(await dialog.locator('.diagram-viewer-zoom').textContent(), '100%', 'tall tables remain readable');
  assert.ok(await dialog.locator('.diagram-viewer-viewport').evaluate(el=>el.scrollHeight>el.clientHeight), 'tall tables scroll vertically');
 } finally {await tallSession.close();}
 const longSession=await openEditor(`$$\n${'x+'.repeat(120)}x\n$$\n`);
 try {
  const {page}=longSession;
  await page.locator('#preview .katex-html').waitFor();
  await page.getByRole('button',{name:'Expand math'}).click();
  const dialog=page.getByRole('dialog',{name:'Expanded math'}); await dialog.waitFor();
  await dialog.getByRole('button',{name:'Actual size'}).click();
  assert.ok(await dialog.locator('.diagram-viewer-viewport').evaluate(el=>el.scrollWidth>el.clientWidth),'long equations can be scrolled at actual size');
  assert.equal(await dialog.locator('.katex-html').count(),1);
  assert.equal(await dialog.locator('.katex-display').evaluate(el=>getComputedStyle(el).overflowX), 'visible', 'long equations scroll in the viewer, not inside the formula');
 } finally {await longSession.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
