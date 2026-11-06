const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('# Note\n\nText\n', { width: 1100, height: 800 });
  try {
    const { page, errors } = session;
    await page.evaluate(() => setDocumentMode('reading'));
    await page.waitForFunction(() => typeof window.dragDropHandler === 'function');
    await page.evaluate(paths => window.dragDropHandler({ payload: { type: 'drop', paths, position: { x: 500, y: 400 } } }), ['/tmp/screenshot.png']);
    await page.waitForFunction(() => current.content.includes('![](image.png)'), undefined, { timeout: 5000 });
    const result = await page.evaluate(() => ({ content: current.content, mode: documentMode, calls: window.imageCommandCalls }));
    assert.equal(result.content, '# Note\n\nText\n![](image.png)');
    assert.equal(result.mode, 'edit', 'dropping an image into Reading mode opens editing for the insertion');
    assert.equal(result.calls.length, 1, 'one dropped image is saved once');
    assert.equal(result.calls[0].command, 'import_document_image');
    assert.equal(result.calls[0].args.path, '/tmp/screenshot.png');
    assert.deepEqual(errors, []);
    console.log('PASS: dropped images are copied beside the document and inserted as Markdown.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
