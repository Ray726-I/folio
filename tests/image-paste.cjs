const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// A minimal PNG payload; the mocked command records it and the editor inserts
// the returned file name without decoding the image in this test.
const PNG = [...Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082', 'hex')];

(async () => {
  const session = await openEditor('# Note\n\nText\n', { width: 1100, height: 800 });
  try {
    const { page, errors } = session;
    await page.evaluate(() => { setDocumentMode('edit'); editor.selectRange(current.content.length); });
    await page.evaluate(data => {
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([new Uint8Array(data)], 'screenshot.png', { type: 'image/png' }));
      document.querySelector('#preview .ProseMirror').dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: clipboard, bubbles: true, cancelable: true
      }));
    }, PNG);
    await page.waitForFunction(() => current.content.includes('![](image.png)'), undefined, { timeout: 5000 });
    const result = await page.evaluate(() => ({ content: current.content, calls: window.imageCommandCalls }));
    assert.equal(result.content, '# Note\n\nText\n![](image.png)');
    assert.equal(result.calls.length, 1, 'one pasted image is saved once');
    assert.equal(result.calls[0].command, 'save_pasted_image');
    assert.equal(result.calls[0].args.mime, 'image/png');
    assert.ok(result.calls[0].args.data.length > 0, 'the image bytes are sent to the native saver');
    assert.deepEqual(errors, []);
    console.log('PASS: pasted screenshots are saved beside the document and inserted as Markdown.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
