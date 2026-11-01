const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Changing the document width must keep the reader where they were, not jump
// to the top. This guards the fix for the old placeholders
// (`previewBlockAtViewportTop()` returned 0 and `previewElementForBlock()`
// returned the first heading), which silently re-anchored every width change to
// the beginning of the document.
// Long paragraphs matter: they must wrap differently at the centered and full
// column widths, or nothing below the fold changes height and the anchor is
// never tested.
const body = 'The quick brown fox jumps over the lazy dog while the reader follows a long line of prose that wraps at the centered width but fits on fewer lines when the document uses the full width. ';
const sections = Array.from({ length: 40 }, (_, index) =>
  `## Section ${index + 1}\n\n${body}${body}\n`
).join('\n');

(async () => {
  const session = await openEditor(`# Width anchor\n\n${sections}`);
  const { page, errors } = session;
  const blockAtViewportTop = () => page.evaluate(() => {
    const scroller = document.getElementById('reader-scroll');
    const top = scroller.getBoundingClientRect().top + 24;
    const blocks = [...document.querySelectorAll('.ProseMirror > *')];
    const index = blocks.findIndex(node => node.getBoundingClientRect().bottom > top);
    const block = blocks[Math.max(0, index)];
    return { index, text: block.textContent.slice(0, 30), top: block.getBoundingClientRect().top };
  });
  try {
    await page.locator('#preview .ProseMirror h2').first().waitFor();
    await page.evaluate(() => {
      const scroller = document.getElementById('reader-scroll');
      scroller.scrollTop = scroller.scrollHeight * 0.5;
    });
    await page.waitForTimeout(250);

    const before = await blockAtViewportTop();
    assert.ok(before.index > 2, `the test must scroll past the first blocks, got index ${before.index}`);

    await page.evaluate(() => setDocumentWidth(true, false));
    await page.waitForTimeout(250);
    const afterWide = await blockAtViewportTop();

    assert.equal(afterWide.text, before.text, 'the same block stays at the top of the viewport after widening');
    assert.ok(Math.abs(afterWide.top - before.top) < 40,
      `the anchored block keeps its viewport offset, got ${before.top.toFixed(0)} -> ${afterWide.top.toFixed(0)}`);

    await page.evaluate(() => setDocumentWidth(false, false));
    await page.waitForTimeout(250);
    const afterNarrow = await blockAtViewportTop();
    assert.equal(afterNarrow.text, before.text, 'the same block stays at the top after narrowing again');
    assert.ok(Math.abs(afterNarrow.top - before.top) < 40,
      `the anchored block keeps its offset in both directions, got ${before.top.toFixed(0)} -> ${afterNarrow.top.toFixed(0)}`);

    assert.deepEqual(errors, []);
    console.log('PASS: changing document width keeps the block at the top of the viewport in both directions.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exit(1); });
