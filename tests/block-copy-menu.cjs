const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Block copying lives in the context menus: formulas copy their TeX, code
// fences copy inner code (mermaid labelled as such), tables copy exact
// Markdown, and any other block copies its exact source. No floating button
// is ever parked on the page.
(async () => {
  const source = ['# Demo', '', 'A plain paragraph.', '', '$$', 'E = mc^2', '$$', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', '```mermaid', 'flowchart TD', '  A-->B', '```', '', '```js', 'const value = 1;', '```', ''].join('\n');
  const session = await openEditor(source, { width: 1100, height: 700 });
  try {
    const { page } = session;
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedCode = text; } }, configurable: true }); });
    await page.waitForFunction(() => document.querySelector('.math-block') && document.querySelector('table') && document.querySelectorAll('.code-container').length >= 2);
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.code-copy').count(), 0, 'no floating copy button exists');
    const docMenu = page.locator('.folio-document-menu');
    await page.locator('.math-block').first().click({ button: 'right' });
    await docMenu.waitFor({ state: 'visible' });
    await docMenu.getByRole('menuitem', { name: 'Copy formula' }).click();
    assert.equal(await page.evaluate(() => window.copiedCode), 'E = mc^2', 'formula copies its TeX source');
    await page.locator('.code-container').first().click({ button: 'right' });
    await docMenu.waitFor({ state: 'visible' });
    await docMenu.getByRole('menuitem', { name: 'Copy mermaid code' }).click();
    assert.equal(await page.evaluate(() => window.copiedCode), 'flowchart TD\n  A-->B', 'mermaid copies diagram source');
    await page.locator('.code-container').nth(1).click({ button: 'right' });
    await docMenu.waitFor({ state: 'visible' });
    await docMenu.getByRole('menuitem', { name: 'Copy code' }).click();
    assert.equal(await page.evaluate(() => window.copiedCode), 'const value = 1;', 'fence copies inner code');
    await page.locator('#preview p').first().click({ button: 'right' });
    await docMenu.waitFor({ state: 'visible' });
    await docMenu.getByRole('menuitem', { name: 'Copy block' }).click();
    assert.equal(await page.evaluate(() => window.copiedCode), 'A plain paragraph.\n', 'plain blocks copy exact source');
    const tableMenu = page.locator('.folio-table-menu');
    await page.locator('table td').first().click({ button: 'right' });
    await tableMenu.waitFor({ state: 'visible' });
    await tableMenu.getByRole('menuitem', { name: 'Copy table' }).click();
    assert.equal(await page.evaluate(() => window.copiedCode), '| A | B |\n|---|---|\n| 1 | 2 |\n', 'tables copy exact source');
    assert.deepEqual(session.errors, []);
    console.log('PASS: context menus copy formulas, mermaid, code, blocks and tables');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
