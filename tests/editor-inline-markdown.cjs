const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const source = '![old](photo.png "title")\n\nText <span>hello</span> after.\n\n[link](https://example.com "old")\n\n[reference][ref]\n\n[ref]: https://example.org "old"\n';
  const session = await openEditor(source);
  try {
    const { page } = session;
    async function editBlock(target, original, replacement) {
      await target.dblclick();
      const block = page.locator('.folio-source-edit');
      assert.equal(await block.textContent({ timeout: 3000 }), original);
      await block.evaluate(element => window.getSelection().selectAllChildren(element));
      await page.keyboard.insertText(replacement);
      await page.keyboard.press('Escape');
      await page.waitForFunction(value => current.content.includes(value), replacement);
    }

    await editBlock(page.locator('.image-widget'), '![old](photo.png "title")', '![new](photo.png "new title")');
    await editBlock(page.locator('.html-inline'), 'Text <span>hello</span> after.', 'Text <em>changed</em> after.');
    await editBlock(page.getByRole('link', { name: 'link', exact: true }),
      '[link](https://example.com "old")', '[link](https://example.com "new")');
    await page.evaluate(() => setDocumentMode('source'));
    const textarea = page.locator('#document-source');
    const markdown = await textarea.inputValue();
    await textarea.fill(markdown.replace('https://example.org', 'https://example.net'));
    await page.evaluate(() => setDocumentMode('edit'));
    assert.equal(await page.getByRole('link', { name: 'reference' }).getAttribute('href'), 'https://example.net');
    assert.ok((await page.evaluate(() => current.content)).includes('[ref]: https://example.net "old"'));
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
