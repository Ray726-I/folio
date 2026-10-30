const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const session = await openEditor('# Title\n\nA paragraph.\n');
  try {
    const { page } = session;
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.locator('#source-snapshot').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#source-dialog').evaluate(node => node.open), false);
    assert.equal(await page.locator('#preview .ProseMirror').evaluate(node => node.contains(document.activeElement)), true,
      'Escape from a source snapshot must return typing focus to the document, not its header button');
    await page.keyboard.type('X');
    assert.equal(await page.evaluate(() => current.content), '# Title\n\nA paragraph.X\n');
    assert.deepEqual(session.errors, []);
    console.log('PASS: Escape closes source inspection and restores document typing focus.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
