const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

const source = '# Shortcuts\n\nPlatform-aware help.\n';

async function shortcutRows(page) {
  return page.evaluate(() => [...document.querySelectorAll('#help-content tr')]
    .map(row => [row.cells[0].textContent, row.cells[1].textContent]));
}

(async () => {
  // Exercise the native-menu setup using the test Tauri bridge, rather than
  // assuming a platform string alone means the menu has been installed.
  const mac = await openEditor(source, undefined, {
    bootstrap: { paths: ['/tmp/test.md'], platform: 'macos', theme: null }
  });
  try {
    const { page } = mac;
    await page.evaluate(async () => { if (!$('app-menubar').hidden) await initializeNativeMenu(); });
    assert.equal(await page.locator('#app-menubar').isHidden(), true, 'native menu setup hides the in-window menu');
    assert.equal(await page.evaluate(() => nativeMenuState().enabled.about), true, 'About is enabled in the native menu state');
    assert.equal(await page.evaluate(() => nativeMenuState().pickerNative), false);
    await page.evaluate(() => window.listeners['native-menu-action'][0]({ payload: 'picker-toggle' }));
    assert.equal(await page.evaluate(() => nativeMenuState().pickerNative), true, 'native picker action updates the preference');
    await page.evaluate(() => window.listeners['native-menu-action'][0]({ payload: 'picker-toggle' }));
    assert.equal(await page.evaluate(() => nativeMenuState().pickerNative), false, 'native picker action can switch back');
    await page.evaluate(() => showHelp(true));
    const rows = await shortcutRows(page);
    const row = label => rows.find(([text]) => text === label);
    assert.deepEqual(row('Next / previous tab'), ['Next / previous tab', 'Control+Tab / Control+Shift+Tab'], 'macOS help names the Control tab shortcuts');
    assert.deepEqual(row('Find / replace'), ['Find / replace', 'Ctrl+F / Edit menu for replace'], 'macOS help does not advertise Command+H for replace');
    assert.deepEqual(row('Close file / Quit'), ['Close file / Quit', 'File menu / Command+Q'], 'macOS help advertises the native Quit shortcut without assigning Command+W to Close File');
    const note = await page.locator('#help-content p').last().textContent();
    assert.match(note, /Control\+Tab \/ Control\+Shift\+Tab/, 'macOS note repeats the tab exception');
    assert.match(note, /Command\+Tab switches apps/, 'macOS note explains why Command does not replace Ctrl for tabs');
    assert.match(note, /Command\+H is macOS Hide/, 'macOS note warns that Command+H is native Hide');
    assert.match(note, /Command\+W closes the window/, 'macOS note warns that Command+W is native Close Window');
    assert.match(note, /Command\+Q quits the app/, 'macOS note warns that Command+Q is native Quit');
    assert.match(note, /Edit and File menus/, 'macOS note points at menu routes');
    assert.doesNotMatch(note, /in-window/, 'native menu help does not point to a hidden menu');
    assert.doesNotMatch(note, /^On macOS, use Command in place of Ctrl\./, 'macOS note is not a blanket substitution instruction');
    assert.deepEqual(mac.errors, []);
  } finally { await mac.close(); }

  // Non-macOS help keeps its existing wording and Ctrl shortcuts.
  const linux = await openEditor(source);
  try {
    const { page } = linux;
    await page.evaluate(() => showHelp(true));
    const rows = await shortcutRows(page);
    const row = label => rows.find(([text]) => text === label);
    assert.deepEqual(row('Next / previous tab'), ['Next / previous tab', 'Ctrl+Tab / Ctrl+Shift+Tab'], 'non-macOS help keeps its Ctrl tab row');
    assert.deepEqual(row('Find / replace'), ['Find / replace', 'Ctrl+F / Ctrl+H'], 'non-macOS help keeps its replace shortcut');
    assert.deepEqual(row('Close file / Quit'), ['Close file / Quit', 'Ctrl+W / Ctrl+Q'], 'non-macOS help keeps its close and quit shortcuts');
    assert.equal(await page.locator('#help-content p').last().textContent(), 'On macOS, use Command in place of Ctrl. Escape exits focus mode.', 'non-macOS help keeps its existing note');
    assert.deepEqual(linux.errors, []);
  } finally { await linux.close(); }

  console.log('PASS: macOS native shortcut help and non-macOS help');
})().catch(error => { console.error(error); process.exitCode = 1; });
