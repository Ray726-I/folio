const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

const fire = (page, event, payload) => page.evaluate(({ event, payload }) => {
  for (const callback of window.listeners[event] || []) callback({ payload });
}, { event, payload });

async function sessionWithDocument(id, content, saved) {
  const session = await openEditor('# Quit race\n\nBody\n');
  const { page } = session;
  await page.waitForFunction(() => (window.listeners['request-close'] || []).length === 1);
  await page.evaluate(({ id, content, saved }) => {
    current.documentId = id;
    current.path = `/tmp/${id}.md`;
    current.name = `${id}.md`;
    current.content = content;
    current.saved = saved;
    current.active = true;
    current.revision = 0;
    registerDocument(current);
  }, { id, content, saved });
  return session;
}

(async () => {
  // While one window is under review, its lifecycle commands are blocked and
  // cannot release the lock or replace the reviewed document.
  {
    const session = await sessionWithDocument('race-doc', 'unsaved original', 'saved original');
    try {
      const { page } = session;
      await fire(page, 'request-close', { quitToken: 81 });
      await page.waitForSelector('#confirm-dialog[open]');
      assert.equal(await page.evaluate(() => transitionLocked), true);
      await page.evaluate(() => { calls.length = 0; });

      await page.evaluate(() => newDocument());
      await page.waitForTimeout(80);
      assert.equal(await page.evaluate(() => calls.some(call => call.command === 'new_document')), false, 'New document is blocked during quit close');
      assert.equal(await page.evaluate(() => transitionLocked), true, 'New document must not unlock the quit review');
      assert.equal(await page.evaluate(() => quitCloseState?.token), 81);

      await page.evaluate(() => requestOpenLocation('/tmp/blocked-quit.md'));
      await page.waitForTimeout(80);
      assert.equal(await page.evaluate(() => calls.some(call => call.command === 'open_document')), false, 'Open is blocked during quit close');
      assert.equal(await page.evaluate(() => transitionLocked), true);

      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.waitForFunction(() => calls.some(call => call.command === 'quit_window_cancel'));
      assert.equal(await page.evaluate(() => transitionLocked), false);
    } finally { await session.close(); }
  }

  // Exact reported regression: approve Discard, press Ctrl+N, then attempt the
  // next step. No unreviewed document may be created and the lock must hold.
  {
    const session = await sessionWithDocument('discard-doc', 'unsaved original', 'saved original');
    try {
      const { page } = session;
      await fire(page, 'request-close', { quitToken: 82 });
      await page.waitForSelector('#confirm-dialog[open]');
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.waitForFunction(() => calls.some(call => call.command === 'close_window'));
      assert.equal(await page.evaluate(() => transitionLocked), true);
      await page.evaluate(() => { calls.length = 0; });
      await page.keyboard.press('Control+n');
      await page.waitForTimeout(80);
      assert.equal(await page.evaluate(() => calls.some(call => call.command === 'new_document')), false, 'Ctrl+N cannot create unreviewed work during quit');
      assert.equal(await page.evaluate(() => transitionLocked), true, 'Ctrl+N cannot release the quit lock');
      assert.equal(await page.evaluate(() => current.documentId), 'discard-doc', 'the reviewed document remains active');
      assert.equal(await page.evaluate(() => quitCloseState?.token), 82);
      assert.equal(await page.evaluate(() => documents.has('discard-doc')), true);
    } finally { await session.close(); }
  }

  // A cancelled sequence event unlocks and dismisses the prompt without
  // closing the window or treating silence as approval.
  {
    const session = await sessionWithDocument('timeout-doc', 'unsaved timeout', 'saved timeout');
    try {
      const { page } = session;
      await fire(page, 'request-close', { quitToken: 83 });
      await page.waitForSelector('#confirm-dialog[open]');
      await fire(page, 'quit-sequence-cancelled', { quitToken: 83 });
      await page.waitForFunction(() => !$('confirm-dialog').open);
      assert.equal(await page.evaluate(() => quitCloseState), null);
      assert.equal(await page.evaluate(() => transitionLocked), false);
      assert.equal(await page.evaluate(() => calls.some(call => call.command === 'close_window')), false);
    } finally { await session.close(); }
  }

  // A normal accepted close also keeps ownership/lock until native
  // destruction; no new/open/autosave may run after close_window resolves.
  {
    const session = await sessionWithDocument('normal-close', 'normal dirty', 'normal saved');
    try {
      const { page } = session;
      await page.evaluate(() => {
        preferences.set('autoSaveFiles', true);
        scheduleAutomaticSave(current);
        calls.length = 0;
      });
      await page.evaluate(() => { void requestClose(); });
      await page.waitForSelector('#confirm-dialog[open]');
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.waitForFunction(() => calls.some(call => call.command === 'close_window'));
      const args = await page.evaluate(() => calls.find(call => call.command === 'close_window').args);
      assert.equal(args.quitToken, undefined);
      assert.deepEqual(args.discardRecovery, [{ documentId: 'normal-close' }]);
      assert.equal(await page.evaluate(() => transitionLocked), true, 'normal close keeps its lock after close_window resolves');
      assert.equal(await page.evaluate(() => windowCloseOwned), true);
      await page.evaluate(() => { calls.length = 0; });
      await page.evaluate(() => newDocument());
      await page.waitForTimeout(80);
      assert.equal(await page.evaluate(() => calls.some(call => call.command === 'new_document')), false, 'new work is blocked while destruction is pending');
      await page.waitForTimeout(1300);
      assert.equal(await page.evaluate(() => calls.some(call => call.command === 'save_document')), false, 'autosave is suppressed while destruction is pending');
    } finally { await session.close(); }
  }

  console.log('PASS: quit review blocks lifecycle races and timeout cancellation never infers approval.');
})().catch(error => { console.error(error); process.exitCode = 1; });
