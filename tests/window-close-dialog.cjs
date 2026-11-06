const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('# Document\n\nText\n');
  try {
    const { page, errors } = session;
    await page.evaluate(() => {
      current.documentId = 'single-close';
      current.revision = 0;
      registerDocument(current);
      editor.replaceContent('unsaved text');
    });
    await page.evaluate(() => { void requestClose(); });
    await page.waitForSelector('#confirm-dialog[open]');
    assert.equal(await page.locator('#confirm-title').textContent(), 'Save changes before closing?');
    assert.deepEqual(await page.locator('#confirm-actions button').allTextContents(), ['Cancel', 'Discard', 'Save']);
    assert.match(await page.locator('#confirm-message').textContent(), /unsaved text|changes/);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForFunction(() => !busy);
    assert.equal(await page.evaluate(() => calls.some(call => call.command === 'close_window')), false, 'Cancel keeps the window open');
    assert.equal(await page.evaluate(() => documents.has('single-close')), true, 'Cancel keeps the document open');
    assert.deepEqual(errors, []);
    console.log('PASS: closing a single edited document uses the standard Cancel/Discard/Save dialog.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
