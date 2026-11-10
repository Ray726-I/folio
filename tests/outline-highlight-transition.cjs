const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const session = await openEditor('## First\n\nOne.\n\n## Second\n\nTwo.\n');
  const { page } = session;
  try {
    await page.waitForFunction(() => outlineEntries.length === 2);
    await page.evaluate(() => setActiveOutline(0, { instant: true }));
    const next = page.locator('.outline-link').nth(1);
    await next.hover();
    await page.waitForTimeout(180);
    await page.evaluate(() => setActiveOutline(1, { instant: true }));
    await page.waitForTimeout(35);
    const background = await next.evaluate(el => getComputedStyle(el).backgroundColor);
    assert.equal(background, 'rgba(0, 0, 0, 0)', 'active row must not retain a fading, indented hover background');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
