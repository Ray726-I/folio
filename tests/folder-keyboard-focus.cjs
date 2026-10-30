const assert = require('node:assert/strict');
const path = require('node:path');
const { openEditor } = require('./editor-browser.cjs');

const folder = '/tmp/folio-folder-focus';
const notes = path.join(folder, 'notes');
const item = path.join(notes, 'item.md');
const listing = {
  path: folder,
  name: 'folio-folder-focus',
  entries: [
    { path: notes, name: 'notes', directory: true, depth: 0 },
    { path: item, name: 'item.md', directory: false, depth: 1 }
  ],
  truncated: false,
  skipped: 0
};

(async () => {
  const session = await openEditor('# H\n\ntext\n', { width: 1000, height: 700 });
  const { page, errors } = session;
  try {
    await page.waitForFunction(() => !busy);
    await session.holdFolder(folder, listing);
    await page.evaluate(path => { window.folderOpen = openFolderPath(path); }, folder);
    await page.waitForFunction(path => folderGateState(path)?.pending, folder);
    await session.releaseFolder(folder);
    await page.evaluate(() => window.folderOpen);
    await page.waitForFunction(() => !busy && activeFolder?.path === '/tmp/folio-folder-focus');
    await page.waitForFunction(() => document.querySelectorAll('#folder-items .folder-entry').length === 1);

    const row = page.locator('#folder-items .folder-entry.directory');
    await row.focus();
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('folder-entry')), true);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#folder-items .folder-entry').length === 2);

    const expanded = await page.evaluate(() => ({
      focused: document.activeElement?.dataset.path,
      expanded: document.activeElement?.getAttribute('aria-expanded'),
      names: [...document.querySelectorAll('#folder-items .folder-entry')].map(button => button.textContent.trim())
    }));
    assert.equal(expanded.focused, notes, 'expanding a folder must keep keyboard focus on that row');
    assert.equal(expanded.expanded, 'true');
    assert.deepEqual(expanded.names, ['notes', 'item.md']);

    // Collapsing again keeps focus as well; the child row disappears.
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#folder-items .folder-entry').length === 1);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.path), notes,
      'collapsing must not drop focus to the document body');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-expanded')), 'false');

    assert.deepEqual(errors, []);
    console.log('PASS: folder expansion/collapse preserves keyboard focus on the tree row.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
