const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

async function session() {
  const s = await openEditor('# Close ownership\n\nBody\n');
  await s.page.waitForFunction(() => (window.listeners['request-close'] || []).length === 1);
  return s;
}

(async () => {
  // A queued ordinary close must refuse while a transfer owns the window.
  {
    const s = await session();
    try {
      const { page } = s;
      await page.evaluate(() => {
        let release;
        window.finishGate = new Promise(resolve => { release = resolve; });
        window.releaseFinish = release;
        window.transferDoc = {
          documentId: 'incoming', name: 'Incoming.md', path: '/tmp/incoming.md',
          content: 'incoming dirty', saved: 'incoming saved', active: true,
          writable: true, revision: 0, view: { mode: 'edit' }
        };
        const original = window.__TAURI__.core.invoke;
        window.__TAURI__.core.invoke = (command, args = {}) => {
          if (command === 'finish_window_transfer') {
            calls.push({ command, args });
            return window.finishGate;
          }
          if (command === 'close_window') { calls.push({ command, args }); return null; }
          return original(command, args);
        };
        void mountTransferredDocument({ token: 'hold-transfer', document: window.transferDoc });
      });
      await page.waitForFunction(() => transitionLocked && calls.some(call => call.command === 'finish_window_transfer'));
      await page.evaluate(() => { void requestClose(); });
      await page.waitForTimeout(120);
      assert.equal(await page.evaluate(() => $('confirm-dialog').open), false, 'ordinary close must not start over a transfer');
      assert.equal(await page.evaluate(() => calls.some(call => call.command === 'close_window')), false, 'ordinary close must not close a transferring window');
      await page.evaluate(() => window.releaseFinish());
      await page.waitForFunction(() => !transitionLocked);
      assert.equal(await page.evaluate(() => windowCloseOwned), false);
      assert.equal(await page.evaluate(() => documents.has('incoming')), true);
    } finally { await s.close(); }
  }

  // A late transfer reply must restore the prior lock, not unconditionally
  // release a close that already owns this window.
  {
    const s = await session();
    try {
      const { page } = s;
      await page.evaluate(() => {
        setTransitionLocked(true);
        windowCloseOwned = true;
        let release;
        window.finishGate = new Promise(resolve => { release = resolve; });
        window.releaseFinish = release;
        window.transferDoc = {
          documentId: 'late-incoming', name: 'Late.md', path: '/tmp/late.md',
          content: 'late content', saved: 'late saved', active: true,
          writable: true, revision: 0, view: { mode: 'edit' }
        };
        const original = window.__TAURI__.core.invoke;
        window.__TAURI__.core.invoke = (command, args = {}) => {
          if (command === 'finish_window_transfer') {
            calls.push({ command, args });
            return window.finishGate;
          }
          return original(command, args);
        };
        void mountTransferredDocument({ token: 'late-transfer', document: window.transferDoc });
      });
      await page.waitForFunction(() => calls.some(call => call.command === 'finish_window_transfer'));
      await page.evaluate(() => window.releaseFinish());
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => transitionLocked), true, 'late transfer completion must not unlock a close-owned window');
      assert.equal(await page.evaluate(() => windowCloseOwned), true);
    } finally { await s.close(); }
  }

  console.log('PASS: ordinary close refuses a transferring window and async transfer finally cannot release close ownership.');
})().catch(error => { console.error(error); process.exitCode = 1; });
