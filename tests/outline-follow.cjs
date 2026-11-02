const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor(Array.from({ length: 60 }, (_, i) => `## Section ${i + 1}\n\nText\n`).join('\n'), { width: 1100, height: 600 });
  try {
    const { page } = session;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => outlineEntries.length === 60);
    await page.waitForFunction(() => outlineActiveIndex >= 0);
    const position = () => page.evaluate(() => {
      const list = $('outline-items'), bounds = list.getBoundingClientRect();
      const item = outlineEntries[outlineActiveIndex].button.getBoundingClientRect();
      return { top: list.scrollTop, relative: ((item.top + item.bottom) / 2 - bounds.top) / list.clientHeight };
    });
    // Select a row that is still visible, but already approaching the bottom.
    const early = await page.evaluate(() => {
      const list = $('outline-items'); list.scrollTop = 0;
      const bounds = list.getBoundingClientRect();
      return outlineEntries.findIndex(entry => {
        const item = entry.button.getBoundingClientRect();
        return item.top > bounds.top + list.clientHeight * .78 && item.bottom < bounds.bottom;
      });
    });
    assert.ok(early > 0, 'fixture has a visible row near the bottom');
    await page.evaluate(index => setActiveOutline(index), early);
    assert.ok(Math.abs((await position()).relative - .5) < .02, 'follow starts before the row leaves view and restores context');
    const settled = (await position()).top;
    await page.evaluate(index => setActiveOutline(index + 1), early);
    assert.equal((await position()).top, settled, 'outline stays still while the highlight is within the central band');
    const before = await page.locator('#reader-scroll').evaluate(el => el.scrollTop);
    await page.evaluate(() => setActiveOutline(50));
    const visible = await page.evaluate(() => {
      const list = document.querySelector('#outline-items').getBoundingClientRect();
      const active = document.querySelector('.outline-link.active').getBoundingClientRect();
      return active.top >= list.top && active.bottom <= list.bottom;
    });
    assert.equal(visible, true, 'active heading is kept visible in outline');
    assert.ok(Math.abs((await position()).relative - .5) < .02, 'large jumps land near the middle');
    assert.equal(await page.locator('#reader-scroll').evaluate(el => el.scrollTop), before, 'following outline does not scroll document');
    const above = await page.evaluate(() => {
      const list = $('outline-items'), bounds = list.getBoundingClientRect();
      return outlineEntries.findIndex(entry => {
        const item = entry.button.getBoundingClientRect();
        return item.top >= bounds.top && item.bottom < bounds.top + list.clientHeight * .22;
      });
    });
    assert.ok(above > 0);
    await page.evaluate(index => setActiveOutline(index), above);
    assert.ok(Math.abs((await position()).relative - .5) < .02, 'upward reading also restores room before reaching the edge');
    await page.evaluate(() => setActiveOutline(0));
    assert.equal((await position()).top, 0, 'first heading clamps to the start');
    await page.evaluate(() => setActiveOutline(59));
    assert.equal(await page.locator('#outline-items').evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 1), true, 'last heading clamps to the end');
    await page.evaluate(() => {
      const reader = $('reader-scroll');
      reader.scrollTop += outlineEntries[35].element.getBoundingClientRect().top - reader.getBoundingClientRect().top - 85;
    });
    await page.waitForFunction(() => outlineActiveIndex === 35);
    assert.ok(Math.abs((await position()).relative - .5) < .02, 'document scrolling drives the same contextual following');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => setActiveOutline(20));
    await page.waitForFunction(() => {
      const list = $('outline-items'), bounds = list.getBoundingClientRect(), item = outlineEntries[20].button.getBoundingClientRect();
      return Math.abs((item.top + item.bottom) / 2 - bounds.top - list.clientHeight / 2) < 2;
    });
    // Reverse while a distant follow animation is pending. The new row is
    // already within the viewing band, so the previous animation must stop.
    await page.evaluate(() => { setActiveOutline(45); setActiveOutline(21); });
    await page.waitForFunction(() => {
      const top = $('outline-items').scrollTop;
      const state = window.outlineScrollTestState ??= { top, stable: 0 };
      state.stable = Math.abs(state.top - top) < 1 ? state.stable + 1 : 0;
      state.top = top;
      return state.stable >= 5;
    });
    const reversed = (await position()).relative;
    assert.ok(reversed >= .25 && reversed <= .75, 'rapid reversals cancel outdated smooth scrolling');
    assert.equal(await page.locator('.navigation-rail').count(), 1, 'navigation modes have a persistent left rail');
    assert.deepEqual(session.errors, []);
    console.log('PASS: outline follows early, preserves context, stays steady within the band and clamps at document ends');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
