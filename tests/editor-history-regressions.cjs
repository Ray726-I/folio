const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('abcdef\n');
  try {
    const { page } = session;
    // The single formatted editor has no mode to enter: moving the caret with
    // the selection API is the same discontinuity a caret jump represents.
    await page.evaluate(() => editor.selectRange(current.content.length));
    await page.keyboard.type('A');
    await page.evaluate(() => editor.selectRange(0));
    await page.keyboard.type('B');
    assert.equal(await page.evaluate(() => current.content), 'Babcdef\nA');
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => current.content), 'abcdef\nA',
      'undo after moving the caret must undo the new edit, not unrelated typing elsewhere');
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => current.content), 'abcdef\n');
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await page.evaluate(() => current.content), 'abcdef\nA');
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await page.evaluate(() => current.content), 'Babcdef\nA');
    assert.deepEqual(session.errors, []);
    console.log('PASS: caret-discontinuous typing creates separate undo/redo events.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
