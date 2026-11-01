const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const session = await openEditor('# Header\n\nText\n');
  try {
    const { page } = session;
    await page.evaluate(() => { document.querySelector('#document-name').textContent = 'markdown-preview-showcase.md'; document.querySelector('#document-location').textContent = '/home/ray/Downloads'; });
    for (const width of [1180, 890, 640, 460]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const boxes = await page.evaluate(() => Object.fromEntries(['.header-start', '.window-title', '.header-end'].map(selector => {
        const r = document.querySelector(selector).getBoundingClientRect(); return [selector, { left:r.left, right:r.right }];
      })));
      const titleVisible = boxes['.window-title'].right - boxes['.window-title'].left > 1;
      assert.ok(!titleVisible || boxes['.header-start'].right <= boxes['.window-title'].left + 1, `left header overlaps title at ${width}px`);
      assert.ok(!titleVisible || boxes['.window-title'].right <= boxes['.header-end'].left + 1, `title overlaps controls at ${width}px`);
      assert.ok(boxes['.header-end'].right <= width, `header overflows at ${width}px`);
      assert.ok(Math.abs((boxes['.window-title'].left + boxes['.window-title'].right) / 2 - width / 2) <= 2, `title must be centered in the window at ${width}px`);
      const firstControl = await page.locator('#lock-document').boundingBox();
      assert.ok(!titleVisible || boxes['.window-title'].right <= firstControl.x + 1, `title overlaps first header control at ${width}px`);
    }
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.evaluate(() => goHome());
    await page.waitForFunction(() => document.querySelector('#document-view').hidden);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const homeTitle = await page.locator('.window-title').boundingBox();
    assert.ok(Math.abs(homeTitle.x + homeTitle.width / 2 - 590) <= 2, 'welcome title must be centered in the window');
    console.log('PASS: responsive header keeps title and controls separate.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
