const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

const PNG = [...Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082', 'hex')];

(async () => {
  const session = await openEditor('# Note\n\nText\n', { width: 1000, height: 800 });
  try {
    const { page, errors } = session;
    await page.evaluate(() => {
      setDocumentMode('source');
      const input = document.getElementById('document-source');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    await page.evaluate(data => {
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([new Uint8Array(data)], 'screenshot.png', { type: 'image/png' }));
      document.getElementById('document-source').dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: clipboard, bubbles: true, cancelable: true
      }));
    }, PNG);
    await page.waitForFunction(() => current.content.includes('![](image.png)'), undefined, { timeout: 5000 });
    const result = await page.evaluate(() => ({ content: current.content, input: document.getElementById('document-source').value, mode: documentMode }));
    assert.equal(result.content, '# Note\n\nText\n![](image.png)');
    assert.equal(result.input, result.content, 'the source textarea mirrors the inserted Markdown');
    assert.equal(result.mode, 'source', 'pasting in Source mode stays in Source mode');
    assert.deepEqual(errors, []);
    console.log('PASS: image paste works through the exact source textarea as well.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
