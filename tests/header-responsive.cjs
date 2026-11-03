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
      assert.ok(boxes['.window-title'].left - boxes['.header-start'].right < 20, `document title stays left-aligned with its toolbar at ${width}px`);
      const firstControl = await page.locator('#document-mode-button').boundingBox();
      assert.ok(!titleVisible || boxes['.window-title'].right <= firstControl.x + 1, `title overlaps first header control at ${width}px`);
    }
    await page.setViewportSize({ width: 600, height: 800 });
    assert.equal(await page.locator('#save').isVisible(), true, 'narrow toolbar provides a save icon');
    assert.match(await page.locator('#save').getAttribute('title'), /saved/i, 'icon exposes the save state');
    await page.evaluate(() => setOutline(false));
    assert.equal(await page.locator('#document-mode-label').isVisible(), false, 'compact modes use icons');
    for (const mode of ['reading', 'edit', 'source']) {
      await page.evaluate(mode => setDocumentMode(mode), mode);
      assert.match(await page.locator('#document-mode-button').getAttribute('aria-label'), new RegExp(mode === 'reading' ? 'Reading' : mode === 'edit' ? 'Edit' : 'Source'));
      assert.equal(await page.locator('#document-mode-button > svg').first().isVisible(), true);
    }
    await page.evaluate(() => { toggleDocumentReadOnly(); });
    assert.match(await page.locator('#document-mode-button').getAttribute('aria-label'), /Read-only/);
    await page.evaluate(() => { toggleDocumentReadOnly(); setDocumentMode('edit'); });
    await page.locator('#preview p').click();
    await page.keyboard.type(' change');
    await page.locator('#save').click();
    await page.waitForFunction(() => !busy && current.content === current.saved);
    await page.setViewportSize({ width: 1180, height: 800 });
    assert.equal(await page.locator('#save').isVisible(), true, 'wide toolbar also uses the save icon');

    await page.evaluate(() => goHome());
    await page.waitForFunction(() => document.querySelector('#document-view').hidden);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.headerbar').isVisible(), false, 'document toolbar hides on the welcome screen');
    console.log('PASS: responsive header keeps title and controls separate.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
