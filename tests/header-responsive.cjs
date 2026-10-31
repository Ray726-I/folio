const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const session = await openEditor('# Header\n\nText\n');
  try {
    const { page } = session;
    await page.evaluate(() => { document.querySelector('#document-name').textContent = 'markdown-preview-showcase.md'; document.querySelector('#document-location').textContent = '/home/ray/Downloads'; });
    for (const width of [890, 640, 460]) {
      await page.setViewportSize({ width, height: 800 });
      const boxes = await page.evaluate(() => Object.fromEntries(['.header-start', '.window-title', '.header-end'].map(selector => {
        const r = document.querySelector(selector).getBoundingClientRect(); return [selector, { left:r.left, right:r.right }];
      })));
      assert.ok(boxes['.header-start'].right <= boxes['.window-title'].left + 1, `left header overlaps title at ${width}px`);
      assert.ok(boxes['.window-title'].right <= boxes['.header-end'].left + 1, `title overlaps controls at ${width}px`);
      assert.ok(boxes['.header-end'].right <= width, `header overflows at ${width}px`);
      const firstControl = await page.locator('#view-switch').boundingBox();
      assert.ok(boxes['.window-title'].right <= firstControl.x + 1, `title overlaps view switch at ${width}px`);
    }
    console.log('PASS: responsive header keeps title and controls separate.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
