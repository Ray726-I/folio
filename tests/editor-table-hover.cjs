const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const source = 'Intro.\n\n| A | B |\n| --- | --- |\n| one | two |\n| three | four |\n';
  const session = await openEditor(source);
  try {
    const { page } = session;
    const table = page.locator('#preview table');
    await table.waitFor();
    const box = await table.boundingBox();
    await page.mouse.move(box.x + box.width * 0.25, box.y + 2);
    await page.waitForFunction(() => [...document.querySelectorAll('.folio-table-handle')].some(node => node.dataset.handleCol !== undefined && getComputedStyle(node).opacity !== '0'));
    let visible = await page.locator('.folio-table-handle').evaluateAll(nodes => nodes.filter(node => getComputedStyle(node).opacity !== '0').length);
    assert.equal(visible, 1, 'only the hovered column handle is visible');
    assert.equal(await page.evaluate(() => current.content), source, 'hovering does not modify source');
    await page.mouse.move(box.x + 2, box.y + box.height * 0.6);
    await page.waitForFunction(() => [...document.querySelectorAll('.folio-table-handle')].some(node => node.dataset.handleRow !== undefined && getComputedStyle(node).opacity !== '0'));
    visible = await page.locator('.folio-table-handle').evaluateAll(nodes => nodes.filter(node => getComputedStyle(node).opacity !== '0').length);
    assert.equal(visible, 1, 'only the hovered row handle is visible');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3);
    const addRow = page.locator('.folio-table-add[data-table-append="row"]');
    await addRow.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('.folio-table-add[data-table-append="column"]').isHidden(), true, 'only the bottom control appears');
    const addBox = await addRow.boundingBox();
    await page.mouse.move(addBox.x + addBox.width / 2, addBox.y + addBox.height / 2, { steps: 10 });
    assert.equal(await addRow.isVisible(), true, 'the control stays visible while the pointer crosses to it');
    assert.deepEqual(session.errors, []);
    console.log('PASS: a single table edge handle appears on hover before clicking and does not change Markdown.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
