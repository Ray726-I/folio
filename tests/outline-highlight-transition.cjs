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
    // Neighbouring active and hovered rows must share full-row geometry.
    // Before the row-level hover fix the hovered row was transparent while
    // its label carried an indented grey wash, so the active gutter on one
    // row plus the hovered label on the next read as one split highlight.
    const TRANSPARENT = 'rgba(0, 0, 0, 0)';
    const neighbor = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.outline-row')];
      const info = row => {
        const btn = row.querySelector('.outline-link');
        const r = row.getBoundingClientRect();
        const b = btn.getBoundingClientRect();
        return {
          rowBg: getComputedStyle(row).backgroundColor,
          btnBg: getComputedStyle(btn).backgroundColor,
          rowLeft: Math.round(r.left),
          btnLeft: Math.round(b.left),
        };
      };
      return { active: info(rows[0]), hovered: info(rows[1]) };
    });
    assert.notEqual(neighbor.active.rowBg, TRANSPARENT, 'active row carries the full-row wash');
    assert.equal(neighbor.active.btnBg, TRANSPARENT, 'active label stays transparent so the row reads as one block');
    assert.notEqual(neighbor.hovered.rowBg, TRANSPARENT, 'hovered neighbour must wash the full row, not just its label');
    assert.equal(neighbor.hovered.btnBg, TRANSPARENT, 'hovered label stays transparent because the row owns the wash');
    assert.equal(neighbor.hovered.rowLeft, neighbor.active.rowLeft, 'hover and active washes must share the same left edge');
    await page.evaluate(() => setActiveOutline(1, { instant: true }));
    await page.waitForTimeout(35);
    const background = await next.evaluate(el => getComputedStyle(el).backgroundColor);
    assert.equal(background, 'rgba(0, 0, 0, 0)', 'active row must not retain a fading, indented hover background');
    // Hovering the active row itself must keep the accent wash (active precedence).
    const activeRow = await next.evaluate(el => {
      const row = el.closest('.outline-row');
      return { rowBg: getComputedStyle(row).backgroundColor, rowLeft: Math.round(row.getBoundingClientRect().left) };
    });
    assert.equal(activeRow.rowBg, neighbor.active.rowBg, 'hovering the active row keeps its accent wash, not the hover grey');
    assert.equal(activeRow.rowLeft, neighbor.active.rowLeft, 'active wash keeps full-row geometry while hovered');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
