const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const original = '# Title\n\nImportant text.\n';
  const session = await openEditor(original);
  try {
    const { page } = session;
    await page.locator('#preview p').click();
    await page.keyboard.press('Control+a');
    const prevented = await page.evaluate(() => {
      const event = new Event('cut', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: {
        setData() { throw new DOMException('Clipboard unavailable', 'NotAllowedError'); }
      } });
      document.querySelector('#preview .ProseMirror').dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(await page.evaluate(() => current.content), original,
      'a failed clipboard write must not delete selected source');
    assert.equal(prevented, true, 'clipboard failure must not fall through to browser cut');
    assert.deepEqual(session.errors, []);
    console.log('PASS: failed clipboard writes preserve selected source and prevent native cut fallback.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
