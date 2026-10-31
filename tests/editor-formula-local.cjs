const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');
(async () => {
  const bundle = buildEditorBundle();
  const source = '# Formula\n\n\\[\nx^2 + y^2\n\\]\n\nInline \\(a+b\\).\n\nAfter.\n';
  const session = await openIsolatedEditor(source, bundle.outfile);
  try {
    const { page } = session;
    await page.locator('.math-block .katex').waitFor();
    assert.equal(await page.locator('.math-block .math-edit').count(), 0, 'formula has no pencil icon');
    await page.locator('.math-block .math-formula').click();
    const input = page.locator('.math-block textarea');
    await input.waitFor({ timeout: 4000 });
    assert.equal(await page.locator('#view-formatted').getAttribute('aria-pressed'), 'true');
    await input.fill('x^2 + y^2 = z^2');
    await page.locator('.math-block button', { hasText: 'Apply' }).click();
    await page.waitForFunction(() => current.content.includes('x^2 + y^2 = z^2'));
    assert.equal(await page.evaluate(() => current.content), source.replace('x^2 + y^2', 'x^2 + y^2 = z^2'));
    assert.equal(await page.locator('#view-formatted').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, source);
    await page.locator('.math-inline .math-formula').focus();
    await page.keyboard.press('Enter');
    await page.locator('.math-inline textarea').fill('a-b');
    await page.locator('.math-inline button', { hasText: 'Apply' }).click();
    await page.waitForFunction(() => current.content.includes('\\(a-b\\)'));
    await page.locator('#lock-document').click();
    assert.equal(await page.locator('.math-inline .math-formula').getAttribute('aria-disabled'), 'true');
    assert.deepEqual(session.errors, []);
    console.log('PASS: formula source edits locally in Formatted mode with exact source and undo.');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
