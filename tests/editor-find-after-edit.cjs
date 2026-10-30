const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

// Find offsets are byte positions in current.content. Editing while the find
// bar is open invalidates them; the next jump must recompute from the live
// document. Focus stays in the input, and the hit stays visible through the
// custom-highlight mirror even though ProseMirror does not own focus.
(async () => {
  const bundle = buildEditorBundle();
  process.on('exit', () => bundle.cleanup());
  const source = '# H\n\nprefix FIND here and another FIND.\n';
  const session = await openIsolatedEditor(source, bundle.outfile, { width: 900, height: 620 });
  const { page, errors } = session;
  try {
    await page.waitForFunction(() => !editor.isSource());
    await page.keyboard.press('Control+f');
    await page.locator('#find-input').fill('FIND');
    await page.waitForFunction(() => document.getElementById('find-result').textContent.trim() === '1 / 2');

    const focused = await page.evaluate(() => ({
      active: document.activeElement.id,
      highlight: Boolean(window.CSS?.highlights?.get('folio-selection')?.size),
      paint: document.querySelector('#preview .ProseMirror')?.classList.contains('folio-paint'),
      selection: editor.getSelection()
    }));
    assert.equal(focused.active, 'find-input', 'find must not steal focus from its input');
    assert.equal(focused.highlight, true, 'the active rich hit must be painted while the input owns focus');
    assert.equal(focused.paint, true, 'the paint class mirrors the custom highlight');
    assert.deepEqual(focused.selection, { anchor: 12, head: 16 });

    // Edit before the first match. The old match offsets now point into the
    // middle of words, so pressing Enter without a recompute would select the
    // wrong bytes.
    await page.evaluate(() => editor.selectRange(8, 8, true));
    await page.keyboard.type('XX');
    await page.waitForFunction(() => current.content.startsWith('# H\n\npreXXfix'));
    await page.locator('#find-input').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const selection = editor.getSelection();
      return current.content.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head)) === 'FIND';
    });

    const found = await page.evaluate(() => {
      const selection = editor.getSelection();
      return {
        content: current.content,
        selection,
        slice: current.content.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head)),
        result: document.getElementById('find-result').textContent.trim(),
        active: document.activeElement.id,
        highlight: Boolean(window.CSS?.highlights?.get('folio-selection')?.size)
      };
    });
    assert.equal(found.content, '# H\n\npreXXfix FIND here and another FIND.\n');
    assert.equal(found.slice, 'FIND', 'find must land on the current match, not a stale offset');
    assert.deepEqual(found.selection, { anchor: 14, head: 18 });
    assert.equal(found.result, '1 / 2');
    assert.equal(found.active, 'find-input', 'recomputing must preserve find-input focus');
    assert.equal(found.highlight, true, 'the recomputed hit must remain visibly painted');

    // Closing find returns focus to the editor, where the match becomes the
    // ordinary native selection.
    await page.locator('#find-close').click();
    assert.equal(await page.evaluate(() => document.getElementById('find-bar').hidden), true);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')), true,
      'closing find returns focus to the editor selection');
    assert.deepEqual(errors, []);
    console.log('PASS: find recomputes offsets after edits, keeps input focus and paints the hit.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
