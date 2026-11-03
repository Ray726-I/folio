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
    assert.equal(await page.evaluate(() => current.content), source, 'rendering preserves exact fences');
    await blocks.first().dblclick();
    await page.locator('.folio-source-edit').waitFor();
    assert.match(await page.locator('.folio-source-edit').textContent(), /x\^2 \+ y\^2/);
    await page.keyboard.press('Escape');
    await page.locator('#document-mode-button').click(); await page.locator('#lock-document').click();
    await blocks.first().dblclick();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.folio-source-edit').count(), 0, 'lock prevents editing math source');
    assert.equal(await page.evaluate(() => current.content), source);
    assert.deepEqual(session.errors, []);
    console.log('PASS: fenced math renders safely, keeps exact source, reveals source on demand and stays locked.');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
