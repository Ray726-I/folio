const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('# Title\n\nA paragraph.\n');
  try {
    const { page } = session;
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() => !busy && mode === 'edit');
    assert.equal(await page.locator('#source-editor .cm-content').evaluate(node => node.contains(document.activeElement)), true,
      'Ctrl+E must focus the new presentation so typing continues without another click');
    await page.keyboard.type('SOURCE');
    assert.equal(await page.evaluate(() => current.content), '# Title\n\nA paragraph.SOURCE\n');
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() => !busy && mode === 'read');
    await page.keyboard.type('RICH');
    assert.equal(await page.evaluate(() => current.content), '# Title\n\nA paragraph.SOURCERICH\n');
    assert.deepEqual(session.errors, []);
    console.log('PASS: keyboard presentation toggle keeps typing focus and caret in both directions.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
