const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const source = '# Hello\n\n## World\n';
  let session = await openEditor(source);
  try {
    const { page } = session;
    const tail = page.locator('.editor-trailing-input');
    await tail.click({ timeout: 5000 });
    assert.equal(await page.evaluate(() => current.content), source, 'focusing the trailing line is zero-write');
    await page.keyboard.type('New paragraph');
    await page.waitForFunction(() => current.content.includes('New paragraph'));
    assert.match(await page.evaluate(() => current.content), /## World\n\nNew paragraph/);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, source);
    await page.locator('.editor-trailing-input').click();
    await page.keyboard.type('/');
    await page.locator('.folio-slash-menu').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await page.evaluate(() => current.content), source + '\n/', 'slash remains in the document while suggestions are open');
    await page.getByRole('option', { name: 'Heading 2', exact: true }).click();
    await page.keyboard.type('Heading');
    await page.waitForFunction(() => current.content.includes('## Heading'));
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, source);
    assert.equal(await page.locator('#context-heading-tools').count(), 0, 'no heading marker toolbar');
    await page.locator('#preview h2').click();
    const marker = page.locator('#preview h2 .folio-heading-source');
    await marker.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await marker.inputValue(), '## World', 'inline editing exposes the whole heading Markdown');
    assert.equal(await page.locator('#preview h2 .folio-heading-source-dim').first().isVisible(), false, 'the rendered heading is not duplicated beside its Markdown');
    await page.waitForFunction(() => document.activeElement?.classList.contains('folio-heading-source'), null, { timeout: 5000 });
    await marker.fill('### World');
    await page.waitForFunction(() => current.content.includes('### World'));
    assert.equal(await page.evaluate(() => current.content), '# Hello\n\n### World\n');
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
  session = await openEditor('| A | B |\n| --- | --- |\n| x | y |\n');
  try {
    const { page } = session;
    await page.locator('#preview td').first().click();
    const add = page.locator('.folio-table-add[data-table-append="row"]');
    const tableBox = await page.locator('#preview table').boundingBox();
    await page.mouse.move(tableBox.x + tableBox.width / 2, tableBox.y + tableBox.height - 3);
    await add.waitFor({ state: 'visible', timeout: 5000 });
    await add.click();
    assert.equal(await page.locator('#preview tr').count(), 3);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelectorAll('#preview tr').length === 2);
    const original = await page.evaluate(() => current.content);
    await page.locator('.editor-trailing-input').click();
    assert.equal(await page.evaluate(() => current.content), original, 'focusing after a table does not change source');
    await page.keyboard.type('After table');
    await page.waitForFunction(() => current.content.includes('After table'));
    assert.match(await page.evaluate(() => current.content), /\| x \| y \|\n\nAfter table/);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, original);
    await page.locator('#lock-document').click();
    assert.equal(await page.locator('.editor-trailing-input').isDisabled(), true, 'the trailing input respects document lock');
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
  session = await openEditor('First paragraph.\n\nLast paragraph.\n');
  try {
    const { page } = session;
    await page.locator('#preview p').last().click();
    await page.keyboard.press('End'); await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    await page.locator('.folio-slash-menu').waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.type('heading 3');
    await page.keyboard.press('Enter');
    await page.keyboard.type('New title');
    await page.waitForFunction(() => current.content.includes('### New title'));
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
  console.log('PASS: trailing writing area, contextual heading marker and table controls.');
})().catch(error => { console.error(error); process.exitCode = 1; });
