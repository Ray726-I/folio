'use strict';
const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const source = '# Tables\n\n| A | B |\n| --- | --- |\n' + Array.from({length: 80}, (_, i) => `| row ${i} | value ${i} |\n`).join('') + '\nAfter.\n';
  const session = await openEditor(source);
  try {
    const { page, errors } = session;
    await page.evaluate(() => editor.selectRange(current.content.indexOf('value 0') + 5));
    await page.mouse.move(2,2);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.folio-table-add:not([hidden]), .folio-table-handles:not([hidden])').count(), 0);
    await page.evaluate(() => {
      window.__tableLayoutReads = 0;
      const bounds = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function() {
        if (this.classList.contains('tableWrapper')) __tableLayoutReads++;
        return bounds.call(this);
      };
    });
    await page.keyboard.type('xyz');
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => __tableLayoutReads), 0, 'typing with hidden table controls never measures table overlay geometry');
    assert.ok(await page.evaluate(() => current.content.includes('valuexyz 0')));
    await page.keyboard.press('Control+z');
    await page.waitForFunction(value => current.content === value, source);
    assert.deepEqual(errors, []);
    console.log('PASS: hidden table controls do not force table layout while typing, with exact source and undo.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
