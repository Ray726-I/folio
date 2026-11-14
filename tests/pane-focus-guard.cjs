// The main-pane focusin handler ran focusPane('main') unconditionally, while
// the companion handler guards on a pane change. Every focus move inside the
// main pane therefore paid for a full pane refresh (chrome sync, title update,
// outline reschedule). The guard must skip redundant main focus without
// changing switching semantics.
const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('# First\n\nBody\n');
  const { page } = session;
  try {
    await page.evaluate(() => {
      window.__focusPaneCalls = [];
      const original = focusPane;
      window.__restoreFocusPane = () => { focusPane = original; };
      focusPane = function (pane) { window.__focusPaneCalls.push(pane); return original.call(this, pane); };
    });

    // 1. Redundant: focus is already on main; moving focus within main must
    // not refresh the pane.
    const redundant = await page.evaluate(() => {
      window.__focusPaneCalls.length = 0;
      $('reader-scroll').focus();
      $('reader-scroll').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      return window.__focusPaneCalls.slice();
    });
    assert.equal(redundant.length, 0, `redundant main focus must not call focusPane (got ${JSON.stringify(redundant)})`);

    // 1b. Redundant focusin leaves all observable pane state untouched.
    const untouched = await page.evaluate(() => {
      const before = {
        focused: focusedPane,
        dataset: $('document-view').dataset.focusedPane,
        label: $('reading-companion').getAttribute('aria-label'),
        active: document.activeElement ? document.activeElement.id || document.activeElement.tagName : null,
      };
      $('reader-scroll').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      const after = {
        focused: focusedPane,
        dataset: $('document-view').dataset.focusedPane,
        label: $('reading-companion').getAttribute('aria-label'),
        active: document.activeElement ? document.activeElement.id || document.activeElement.tagName : null,
      };
      return { before, after };
    });
    assert.deepEqual(untouched.after, untouched.before, 'redundant main focusin changes no pane state');

    // 2. Switching semantics retained: companion -> main still updates.
    await page.evaluate(() => { showReadingCompanion(); });
    await page.waitForSelector('#companion-preview h1');
    await page.evaluate(() => { $('companion-scroll').focus(); });
    assert.equal(await page.evaluate(() => focusedPane), 'companion', 'precondition: companion holds focus');
    const switched = await page.evaluate(() => {
      window.__focusPaneCalls.length = 0;
      $('reader-scroll').focus();
      return { calls: window.__focusPaneCalls.slice(), focused: focusedPane };
    });
    assert.deepEqual(switched.calls, ['main'], `companion->main must call focusPane('main') once (got ${JSON.stringify(switched.calls)})`);
    assert.equal(switched.focused, 'main', 'companion->main updates the focused pane');
    assert.equal(await page.evaluate(() => $('document-view').dataset.focusedPane), 'main', 'dataset follows the switch back to main');

    // 3. Companion-side guard is unchanged: redundant companion focusin is inert.
    const companionRedundant = await page.evaluate(() => {
      $('companion-scroll').focus();
      window.__focusPaneCalls.length = 0;
      $('companion-scroll').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      return window.__focusPaneCalls.slice();
    });
    assert.equal(companionRedundant.length, 0, `redundant companion focus must stay inert (got ${JSON.stringify(companionRedundant)})`);

    await page.evaluate(() => window.__restoreFocusPane());
    assert.deepEqual(session.errors, []);
    console.log('PASS: redundant main focus skips pane refresh; companion->main switching retained.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
