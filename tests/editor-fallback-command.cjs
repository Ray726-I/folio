const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

// Force-source documents intentionally never mount the rich engine. Formatting
// commands must still work against the source buffer instead of throwing on a
// null rich controller.
(async () => {
  const bundle = buildEditorBundle();
  process.on('exit', () => bundle.cleanup());
  const source = '# H\n\nHello plain\n';
  const session = await openIsolatedEditor(source, bundle.outfile, { width: 900, height: 620 });
  const { page, errors } = session;
  try {
    await page.waitForFunction(() => !editor.isSource());
    await page.evaluate(() => editor.setFallback(true));
    await page.waitForFunction(() => editor.isSource());

    await page.evaluate(() => editor.selectRange(11, 16, true));
    await page.evaluate(() => editor.command('bold'));
    await page.waitForFunction(() => current.content.includes('**plain**'));
    assert.equal(await page.evaluate(() => current.content), '# H\n\nHello **plain**\n',
      'a fallback document applies bold through the source buffer');
    await page.evaluate(() => editor.undo());
    await page.waitForFunction(() => current.content === '# H\n\nHello plain\n');

    await page.evaluate(() => editor.selectRange(11, 16, true));
    await page.evaluate(() => editor.command('link'));
    await page.waitForFunction(() => current.content.includes('[plain](https://example.com)'));
    assert.equal(await page.evaluate(() => current.content), '# H\n\nHello [plain](https://example.com)\n',
      'Link inserts usable syntax in the source-only fallback');

    assert.deepEqual(errors, []);
    console.log('PASS: formatting commands work in source-only fallback without a null crash.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
