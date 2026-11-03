const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const source = 'First paragraph.\n';
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.locator('.editor-trailing-input').click();
    await page.keyboard.type('/what');
    await page.waitForFunction(() => current.content.includes('/what'), null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('ProseMirror')), true, 'slash does not take typing focus');
    assert.equal(await page.locator('.folio-slash-empty').count(), 1, 'unmatched text shows an empty state');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/he');
    await page.keyboard.press('Escape');
    await page.keyboard.type('llo');
    assert.ok((await page.evaluate(() => current.content)).includes('/hello'), 'Escape dismisses suggestions without losing typed text');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/heading 3');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('ProseMirror')), true);
    await page.locator('.folio-slash-menu').waitFor({ state: 'visible' });
    await page.keyboard.press('Enter');
    await page.keyboard.type('New title');
    await page.waitForFunction(() => current.content.includes('### New title'));
    assert.ok((await page.evaluate(() => current.content)).includes('/what'), 'literal slash survives block insertion');
    assert.deepEqual(session.errors, []);
    console.log('PASS: slash text remains editable and matching block commands stay keyboard accessible.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
