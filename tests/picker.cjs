const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(os.tmpdir(), 'folio-picker');
const fileA = path.join(root, 'opened.md');
const fileB = path.join(root, 'typed.md');
const notes = path.join(root, 'notes');
const noteItem = path.join(notes, 'item.md');

const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
let errors = [];

async function installMock(page, { truncated = false, seedPicker = null } = {}) {
  await page.addInitScript(({ root, fileA, notes, noteItem, platform, truncated, seedPicker }) => {
    if (seedPicker) localStorage.setItem('folio.filePicker', JSON.stringify(seedPicker));
    window.nativeCalls = [];
    window.pickResult = null;
    window.pickDelayMs = 0;
    window.pickShouldThrow = null;
    const escape = v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    window.__TAURI__ = {
      core: { invoke: async (command, args = {}) => {
        window.nativeCalls.push({ command, args });
        switch (command) {
          case 'bootstrap': return { paths: [], platform, theme: null };
          case 'render_markdown': {
            const parts = String(args.content || '').split(/\n\n/);
            const heading = parts[0] || '# Opened';
            const body = parts[1] || 'Text';
            return { html: `<h1>${escape(heading.replace(/^# /, ''))}</h1><p>${escape(body)}</p>`, blocks: [] };
          }
          case 'browse_directory': {
            const folder = args.path || root;
            const listings = {
              [root]: [
                { path: notes, name: 'notes', directory: true },
                { path: fileA, name: 'opened.md', directory: false }
              ],
              [notes]: [{ path: noteItem, name: 'item.md', directory: false }]
            };
            const parents = { [root]: null, [notes]: root };
            return { path: folder, parent: parents[folder] ?? null, entries: listings[folder] || [], truncated };
          }
          case 'pick_open_target': {
            if (window.pickDelayMs) await new Promise(r => setTimeout(r, window.pickDelayMs));
            if (window.pickShouldThrow) { const message = window.pickShouldThrow; window.pickShouldThrow = null; throw { code: 'error', message }; }
            return window.pickResult;
          }
          case 'path_is_directory': return [root, notes].includes(args.path);
          case 'open_document': return { path: args.path, name: window.FolioPaths.basename(args.path), content: `# Opened\n\nText for ${args.path}`, lineEnding: 'LF' };
          case 'open_folder': return { path: args.path, name: window.FolioPaths.basename(args.path), entries: [], truncated: false, skipped: 0 };
          case 'document_changed': return false;
          case 'save_document': return { path: fileA, name: 'opened.md' };
          case 'set_window_zoom': return null;
          case 'set_title': return null;
          case 'new_document': return null;
          default: return null;
        }
      } },
      event: { listen: async () => () => {} },
      webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }
    };
  }, { root, fileA, notes, noteItem, platform, truncated, seedPicker });
}

async function ready(page) {
  await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
  await page.waitForFunction(() => typeof busy !== 'undefined' && !busy && document.documentElement.dataset.documentWidth);
}

