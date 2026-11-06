const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

const BASE64 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082', 'hex').toString('base64');

(async () => {
  const session = await openEditor('# Note\n\nText\n', { width: 1000, height: 800 });
  try {
    const { page, errors } = session;
    await page.evaluate(() => { setDocumentMode('edit'); editor.selectRange(current.content.length); });
    await page.evaluate(base64 => {
      const clipboard = new DataTransfer();
      clipboard.setData('text/html', `<img src="data:image/png;base64,${base64}" alt="screenshot">`);
      document.querySelector('#preview .ProseMirror').dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: clipboard, bubbles: true, cancelable: true
      }));
    }, BASE64);
    await page.waitForFunction(() => current.content.includes('![](image.png)'), undefined, { timeout: 5000 });
    const result = await page.evaluate(() => ({ content: current.content, calls: window.imageCommandCalls }));
    assert.equal(result.content, '# Note\n\nText\n![](image.png)');
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].command, 'save_pasted_image');
    assert.equal(result.calls[0].args.data, BASE64, 'the HTML data URL payload is forwarded without re-encoding');
    assert.equal(result.calls[0].args.mime, 'image/png');
    assert.deepEqual(errors, []);
    console.log('PASS: a webview that exposes a pasted screenshot only as an HTML data URL is supported.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
