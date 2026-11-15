const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const source = 'Before.\n\n```text\nalpha beta gamma\ndelta epsilon zeta\n```\n\nAfter.\n';
  const session = await openEditor(source);
  try {
    const { page } = session;
    const firstEnd = source.indexOf('gamma') + 'gamma'.length;
    const secondEnd = source.indexOf('zeta') + 'zeta'.length;
    // Undo, find and presentation restoration retain exact source bookmarks.
    // A secondary click can move the native caret without a primary mousedown
    // to clear that bookmark; Edit Markdown must use the newly visible caret.
    await page.evaluate(firstEnd => editor.selectRange(firstEnd), firstEnd);
    const endPoint = await page.evaluate(() => {
      const text = document.querySelector('.code-surface code').firstChild;
      const range = document.createRange(); range.setStart(text, text.length); range.collapse(true);
      const rect = range.getBoundingClientRect();
      return { x: rect.left - 1, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(endPoint.x, endPoint.y, { button: 'right' });
    await page.getByRole('menu', { name: 'Document menu' }).getByRole('menuitem', { name: 'Edit Markdown', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => editor.getSelection()), { anchor: secondEnd, head: secondEnd }, 'a secondary-click caret supersedes the old source bookmark');
    assert.equal(await page.evaluate(() => current.content), source, 'revealing the new caret leaves Markdown unchanged');
    await page.keyboard.type('!');
    assert.equal(await page.evaluate(() => current.content), source.replace('zeta', 'zeta!'), 'the first edit occurs at the visible current caret');
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => current.content), source, 'undo restores the original Markdown');
    assert.deepEqual(session.errors, []);
    console.log('PASS: Edit Markdown adopts the current secondary-click caret rather than a stale source bookmark.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
