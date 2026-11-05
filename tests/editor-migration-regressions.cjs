const { openMarkdown } = require('./editor-test-actions.cjs');
const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  let session = await openEditor('<div>same</div>\n\nMiddle.\n\n<div>same</div>\n');
  try {
    const { page } = session;
    const block = page.locator('.extension-block').nth(1);
    await openMarkdown(block.locator('.extension-preview'));
    await page.locator('.folio-source-edit').waitFor();
    assert.match(await page.locator('.folio-source-edit').textContent(), /<div>same<\/div>/,
      'the second repeated raw block reveals its own source');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => current.content), '<div>same</div>\n\nMiddle.\n\n<div>same</div>\n');
  } finally { await session.close(); }

  session = await openEditor('![image.png](image.png)\n\nA [link](https://example.com/a\\(b\\)).\n');
  try {
    const { page } = session;
    await openMarkdown(page.locator('.image-widget'));
    await page.locator('.folio-source-edit').waitFor();
    assert.match(await page.locator('.folio-source-edit').textContent(), /!\[image\.png\]\(image\.png\)/);
    await page.keyboard.press('Escape');
    await page.locator('#preview a').click();
    await page.waitForFunction(() => document.getElementById('editor-action-dialog').open);
    const input = page.locator('#editor-action-value');
    assert.equal(await input.inputValue(), 'https://example.com/a\\(b\\)');
    await input.fill('https://example.com/new');
    await page.locator('#editor-action-form button[type="submit"]').click();
    await page.waitForFunction(() => current.content.includes('(https://example.com/new)'));
    assert.ok((await page.evaluate(() => current.content)).includes('[link](https://example.com/new)'));
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
  console.log('PASS: repeated raw blocks reveal their own source and exact link destinations remain editable.');
})().catch(error => { console.error(error); process.exitCode = 1; });
