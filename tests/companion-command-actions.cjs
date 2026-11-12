const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const session = await openEditor('# Main A\n\nAlpha\n', { width: 1200, height: 700 });
  const { page } = session;
  try {
    // Two distinct documents: A is the active main document, B is pinned in
    // the reading companion. Only B is focused when the commands run.
    await page.evaluate(() => {
      const main = {
        documentId: 'main-a', path: '/tmp/main-a.md', name: 'Main A.md',
        content: '# Main A\n\nAlpha\n', saved: '# Main A\n\nAlpha\n', active: true, revision: 0
      };
      const companion = {
        documentId: 'companion-b', path: '/tmp/companion-b.md', name: 'Companion B.md',
        content: '# Companion B\n\nBeta\n', saved: '# Companion B\n\nBeta\n', active: true, revision: 0
      };
      current = main;
      registerDocument(main);
      registerDocument(companion);
      showReadingCompanion(companion, false);
      focusPane('companion');
    });
    await page.waitForFunction(() => $('companion-preview').querySelector('h1')?.textContent === 'Companion B');
    assert.equal(await page.evaluate(() => current.documentId), 'main-a');
    assert.equal(await page.evaluate(() => companionDocument.documentId), 'companion-b');
    assert.equal(await page.evaluate(() => focusedPane), 'companion');

    // The command palette must not duplicate main A while B owns focus.
    await page.evaluate(() => { window.calls.length = 0; openCommands(); });
    await page.locator('#command-search').fill('duplicate');
    assert.equal(await page.locator('#command-list .command-label').first().textContent(), 'Duplicate…');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    assert.deepEqual(
      await page.evaluate(() => window.calls.filter(call => call.command === 'duplicate_document')),
      [],
      'Duplicate must not act on the main document while the companion is focused'
    );
    assert.equal(await page.evaluate(() => current.documentId), 'main-a');
    assert.equal(await page.evaluate(() => focusedPane), 'companion');

    // Rename must likewise no-op rather than opening a rename dialog for A.
    await page.evaluate(() => { window.calls.length = 0; openCommands(); });
    await page.locator('#command-search').fill('rename');
    assert.equal(await page.locator('#command-list .command-label').first().textContent(), 'Rename…');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(() => document.getElementById('editor-action-dialog').open),
      false,
      'Rename must not open a rename dialog for the main document while the companion is focused'
    );
    assert.deepEqual(
      await page.evaluate(() => window.calls.filter(call => call.command === 'rename_document')),
      [],
      'Rename must not act on the main document while the companion is focused'
    );
    assert.equal(await page.evaluate(() => current.documentId), 'main-a');
    assert.equal(await page.evaluate(() => focusedPane), 'companion');

    // Main focus remains unaffected: the same command still targets A.
    await page.evaluate(() => { focusPane('main'); window.calls.length = 0; openCommands(); });
    await page.locator('#command-search').fill('duplicate');
    assert.equal(await page.locator('#command-list .command-label').first().textContent(), 'Duplicate…');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.calls.some(call => call.command === 'duplicate_document'));
    assert.equal(
      await page.evaluate(() => window.calls.find(call => call.command === 'duplicate_document').args.documentId),
      'main-a',
      'Duplicate still targets the main document when the main pane is focused'
    );

    assert.deepEqual(session.errors, []);
    console.log('PASS: command palette Duplicate/Rename are scoped away from the main document while the companion is focused');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
