const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

(async () => {
  const bundle = buildEditorBundle();
  const source = '# Math\n\n```math\nx^2 + y^2\n```\n\n```math\n\\notARealCommand\n```\n';
  const session = await openIsolatedEditor(source, bundle.outfile);
  try {
    const { page } = session;
    const blocks = page.locator('.code-container[data-language="math"]');
    await blocks.first().locator('.katex').waitFor();
    await blocks.nth(1).locator('.math-error').waitFor();
    assert.equal(await blocks.first().locator('details').getAttribute('open'), null);
    assert.notEqual(await blocks.nth(1).locator('details').getAttribute('open'), null, 'bad TeX shows editable source');
    assert.equal(await page.evaluate(() => current.content), source, 'rendering preserves exact fences');
    await page.locator('#document-mode-button').click(); await page.locator('#lock-document').click();
    await blocks.first().locator('summary').click();
    await blocks.first().locator('.code-surface code').click();
    await page.keyboard.type('Z');
    assert.equal(await page.evaluate(() => current.content), source, 'lock prevents editing math source');
    await page.locator('#document-mode-button').click(); await page.locator('#lock-document').click();
    await blocks.first().locator('.code-surface code').click();
    await page.keyboard.press('End');
    await page.keyboard.type('+1');
    await page.waitForFunction(() => current.content.includes('x^2 + y^2+1'));
    assert.notEqual(await blocks.first().locator('details').getAttribute('open'), null, 'source remains open while typing');
    assert.ok((await page.evaluate(() => current.content)).includes('```math\nx^2 + y^2+1\n```'));
    assert.deepEqual(session.errors, []);
    console.log('PASS: fenced math renders safely, keeps exact source, supports explicit editing and lock, and exposes source on failure.');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
