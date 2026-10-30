const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

// Shift+Enter is a soft break. ProseMirror's base keymap does not bind it, so
// the rich editor must explicitly insert the schema hard_break and serialize
// it back to Markdown instead of swallowing the chord.
(async () => {
  const bundle = buildEditorBundle();
  process.on('exit', () => bundle.cleanup());
  const source = '# H\n\nAlpha beta\n';
  const session = await openIsolatedEditor(source, bundle.outfile, { width: 900, height: 620 });
  const { page, errors } = session;
  try {
    await page.waitForFunction(() => !editor.isSource());
    await page.evaluate(() => editor.selectRange(10, 10, true));
    await page.keyboard.press('Shift+Enter');
    await page.waitForFunction(() => current.content === '# H\n\nAlpha\\\n beta\n');

    const state = await page.evaluate(() => ({
      content: current.content,
      html: document.querySelector('#preview .ProseMirror p').innerHTML,
      selection: editor.getSelection()
    }));
    assert.equal(state.content, '# H\n\nAlpha\\\n beta\n', 'Shift+Enter must serialize a Markdown hard break');
    assert.match(state.html, /<br\s*\/?>/, 'the rich projection must contain a hard break');
    assert.equal(state.selection.anchor, state.selection.head);

    await page.keyboard.type('next');
    await page.waitForFunction(() => current.content === '# H\n\nAlpha\\\nnext beta\n');
    assert.equal(await page.evaluate(() => current.content), '# H\n\nAlpha\\\nnext beta\n',
      'typing after the soft break must stay in the same paragraph');

    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(value => current.content === value, source);
    assert.equal(await page.evaluate(() => current.content), source, 'undo restores the paragraph exactly');

    assert.deepEqual(errors, []);
    console.log('PASS: Shift+Enter inserts and serializes a soft line break.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
