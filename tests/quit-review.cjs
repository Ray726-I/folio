const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

const fire = (page, event, payload) => page.evaluate(({ event, payload }) => {
  for (const callback of window.listeners[event] || []) callback({ payload });
}, { event, payload });

async function editedSession(id, content, saved, path = `/tmp/${id}.md`) {
  const session = await openEditor('# Quit\n\nBody\n');
  const { page } = session;
  await page.waitForFunction(() => (window.listeners['request-close'] || []).length === 1);
  await page.evaluate(({ id, content, saved, path }) => {
    current.documentId = id;
    current.path = path;
    current.name = `${id}.md`;
    current.content = content;
    current.saved = saved;
    current.active = true;
    current.revision = 0;
    registerDocument(current);
  }, { id, content, saved, path });
  return session;
}

(async () => {
  // The in-window Quit command starts the backend sequence; it must not close
  // only the focused window.
  {
    const session = await editedSession('quit-command', 'draft', 'saved');
    try {
      const { page } = session;
      await page.evaluate(() => requestQuit());
      await page.waitForFunction(() => calls.some(call => call.command === 'request_quit'));
      assert.equal(await page.evaluate(() => calls.some(call => call.command === 'close_window')), false);
    } finally { await session.close(); }
  }

  // Cancel keeps the window open and tells the backend to stop the sequence.
  {
    const session = await editedSession('cancel-doc', 'unsaved text', 'saved text');
    try {
      const { page } = session;
      await fire(page, 'request-close', { quitToken: 71 });
      await page.waitForSelector('#confirm-dialog[open]');
      assert.equal(await page.locator('#confirm-title').textContent(), 'Save changes before closing?');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.waitForFunction(() => calls.some(call => call.command === 'quit_window_cancel'));
      assert.deepEqual(await page.evaluate(() => calls.find(call => call.command === 'quit_window_cancel').args), { token: 71 });
      assert.equal(await page.evaluate(() => calls.some(call => call.command === 'close_window')), false);
      assert.equal(await page.evaluate(() => documents.has('cancel-doc')), true);
      assert.equal(await page.evaluate(() => quitCloseState), null);
      assert.equal(await page.evaluate(() => transitionLocked), false);
    } finally { await session.close(); }
  }

  // Discard is durable before destruction, closes only via the existing
  // close_window command, and keeps the quit lock through the pending native
  // destruction so a queued autosave cannot write the discarded text.
  {
    const session = await editedSession('discard-doc', 'discarded text', 'saved text');
    try {
      const { page } = session;
      await page.evaluate(() => {
        preferences.set('autoSaveFiles', true);
        scheduleAutomaticSave(current);
        calls.length = 0;
      });
      await fire(page, 'request-close', { quitToken: 72 });
      await page.waitForSelector('#confirm-dialog[open]');
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.waitForFunction(() => calls.some(call => call.command === 'close_window'));
      const closeCall = await page.evaluate(() => calls.find(call => call.command === 'close_window').args);
      assert.equal(closeCall.quitToken, 72);
      assert.deepEqual(closeCall.discardRecovery, [{ documentId: 'discard-doc' }]);
      assert.equal(await page.evaluate(() => calls.some(call => call.command === 'recovery_saved')), false, 'frontend must not retire recovery before native destruction');
      assert.equal(await page.evaluate(() => calls.some(call => call.command === 'quit_window_cancel')), false);
      assert.equal(await page.evaluate(() => quitCloseState?.token), 72, 'lock/token remain until native destruction');
      assert.equal(await page.evaluate(() => transitionLocked), true);
      await page.waitForTimeout(1300);
      assert.equal(await page.evaluate(() => calls.some(call => call.command === 'save_document')), false, 'discarded work must not be autosaved after close');
    } finally { await session.close(); }
  }

  // A recovery cleanup failure blocks destruction and reports cancellation.
  {
    const session = await editedSession('recovery-doc', 'unsaved recovery', 'saved recovery');
    try {
      const { page } = session;
      await page.evaluate(() => {
        // A non-strict flush may run from rememberDocument and swallow the
        // error; the strict close path must still surface it.
        recoveryWriter.changed(current);
        const original = window.__TAURI__.core.invoke;
        window.__TAURI__.core.invoke = (command, args = {}) => command === 'recovery_write'
          ? Promise.reject(new Error('recovery disk full'))
          : original(command, args);
      });
      await fire(page, 'request-close', { quitToken: 73 });
      await page.waitForSelector('#confirm-dialog[open]');
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.waitForFunction(() => calls.some(call => call.command === 'quit_window_cancel'));
      assert.equal(await page.evaluate(() => calls.some(call => call.command === 'close_window')), false, 'recovery failure must prevent destruction');
      assert.equal(await page.evaluate(() => documents.has('recovery-doc')), true);
      assert.equal(await page.evaluate(() => quitCloseState), null);
      assert.equal(await page.evaluate(() => transitionLocked), false);
    } finally { await session.close(); }
  }

  // Exact failure regression: discard must not retire recovery before native
  // destruction. A rejected close_window leaves dirty work with a fresh
  // recovery revision and no recovery_saved deletion.
  {
    const session = await editedSession('failed-close', 'live dirty text', 'saved text');
    try {
      const { page } = session;
      await page.evaluate(() => {
        current.revision = 1;
        recoveryWriter.changed(current);
        const original = window.__TAURI__.core.invoke;
        window.__TAURI__.core.invoke = (command, args = {}) => {
          if (command === 'close_window') {
            calls.push({ command, args });
            return Promise.reject(new Error('window close failed'));
          }
          return original(command, args);
        };
      });
      await fire(page, 'request-close', { quitToken: 75 });
      await page.waitForSelector('#confirm-dialog[open]');
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.waitForFunction(() => calls.some(call => call.command === 'quit_window_cancel'));
      await page.waitForFunction(() => !transitionLocked);
      const evidence = await page.evaluate(() => ({
        dirty: current.content !== current.saved,
        revision: current.revision,
        closeArgs: calls.find(call => call.command === 'close_window').args,
        saved: calls.filter(call => call.command === 'recovery_saved').length,
        writes: calls.filter(call => call.command === 'recovery_write').map(call => call.args.revision)
      }));
      assert.equal(evidence.dirty, true);
      assert.equal(evidence.closeArgs.quitToken, 75);
      assert.deepEqual(evidence.closeArgs.discardRecovery, [{ documentId: 'failed-close' }]);
      assert.equal(evidence.saved, 0, 'no recovery_saved may run before destruction');
      assert.ok(evidence.revision > 1, 'failure must advance the dirty document revision');
      assert.ok(evidence.writes.some(revision => revision > 1), 'failure must write a fresh recovery snapshot');
      assert.equal(await page.evaluate(() => documents.has('failed-close')), true);
    } finally { await session.close(); }
  }

  // A timeout/cancel event closes the open prompt and unlocks without inferring
  // approval or destroying anything.
  {
    const session = await editedSession('timeout-doc', 'unsaved timeout', 'saved timeout');
    try {
      const { page } = session;
      await fire(page, 'request-close', { quitToken: 74 });
      await page.waitForSelector('#confirm-dialog[open]');
      await fire(page, 'quit-sequence-cancelled', { quitToken: 74 });
      await page.waitForFunction(() => !$('confirm-dialog').open);
      assert.equal(await page.evaluate(() => quitCloseState), null);
      assert.equal(await page.evaluate(() => transitionLocked), false);
      assert.equal(await page.evaluate(() => calls.some(call => call.command === 'close_window')), false);
      assert.equal(await page.evaluate(() => documents.has('timeout-doc')), true);
    } finally { await session.close(); }
  }

  console.log('PASS: sequential quit cancel, discard durability, autosave suppression, recovery failure, and timeout safety.');
})().catch(error => { console.error(error); process.exitCode = 1; });
