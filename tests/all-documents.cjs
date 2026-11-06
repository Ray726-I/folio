const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('# Example\n', { width: 1200, height: 800 });
  try {
    const { page, errors } = session;
    await page.waitForSelector('#all-documents:not([hidden])');
    assert.equal(await page.locator('#all-documents use').getAttribute('href'), '#i-tab-search', 'the all-documents control uses its own tab/search glyph');
    assert.equal(await page.locator('#all-documents').getAttribute('title'), 'All documents (Ctrl+Shift+A)');
    await page.keyboard.press('Control+Shift+A');
    await page.waitForSelector('#command-dialog[open]');
    assert.equal(await page.locator('#command-scope').textContent(), 'Open documents');
    assert.equal(await page.locator('#command-search').getAttribute('placeholder'), 'Search open documents…');
    await page.keyboard.press('Escape');
    // Ctrl+P belongs to print; the app must not intercept it for All documents.
    const printKey = await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      return { prevented: event.defaultPrevented, open: document.getElementById('command-dialog').open };
    });
    assert.deepEqual(printKey, { prevented: false, open: false });
    await page.setViewportSize({ width: 600, height: 800 });
    assert.equal(await page.locator('#all-documents').isVisible(), true, 'the control remains visible in a narrow window');
    assert.deepEqual(errors, []);
    console.log('PASS: the all-documents control is always visible, uses its own icon, and opens from Ctrl+Shift+A and leaves Ctrl+P for printing.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
