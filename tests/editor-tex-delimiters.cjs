const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

(async () => {
  const bundle = buildEditorBundle();
  const source = '# Math\n\nInline \\(E = mc^2\\) and \\(x = \\frac{1}{2}\\).\n\n\\[\nA = \\begin{bmatrix}1 & 2\\\\3 & 4\\end{bmatrix}\n\\]\n\nAfter.\n';
  const session = await openIsolatedEditor(source, bundle.outfile);
  try {
    const { page } = session;
    await page.locator('.math-inline .katex').first().waitFor({ timeout: 5000 });
    assert.equal(await page.locator('.math-inline .katex').count(), 2);
    await page.locator('.math-block .katex').first().waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate(() => current.content), source, 'preview must not rewrite delimiters');
    await page.locator('#preview p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.waitForFunction(() => current.content.endsWith('After.!\n'));
    assert.ok((await page.evaluate(() => current.content)).includes('\\[\nA = \\begin{bmatrix}'));
    await page.locator('.math-inline .math-formula').first().dblclick();
    await page.locator('.math-inline textarea').first().waitFor();
    assert.equal(await page.locator('#view-formatted').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => current.content), source.replace('After.', 'After.!'), 'editing access must preserve source');
    assert.deepEqual(session.errors, []);
    console.log('PASS: TeX delimiters render inline and display math without rewriting source.');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
