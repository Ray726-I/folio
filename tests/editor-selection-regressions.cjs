const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('A &amp; B\n\nA **bold** B\n');
  try {
    const { page } = session;
    await page.locator('#show-markdown').click();
    await page.waitForFunction(() => !busy && mode === 'edit');
    await page.evaluate(() => editor.selectRange(4)); // inside the entity spelling
    await page.locator('#show-markdown').click();
    await page.waitForFunction(() => !busy && mode === 'read');
    await page.locator('#show-markdown').click();
    await page.waitForFunction(() => !busy && mode === 'edit');
    assert.deepEqual(await page.evaluate(() => editor.getSelection()), { anchor: 4, head: 4 },
      'a non-injective source position must survive a zero-write presentation round trip');
    await page.evaluate(() => {
      const start = current.content.indexOf('**bold**');
      editor.selectRange(start, start + 8);
    });
    await page.locator('#show-markdown').click();
    await page.waitForFunction(() => !busy && mode === 'read');
    await page.keyboard.type('X');
    assert.equal(await page.evaluate(() => current.content), 'A &amp; B\n\nA X B\n',
      'replacement must replace the exact logical source selection, including its selected delimiters');
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => current.content), 'A &amp; B\n\nA **bold** B\n');
    assert.deepEqual(session.errors, []);
    console.log('PASS: latent source offsets and selected syntax survive toggles and exact replacement/undo.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
