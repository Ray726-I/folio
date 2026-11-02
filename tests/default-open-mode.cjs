const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const session = await openEditor('# Document\n\nText.\n', undefined, { defaultMode: true });
  const { page } = session;
  try {
    assert.equal(await page.locator('#document-mode-label').textContent(), 'Edit mode');
    for (const mode of ['reading', 'source', 'locked']) {
      await page.evaluate(mode => { if (mode === 'locked') toggleDocumentReadOnly(); else setDocumentMode(mode); }, mode);
      await page.evaluate(() => requestOpen('/tmp/test.md'));
      assert.equal(await page.locator('#document-mode-label').textContent(), 'Edit mode', `opening clears previous ${mode} mode`);
      assert.equal(await page.locator('#preview .ProseMirror').getAttribute('contenteditable'), 'true');
    }
    await page.locator('#view-menu-button').click();
    await page.getByLabel('Open documents in Edit mode').uncheck();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#document-mode-label').textContent(), 'Edit mode', 'preference affects future opens');
    await page.evaluate(() => requestOpen('/tmp/test.md'));
    assert.equal(await page.locator('#document-mode-label').textContent(), 'Reading mode');
    await page.reload();
    await page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
    assert.equal(await page.locator('#document-mode-label').textContent(), 'Reading mode', 'opt-out persists across launches');
    await page.evaluate(() => { preferences.set('openInEditMode', true); current.writable = false; resetDocumentPresentation(); syncDocumentMode(); });
    assert.equal(await page.locator('#preview .ProseMirror').getAttribute('contenteditable'), 'false', 'filesystem permissions take precedence');
    assert.deepEqual(session.errors, []);
    console.log('PASS: default Edit, independent opens, persistent Reading opt-out, filesystem protection');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
