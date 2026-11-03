const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const source = '# Start\n\n' + 'Prose before the tables.\n\n'.repeat(30) +
    Array.from({ length: 150 }, (_, i) => `## Table ${i}\n\n| A | B |\n| --- | --- |\n| one | two |\n\n`).join('');
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.tableReads = 0;
      const rect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function (...args) {
        if (this.classList.contains('tableWrapper')) window.tableReads++;
        return rect.apply(this, args);
      };
    });
    const paragraph = await page.locator('#preview p').first().boundingBox();
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(paragraph.x + 20 + i * 10, paragraph.y + 8);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    const reads = await page.evaluate(() => window.tableReads);
    assert.ok(reads < 20, `hovering prose must not measure all offscreen tables (${reads} reads)`);
    // Newly scrolled-in tables must expose gutter controls immediately; no
    // observer delivery delay may make an edge permanently undiscoverable.
    const table = page.locator('#preview table').first();
    await table.scrollIntoViewIfNeeded();
    const box = await table.boundingBox();
    await page.mouse.move(box.x - 18, box.y + box.height * .6);
    const handle = page.locator('.folio-table-handle-row');
    await handle.waitFor({ state: 'visible' });
    const beforeScroll = await page.locator('#reader-scroll').evaluate(el => el.scrollTop);
    await page.locator('#reader-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await handle.waitFor({ state: 'hidden' });
    await page.locator('#reader-scroll').evaluate((el, top) => { el.scrollTop = top; }, beforeScroll);
    await handle.waitFor({ state: 'visible', timeout: 2000 });
    await handle.focus();
    const identity = await handle.evaluate(el => { window.originalHandle = el; return el.dataset.handleRow; });
    await page.locator('#reader-scroll').evaluate(el => { el.scrollTop += 2; });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await handle.evaluate(el => el === window.originalHandle), true, 'scroll preserves the focused handle node');
    assert.equal(await page.evaluate(() => document.activeElement === window.originalHandle), true, 'scroll preserves keyboard focus');
    assert.equal(await handle.getAttribute('data-handle-row'), identity);
    assert.equal(await page.evaluate(() => current.content), source, 'hover and scroll preserve exact Markdown');
    assert.deepEqual(session.errors, []);
    console.log('PASS: table hover bounds geometry work and scroll preserves focused controls.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
