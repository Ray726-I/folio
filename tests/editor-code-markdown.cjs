const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const source = 'Before\n\n```rust\nhello world\n```\n\nAfter\n';
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.locator('.code-container').dblclick();
    const input = page.getByRole('textbox', { name: 'Edit code block Markdown' });
    assert.equal(await input.inputValue({ timeout: 3000 }), '```rust\nhello world\n```');
    await input.fill('hello world');
    await input.press('Control+Enter');
    await page.waitForFunction(() => current.content === 'Before\n\nhello world\n\nAfter\n', null, { timeout: 3000 });
    assert.equal(await page.locator('#preview .code-container').count(), 0);
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
