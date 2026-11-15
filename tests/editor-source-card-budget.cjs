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
    await card.locator('code').click();
    await page.keyboard.press('End');
    await page.evaluate(() => editor.resetStats());
    await page.keyboard.type('abc');
    const expected = source.replace('# Source card', '# Source cardabc');
    await page.waitForFunction(value => current.content === value, expected);
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
