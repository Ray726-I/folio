const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

const source = 'Before.\n\n```text\nalpha beta gamma\ndelta epsilon zeta\n```\n\nAfter.\n';

async function revealAtLineEnd(page, line) {
  await page.locator('.code-surface code').click();
  await page.keyboard.press('Control+Home');
  // Place the actual browser caret in the code text, then use its native End.
  await page.evaluate(line => {
    const code = document.querySelector('.code-surface code');
    const text = code.firstChild;
    const offset = line === 0 ? 0 : text.textContent.indexOf('\n') + 1;
    document.querySelector('.ProseMirror').focus();
    window.getSelection().collapse(text, offset);
  }, line);
  await page.keyboard.press('End');
  if (process.env.FOLIO_BROWSER === 'webkit') {
    // Playwright WebKit does not synthesize the platform keyboard-menu gesture.
    await page.locator('.code-surface code').dispatchEvent('contextmenu', { bubbles: true, cancelable: true });
  } else await page.keyboard.press('Shift+F10');
  await page.getByRole('menu', { name: 'Document menu' }).getByRole('menuitem', { name: 'Edit Markdown', exact: true }).click();
  await page.locator('.folio-source-edit').waitFor();
}

(async () => {
  const session = await openEditor(source);
  try {
    const { page } = session;
    await revealAtLineEnd(page, 0);
    const firstEnd = source.indexOf('gamma') + 'gamma'.length;
    assert.deepEqual(await page.evaluate(() => editor.getSelection()), { anchor: firstEnd, head: firstEnd }, 'revealing preserves the current first-line end');
    assert.equal(await page.evaluate(() => current.content), source, 'revealing source is zero-write');
    await page.keyboard.press('Control+Backspace');
    assert.equal(await page.evaluate(() => current.content), source.replace('beta gamma', 'beta '), 'the first Ctrl+Backspace deletes the last word, preserving its preceding space');
    assert.deepEqual(await page.evaluate(() => editor.getSelection()), { anchor: firstEnd - 5, head: firstEnd - 5 }, 'word deletion leaves the caret where the deleted word began');
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => current.content), source, 'undo restores the exact original Markdown');
    await page.keyboard.press('Escape');
    await revealAtLineEnd(page, 1);
    const secondEnd = source.indexOf('zeta') + 'zeta'.length;
    assert.deepEqual(await page.evaluate(() => editor.getSelection()), { anchor: secondEnd, head: secondEnd }, 'reopening source uses the current second-line end, rather than the previous source caret');
    await page.keyboard.press('Control+Backspace');
    assert.equal(await page.evaluate(() => current.content), source.replace('epsilon zeta', 'epsilon '), 'Ctrl+Backspace deletes the current line’s word after reopening');
    assert.deepEqual(session.errors, []);
    console.log('PASS: Edit Markdown preserves current code-line carets and native word deletion removes the intended source text.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
