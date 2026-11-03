const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Copying a reading selection that covers a rendered extension projection must
// yield the rendered text once. ProseMirror's serializer emits the literal
// Markdown for a raw atom, while a DOM range that includes the action row adds
// the "Edit source" button. Both are duplicate representations; neither may
// reach the clipboard.
const source = `# Showcase

Before word here.

Press <kbd>Use</kbd> to run and stop <samp>here.</samp>[^1]

[^1]: note

After word here.
`;
const before = source.indexOf('Before');
const rawStart = source.indexOf('Press');
const rawEnd = source.indexOf('[^1]: note') - 1;

function probe(page) {
  return page.evaluate(() => {
    window.copyProbe = [];
    document.addEventListener('copy', event => {
      window.copyProbe.push(event.clipboardData ? event.clipboardData.getData('text/plain') : null);
    });
  });
}
async function copied(page) {
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(150);
  return page.evaluate(() => window.copyProbe.at(-1));
}
function assertRendered(text, label) {
  assert.ok(text.includes('Press <kbd>Use</kbd>'), `${label} preserves literal Markdown/HTML source`);
  assert.ok(text.includes('[^1]'), `${label} preserves footnote source`);
  assert.ok(!text.includes('Edit source'), `${label} excludes editor controls`);
}

(async () => {
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.waitForFunction(() => document.querySelector('.extension-preview')?.textContent.includes('Use'));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await probe(page);

    // A whole logical range across the raw block (for example from the find
    // bar or a source bookmark) must not serialize stored Markdown.
    await page.evaluate(([from, to]) => editor.selectRange(from, to, true), [before, rawEnd + 1]);
    await page.waitForTimeout(250);
    assertRendered(await copied(page), 'logical range');
    assert.equal(await page.evaluate(() => current.content), source, 'copy never mutates the document');

    // Keyboard expansion can put the ProseMirror head inside the atom while
    // the native DOM range covers only the preceding paragraph.
    const caret = await page.evaluate(() => {
      const paragraph = [...document.querySelectorAll('#preview .ProseMirror > p')].find(node => node.textContent.startsWith('Before'));
      const range = document.createRange();
      range.setStart(paragraph.firstChild, 0); range.setEnd(paragraph.firstChild, 0);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: (rect.top + rect.bottom) / 2 };
    });
    await page.mouse.click(caret.x, caret.y);
    await page.waitForTimeout(200);
    for (let i = 0; i < 80; i++) {
      const head = await page.evaluate(() => editor.getSelection().head);
      if (head >= rawEnd) break;
      await page.keyboard.press('Shift+ArrowRight');
    }
    let selection = await page.evaluate(() => editor.getSelection());
    assert.ok(selection.head >= rawStart && selection.head <= source.indexOf('[^1]: note'),
      `keyboard selection covers the raw projection, got ${JSON.stringify(selection)}`);
    assertRendered(await copied(page), 'keyboard range');
    assert.equal(await page.evaluate(() => current.content), source, 'keyboard copy never mutates the document');

    // A native drag is authoritative for partial readings and still must not
    // pick up the hover action row.
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.waitForTimeout(300);
    const points = await page.evaluate(() => {
      const paragraph = [...document.querySelectorAll('#preview .ProseMirror > p')].find(node => node.textContent.startsWith('Before'));
      const block = document.querySelector('#preview .extension-block');
      const start = document.createRange();
      start.setStart(paragraph.firstChild, 0); start.setEnd(paragraph.firstChild, 0);
      const rect = start.getBoundingClientRect();
      const end = block.getBoundingClientRect();
      return { from: [rect.left, (rect.top + rect.bottom) / 2], to: [end.right - 4, end.bottom - 4] };
    });
    await page.mouse.move(points.from[0], points.from[1]);
    await page.mouse.down();
    await page.mouse.move(points.to[0], points.to[1], { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    assertRendered(await copied(page), 'native drag');
    assert.equal(await page.evaluate(() => current.content), source, 'drag copy never mutates the document');

    assert.deepEqual(session.errors, []);
    console.log('PASS: copy preserves Markdown source and excludes editor controls.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
