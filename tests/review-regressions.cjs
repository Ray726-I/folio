const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const source = '| A | B |\n| --- | --- |\n| one | two |\n';
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.evaluate(() => {
      const offset = current.content.indexOf('one');
      editor.selectRange(offset, offset, true);
      editor.openBlockMenu();
    });
    // A block picker must refuse nested table content rather than prefix a row.
    assert.equal(await page.locator('.folio-slash-menu').count(), 0, 'block picker is unavailable within a table cell');
    assert.equal(await page.evaluate(() => current.content), source);
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
  console.log('PASS: attached block picker preserves table structure');
})().catch(error => { console.error(error); process.exitCode = 1; });
