const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Booting narrow auto-closes the dock, so the first outline refresh
// early-returns while hidden. Widening reopens the panel, which must then
// populate instead of sitting visible with "No headings".
(async () => {
  const source = ['# Doc', '', '## One', '', '## Two', '', '## Three', ''].join('\n');
  const session = await openEditor(source, { width: 800, height: 600 });
  try {
    const { page } = session;
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => $('outline').hidden), true, 'narrow boot keeps the dock closed');
    await page.setViewportSize({ width: 1200, height: 600 });
    await page.waitForFunction(() => !$('outline').hidden, undefined, { timeout: 5000 });
    await page.waitForFunction(() => outlineEntries.length === 4, undefined, { timeout: 5000 });
    const state = await page.evaluate(() => ({
      rows: $('outline-items').querySelectorAll('.outline-row').length,
      count: $('outline-count').textContent,
    }));
    assert.equal(state.rows, 4, 'widening populates the reopened panel');
    assert.equal(state.count, '4 sections', 'count matches the populated rows');
    assert.deepEqual(session.errors, []);
    console.log('PASS: outline populates when the dock reopens on a wider viewport');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
