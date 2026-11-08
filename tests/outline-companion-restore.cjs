const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// The outline panel must never show a visible-but-empty (or foreign) list:
// closing the reading companion restores the document rows, and unhiding the
// panel on a wider viewport populates it instead of stranding "No headings".
(async () => {
  const source = ['# Doc', '', '## One', '', '## Two', '', '## Three', ''].join('\n');
  const session = await openEditor(source, { width: 1100, height: 600 });
  try {
    const { page } = session;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => outlineEntries.length === 4);
    await page.evaluate(() => { showReadingCompanion(); focusPane('companion'); });
    await page.waitForFunction(() => !$('reading-companion').hidden);
    await page.waitForTimeout(800);
    await page.evaluate(() => { closeReadingCompanion(); });
    await page.waitForTimeout(300);
    const restored = await page.evaluate(() => ({
      rows: $('outline-items').querySelectorAll('.outline-row').length,
      count: $('outline-count').textContent,
    }));
    assert.equal(restored.rows, 4, 'closing the side pane restores the document rows');
    assert.equal(restored.count, '4 sections', 'count matches the restored rows');
    assert.deepEqual(session.errors, []);
    console.log('PASS: outline recovers after the reading companion closes');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
