const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

const PNG = [...Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082', 'hex')];

(async () => {
  const session = await openEditor('# Note\n\nText\n', { width: 1000, height: 800 });
  try {
    const { page, errors } = session;
    await page.evaluate(() => setDocumentMode('edit'));
    await page.locator('#document-mode-menu-button').click();
    await page.locator('#lock-document').click();
    await page.waitForFunction(() => documentReadOnly === true && editor.isLocked());
    await page.evaluate(data => {
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([new Uint8Array(data)], 'screenshot.png', { type: 'image/png' }));
      document.querySelector('#preview .ProseMirror').dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: clipboard, bubbles: true, cancelable: true
      }));
    }, PNG);
    await page.waitForTimeout(250);
    const result = await page.evaluate(() => ({ content: current.content, calls: window.imageCommandCalls.length, toast: document.getElementById('toast').textContent }));
    assert.equal(result.content, '# Note\n\nText\n');
    assert.equal(result.calls, 0, 'a read-only document must not write an image beside it');
    assert.match(result.toast, /read-only/i);
    assert.deepEqual(errors, []);
    console.log('PASS: a locked document rejects image paste without changing the document or writing files.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
