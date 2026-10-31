const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

const original = '# Title\n\nFirst __bold__ and *em* &amp; \\*literal\\*.\n\nSecond [two][b].\n\n| A | B |\n| --- | --- |\n| one | two |\n\nAfter the table.\n\n[a]: https://a.example\n[b]: https://b.example\n';
(async () => {
  const session = await openEditor(original);
  try {
    const { page } = session;
    await page.locator('#preview .ProseMirror > p').nth(0).click();
    await page.keyboard.press('End');
    await page.keyboard.type('X');
    assert.equal(await page.evaluate(() => current.content), original.replace('literal\\*.', 'literal\\*.X'),
      'ordinary typing must preserve emphasis spelling, entities, escapes and all untouched bytes');
    await page.locator('#preview .ProseMirror > p').nth(1).click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    const changed = original.replace('literal\\*.', 'literal\\*.X').replace('[two][b].', '[two][b].!');
    assert.equal(await page.evaluate(() => current.content), changed,
      'editing reference-link prose must preserve both reference syntax and definitions');
    await page.locator('#show-markdown').click();
    await page.waitForFunction(() => !busy && mode === 'edit');
    await page.evaluate(() => editor.selectRange(current.content.indexOf('After the table.')));
    await page.locator('#view-formatted').click();
    await page.waitForFunction(() => !busy && mode === 'read');
    await page.keyboard.type('Z');
    assert.equal(await page.evaluate(() => current.content), changed.replace('After the table.', 'ZAfter the table.'),
      'source caret after a table must type in the following paragraph, not the last cell');
    assert.deepEqual(session.errors, []);
    console.log('PASS: real typing preserves source spelling, reference definitions and post-table caret ownership.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
