const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('# Heading\n');
  try {
    const { page } = session;
    const toolbar = page.locator('#format-tools');
    const close = page.getByRole('button', { name: 'Hide formatting toolbar', exact: true }).last();
    assert.equal(await toolbar.isVisible(), true);
    await close.click();
    assert.equal(await toolbar.isHidden(), true, 'close hides the toolbar');
    assert.equal(await page.locator('#format-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'view-menu-button', 'focus returns to the view menu');
    await page.locator('#view-menu-button').click();
    await page.getByRole('button', { name: 'Show formatting toolbar' }).click();
    assert.equal(await toolbar.isVisible(), true, 'the view menu restores the toolbar');
    await page.locator('#document-mode-button').click(); await page.locator('#lock-document').click();
    await page.locator('#format-toolbar-close').click();
    assert.equal(await toolbar.isHidden(), true, 'the close control remains available while locked');
    assert.deepEqual(session.errors, []);
    console.log('PASS: formatting toolbar closes, can be reopened, and remains closable under Lock.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
