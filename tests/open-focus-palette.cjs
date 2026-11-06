const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async()=>{
 const s=await openEditor('# Heading\n\nDocument text.\n\nAnother paragraph.\n',undefined,{defaultMode:true});
 const {page}=s;
 try {
  assert.equal(await page.evaluate(()=>document.getElementById('preview').contains(document.activeElement)),false,'opening does not put a caret in the editor');
  assert.equal(await page.locator('.folio-heading-source').isVisible(),false,'idle document shows rendered heading');
  assert.equal(await page.locator('#preview h1').innerText(),'Heading');
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#command-search').getAttribute('aria-activedescendant'),'command-1');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.locator('#command-search').getAttribute('aria-activedescendant'),'command-0');
  await page.locator('#command-1').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#command-search').getAttribute('aria-activedescendant'),'command-2','arrows work with a result focused too');
  await page.locator('#command-search').fill('change theme');
  await page.keyboard.press('Enter');
  await page.locator('#command-search').fill('Nord');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>selectedTheme==='nord');
  assert.equal(await page.locator('#command-dialog').evaluate(el=>el.open),false);
  await page.evaluate(()=>requestOpen('/tmp/another.md'));
  assert.equal(await page.evaluate(()=>document.getElementById('preview').contains(document.activeElement)),false,'replacement documents also avoid editor autofocus');
  const points = await page.locator('#preview p').evaluateAll(elements => {
    const first = document.createRange(), last = document.createRange();
    first.setStart(elements[0].firstChild, 0); first.setEnd(elements[0].firstChild, 1);
    last.setStart(elements[1].firstChild, 6); last.setEnd(elements[1].firstChild, 7);
    const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
    return { x1: a.left, y1: a.top + a.height / 2, x2: b.right, y2: b.top + b.height / 2 };
  });
  await page.mouse.move(points.x1, points.y1); await page.mouse.down();
  await page.mouse.move(points.x2, points.y2, { steps: 12 }); await page.mouse.up();
  assert.match(await page.evaluate(()=>window.getSelection().toString()), /Document text[\s\S]*Another/, 'drag selection works without initial editor focus');
  await page.locator('#preview p').first().click();
  await page.keyboard.press('End');await page.keyboard.type(' Edited');
  assert.match(await page.evaluate(()=>current.content),/ Edited/,'click still starts normal editing');
  assert.deepEqual(s.errors,[]);
  console.log('PASS: unfocused document opens, rendered idle headings, palette arrows and Enter, click-to-edit');
 }finally{await s.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
