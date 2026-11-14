const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const s = await openEditor('# Main\n\nNo result here.\n');
  try {
    const { page } = s;
    await page.evaluate(() => {
      current.documentId = 'main'; current.path = '/docs/main.md'; registerDocument(current);
      activeFolder = { path: '/docs', name: 'docs' }; openFolderSearch();
      registerDocument({ documentId: 'inactive', path: '/docs/inactive.md', name: 'inactive.md', content: 'NEEDLE unsaved\n', saved: 'disk content\n', active: true, writable: true });
      registerDocument({ documentId: 'removed', path: '/docs/removed.md', name: 'removed.md', content: 'deleted in buffer\n', saved: 'NEEDLE disk\n', active: true, writable: true });
      const original = window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = async (command, args) => command === 'search_folder'
        ? { results: [{ path: '/docs/removed.md', name: 'removed.md', offset: 0, line: 1, length: 11, snippet: 'NEEDLE disk' }], truncated: false }
        : original(command, args);
      $('folder-search-input').value = 'NEEDLE';
      return searchFolderContents();
    });
    assert.deepEqual(await page.locator('.grep-file h3').allTextContents(), ['inactive.md'], 'inactive live buffers replace their disk results');
    await page.locator('.grep-match').click();
    await page.waitForFunction(() => current.documentId === 'inactive' && !busy);
    assert.equal(await page.evaluate(() => current.content.slice(editor.getSelection().anchor, editor.getSelection().head)), 'NEEDLE');
    await page.evaluate(() => { $('folder-search-input').value = 'NEEDLE -in:inactive.md'; return searchFolderContents(); });
    assert.equal(await page.locator('.grep-match').count(), 0, 'path filters also apply to inactive buffers');
    assert.deepEqual(s.errors, []);
    console.log('PASS: folder search overlays inactive buffers, removes stale disk hits and respects filters');
  } finally { await s.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
