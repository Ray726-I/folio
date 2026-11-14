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
    await page.evaluate(() => {
      const original = window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = async (command, args) => {
        if (command === 'resolve_document_link') return '/other.md';
        if (command === 'open_document') return { documentId: 'other', path: '/other.md', name: 'other.md', content: '# Other\n\nOpening text.\n\n## Section\n\nTarget text.\n', writable: true };
        return original(command, args);
      };
      const anchor = document.createElement('a'); anchor.href = 'other.md#section';
      followPreviewLink(anchor);
    });
    await page.waitForFunction(() => current.path === '/other.md' && !busy);
    assert.equal(await page.evaluate(() => editor.getSelection().head), await page.evaluate(() => current.content.indexOf('## Section')), 'cross-file link selects its heading');
    await page.keyboard.press('Control+Shift+P');
    const search = page.getByRole('combobox', { name: 'Search commands' });
    const listId = await search.getAttribute('aria-controls');
    assert.equal(await page.locator(`#${listId}`).getAttribute('role'), 'listbox', 'command combobox controls its owning listbox');
    assert.ok(await page.locator(`#${listId} [role=option]`).count() > 0);
    await page.keyboard.press('Escape');
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
  console.log('PASS: attached block picker preserves table structure');
})().catch(error => { console.error(error); process.exitCode = 1; });
