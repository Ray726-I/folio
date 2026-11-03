const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
 for (const fixture of [
  ['# Title\n\nBody below.\n', 'h1', 'click'],
  ['[Title](https://example.com)\n\nBody below.\n', 'a', 'dblclick'],
  ['```js\nlet x = 1;\n```\n\nBody below.\n', '.code-container', 'dblclick'],
  ['$x+1$\n\nBody below.\n', '.math-formula', 'dblclick'],
  ['![Title](local.png)\n\nBody below.\n', '.image-widget', 'dblclick'],
  ['---\ntitle: Example\n---\n\nBody below.\n', '.extension-edit', 'click'],
  ['Press <kbd>Use</kbd>.\n\nBody below.\n', '.html-inline', 'dblclick'],
 ]) {
  const [source, selector, gesture] = fixture;
  console.log('Checking', selector);
  const session = await openEditor(source);
  try {
   const { page } = session;
   if (selector === '.extension-edit') await page.locator('#preview ' + selector).first().evaluate(button => button.click());
   else await page.locator('#preview ' + selector).first()[gesture]({ timeout: 5000 });
   assert.equal(await page.locator('.folio-source-edit').count(), 1, selector + ' source is document content');
   assert.equal(await page.locator('.folio-source-edit input,.folio-source-edit textarea').count(), 0);
   assert.equal(await page.evaluate(() => current.content), source, 'opening is zero-write');
   await page.keyboard.press('Home');
   await page.keyboard.press('Control+Shift+End');
   assert.match(await page.evaluate(() => window.getSelection().toString()), /Body below/, selector + ' selection crosses into body');
   assert.equal(await page.evaluate(() => current.content), source);
   assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
 }
 const session = await openEditor('# Title\n\nBody below.\n');
 try {
  const { page } = session;
  await page.locator('#preview h1').click();
  const points = await page.evaluate(() => {
   const point = (element, end) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode(); const range = document.createRange();
    range.setStart(node, end ? node.length : 0); range.collapse(true);
    const r = range.getBoundingClientRect(); return { x:r.x, y:r.y+r.height/2 };
   };
   return { a:point(document.querySelector('.folio-source-edit'), false), b:point(document.querySelector('.ProseMirror > p'), true) };
  });
  await page.mouse.move(points.a.x, points.a.y); await page.mouse.down();
  await page.mouse.move(points.b.x, points.b.y, {steps:15}); await page.mouse.up();
  assert.match(await page.evaluate(() => window.getSelection().toString()), /Title[\s\S]*Body below/, 'mouse selection spans source and body');
  await page.keyboard.press('ArrowLeft');
  await page.locator('.folio-source-edit').click();
  await page.keyboard.press('End'); await page.keyboard.type(' edited');
  assert.equal(await page.evaluate(() => current.content), '# Title edited\n\nBody below.\n');
  await page.keyboard.press('Backspace');
  assert.equal(await page.evaluate(() => current.content), '# Title edite\n\nBody below.\n');
  await page.keyboard.press('Control+z');
  assert.ok((await page.evaluate(() => current.content)).includes('Title'));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.folio-source-edit').count(), 0);
  assert.equal(await page.locator('#preview h1').count(), 1);
  assert.deepEqual(session.errors, []);
 } finally { await session.close(); }
 console.log('PASS: source editing shares document selection across headings, links, code, formulas and HTML');
})().catch(e => { console.error(e); process.exitCode = 1; });
