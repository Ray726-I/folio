const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const source = '| Name | Score |\n| --- | --- |\n| Alpha | 2 |\n| Beta | 1 |\n| Gamma | 3 |\n';
  const session = await openEditor(source);
  try {
    const { page } = session;
    const hoverEdge = async edge => {
      const box = await page.locator('#preview table').boundingBox();
      const point = edge === 'bottom' ? [box.x + box.width / 2, box.y + box.height - 3]
        : edge === 'right' ? [box.x + box.width - 3, box.y + box.height / 2]
          : edge === 'top' ? [box.x + box.width / 2, box.y + 3]
            : [box.x + 3, box.y + box.height * .4];
      await page.mouse.move(...point);
    };
    await page.locator('#preview td').first().click();
    const appendRow = page.locator('.folio-table-add[data-table-append="row"]');
    const appendColumn = page.locator('.folio-table-add[data-table-append="column"]');
    await hoverEdge('bottom'); await appendRow.waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => current.content), source, 'table controls do not edit on reveal');
    await appendRow.click();
    assert.equal(await page.locator('#preview tr').count(), 5);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, source);
    await page.locator('#preview td').first().click();
    await hoverEdge('right'); await appendColumn.click();
    assert.equal(await page.locator('#preview tr').first().locator('th').count(), 3);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, source);

    await page.locator('#preview td').first().click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Table menu' });
    await menu.waitFor({ state: 'visible' });
    assert.equal(await page.locator('.folio-table-submenu:visible').count(), 0, 'opening the menu does not automatically open a submenu');
    await menu.getByRole('button', { name: 'Row submenu' }).hover();
    const boxes = await page.evaluate(() => {
      const main = document.querySelector('.folio-table-menu').getBoundingClientRect();
      const sub = document.querySelector('.folio-table-submenu:not([hidden])').getBoundingClientRect();
      return { mainRight: main.right, subLeft: sub.left, x: sub.left + 30, y: sub.top + 20 };
    });
    assert.ok(boxes.subLeft >= boxes.mainRight - 12, `submenu appears beside the main menu, not clipped inside it: ${JSON.stringify(boxes)}`);
    await page.mouse.move(boxes.x, boxes.y, { steps: 12 });
    assert.equal(await page.locator('.folio-table-submenu:visible').count(), 1, 'submenu stays open when moving into it');
    for (const label of ['Insert row above', 'Duplicate row']) assert.equal(await menu.getByRole('menuitem', { name: label, exact: true }).count(), 1, `${label} is available`);
    await menu.getByRole('button', { name: 'Column submenu' }).hover();
    for (const label of ['Insert column left', 'Duplicate column', 'Align center']) assert.equal(await menu.getByRole('menuitem', { name: label, exact: true }).count(), 1, `${label} is available`);
    assert.equal(await menu.getByRole('menuitem', { name: 'Sort ascending', exact: true }).count(), 1);
    await menu.getByRole('button', { name: 'Row submenu' }).hover();
    await menu.getByRole('menuitem', { name: 'Duplicate row' }).click();
    assert.equal(await page.locator('#preview tr').count(), 5);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, source);

    await page.locator('#preview td').first().click({ button: 'right' });
    await menu.waitFor({ state: 'visible' });
    await page.keyboard.press('ArrowDown'); // Edit Markdown
    await page.keyboard.press('ArrowDown'); // Row submenu
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('.folio-table-submenu:visible').count(), 1, 'keyboard opens the submenu');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('.folio-table-submenu:visible').count(), 0, 'keyboard returns to the main menu');
    await page.keyboard.press('Escape');
    assert.equal(await menu.isHidden(), true, 'Escape closes the main menu');

    await page.locator('#preview td').first().click();
    await hoverEdge('left');
    const row = page.locator('[data-handle-row="1"]');
    await row.focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('#preview tr').nth(1).locator('td').first().innerText(), 'Beta', 'keyboard row movement changes order');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, source);
    await page.locator('#preview td').first().click();
    await hoverEdge('left');
    const dragRow = page.locator('[data-handle-row="1"]');
    const targetRow = page.locator('#preview tr').nth(3);
    const start = await dragRow.boundingBox(), target = await targetRow.boundingBox();
    assert.ok(start && target, 'row handle and drop target exist');
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2, target.y + target.height - 1, { steps: 12 });
    await page.locator('.folio-table-drag-preview').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.folio-table-drag-source').count(), 1, 'drag marks the original row');
    const liveReorder = await page.evaluate(() => [...document.querySelectorAll('#preview tr')].map(row => {
      const style = getComputedStyle(row.querySelector('th,td'));
      return { hidden: style.visibility === 'hidden', shifted: style.transform !== 'none' };
    }));
    assert.ok(liveReorder.some(row => row.hidden), 'the dragged row is hidden while it follows the pointer');
    assert.ok(liveReorder.some(row => row.shifted), 'neighbouring rows move aside before the drop');
    await page.mouse.up();
    assert.equal(await page.locator('#preview tr').nth(1).locator('td').first().innerText(), 'Beta', 'dragging a row changes its order');
    assert.equal(await page.locator('style[data-folio-table-live]').count(), 0, 'row drag removes its scoped animation styles');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('#preview table')].some(table => [...table.classList].some(name => name.startsWith('folio-table-live-')))), false, 'row drag leaves no animation scope class');
    assert.equal(await page.evaluate(() => window.getSelection().toString()), '', 'dragging does not leave text selected');
    assert.equal(await page.locator('#preview .selectedCell').count(), 0, 'dragging does not leave a cell range selected');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, source);

    // Columns use the same live gap: neighbouring columns slide before drop.
    await page.locator('#preview td').first().click();
    await hoverEdge('top');
    const dragColumn = page.locator('[data-handle-col="0"]');
    const tableBox = await page.locator('#preview table').boundingBox();
    const columnStart = await dragColumn.boundingBox();
    await page.mouse.move(columnStart.x + columnStart.width / 2, columnStart.y + columnStart.height / 2);
    await page.mouse.down();
    await page.mouse.move(tableBox.x + tableBox.width + 4, tableBox.y + tableBox.height / 2, { steps: 12 });
    await page.locator('.folio-table-drag-preview').waitFor({ state: 'visible' });
    const liveColumns = await page.evaluate(() => [...document.querySelectorAll('#preview tr')].map(row => [...row.children].map(cell => {
      const style = getComputedStyle(cell);
      return { hidden: style.visibility === 'hidden', shifted: style.transform !== 'none' };
    })));
    assert.ok(liveColumns.every(row => row.some(cell => cell.hidden)), 'the dragged column is hidden while it follows the pointer');
    assert.ok(liveColumns.every(row => row.some(cell => cell.shifted)), 'neighbouring columns move aside before the drop');
    await page.mouse.up();
    assert.deepEqual(await page.locator('#preview tr').first().locator('th').allTextContents(), ['Score', 'Name'], 'dragging a column changes its order');
    assert.equal(await page.locator('style[data-folio-table-live]').count(), 0, 'column drag removes its scoped animation styles');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, source);

    await page.locator('#document-mode-menu-button').click(); await page.locator('#lock-document').click();
    await hoverEdge('bottom');
    assert.equal(await appendRow.isDisabled(), true, 'lock disables append');
    assert.equal(await page.evaluate(() => current.content), source);
    assert.deepEqual(session.errors, []);
    console.log('PASS: edge add controls, table context actions, keyboard arrangement, undo and lock.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
