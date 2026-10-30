const assert = require('node:assert/strict');
const path = require('node:path');
const { openEditor } = require('./editor-browser.cjs');

const root = '/tmp/folio-picker-keyboard';
const notes = path.join(root, 'notes');
const note = path.join(notes, 'note.md');
const alpha = path.join(root, 'alpha.md');
const beta = path.join(root, 'beta.md');
const listings = {
  [root]: [
    { path: notes, name: 'notes', directory: true },
    { path: alpha, name: 'alpha.md', directory: false },
    { path: beta, name: 'beta.md', directory: false }
  ],
  [notes]: [{ path: note, name: 'note.md', directory: false }]
};

(async () => {
  const session = await openEditor('# H\n\ntext\n', { width: 1000, height: 700 });
  const { page, errors } = session;
  try {
    await page.waitForFunction(() => !busy);
    await page.evaluate(listing => {
      window.__TAURI__.core.invoke = (original => async (command, args = {}) => {
        if (command === 'browse_directory') return { path: args.path || '/tmp/folio-picker-keyboard', parent: args.path === '/tmp/folio-picker-keyboard/notes' ? '/tmp/folio-picker-keyboard' : null, entries: listing[args.path] || listing['/tmp/folio-picker-keyboard'], truncated: false };
        return original(command, args);
      })(window.__TAURI__.core.invoke);
    }, listings);
    await page.evaluate(() => openChooser());
    await page.waitForFunction(() => document.getElementById('open-dialog').open);
    await page.waitForFunction(() => document.querySelectorAll('#open-items .file-dialog-item').length === 3);
    assert.equal(await page.evaluate(() => document.activeElement?.__folioPickerEntry?.path), notes, 'the first picker row starts focused');

    const active = () => page.evaluate(() => ({ path: document.activeElement?.__folioPickerEntry?.path, selected: pickerSelection?.path, hint: document.getElementById('open-selection-hint').textContent }));
    await page.keyboard.press('ArrowDown');
    assert.deepEqual(await active(), { path: alpha, selected: alpha, hint: 'Open selected Markdown file' }, 'ArrowDown must focus and select the next row');
    await page.keyboard.press('ArrowDown');
    assert.equal((await active()).path, beta);
    await page.keyboard.press('Home');
    assert.equal((await active()).path, notes);
    await page.keyboard.press('End');
    assert.equal((await active()).path, beta);
    await page.keyboard.press('ArrowUp');
    assert.equal((await active()).path, alpha);

    // Enter on a directory navigates into it and keeps focus inside the list.
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#open-items .file-dialog-item').length === 1);
    assert.equal(await page.evaluate(() => document.activeElement?.__folioPickerEntry?.path), note, 'Enter on a folder must focus its first child');
    assert.equal(await page.evaluate(() => document.getElementById('open-dialog').open), true);

    // Enter on a file closes the picker and opens the selected document.
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !busy && current.path === '/tmp/folio-picker-keyboard/notes/note.md');
    assert.equal(await page.evaluate(() => document.getElementById('open-dialog').open), false);

    assert.deepEqual(errors, []);
    console.log('PASS: picker arrows navigate, Enter opens folders and files, and focus stays in the list.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
