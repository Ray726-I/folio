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
    await blockFormula.click();
    const input = page.locator('.math-block textarea');
    await input.waitFor({ timeout: 4000 });
    assert.equal(await input.isVisible(), true, 'one click opens the formula editor');
    await page.locator('#preview .ProseMirror').waitFor({ state: 'visible' });
    await input.fill('x^2 + y^2 = z^2');
    await page.locator('.math-block button', { hasText: 'Apply' }).click();
    await page.waitForFunction(() => current.content.includes('x^2 + y^2 = z^2'));
    assert.equal(await page.evaluate(() => current.content), source.replace('x^2 + y^2', 'x^2 + y^2 = z^2'));
    await page.locator('#preview .ProseMirror').waitFor({ state: 'visible' });
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, source);
    await page.locator('.math-inline .math-formula').last().focus();
    await page.keyboard.press('Enter');
    await page.locator('.math-inline textarea').last().fill('a-b');
    await page.locator('.math-inline').last().getByRole('button', { name: 'Apply' }).click();
    await page.waitForFunction(() => current.content.includes('\\(a-b\\)'));
    await page.locator('#lock-document').click();
    assert.equal(await page.locator('.math-inline .math-formula').first().getAttribute('aria-disabled'), 'true');
    assert.deepEqual(session.errors, []);
    console.log('PASS: formula source edits locally in the formatted editor with exact source and undo.');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
