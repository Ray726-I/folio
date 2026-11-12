const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('# Example\n', { width: 1200, height: 800 });
  try {
    const { page, errors } = session;
    assert.equal(await page.locator('#all-documents').isVisible(), false, 'All documents is not in the toolbar');
    await page.locator('#document-more-button').hover();
    await page.waitForFunction(() => !document.getElementById('document-more-menu').hidden);
    assert.equal(await page.locator('#document-more-button').getAttribute('aria-expanded'), 'true', 'hover opens document actions');
    await page.mouse.click(600, 400);
    await page.waitForFunction(() => document.getElementById('document-more-menu').hidden);
    await page.locator('#document-more-button').click();
    await page.locator('#all-documents').click();
    assert.equal(await page.locator('#command-scope').textContent(), 'Open documents');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+P');
    await page.locator('#command-search').fill('Ctrl+Shift+F');
    assert.match(await page.locator('#command-list').innerText(), /Search folder contents/);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+A');
    await page.waitForSelector('#command-dialog[open]');
    assert.equal(await page.locator('#command-scope').textContent(), 'Open documents');
    assert.equal(await page.locator('#command-search').getAttribute('placeholder'), 'Search open documents…');
    await page.keyboard.press('Escape');
    // Ctrl+P opens fuzzy file search; Ctrl+Shift+A stays scoped to open tabs.
    const quickOpenKey = await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      return { prevented: event.defaultPrevented, open: document.getElementById('command-dialog').open };
    });
    assert.deepEqual(quickOpenKey, { prevented: true, open: true });
    assert.equal(await page.locator('#command-scope').textContent(), 'Quick open');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 600, height: 800 });
    assert.equal(await page.locator('#all-documents').isVisible(), false, 'the toolbar remains clear at narrow widths');
    assert.deepEqual(errors, []);
    console.log('PASS: All documents opens from the menu and keyboard, and folder search is discoverable by shortcut.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
