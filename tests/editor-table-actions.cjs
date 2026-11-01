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
    await menu.getByRole('button', { name: 'Row submenu' }).hover();
    for (const label of ['Insert row above', 'Duplicate row']) assert.equal(await menu.getByRole('menuitem', { name: label, exact: true }).count(), 1, `${label} is available`);
    await menu.getByRole('button', { name: 'Column submenu' }).hover();
    for (const label of ['Insert column left', 'Duplicate column', 'Align center']) assert.equal(await menu.getByRole('menuitem', { name: label, exact: true }).count(), 1, `${label} is available`);
    assert.equal(await menu.getByRole('menuitem', { name: 'Sort ascending', exact: true }).count(), 1);
    await menu.getByRole('button', { name: 'Row submenu' }).hover();
    await menu.getByRole('menuitem', { name: 'Duplicate row' }).click();
    assert.equal(await page.locator('#preview tr').count(), 5);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, source);

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
    await page.mouse.up();
    assert.equal(await page.locator('#preview tr').nth(1).locator('td').first().innerText(), 'Beta', 'dragging a row changes its order');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, source);
    await page.locator('#lock-document').click();
    await hoverEdge('bottom');
    assert.equal(await appendRow.isDisabled(), true, 'lock disables append');
    assert.equal(await page.evaluate(() => current.content), source);
    assert.deepEqual(session.errors, []);
    console.log('PASS: edge add controls, table context actions, keyboard arrangement, undo and lock.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
