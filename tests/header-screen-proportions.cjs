const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const session = await openEditor('# Header\n\nText.\n');
  try {
    const { page } = session;
    await page.evaluate(() => Object.defineProperty(window.screen, 'availWidth', { configurable: true, value: 1920 }));
    // The Formatted/Markdown mode switch was removed, so only the compact save
    // state remains to verify against screen-relative width.
    for (const [width, hideSaved] of [[1400, false], [1250, false], [1000, true]]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      const saved = await page.locator('#save-state').evaluate(node => getComputedStyle(node).clipPath);
      assert.equal(saved === 'inset(50%)', hideSaved, `saved text at ${width}px`);
    }
    const clip = () => page.locator('#save-state').evaluate(e => getComputedStyle(e).clipPath);
    await page.locator('#preview p').click();
    await page.keyboard.type(' edit');
    assert.equal(await page.locator('#save-state').getAttribute('data-state'), 'dirty');
    assert.equal(await clip(), 'inset(50%)', 'edited status is compact at narrow widths');
    await page.evaluate(() => { document.querySelector('#save-state').dataset.state = 'error'; });
    assert.notEqual(await clip(), 'inset(50%)', 'save errors stay visible');
    await page.evaluate(() => { document.querySelector('#save-state').dataset.state = 'dirty'; });
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    assert.notEqual(await clip(), 'inset(50%)', 'edited status is visible again when there is room');
    console.log('PASS: header responds to screen-relative width and keeps only errors visible when compact.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
