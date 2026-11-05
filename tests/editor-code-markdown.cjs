const { openMarkdown } = require('./editor-test-actions.cjs');
const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const source = 'Before\n\n```rust\nhello world\n```\n\nAfter\n';
  const session = await openEditor(source);
  try {
    const { page } = session;
    await openMarkdown(page.locator('.code-container'));
    const input = page.locator('.folio-source-edit');
    assert.equal(await input.textContent({ timeout: 3000 }), '```rust\nhello world\n```');
    await input.evaluate(block => window.getSelection().selectAllChildren(block));
    await page.keyboard.insertText('hello world');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => current.content === 'Before\n\nhello world\n\nAfter\n', null, { timeout: 3000 });
    assert.equal(await page.locator('#preview .code-container').count(), 0);
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