async function runPalette(page, query) {
  await page.keyboard.press('Control+Shift+P');
  await page.locator('#command-dialog').waitFor();
  await page.locator('#command-search').fill(query);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
    errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await installMock(page);
    await ready(page);

    // 1. Default is Folio when missing/invalid.
    await page.evaluate(() => localStorage.removeItem('folio.filePicker'));
    await page.reload();
    await page.waitForFunction(() => typeof busy !== 'undefined' && !busy && document.documentElement.dataset.documentWidth);
    assert.equal(await page.evaluate(() => filePicker()), 'folio', 'missing pref defaults to folio');
    await page.evaluate(() => localStorage.setItem('folio.filePicker', JSON.stringify('bogus')));
    assert.equal(await page.evaluate(() => filePicker()), 'folio', 'invalid pref normalizes to folio');
    await page.evaluate(() => localStorage.removeItem('folio.filePicker'));

    // 2. Folio main Open entry points share routing (toolbar, welcome, Ctrl+O, palette).
    for (const entry of ['toolbar', 'welcome', 'shortcut', 'palette']) {
      await page.evaluate(() => { window.nativeCalls = []; if (document.getElementById('open-dialog').open) document.getElementById('open-dialog').close(); });
      if (entry === 'toolbar') await page.locator('#open').click();
      else if (entry === 'welcome') await page.locator('#welcome-open').click();
      else if (entry === 'shortcut') await page.keyboard.press('Control+O');
      else { await runPalette(page, 'Open file'); await page.keyboard.press('Enter'); }
      await page.locator('#open-dialog').waitFor();
      assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'pick_open_target')), false, `${entry} in folio mode must not call native pick`);
      assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'browse_directory')), true, `${entry} in folio mode uses browse_directory`);
      await page.locator('#open-cancel').click();
    }

    // 3. Typed path beats a stale row selection (row -> type); a later row click wins (type -> row).
    await page.locator('#open').click();
    await page.locator('#open-dialog').waitFor();
    await page.getByRole('option', { name: 'opened.md' }).click();
    await page.locator('#open-path').fill(fileB);
    await page.locator('#open-confirm').click();
    await page.waitForFunction(() => !busy);
    assert.equal(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'open_document').at(-1)?.args.path), fileB, 'typed path must win over stale row selection');
    await page.waitForFunction(() => !document.getElementById('document-view').hidden && !busy);
    await page.locator('#home').click();
    await page.waitForFunction(() => !document.getElementById('welcome').hidden && !busy);
    await page.locator('#open').click();
    await page.locator('#open-dialog').waitFor();
    await page.locator('#open-path').fill(fileB);
    await page.getByRole('option', { name: 'opened.md' }).click();
    assert.equal(await page.locator('#open-selection-hint').textContent(), 'Open selected Markdown file', 'row click after typing selects the file');
    await page.locator('#open-confirm').click();
    await page.waitForFunction(() => !busy);
    assert.equal(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'open_document').at(-1)?.args.path), fileA, 'row click after typing must win');
    // Back home clean for the next group (doc is clean: content === saved).
    await page.locator('#home').click();
    await page.waitForFunction(() => !document.getElementById('welcome').hidden && !busy);

    // 4. Palette toggle copy, persistence, searchability, status feedback.
    await runPalette(page, 'system file picker');
    assert.equal(await page.locator('#command-results .command-item .command-label').first().textContent(), 'Use system file picker', 'folio mode offers the system picker');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => localStorage.getItem('folio.filePicker') === JSON.stringify('native'));
    assert.equal(await page.locator('#app-status').textContent(), 'System file picker enabled', 'switching reports status');
    await runPalette(page, 'dialog');
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('#command-results .command-label')].some(el => el.textContent === 'Use Folio file picker')), 'toggle is findable via dialog detail text');
    await page.locator('#command-search').fill('folio');
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('#command-results .command-label')].some(el => el.textContent === 'Use Folio file picker')), 'toggle is findable via folio picker text');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { if (document.getElementById('command-dialog').open) document.getElementById('command-dialog').close(); });
    assert.equal(await page.evaluate(() => filePicker()), 'native', 'preference persists as native');
    await page.reload();
    await page.waitForFunction(() => typeof busy !== 'undefined' && !busy && document.documentElement.dataset.documentWidth);
    assert.equal(await page.evaluate(() => filePicker()), 'native', 'preference survives reload');
    assert.equal(await page.locator('#open-folder').count(), 1, 'exactly one Open folder action exists');
    assert.equal(await page.evaluate(() => document.getElementById('open-folder').closest('#open-menu') !== null), true, 'the folder action lives in the Open menu, not the toolbar');
    assert.equal(await page.locator('.header-start > #open-folder').count(), 0, 'the duplicate toolbar folder action is gone');
    await page.locator('#open-chevron').click();
    await page.waitForFunction(() => !document.getElementById('open-menu').hidden);
    assert.equal(await page.locator('#open-menu #open-folder').isVisible(), true, 'native mode exposes Open folder… in the Open menu');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('open-menu').hidden);
    await page.locator('#open-chevron').focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => !document.getElementById('open-menu').hidden);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'open-file', 'the Open menu is keyboard-reachable');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'open-folder', 'Open folder… is keyboard-reachable');
    await page.keyboard.press('Escape');
    assert.equal((await page.locator('#open span').textContent()).trim(), 'Open file', 'native Open advertises files only');
    assert.match(await page.locator('#open').getAttribute('title'), /file/i, 'native Open title names files');
    assert.doesNotMatch(await page.locator('#open').getAttribute('title'), /folder/i, 'native Open title does not promise folders');

    // 5. Native main Open uses the OS file dialog; all entry points route the same.
    for (const entry of ['toolbar', 'welcome', 'shortcut', 'palette']) {
      await page.evaluate((f) => { window.nativeCalls = []; window.pickResult = null; }, fileA);
      if (entry === 'toolbar') await page.locator('#open').click();
      else if (entry === 'welcome') await page.locator('#welcome-open').click();
      else if (entry === 'shortcut') await page.keyboard.press('Control+O');
      else { await runPalette(page, 'Open file'); await page.keyboard.press('Enter'); }
      await page.waitForFunction(() => window.nativeCalls.some(c => c.command === 'pick_open_target'));
      await page.waitForFunction(() => !busy);
      const pick = await page.evaluate(() => window.nativeCalls.find(c => c.command === 'pick_open_target'));
      assert.ok(pick, `${entry} in native mode calls pick_open_target`);
      assert.equal(pick.args.kind, 'file', `${entry} native main Open requests kind=file`);
      assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'browse_directory')), false, `${entry} native main Open must not open the Folio chooser`);
      assert.equal(await page.locator('#open-dialog').isVisible().catch(() => false), false, `${entry} native main Open shows no Folio dialog on cancel`);
    }

    // 6. Native file pick opens the document; folder command opens the folder.
    await page.evaluate((f) => { window.nativeCalls = []; window.pickResult = { path: f, kind: 'file' }; }, fileA);
    await page.locator('#open').click();
    await page.waitForFunction(() => !busy && !document.getElementById('document-view').hidden);
    assert.equal(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'open_document').length), 1, 'native file pick opens once');
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'path_is_directory')), false, 'native file result opens directly without a queued directory probe');
    assert.equal(await page.evaluate(() => current.path), fileA, 'native file pick sets the document');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('folio.recent') || '[]').slice(0, 1)), [fileA], 'successful native open updates recents');

    await runPalette(page, 'Open folder');
    const folderLabels = await page.evaluate(() => [...document.querySelectorAll('#command-results .command-label')].map(el => el.textContent));
    assert.ok(folderLabels.includes('Open folder…'), 'Open folder… is always visible in native mode');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { if (document.getElementById('command-dialog').open) document.getElementById('command-dialog').close(); });
    await page.evaluate((n) => { window.nativeCalls = []; window.pickResult = { path: n, kind: 'folder' }; }, notes);
    await page.locator('#open-chevron').click();
    await page.waitForFunction(() => !document.getElementById('open-menu').hidden);
    await page.locator('#open-folder').click();
    await page.waitForFunction(() => !busy && document.getElementById('folder-name').textContent === 'notes');
    const folderPick = await page.evaluate(() => window.nativeCalls.find(c => c.command === 'pick_open_target'));
    assert.equal(folderPick.args.kind, 'folder', 'toolbar Open folder in native mode requests kind=folder');
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'browse_directory')), false, 'toolbar Open folder in native mode skips the Folio chooser');
    assert.equal(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'open_folder').length), 1, 'native folder pick opens once');
    assert.equal(await page.evaluate(() => document.getElementById('folder-empty').querySelector('h1').textContent), 'No Markdown files', 'folder view renders without stale document content');
    assert.equal(await page.evaluate(() => document.getElementById('editor-lock-note').hidden), true, 'folder view leaves no stale editor state');

    // 7. Native cancel changes nothing: no prompt, no recents change, no doc switch.
    await page.evaluate((f) => { window.nativeCalls = []; window.pickResult = { path: f, kind: 'file' }; }, fileA);
    await page.locator('#open').click();
    await page.waitForFunction(() => !busy);
    const recentsBefore = await page.evaluate(() => localStorage.getItem('folio.recent'));
    await page.evaluate(() => { window.nativeCalls = []; window.pickResult = null; });
    await page.locator('#open').click();
    await page.waitForFunction(() => window.nativeCalls.some(c => c.command === 'pick_open_target'));
    await page.waitForFunction(() => !busy);
    assert.equal(await page.evaluate(() => document.getElementById('confirm-dialog').open), false, 'native cancel never prompts');
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'open_document' || c.command === 'open_folder')), false, 'native cancel opens nothing');
    assert.equal(await page.evaluate(() => localStorage.getItem('folio.recent')), recentsBefore, 'native cancel leaves recents alone');

    // 8. Selection-first dirty prompt: pick, then prompt; Cancel keeps the doc.
    await page.evaluate(() => { current.content += ' dirty'; updateTitle(); });
    await page.waitForFunction(() => document.getElementById('dirty-dot').hidden === false);
    await page.evaluate((f) => { window.nativeCalls = []; window.pickResult = { path: f, kind: 'file' }; }, fileB);
    await page.locator('#open').click();
    await page.locator('#confirm-dialog').waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForFunction(() => !busy);
    assert.ok((await page.evaluate(() => current.content)).includes('dirty'), 'cancelling the dirty prompt keeps the document');
    // Dirty + picker cancel never prompts at all.
    await page.evaluate(() => { window.nativeCalls = []; window.pickResult = null; });
    await page.locator('#open').click();
    await page.waitForFunction(() => window.nativeCalls.some(c => c.command === 'pick_open_target'));
    await page.waitForFunction(() => !busy);
    assert.equal(await page.evaluate(() => document.getElementById('confirm-dialog').open), false, 'dirty doc + native cancel never prompts');
    assert.ok((await page.evaluate(() => current.content)).includes('dirty'), 'dirty content survives a native cancel');
    await page.evaluate(() => { current.content = current.saved; updateTitle(); });

    // 9. Duplicate native launches collapse to one pick.
    await page.evaluate((f) => { window.nativeCalls = []; window.pickDelayMs = 250; window.pickResult = { path: f, kind: 'file' }; }, fileB);
    await page.evaluate(() => { openEntry(); openEntry(); });
    await page.waitForFunction((f) => window.nativeCalls.filter(c => c.command === 'pick_open_target').length === 1 && !busy && current.path === f, fileB, { timeout: 8000 });
    // 9b. Slow native pick holds the queue: busy + Open/Save disabled, queued work waits.
    await page.evaluate((f) => { window.nativeCalls = []; window.pickDelayMs = 400; window.pickResult = { path: f, kind: 'file' }; window.queuedRan = false; }, fileA);
    await page.locator('#open').click();
    await page.waitForFunction(() => busy === true);
    assert.equal(await page.locator('#open').isDisabled(), true, 'Open is disabled while the native picker is pending');
    assert.equal(await page.locator('#save').isDisabled(), true, 'Save is disabled while the native picker is pending');
    assert.equal(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'open_document').length), 0, 'protected open waits while the native pick is pending');
    await page.evaluate(() => { enqueue(() => { window.queuedRan = true; }); });
    assert.equal(await page.evaluate(() => window.queuedRan), false, 'queued action waits while the native pick is pending');
    await page.waitForFunction((f) => !busy && current.path === f, fileA, { timeout: 8000 });
    assert.equal(await page.evaluate(() => window.queuedRan), true, 'queued action runs after the pick resolves');
    assert.equal(await page.evaluate(() => window.nativeCalls.find(c => c.command === 'pick_open_target').args.start), root, 'native pick starts from the document folder');
    await page.evaluate(() => { window.pickDelayMs = 0; });

    // 9c. Native failures and malformed results are rejected safely; the guard resets for retry.
    await page.evaluate(() => { window.nativeCalls = []; window.pickShouldThrow = 'System dialog unavailable.'; window.pickResult = null; });
    await page.locator('#open').click();
    await page.waitForFunction(() => window.nativeCalls.some(c => c.command === 'pick_open_target'));
    await page.waitForFunction(() => !busy);
    assert.match(await page.locator('#toast').textContent(), /unavailable/, 'native pick failure shows a safe error');
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'open_document' || c.command === 'open_folder')), false, 'failed native pick opens nothing');
    await page.evaluate((f) => { window.nativeCalls = []; window.pickResult = { path: f, kind: 'file' }; }, fileB);
    await page.locator('#open').click();
    await page.waitForFunction((f) => !busy && current.path === f, fileB, { timeout: 8000 });
    assert.equal(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'open_document').length), 1, 'retry after rejection opens');
    for (const bad of [{}, { path: fileA, kind: 'bogus' }, 'not-an-object']) {
      await page.evaluate((v) => { window.nativeCalls = []; window.pickResult = v; }, bad);
      await page.locator('#open').click();
      await page.waitForFunction(() => window.nativeCalls.some(c => c.command === 'pick_open_target'));
      await page.waitForFunction(() => !busy);
      assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'open_document' || c.command === 'open_folder')), false, `malformed native result opens nothing (${JSON.stringify(bad)})`);
    }
    assert.match(await page.locator('#toast').textContent(), /unexpected result/, 'malformed native result shows a safe error');
    assert.equal(await page.evaluate(() => current.path), fileB, 'malformed native result keeps the document');

    // 9d. Native pick starts from the active folder when one is open.
    await page.evaluate((n) => { window.nativeCalls = []; window.pickResult = { path: n, kind: 'folder' }; }, notes);
    await runPalette(page, 'Open folder');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !busy && document.getElementById('folder-name').textContent === 'notes');
    await page.evaluate(() => { window.nativeCalls = []; window.pickResult = null; });
    await page.keyboard.press('Control+O');
    await page.waitForFunction(() => window.nativeCalls.some(c => c.command === 'pick_open_target'));
    await page.waitForFunction(() => !busy);
    assert.equal(await page.evaluate(() => window.nativeCalls.find(c => c.command === 'pick_open_target').args.start), notes, 'native pick starts from the active folder');

    // 10. Open folder… honors Folio mode via the existing chooser.
    await runPalette(page, 'Use Folio file picker');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => filePicker() === 'folio');
    await page.evaluate(() => { if (document.getElementById('command-dialog').open) document.getElementById('command-dialog').close(); window.nativeCalls = []; });
    assert.equal(await page.locator('#open-folder').isVisible(), false, 'Folio picker folds folder opening into Open');
    await page.locator('#open-chevron').click();
    await page.waitForFunction(() => !document.getElementById('open-menu').hidden);
    assert.equal(await page.locator('#open-menu #open-file').isVisible(), true, 'Open file or folder… remains reachable in Folio mode');
    assert.equal(await page.locator('#open-menu #open-folder').isVisible(), false, 'Folio mode hides the separate folder item');
    await page.keyboard.press('Escape');
    assert.equal((await page.locator('#open span').textContent()).trim(), 'Open', 'Folio Open covers files and folders');
    assert.match(await page.locator('#open').getAttribute('title'), /file or folder/i, 'Folio Open advertises both');
    await runPalette(page, 'Open folder');
    await page.keyboard.press('Enter');
    await page.locator('#open-dialog').waitFor();
    assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.command === 'pick_open_target')), false, 'folio Open folder… uses the built-in chooser');
    await page.locator('#open-cancel').click();

    // 11. Truncated Folio listing keeps selection instructions visible.
    const truncPage = await browser.newPage({ viewport: { width: 1120, height: 800 } });
    truncPage.on('pageerror', e => errors.push(String(e)));
    await installMock(truncPage, { truncated: true, seedPicker: 'folio' });
    await ready(truncPage);
    assert.equal(await truncPage.evaluate(() => filePicker()), 'folio', 'truncated page uses the Folio picker');
    await truncPage.locator('#open').click();
    await truncPage.locator('#open-dialog').waitFor();
    const hint = await truncPage.locator('#open-selection-hint').textContent();
    assert.match(hint, /limited|not shown/i, 'truncated listing must surface limit info');
    assert.ok(!/5,?000/.test(hint), 'truncated notice must not claim a numeric count');
    assert.match(hint.toLowerCase(), /select|markdown|file|folder/, 'truncated notice must not hide selection instructions');
    await truncPage.close();

    assert.deepEqual(errors, []);
    await browser.close();
    console.log('PASS: picker default/persistence, shared routing, native file/folder results, selection-first dirty prompts, cancel silence, duplicate guard, busy queue hold, malformed rejection, stale typed path, limit notice.');
  } catch (e) { throw e; }
})().catch(e => { console.error(e); console.error('PAGE ERRORS:', errors); process.exit(1); });
