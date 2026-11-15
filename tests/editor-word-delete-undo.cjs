const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
 const deleteWord = process.platform === 'darwin' ? 'Alt+Backspace' : 'Control+Backspace';
 const source = 'Before.\n\nalpha beta gamma delta epsilon zeta\n\nAfter.\n';
 const session = await openEditor(source);
 try {
  const { page } = session;
  await page.evaluate(() => editor.selectRange(current.content.indexOf('zeta') + 4));
  const snapshots = [source];
  for (const word of ['zeta', 'epsilon ', 'delta ']) {
   await page.waitForTimeout(700);
   await page.keyboard.press(deleteWord);
   const expected = snapshots.at(-1).replace(word, '');
   assert.equal(await page.evaluate(() => current.content), expected, 'native word deletion preserves paragraphs');
   snapshots.push(expected);
  }
  for (let i = snapshots.length - 2; i >= 0; i--) {
   await page.keyboard.press('Control+z');
   assert.equal(await page.evaluate(() => current.content), snapshots[i], 'each undo restores the exact preceding source');
  }
  for (let i = 1; i < snapshots.length; i++) {
   await page.keyboard.press('Control+Shift+z');
   assert.equal(await page.evaluate(() => current.content), snapshots[i], 'redo restores exact deletion');
  }
  assert.deepEqual(session.errors, []);
  console.log('PASS: word deletions and repeated undo/redo preserve exact source.');
 } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
