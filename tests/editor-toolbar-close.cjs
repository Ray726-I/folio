const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const session = await openEditor('# Heading\n\nSome text\n');
  try {
    const { page, errors } = session;
    assert.equal(await page.locator('#format-tools, #format-toggle').count(), 0, 'formatting toolbar and its setting are absent');
    await page.locator('#view-menu-button').click();
    assert.equal(await page.getByText('Formatting toolbar', { exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { const at = current.content.indexOf('Some text'); editor.selectRange(at, at + 9, true); });
    await page.keyboard.press('Control+b');
    await page.waitForFunction(() => current.content.includes('**Some text**'));
    assert.deepEqual(errors, []);
    console.log('PASS: formatting toolbar is absent and keyboard formatting works');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
