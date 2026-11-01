const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const source = '```rust extra\nlet x = 1;\n```\n';
  const session = await openEditor(source);
  try {
    const { page } = session;
    const info = page.getByRole('textbox', { name: 'Code fence info' });
    assert.equal(await info.inputValue({ timeout: 3000 }), 'rust extra');
    await info.fill('javascript extra');
    await info.press('Enter');
    await page.waitForFunction(() => current.content === '```javascript extra\nlet x = 1;\n```\n');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(value => current.content === value, source);
    await info.fill('discarded');
    await info.press('Escape');
    assert.equal(await info.inputValue(), 'rust extra', 'Escape cancels the draft');
    assert.equal(await page.evaluate(() => current.content), source);
    await page.locator('#lock-document').click();
    assert.equal(await page.getByRole('textbox', { name: 'Code fence info' }).isDisabled(), true);
    assert.deepEqual(session.errors, []);
    console.log('PASS: fence info is editable in place and preserves source, undo and lock.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
