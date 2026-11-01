const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

// An exact logical bookmark is kept through the rich projection. A formatting
// command sets stored marks on the rich state; typing must honour those marks
// instead of splicing plain text through the bookmark and silently dropping them.
(async () => {
  const bundle = buildEditorBundle();
  process.on('exit', () => bundle.cleanup());
  const source = '# H\n\nHello world\n';
  const session = await openIsolatedEditor(source, bundle.outfile, { width: 900, height: 620 });
  const { page, errors } = session;
  try {
    // Wait for the editor itself, not just a property of it: under load the
    // shell may still be mounting, and Ctrl+B only bolds while focus is inside
    // the document (it toggles the file tree otherwise).
    await page.waitForFunction(() => typeof editor !== 'undefined' && !!editor);
    await page.locator('#preview .ProseMirror').waitFor({ state: 'visible' });
    await page.locator('#preview .ProseMirror p').first().click();
    // Place the caret deterministically (between "l" and "o"). A prior version
    // pressed ArrowLeft after selectRange and raced the following action, so the
    // typed character sometimes landed at the end of the word instead.
    await page.evaluate(() => editor.selectRange(9, 9, true));
    // Drive the command directly rather than through the Ctrl+B chord: the
    // chord routes through the shell's focus handler. Same code path.
    await page.evaluate(() => editor.command('bold'));
    await page.keyboard.type('X');
    await page.waitForFunction(() => current.content.includes('**X**'));

    const bold = await page.evaluate(() => ({
      content: current.content,
      html: document.querySelector('#preview .ProseMirror').innerHTML,
      selection: editor.getSelection()
    }));
    assert.equal(bold.content, '# H\n\nHell**X**o world\n',
      'typing after Ctrl+B must serialize the stored bold mark into Markdown');
    assert.match(bold.html, /<strong[^>]*>X<\/strong>/, 'the typed character must render bold');
    assert.ok(bold.selection.anchor > 0, 'the caret must survive the edit');

    await page.keyboard.press('Control+z');
    await page.waitForFunction(value => current.content === value, source);
    assert.equal(await page.evaluate(() => current.content), source, 'undo must restore the exact source bytes');

    // Ctrl+I must follow the same path.
    await page.evaluate(() => editor.selectRange(10, 10, true));
    await page.keyboard.press('Control+i');
    await page.keyboard.type('Y');
    await page.waitForFunction(() => current.content.includes('*Y*'));
    assert.equal(await page.evaluate(() => current.content), '# H\n\nHello*Y* world\n',
      'typing after Ctrl+I must serialize the stored italic mark');
    await page.evaluate(() => { current.content = '**Hello**'; editor.replaceContent(current.content); editor.selectRange(3, 3, true); });
    await page.keyboard.press('Control+b');
    await page.keyboard.type('X');
    assert.equal(await page.evaluate(() => current.content), '**H**X**ello**', 'explicit empty stored marks turn bold off');
    assert.deepEqual(errors, []);
    console.log('PASS: stored bold/italic marks survive typing in the single formatted editor.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
