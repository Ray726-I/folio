const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');
(async () => {
  const bundle = buildEditorBundle();
  const source = '# Before\n\nMarkdown\n: A lightweight markup language.\n\nRenderer\n: Software that renders Markdown.\n\n## After\n\nUnchanged paragraph.\n';
  const session = await openIsolatedEditor(source, bundle.outfile);
  const { page } = session;
  try {
    await page.locator('.extension-preview dl').first().waitFor();
    await page.locator('.extension-preview dt').first().click();
    const input = page.locator('.extension-source-editor textarea:visible');
    await input.waitFor({ timeout: 3000 });
    assert.equal(await page.evaluate(() => current.content), source, 'revealing source preserves bytes');
    assert.equal(await input.evaluate(el => document.activeElement === el && el.selectionStart === el.selectionEnd), true, 'source receives a caret rather than selecting the entire block');
    const block = await input.inputValue();
    assert.match(block, /Markdown\n: A lightweight markup language\./);
    await input.fill(block.replace('lightweight', 'readable'));
    await input.press('Control+Enter');
    await page.locator('.extension-preview dl').first().waitFor();
    assert.equal(await page.evaluate(() => current.content), source.replace('lightweight', 'readable'));
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => current.content), source, 'undo preserves surrounding source');
    await page.evaluate(() => setDocumentMode('reading'));
    await page.locator('.extension-preview dt').first().click();
    assert.equal(await page.locator('.extension-source-editor textarea:visible').count(), 0, 'Reading stays protected');
    assert.deepEqual(session.errors, []);
    console.log('PASS: click definition list reveals exact local Markdown, caret, commit, undo and Reading protection');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
