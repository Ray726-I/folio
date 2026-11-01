const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

(async () => {
  const source = '- [ ] Formula $a^2+b^2=c^2$ survives\n- [x] Another task\n';
  const bundle = buildEditorBundle();
  const session = await openIsolatedEditor(source, bundle.outfile);
  try {
    const { page } = session;
    assert.equal(await page.locator('.extension-source-editor').count(), 0, 'supported math does not put the list in a raw source editor');
    assert.equal(await page.locator('#preview li input[type=checkbox]').count(), 2);
    await page.locator('#preview .math-inline .katex').waitFor();
    await page.locator('#preview li input[type=checkbox]').first().check();
    assert.ok((await page.evaluate(() => current.content)).includes('- [x] Formula $a^2+b^2=c^2$ survives'));
    await page.locator('#preview li').first().locator('.list-content').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' edited');
    await page.waitForFunction(() => current.content.includes('survives edited'));
    assert.ok((await page.evaluate(() => current.content)).includes('$a^2+b^2=c^2$'));
    assert.deepEqual(session.errors, []);
    console.log('PASS: task lists with multi-exponent math remain directly editable and render formulas.');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
