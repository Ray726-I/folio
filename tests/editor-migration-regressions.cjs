const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  let session = await openEditor('<div>same</div>\n\nMiddle.\n\n<div>same</div>\n');
  try {
    const { page } = session;
    const block = page.locator('.extension-block').nth(1);
    await block.hover();
    await block.locator('.extension-edit').click();
    const input = block.locator('.extension-source-editor textarea');
    await input.waitFor({ state: 'visible' });
    await input.fill('<div>changed</div>');
    await block.getByRole('button', { name: 'Apply' }).click();
    await page.waitForFunction(() => current.content.includes('<div>changed</div>'));
    assert.equal(await page.evaluate(() => current.content), '<div>same</div>\n\nMiddle.\n\n<div>changed</div>\n');
  } finally { await session.close(); }

  session = await openEditor('![image.png](image.png)\n\nA [link](https://example.com/a\\(b\\)).\n');
  try {
    const { page } = session;
    await page.getByRole('button', { name: 'Edit image', exact: true }).click();
    const input = page.locator('#editor-action-value');
    assert.equal(await input.inputValue(), 'image.png');
    await input.fill('new.png');
    await page.locator('#editor-action-form button[type="submit"]').click();
    await page.waitForFunction(() => current.content.includes('(new.png)'));
    assert.ok((await page.evaluate(() => current.content)).startsWith('![image.png](new.png)'));
    await page.locator('#preview a').click();
    assert.equal(await input.inputValue(), 'https://example.com/a\\(b\\)');
    await input.fill('https://example.com/new');
    await page.locator('#editor-action-form button[type="submit"]').click();
    await page.waitForFunction(() => current.content.includes('(https://example.com/new)'));
    assert.ok((await page.evaluate(() => current.content)).includes('[link](https://example.com/new)'));
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
  console.log('PASS: repeated raw blocks and exact link/image destinations remain editable.');
})().catch(error => { console.error(error); process.exitCode = 1; });
