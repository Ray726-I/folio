const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Regression: save() captured previousPath but evaluated `owner.path !==
// previousPath` before assigning owner.path = saved.path, so pathChanged was
// always false. A first save / Save As then skipped the explorer refresh and
// the reading-companion re-render even though the document moved on disk.
(async () => {
  const session = await openEditor('# Draft\n\nBody text.\n', { width: 1200, height: 800 });
  const { page } = session;
  try {
    await page.evaluate(() => {
      window.folderEntries = [
        { path: '/work/draft.md', name: 'draft.md', directory: false, depth: 0 },
        { path: '/work/other.md', name: 'other.md', directory: false, depth: 0 }
      ];
      window.folderScans = 0;
      const original = window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = async (cmd, args = {}) => {
        if (cmd === 'open_folder') {
          ++window.folderScans;
          return { path: args.path, name: 'work', entries: window.folderEntries.map(entry => ({ ...entry })), truncated: false, skipped: 0 };
        }
        return original(cmd, args);
      };
    });
    await page.evaluate(() => openFolderPath('/work'));
    await page.waitForSelector('.folder-entry[data-path="/work/draft.md"]');
    await page.evaluate(() => openPath('/work/draft.md'));
    await page.evaluate(() => showReadingCompanion(current, true));
    await page.waitForFunction(() => document.getElementById('companion-name')?.textContent === 'test.md');

    // Save As moves the document to a new path inside the open folder.
    await page.evaluate(async () => {
      const original = window.__TAURI__.core.invoke;
      window.folderEntries.push({ path: '/work/saved.md', name: 'saved.md', directory: false, depth: 0 });
      window.__TAURI__.core.invoke = async (cmd, args = {}) => cmd === 'save_document'
        ? { path: '/work/saved.md', name: 'saved.md' }
        : original(cmd, args);
      window.saveAsResult = await save(true, false, current);
    });
    assert.equal(await page.evaluate(() => window.saveAsResult), true, 'Save As succeeds');
    assert.equal(await page.evaluate(() => current.path), '/work/saved.md');
    await page.waitForSelector('.folder-entry[data-path="/work/saved.md"]', { timeout: 2500 });
    assert.ok(await page.evaluate(() => window.folderScans) > 1, 'Save As refreshes the file explorer');
    await page.waitForFunction(() => document.getElementById('companion-name')?.textContent === 'saved.md', null, { timeout: 2500 });
    assert.equal(await page.evaluate(() => document.getElementById('companion-name').textContent), 'saved.md', 'Save As re-renders the reading companion name');

    // A brand-new document has no path yet: its first save is also a path change.
    await page.evaluate(async () => {
      await newDocument();
      const original = window.__TAURI__.core.invoke;
      window.folderEntries.push({ path: '/work/fresh.md', name: 'fresh.md', directory: false, depth: 0 });
      window.__TAURI__.core.invoke = async (cmd, args = {}) => cmd === 'save_document'
        ? { path: '/work/fresh.md', name: 'fresh.md' }
        : original(cmd, args);
      window.firstSaveResult = await save(false, false, current);
    });
    assert.equal(await page.evaluate(() => window.firstSaveResult), true, 'first save succeeds');
    assert.equal(await page.evaluate(() => current.path), '/work/fresh.md');
    await page.waitForSelector('.folder-entry[data-path="/work/fresh.md"]', { timeout: 2500 });
    assert.deepEqual(session.errors, []);
    console.log('PASS: first save and Save As refresh the explorer and reading companion when the path changes');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
