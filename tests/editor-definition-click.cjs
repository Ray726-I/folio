const { openMarkdown } = require('./editor-test-actions.cjs');
const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');
(async () => {
  const bundle = buildEditorBundle();
  const source = '# Before\n\nMarkdown\n: A lightweight markup language.\n\nRenderer\n: Software that renders Markdown.\n\n## After\n\nUnchanged paragraph.\n';
  const session = await openIsolatedEditor(source, bundle.outfile);
  const { page } = session;
  try {
    await page.locator('.extension-preview dl').first().waitFor();
    await page.locator('.extension-preview dt').first().click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Document menu' });
    await menu.waitFor();
    await page.locator('.extension-preview').first().evaluate(element => { element.innerHTML = element.innerHTML; });
    await menu.getByRole('menuitem', { name: 'Edit Markdown' }).click();
    await page.locator('.folio-source-edit').waitFor({ timeout: 3000 });
    assert.equal(await page.evaluate(() => current.content), source, 'revealing source preserves bytes');
    assert.match(await page.locator('.folio-source-edit').textContent(), /Markdown\n: A lightweight markup language\./);
    await page.keyboard.press('Escape');
    await page.evaluate(() => setDocumentMode('reading'));
    await openMarkdown(page.locator('.extension-preview dt').first());
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.folio-source-edit').count(), 0, 'Reading stays protected');
    assert.deepEqual(session.errors, []);
    console.log('PASS: using the context menu on a definition list reveals exact local Markdown and Reading stays protected');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
