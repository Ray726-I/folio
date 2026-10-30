const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('# H\n\ntext\n');
  try {
    const { page } = session;
    await page.locator('#lock-document').click();
    assert.equal(await page.locator('#editor-lock-note').isHidden(), false);
    await page.evaluate(() => openFolderPath('/tmp/empty-folder'));
    assert.equal(await page.locator('#format-tools').isHidden(), true);
    assert.equal(await page.locator('#editor-lock-note').isHidden(), true);
    assert.equal(await page.locator('#editor-notice').isHidden(), true);
    await page.evaluate(() => openPath('/tmp/test.md'));
    await page.waitForFunction(() => current.active && editor);
    assert.equal(await page.locator('#format-tools').isHidden(), false);
    assert.equal(await page.evaluate(() => editor.isLocked()), false, 'new document retains existing per-document lock policy');
    assert.deepEqual(session.errors, []);
    console.log('PASS: empty-folder chrome clears stale lock and restores formatting for a reopened document.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
