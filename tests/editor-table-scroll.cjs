const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Table chrome lives in a fixed viewport layer on document.body, outside the
// reader's scroll container. When the table is horizontally scrollable, wheel
// input over a row/column handle must still scroll the reader vertically and
// the table wrapper horizontally; otherwise the handle "freezes" scrolling
// the moment it appears under a stationary cursor.
function wideSource() {
  const row = cells => `| ${cells.join(' | ')} |\n`;
  const columns = 18;
  let source = 'Intro paragraph.\n\n';
  for (let i = 0; i < 8; i++) source += `Paragraph ${i} with enough text to make the reader scroll a long way.\n\n`;
  source += row(Array.from({ length: columns }, (_, i) => `Column ${i}`));
  source += row(Array.from({ length: columns }, () => '---'));
  for (let r = 0; r < 24; r++) source += row(Array.from({ length: columns }, (_, c) => `r${r}c${c} data`));
  return source + '\nAfter table.\n';
}

const targetClass = (page, x, y) => page.evaluate(([x, y]) => {
  const element = document.elementFromPoint(x, y);
  return element ? element.className : null;
}, [x, y]);

(async () => {
  const session = await openEditor(wideSource());
  try {
    const { page } = session;
    await page.locator('#preview table').waitFor();
    await page.waitForTimeout(600);
    const reader = page.locator('#reader-scroll');
    const wrapper = page.locator('#preview .tableWrapper');
    assert.ok(await wrapper.evaluate(node => node.scrollWidth > node.clientWidth), 'fixture table is horizontally scrollable');

    const reset = async () => {
      await reader.evaluate(node => { node.scrollTop = 400; });
      await wrapper.evaluate(node => { node.scrollLeft = 0; });
      await page.waitForTimeout(350);
    };
    const tableBox = () => page.locator('#preview table').boundingBox();
    const rowCss = async () => {
      const box = await tableBox();
      const cell = await page.locator('#preview table tr').nth(3).locator('td,th').first().boundingBox();
      return { x: box.x - 18, y: cell.y + cell.height / 2 };
    };
    const columnCss = async () => {
      const box = await tableBox();
      const cell = await page.locator('#preview table tr').first().locator('td,th').first().boundingBox();
      return { x: cell.x + cell.width / 2, y: box.y - 18 };
    };

    // Row handle: a stationary pointer over the handle scrolls the reader.
    await reset();
    let point = await rowCss();
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(200);
    assert.match(await targetClass(page, point.x, point.y), /folio-table-handle-row/, 'row handle sits under the stationary pointer');
    const beforeRow = await reader.evaluate(node => node.scrollTop);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(350);
    const afterRow = await reader.evaluate(node => node.scrollTop);
    assert.ok(afterRow > beforeRow, `wheel over the row handle scrolls the reader vertically (${beforeRow} -> ${afterRow})`);

    // Column handle: vertical wheel also scrolls the reader.
    await reset();
    point = await columnCss();
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(200);
    assert.match(await targetClass(page, point.x, point.y), /folio-table-handle-col/, 'column handle sits under the stationary pointer');
    const beforeColumn = await reader.evaluate(node => node.scrollTop);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(350);
    const afterColumn = await reader.evaluate(node => node.scrollTop);
    assert.ok(afterColumn > beforeColumn, `wheel over the column handle scrolls the reader vertically (${beforeColumn} -> ${afterColumn})`);

    // Column handle: horizontal wheel scrolls the table wrapper.
    await reset();
    point = await columnCss();
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(200);
    await page.mouse.wheel(300, 0);
    await page.waitForTimeout(350);
    const handleScrollLeft = await wrapper.evaluate(node => node.scrollLeft);
    assert.ok(handleScrollLeft > 0, `wheel over the column handle scrolls the table horizontally (${handleScrollLeft})`);

    // Row handle: horizontal wheel also pans the table wrapper.
    await reset();
    point = await rowCss();
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(200);
    await page.mouse.wheel(300, 0);
    await page.waitForTimeout(350);
    const rowHandleScrollLeft = await wrapper.evaluate(node => node.scrollLeft);
    assert.ok(rowHandleScrollLeft > 0, `wheel over the row handle scrolls the table horizontally (${rowHandleScrollLeft})`);

    // Control: wheel over table content still scrolls the wrapper.
    await wrapper.evaluate(node => { node.scrollLeft = 0; });
    const box = await tableBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 100);
    await page.mouse.wheel(300, 0);
    await page.waitForTimeout(350);
    const bodyScrollLeft = await wrapper.evaluate(node => node.scrollLeft);
    assert.ok(bodyScrollLeft > 0, `wheel over table content scrolls the table horizontally (${bodyScrollLeft})`);

    assert.deepEqual(session.errors, []);
    console.log('PASS: wheel over table handles scrolls the reader and table without stealing the gesture.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
