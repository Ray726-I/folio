const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const app = await openEditor('# Before\n', undefined, { bootstrap: { paths: ['/tmp/test.md'], platform: 'macos', theme: null } });
  try {
    const { page } = app;
    await page.waitForFunction(() => (window.listeners['native-menu-action'] || []).length > 0);
    await page.evaluate(() => { editor.replaceContent('# Changed\n'); openFind(); });
    const before = await page.evaluate(() => current.content);
    await page.locator('#find-input').fill('');
    await page.locator('#find-input').pressSequentially('needle');
    await page.evaluate(() => window.listeners['native-menu-action'][0]({ payload: 'undo' }));
    assert.equal(await page.evaluate(() => current.content), before, 'native Undo in Find must not undo the document');
    assert.equal(await page.locator('#find-input').inputValue(), 'needl', 'native Undo acts on the Find input');
    await page.evaluate(() => window.listeners['native-menu-action'][0]({ payload: 'redo' }));
    assert.equal(await page.evaluate(() => current.content), before, 'native Redo in Find must not redo the document');
    assert.equal(await page.locator('#find-input').inputValue(), 'needle', 'native Redo acts on the Find input');
    await page.evaluate(() => openCommands());
    assert.equal(await page.locator('#command-dialog').evaluate(dialog => dialog.open), true);
    await page.evaluate(() => window.listeners['native-menu-action'][0]({ payload: 'commands' }));
    assert.equal(await page.locator('#command-dialog').evaluate(dialog => dialog.open), false, 'native command action closes its own dialog');
    await page.evaluate(() => showHelp());
    await page.evaluate(() => window.listeners['native-menu-action'][0]({ payload: 'commands' }));
    assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.open), true, 'Help stays open under the command palette');
    assert.equal(await page.locator('#command-dialog').evaluate(dialog => dialog.open), true, 'native command toggle opens above Help');
    await page.locator('#command-search').pressSequentially('needle');
    await page.evaluate(() => window.listeners['native-menu-action'][0]({ payload: 'undo' }));
    assert.equal(await page.locator('#command-search').inputValue(), 'needl', 'Undo follows the focused command search above Help');
    await page.evaluate(() => window.listeners['native-menu-action'][0]({ payload: 'commands' }));
    assert.equal(await page.locator('#command-dialog').evaluate(dialog => dialog.open), false, 'native command toggle closes the focused top dialog');
    assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.open), true, 'the underlying Help dialog stays open');
    await page.evaluate(() => { $('help-dialog').close(); openCommands(); showHelp(); });
    await page.evaluate(() => window.listeners['native-menu-action'][0]({ payload: 'commands' }));
    assert.equal(await page.locator('#command-dialog').evaluate(dialog => dialog.open), true, 'a command dialog under Help must not be closed');
    assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.open), true, 'the top Help dialog stays open');
    const beforeOpen = await page.evaluate(() => window.calls.filter(call => call.command === 'pick_open_target').length);
    await page.evaluate(() => window.listeners['native-menu-action'][0]({ payload: 'open' }));
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'pick_open_target').length), beforeOpen, 'unrelated actions remain blocked by modals');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
  console.log('PASS: native history follows the focused Find input');
})().catch(error => { console.error(error); process.exitCode = 1; });
