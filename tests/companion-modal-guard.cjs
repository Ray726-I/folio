// Modal dialogs own the keyboard. Companion shortcuts must not fire behind one:
// Ctrl+W closed the companion under the dialog, Ctrl+F opened its find bar and
// hijacked routing, and Ctrl+S reached the app save path.
const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const session = await openEditor('# First\n\nBody\n');
  const { page } = session;
  try {
    await page.evaluate(() => { showReadingCompanion(); $('companion-scroll').focus(); });
    await page.waitForSelector('#companion-preview h1');
    await page.evaluate(() => {
      window.saveCalls = 0;
      window.requestSave = () => { ++window.saveCalls; return Promise.resolve(true); };
      $('help-dialog').showModal();
    });
    assert.equal(await page.evaluate(() => document.activeElement?.closest('dialog')?.id), 'help-dialog');

    await page.keyboard.press('Control+s');
    const saveCalls = await page.evaluate(() => window.saveCalls);
    await page.keyboard.press('Control+f');
    const findOpen = await page.locator('#companion-find').isVisible();
    await page.keyboard.press('Control+w');
    const companionOpen = await page.locator('#reading-companion').isVisible();
    const focusDialog = await page.evaluate(() => document.activeElement?.closest('dialog')?.id);

    assert.equal(findOpen, false, 'Ctrl+F does not open companion find behind a modal');
    assert.equal(companionOpen, true, 'Ctrl+W does not close the underlying companion behind a modal');
    assert.equal(saveCalls, 0, 'Ctrl+S does not save behind a modal');
    assert.equal(focusDialog, 'help-dialog', 'modal keeps keyboard focus');

    await page.evaluate(() => $('help-dialog').close());
    await page.evaluate(() => $('companion-scroll').focus());
    await page.keyboard.press('Control+f');
    assert.equal(await page.locator('#companion-find').isVisible(), true, 'companion shortcuts resume after the modal closes');
    assert.deepEqual(session.errors, []);
    console.log('companion modal guard passed');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
