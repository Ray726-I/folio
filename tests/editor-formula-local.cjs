const { openMarkdown } = require('./editor-test-actions.cjs');
const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');
(async () => {
  const bundle = buildEditorBundle();
  const source = '# Formula\n\n\\[\nx^2 + y^2\n\\]\n\nInline \\(a+b\\).\n\nAfter.\n';
  const session = await openIsolatedEditor(source, bundle.outfile);
  try {
    const { page } = session;
    await page.locator('.math-block .katex').waitFor();
    assert.equal(await page.locator('.math-block .math-edit').count(), 0, 'formula editing does not require a separate button');
    assert.equal(await page.locator('.math-block .math-formula').getAttribute('aria-label'), 'Edit formula');
    const blockFormula = page.locator('.math-block .math-formula');
    await openMarkdown(blockFormula);
    const markdown = page.locator('.folio-source-edit');
    assert.match(await markdown.textContent(), /x\^2 \+ y\^2/);
    await markdown.evaluate(element => window.getSelection().selectAllChildren(element));
    await page.waitForFunction(() => { const selection = editor.getSelection(); return selection.anchor !== selection.head; });
    await page.keyboard.insertText('\\[\nx^2 + y^2 = z^2\n\\]');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => current.content), source.replace('x^2 + y^2', 'x^2 + y^2 = z^2'));
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, source);
    await page.locator('.math-inline .math-formula').last().focus();
    await page.keyboard.press('Enter');
    assert.match(await markdown.textContent(), /Inline/);
    await page.keyboard.press('Escape');
    await page.locator('#document-mode-button').click(); await page.locator('#lock-document').click();
    assert.equal(await page.locator('.math-inline .math-formula').first().getAttribute('aria-disabled'), 'true');
    assert.deepEqual(session.errors, []);
    console.log('PASS: formula source edits locally in the formatted editor with exact source and undo.');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
