const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor(Array.from({ length: 60 }, (_, i) => `## Section ${i + 1}\n\nText\n`).join('\n'), { width: 1100, height: 600 });
  try {
    const { page } = session;
    await page.waitForFunction(() => outlineEntries.length === 60);
    const before = await page.locator('#reader-scroll').evaluate(el => el.scrollTop);
    await page.evaluate(() => setActiveOutline(50));
    const visible = await page.evaluate(() => {
      const list = document.querySelector('#outline-items').getBoundingClientRect();
      const active = document.querySelector('.outline-link.active').getBoundingClientRect();
      return active.top >= list.top && active.bottom <= list.bottom;
    });
    assert.equal(visible, true, 'active heading is kept visible in outline');
    assert.equal(await page.locator('#reader-scroll').evaluate(el => el.scrollTop), before, 'following outline does not scroll document');
    assert.equal(await page.locator('.navigation-rail').count(), 1, 'navigation modes have a persistent left rail');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
