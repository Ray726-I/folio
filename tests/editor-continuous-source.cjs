const { openMarkdown } = require('./editor-test-actions.cjs');
const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
 for (const fixture of [
  ['# Title\n\nBody below.\n', 'h1'],
  ['[Title](https://example.com)\n\nBody below.\n', 'a'],
  ['```js\nlet x = 1;\n```\n\nBody below.\n', '.code-container'],
  ['$x+1$\n\nBody below.\n', '.math-formula'],
  ['![Title](local.png)\n\nBody below.\n', '.image-widget'],
  ['---\ntitle: Example\n---\n\nBody below.\n', '.extension-preview'],
  ['Press <kbd>Use</kbd>.\n\nBody below.\n', '.html-inline'],
 ]) {
  const [source, selector] = fixture;
  console.log('Checking', selector);
  const session = await openEditor(source);
  try {
   const { page } = session;
   await openMarkdown(page.locator('#preview ' + selector).first());
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
  assert.equal(await page.locator('.folio-source-edit').count(), 0, 'a single click keeps the heading rendered');
  const renderedPoints = await page.evaluate(() => {
   const heading = document.querySelector('#preview h1').firstChild;
   const body = document.querySelector('.ProseMirror > p').firstChild;
   const range = document.createRange();
   range.setStart(heading, 0); range.collapse(true); const a = range.getBoundingClientRect();
   range.setStart(body, body.length); range.collapse(true); const b = range.getBoundingClientRect();
   return { a: { x:a.x, y:a.y+a.height/2 }, b: { x:b.x, y:b.y+b.height/2 } };
  });
  await page.mouse.move(renderedPoints.a.x, renderedPoints.a.y); await page.mouse.down();
  await page.mouse.move(renderedPoints.b.x, renderedPoints.b.y, {steps:15}); await page.mouse.up();
  assert.match(await page.evaluate(() => window.getSelection().toString()), /Title[\s\S]*Body below/, 'selection crosses a rendered heading');
  assert.equal(await page.locator('.folio-source-edit').count(), 0, 'dragging keeps the heading rendered');
  await openMarkdown(page.locator('#preview h1'));
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
  await page.locator('.folio-source-edit code').click();
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
