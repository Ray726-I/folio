const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

// Link/Image/Math are authoring commands, not just source-reveal shortcuts.
// Each must insert usable Markdown at the exact source selection, keep the
// history exact, and undo back to the byte-identical document.
(async () => {
  const bundle = buildEditorBundle();
  process.on('exit', () => bundle.cleanup());
  const source = '# H\n\nlabel text\n\nhttps://example.org/a\n\nx^2\n\nassets/pic.png\n';
  const session = await openIsolatedEditor(source, bundle.outfile, { width: 1000, height: 700 });
  const { page, errors } = session;
  try {
    await page.waitForFunction(() => !editor.isSource());
    const select = text => page.evaluate(value => {
      const offset = current.content.indexOf(value);
      editor.selectRange(offset, offset + value.length, true);
    }, text);

    const command = async (name, expected, selected) => {
      await page.locator(`[data-editor-command="${name}"]`).click();
      await page.waitForFunction(value => current.content === value, expected);
      const state = await page.evaluate(() => {
        const selection = editor.getSelection();
        return {
          content: current.content,
          selection,
          selected: current.content.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head))
        };
      });
      assert.equal(state.content, expected, `${name} must insert exact Markdown`);
      assert.equal(state.selected, selected, `${name} must select its editable placeholder`);
      await page.keyboard.press('Control+z');
      await page.waitForFunction(value => current.content === value, source);
    };

    await select('label text');
    await command('link', '# H\n\n[label text](https://example.com)\n\nhttps://example.org/a\n\nx^2\n\nassets/pic.png\n', 'https://example.com');

    await select('https://example.org/a');
    await command('link', '# H\n\nlabel text\n\n[https://example.org/a](https://example.org/a)\n\nx^2\n\nassets/pic.png\n', 'https://example.org/a');

    await select('x^2');
    await command('math', '# H\n\nlabel text\n\nhttps://example.org/a\n\n$x^2$\n\nassets/pic.png\n', 'x^2');

    await select('assets/pic.png');
    await command('image', '# H\n\nlabel text\n\nhttps://example.org/a\n\nx^2\n\n![image](assets/pic.png)\n', 'image');

    // Collapsed insertion supplies a complete editable placeholder.
    await page.evaluate(() => { const offset = current.content.indexOf('label text'); editor.selectRange(offset + 'label text'.length, offset + 'label text'.length, true); });
    await page.locator('[data-editor-command="math"]').click();
    await page.waitForFunction(() => current.content.includes('label text$x$'));
    assert.equal(await page.evaluate(() => current.content), '# H\n\nlabel text$x$\n\nhttps://example.org/a\n\nx^2\n\nassets/pic.png\n');
    assert.equal(await page.evaluate(() => {
      const selection = editor.getSelection();
      return current.content.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head));
    }), 'x', 'collapsed math keeps its placeholder selected for immediate typing');

    await page.evaluate(() => {
      activeFolder = '/tmp';
      const from = current.content.indexOf('label text'); editor.selectRange(from, from + 10, true);
    });
    const folderBefore = await page.evaluate(() => folderVisible);
    await page.keyboard.press('Control+b');
    assert.ok((await page.evaluate(() => current.content)).includes('**label text**'), 'Ctrl+B in the editor formats the selection');
    assert.equal(await page.evaluate(() => folderVisible), folderBefore, 'Ctrl+B in the editor does not toggle the folder');

    assert.deepEqual(errors, []);
    console.log('PASS: Link/Image/Math insert usable exact Markdown with selected address/TeX and undo.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
