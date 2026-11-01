const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const source = '![old](photo.png "title")\n\nText <span>hello</span> after.\n\n[link](https://example.com "old")\n\n[reference][ref]\n\n[ref]: https://example.org "old"\n';
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.locator('.image-widget').dblclick();
    const image = page.getByRole('textbox', { name: 'Image Markdown' });
    assert.equal(await image.inputValue({ timeout: 3000 }), '![old](photo.png "title")');
    await image.fill('![new](photo.png "new title")');
    await image.press('Control+Enter');
    await page.waitForFunction(() => current.content.includes('![new](photo.png "new title")'));
    await page.locator('.html-inline').dblclick();
    const html = page.getByRole('textbox', { name: 'Inline HTML source' });
    assert.equal(await html.inputValue({ timeout: 3000 }), '<span>hello</span>');
    await html.fill('<em>changed</em>');
    await html.press('Control+Enter');
    await page.waitForFunction(() => current.content.includes('<em>changed</em>'));
    await page.getByRole('link', { name: 'link', exact: true }).click({ modifiers: ['Alt'] });
    const link = page.getByRole('textbox', { name: 'Link Markdown' });
    assert.equal(await link.inputValue({ timeout: 3000 }), '[link](https://example.com "old")');
    await link.fill('[link](https://example.com "new")');
    await link.press('Enter');
    await page.waitForFunction(() => current.content.includes('[link](https://example.com "new")'));
    await page.getByRole('link', { name: 'reference' }).click({ modifiers: ['Alt'] });
    const reference = page.getByRole('textbox', { name: 'Link Markdown' });
    assert.equal(await reference.inputValue({ timeout: 3000 }), '[ref]: https://example.org "old"');
    await reference.fill('[ref]: https://example.org "new"');
    await reference.press('Enter');
    await page.waitForFunction(() => current.content.includes('[ref]: https://example.org "new"'));
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
