'use strict';
const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
const { openMarkdown } = require('./editor-test-actions.cjs');
(async () => {
  const source = 'Before.\n\n# Source card\n\n' + 'Ordinary paragraph with enough text to make this a long document and keep the surrounding source unchanged.\n\n'.repeat(1200);
  const session = await openEditor(source);
  try {
    const { page } = session;
    await openMarkdown(page.locator('#preview h1'));
    const card = page.locator('.folio-source-edit');
    await card.waitFor();
    // Click past the end of the card's text so the caret lands at the line end
    // on every platform. End only moves the caret on some platforms; on macOS
    // it scrolls instead and typing would splice into the middle of the word.
    const box = await card.boundingBox();
    assert.ok(box, 'source card has layout');
    const placeCaret = () => page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
    await placeCaret();
    const focusesCard = () => page.waitForFunction(() => {
      const card = document.querySelector('.folio-source-edit');
      return !!card && !!document.activeElement?.contains(card);
    }, null, { timeout: 3000 });
    // The card node view can be replaced while it opens; retry the click once
    // when the editable host lost focus during that remount.
    await focusesCard().catch(async () => { await placeCaret(); await focusesCard(); });
    const cardEnd = source.indexOf('# Source card') + '# Source card'.length;
    await page.evaluate(() => editor.captureSelection());
    const caret = await page.evaluate(() => editor.getSelection());
    assert.deepEqual(caret, { anchor: cardEnd, head: cardEnd }, 'caret starts at the end of the source card');
    await page.evaluate(() => editor.resetStats());
    await page.keyboard.type('abc');
    const expected = source.replace('# Source card', '# Source cardabc');
    try {
      await page.waitForFunction(value => current.content === value, expected);
    } catch (error) {
      const actual = await page.evaluate(() => current.content.slice(0, 120));
      throw new Error(`source-card typing did not commit: ${JSON.stringify(actual)}`, { cause: error });
    }
    const stats = await page.evaluate(() => editor.stats());
    assert.ok(stats.sourceParseBytes < 1000, `three source-card keystrokes parsed ${stats.sourceParseBytes} bytes of ${source.length}`);
    assert.equal(await page.locator('.folio-source-edit').count(), 1, 'typing keeps the source card active');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(value => current.content === value, source);
    await page.keyboard.press('Control+Shift+z');
    await page.waitForFunction(value => current.content === value, expected);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#preview h1').textContent(), 'Source cardabc');
    assert.deepEqual(session.errors, []);
    console.log(`PASS: source-card typing parses ${stats.sourceParseBytes} bytes for three keystrokes in a ${source.length}-byte document, with exact source, undo and redo.`);
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
