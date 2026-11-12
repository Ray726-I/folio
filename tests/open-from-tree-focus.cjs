const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Regression: openPath declares `const document = await invoke('open_document')`,
// which shadows the DOM document. The focus fallback then read
// document.activeElement on the opened payload (undefined) and always moved
// focus to #reader-scroll, yanking keyboard users out of the file tree.
(async () => {
  const session = await openEditor('# H\n\ntext\n', { width: 1000, height: 700 });
  const { page } = session;
  const listing = {
    path: '/tree', name: 'tree',
    entries: [
      { path: '/tree/note.md', name: 'note.md', directory: false, depth: 0 },
      { path: '/tree/other.md', name: 'other.md', directory: false, depth: 0 }
    ],
    truncated: false, skipped: 0
  };
  try {
    await page.evaluate(listing => {
      const original = window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = async (cmd, args = {}) => cmd === 'open_folder'
        ? { ...listing, entries: listing.entries.map(entry => ({ ...entry })) }
        : original(cmd, args);
    }, listing);
    await page.evaluate(() => openFolderPath('/tree'));
    await page.waitForSelector('.folder-entry[data-path="/tree/note.md"]');

    const note = page.locator('.folder-entry[data-path="/tree/note.md"]');
    await note.focus();
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.path), '/tree/note.md');
    await page.evaluate(() => requestOpen('/tree/note.md'));
    await page.waitForFunction(() => current.path === '/tree/note.md' && !busy);
    assert.equal(await page.evaluate(() => current.path), '/tree/note.md');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.path), '/tree/note.md',
      'opening a file from the tree leaves keyboard focus on that row');

    // The fallback still applies when the picker/menu opener is gone.
    await page.evaluate(() => document.activeElement.blur());
    await page.evaluate(() => requestOpen('/tree/other.md'));
    await page.waitForFunction(() => current.path === '/tree/other.md' && !busy);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'reader-scroll',
      'opening without an opener still places keyboard focus in the document');
    assert.deepEqual(session.errors, []);
    console.log('PASS: opening from the file tree keeps tree focus; body focus falls back to the reader');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
