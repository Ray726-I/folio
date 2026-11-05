const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Revealing the exact Markdown replaces a rendered block with a shorter source
// presentation. The block must stay at the same viewport position: a reveal
// that scrolls the reader moves the text the user was reading.
const filler = Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1} with enough words to wrap onto a second line in the reader view for testing.`).join('\n\n');
const source = `${filler}

> [!CAUTION]
> This is sample content. There is no actual danger or destructive action here.

Trailing paragraph.`;

async function measure(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector('#reader-scroll') || document.scrollingElement;
    const block = document.querySelector('.extension-block') || document.querySelector('.folio-source-edit');
    return { scrollTop: scroll.scrollTop, top: block.getBoundingClientRect().top, sourceShown: block.classList.contains('folio-source-edit') };
  });
}

(async () => {
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.waitForFunction(() => document.querySelector('.extension-preview')?.textContent.includes('sample'));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    // Park the block low in the viewport, away from the scroll limits so a
    // clamped scroll cannot mask the jump.
    await page.evaluate(() => {
      const scroll = document.querySelector('#reader-scroll') || document.scrollingElement;
      scroll.scrollTop += document.querySelector('.extension-block').getBoundingClientRect().top - 700;
    });
    await page.waitForTimeout(250);

    const before = await measure(page);
    assert.equal(before.sourceShown, false, 'the block starts as a rendered projection');

    const point = await page.evaluate(() => {
      const body = document.querySelector('.extension-preview p:not(.markdown-alert-title)');
      const rect = body.getBoundingClientRect();
      return { x: rect.left + 40, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(point.x, point.y, { button: 'right' });
    const menu = page.getByRole('menu', { name: /^(Document|Table) menu$/ });
    const action = menu.getByRole('menuitem', { name: 'Edit Markdown', exact: true });
    await action.waitFor();
    const box = await action.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => document.querySelector('.folio-source-edit'));
    await page.waitForTimeout(300);

    const after = await measure(page);
    assert.equal(after.sourceShown, true, 'the block shows its exact Markdown');
    assert.ok(Math.abs(after.top - before.top) <= 1, `the revealed block keeps its viewport position, moved ${(after.top - before.top).toFixed(2)}px`);
    assert.equal(await page.evaluate(() => current.content), source, 'revealing the source leaves the Markdown untouched');
    assert.deepEqual(session.errors, []);
    console.log('PASS: revealing the exact Markdown keeps the block at the same viewport position instead of scrolling the reader.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
