const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('# H\n\ntext\n');
  try {
    const { page } = session;
    await page.locator('#document-mode-button').click(); await page.locator('#lock-document').click();
    assert.equal(await page.locator('#editor-lock-note').isHidden(), false);
    await page.evaluate(() => openFolderPath('/tmp/empty-folder'));
    assert.equal(await page.locator('#editor-lock-note').isHidden(), true);
    assert.equal(await page.locator('#editor-notice').isHidden(), true);
    // Without a document the rail keeps Contents and search out of reach and shows Files.
    assert.equal(await page.getByRole('button', { name: 'Contents', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Contents', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('[data-rail-action="find"]').isDisabled(), false);
    assert.equal(await page.getByRole('button', { name: 'Files', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => openPath('/tmp/test.md'));
    await page.waitForFunction(() => current.active && editor);
    assert.equal(await page.getByRole('button', { name: 'Contents', exact: true }).isEnabled(), true);
    assert.equal(await page.locator('[data-rail-action="find"]').isEnabled(), true);
    await page.evaluate(() => setDocumentMode('edit'));
    assert.equal(await page.evaluate(() => editor.isLocked()), false, 'new document retains existing per-document lock policy');
    assert.deepEqual(session.errors, []);
    console.log('PASS: empty-folder chrome clears stale lock and restores controls for a reopened document.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
