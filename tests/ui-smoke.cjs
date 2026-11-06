const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fixtureRoot = path.join(os.tmpdir(), 'folio-smoke');
const fixtureNotes = path.join(fixtureRoot, 'notes');
const fixtureSub = path.join(fixtureNotes, 'sub');
const fixtureOpened = path.join(fixtureRoot, 'opened.md');
const fixtureItem = path.join(fixtureNotes, 'item.md');
const fixtureSaved = path.join(fixtureRoot, 'saved.md');
let errors = [];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
  errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(fixtures => {
    window.nativeCalls = [];
    window.nativeEvents = {};
    window.saveFailure = null;
    const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    window.__TAURI__ = {
      core: { invoke: async (command, args = {}) => {
        window.nativeCalls.push({ command, args });
        switch (command) {
          case 'bootstrap': return { paths: [], platform: fixtures.platform, theme: { name: 'midnight', mode: 'dark', colors: { background: '#060b1e', foreground: '#ffcead', accent: '#7d82d9', dark_background: '#040816', lighter_background: '#131a3a' } } };
          case 'render_markdown': {
            if (args.content.includes('Plain text, beautifully rendered')) {
              const items = [...args.content.matchAll(/^- \[([ x])\] (.*)$/gm)];
              return { html: `<h1 id="heading-1">A quiet place for your words</h1><p>Folio opens individual Markdown files.</p><h2 id="heading-2">Plain text, beautifully rendered</h2><ul>${items.map((item, index) => `<li><input type="checkbox" data-task-index="${index}" ${item[1] === 'x' ? 'checked' : ''}> ${escape(item[2])}</li>`).join('')}</ul>`, blocks: [] };
            }
            if (!args.content.includes('\n\n')) {
              // Single raw block (table preview fallback, code highlight and
              // image probes): the real renderer returns the block element it
              // parsed, never a bare document heading. Keep the mock honest so
              // async projections cannot inject stray headings into the page.
              return { html: `<div>${escape(args.content)}</div>`, blocks: [] };
            }
            const parts = args.content.split(/\n\n/);
            const heading = parts[0] || '# Opened';
            const body = parts[1] || 'Text';
            return { html: `<h1 id="heading-1">${escape(heading.replace(/^# /, ''))}</h1><p>${escape(body)}</p>`, blocks: [{ source: heading, start: 0, end: heading.length }, { source: body, start: heading.length + 2, end: heading.length + 2 + body.length }] };
          }
          case 'browse_directory': {
            const folder = args.path || fixtures.root;
            return { path: folder, parent: fixtures.parents[folder] ?? null, entries: fixtures.listings[folder] || [] };
          }
          case 'path_is_directory': return fixtures.directories.includes(args.path);
          case 'open_folder': return { path: args.path, name: window.FolioPaths.basename(args.path), entries: fixtures.folderEntries[args.path] || [] };
          case 'open_document': return { path: args.path, name: window.FolioPaths.basename(args.path), content: '# Opened\n\nText', lineEnding: 'LF' };
          case 'set_task_checked': {
            const matches = [...args.content.matchAll(/^- \[([ x])\] /gm)];
            const marker = matches[args.taskIndex].index + 3;
            return args.content.slice(0, marker) + (args.checked ? 'x' : ' ') + args.content.slice(marker + 1);
          }
          case 'save_document':
            if (window.saveFailure) { const failure = window.saveFailure; window.saveFailure = null; throw failure; }
            return { path: fixtures.saved, name: window.FolioPaths.basename(fixtures.saved) };
          case 'document_changed': return false;
          default: return null;
        }
      } },
      event: { listen: async (name, callback) => { window.nativeEvents[name] = callback; return () => {}; } },
      webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }
    };
  }, {
    root: fixtureRoot,
    saved: fixtureSaved,
    platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    directories: [fixtureRoot, fixtureNotes, fixtureSub],
    parents: {
      [fixtureRoot]: path.dirname(fixtureRoot) === fixtureRoot ? null : path.dirname(fixtureRoot),
      [fixtureNotes]: fixtureRoot,
      [fixtureSub]: fixtureNotes
    },
    listings: {
      [fixtureRoot]: [
        { path: fixtureNotes, name: 'notes', directory: true },
        { path: fixtureOpened, name: 'opened.md', directory: false }
      ],
      [fixtureNotes]: [
        { path: fixtureSub, name: 'sub', directory: true },
        { path: fixtureItem, name: 'item.md', directory: false }
      ],
      [fixtureSub]: []
    },
    folderEntries: {
      [fixtureNotes]: [
        { path: fixtureSub, name: 'sub', depth: 0, directory: true },
        { path: fixtureItem, name: 'item.md', depth: 0, directory: false }
      ]
    }
  });
  await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'omarchy');
  await page.locator('#sample').click();
  await page.locator('#preview h1').waitFor();
  await page.waitForFunction(() => !busy);
  await page.locator('#preview .ProseMirror').waitFor({ state: 'visible' });
  await page.evaluate(() => setDocumentMode('edit'));
  assert.equal(await page.locator('#lock-document').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#view-menu #source-snapshot').count(), 1, 'the source snapshot lives in the View menu');
  if (await page.locator('#outline').isHidden()) await page.getByRole('button', { name: 'Contents', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('outline').hidden);
  await page.waitForFunction(() => document.querySelectorAll('#outline-items .outline-link[aria-current="location"]').length === 1);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dock-sidebar-width').trim()), '280px', 'the wider navigation dock default should drive its CSS variable');
  assert((await page.locator('#outline-items .outline-link').count()) > 0, 'the outline should list headings');
  assert.equal(await page.evaluate(() => localStorage.getItem('folio.dockWidth')), '280', 'dock width is persisted');
  await page.locator('#outline-close').click();
  // The Formatted/Markdown mode switch was removed; there are no mode-switch
  // steps left to verify preview reuse.

  const lastRemoteFlag = () => page.evaluate(() => window.nativeCalls.filter(call => call.command === 'render_markdown').at(-1)?.args.remoteImages);
  assert.equal(await lastRemoteFlag(), false, 'remote images should be blocked by default');
  await page.keyboard.press('Control+Shift+P');
  await page.locator('#command-search').fill('load remote images');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => remoteImages === true && preferences.get('remoteImages', false) === true);
  await page.keyboard.press('Control+Shift+P');
  await page.locator('#command-search').fill('use serif reading text');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.documentElement.dataset.readingFont === 'serif');
  await page.keyboard.press('Control+Shift+P');
  await page.locator('#command-search').fill('use sans-serif reading text');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.documentElement.dataset.readingFont === 'sans');
  await page.keyboard.press('Control+Shift+P');
  await page.locator('#command-search').fill('block remote images');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => remoteImages === false && preferences.get('remoteImages', true) === false);

  await page.evaluate(() => changeContent(current.content + '\n\n<input type="checkbox" id="raw-html-checkbox" checked> author HTML\n'));
  assert.equal(await page.locator('#preview .task-item input').first().isDisabled(), false, 'tasks work in clean editing');
  assert.equal(await page.locator('#raw-html-checkbox:not(:disabled)').count(), 0, 'author HTML must not create interactive controls');
  assert.ok((await page.evaluate(() => current.content)).includes('<input type="checkbox"'), 'author source is retained');
  await page.locator('#document-mode-menu-button').click(); await page.locator('#lock-document').click();
  assert.equal(await page.locator('#preview .task-item input').first().isDisabled(), true, 'Lock prevents task writes');
  await page.locator('#document-mode-menu-button').click(); await page.locator('#lock-document').click();
  assert.equal(await page.locator('html').getAttribute('data-document-width'), 'centered');
  assert.equal(await page.locator('#view-menu #width-toggle').count(), 1, 'the width toggle lives in the View menu');
  await page.locator('#view-menu-button').click();
  await page.waitForFunction(() => !document.getElementById('view-menu').hidden);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'preference-font', 'opening the View menu focuses its first item');
  const centeredWidth = await page.locator('#preview .ProseMirror > h1').first().evaluate(element => element.getBoundingClientRect().width);
  await page.locator('#width-toggle').click();
  assert(await page.locator('#preview .ProseMirror > h1').first().evaluate(element => element.getBoundingClientRect().width) > centeredWidth, 'full-width layout expands the column for either reading font');
  await page.keyboard.press('Control+Shift+P');
  await page.locator('#command-search').fill('centered document width');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.documentElement.dataset.documentWidth === 'centered');

  await page.keyboard.press('Control+Equal');
  assert.equal(await page.locator('#zoom-reset').textContent(), '110%');
  await page.keyboard.press('Control+Shift+Equal');
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--text-size')), '20px');
  await page.keyboard.press('Control+Minus');
  assert.equal(await page.locator('#zoom-reset').textContent(), '100%');
  await page.keyboard.press('Control+Shift+Minus');
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--text-size')), '19px');
  assert.equal(await page.evaluate(() => window.nativeCalls.filter(call => call.command === 'set_window_zoom').at(-1).args.scale), 1);

  await page.locator('#preview .task-item input').nth(3).check();
  await page.waitForFunction(() => document.getElementById('dirty-dot').hidden === false);
  const source = await page.evaluate(() => current.content);
  assert(source.includes('- [x] Tables, task lists, and footnotes'));
  assert(source.includes('- [x] Your next idea'));
  assert(source.includes('```rust'));
  assert.equal((source.match(/Your next idea/g) || []).length, 1);

  await page.keyboard.press('Control+O');
  await page.locator('#open-dialog').waitFor();
  await page.getByRole('option', { name: 'opened.md' }).click();
  await page.locator('#open-confirm').click();
  await page.locator('#confirm-dialog').waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert((await page.evaluate(() => current.content)).includes('Your next idea'));
  await page.keyboard.press('Control+S');
  await page.waitForFunction(() => document.getElementById('dirty-dot').hidden);

  await page.keyboard.press('Control+O');
  await page.getByRole('option', { name: 'notes' }).click();
  await page.locator('#open-confirm').click();
  await page.waitForFunction(() => document.getElementById('folder-name').textContent === 'notes');
  assert.equal(await page.locator('#folder-divider').isVisible(), true);
  const initialWidth = await page.locator('#file-browser').evaluate(node => node.getBoundingClientRect().width);
  const divider = await page.locator('#folder-divider').boundingBox();
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 60);
  await page.mouse.down(); await page.mouse.move(divider.x + 65, divider.y + 60); await page.mouse.up();
  const expandedWidth = await page.locator('#file-browser').evaluate(node => node.getBoundingClientRect().width);
  assert(expandedWidth > initialWidth + 30, 'folder sidebar should resize by dragging');
  await page.getByRole('button', { name: 'sub' }).click();
  await page.waitForFunction(() => document.querySelector('.folder-entry[aria-expanded="true"]') !== null);
  await page.locator('#folder-close').click();
  assert.equal(await page.locator('#file-browser').getAttribute('hidden'), '');
  await page.keyboard.press('Control+B');
  await page.waitForFunction(() => document.getElementById('file-browser').hidden === false);
  await page.getByRole('button', { name: 'item.md' }).click();
  await page.locator('#preview h1').waitFor();
  assert.equal(await page.locator('#line-ending').textContent(), ' · LF', 'the status bar should show the detected line ending');
  await page.evaluate(() => setDocumentMode('edit'));
  await page.locator('#preview p').click();
  await page.evaluate(() => {
    const text = document.querySelector('#preview p').firstChild;
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.type('Edited text');
  await page.waitForFunction(() => !busy);
  assert.equal(await page.evaluate(() => current.content), '# Opened\n\nEdited text');

  await page.evaluate(() => { window.saveFailure = { code: 'file_changed', message: 'Another app changed this file.' }; });
  await page.keyboard.press('Control+S');
  await page.locator('#confirm-dialog').waitFor();
  assert((await page.locator('#confirm-message').textContent()).includes('Another app changed this file'));
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('dirty-dot').hidden === false);
  assert.equal(await page.evaluate(() => Boolean(window.saveFailure)), false, 'a structured file-changed error should be consumed once');

  await page.setViewportSize({ width: 720, height: 800 });
  await page.waitForFunction(() => window.matchMedia('(max-width:960px)').matches);
  if (await page.locator('#outline').isHidden()) await page.getByRole('button', { name: 'Contents', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('outline').hidden === false);
  assert.equal(await page.locator('#file-browser').getAttribute('hidden'), '', 'on narrow screens the outline takes over from the file tree');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('file-browser').hidden === false);
  assert.equal(await page.locator('#outline').getAttribute('hidden'), '', 'on narrow screens the file tree takes over from the outline');

  await page.evaluate(() => { void goHome(); });
  await page.locator('#confirm-dialog').waitFor();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('welcome').hidden);
  assert.equal(await page.locator('#document-view').getAttribute('hidden'), '', 'home should return to the welcome screen');
  assert.equal(await page.locator('#statusbar').getAttribute('hidden'), '', 'home should hide the document status bar');

  assert.deepEqual(errors, []);
  await browser.close();
  console.log('PASS: unified controls preserve content, image preference and save conflicts work, line endings/width/themes/zoom/tree/outline persist, tasks are directly editable, Lock and raw HTML remain safe, and narrow sidebars behave correctly.');
})().catch(error => { console.error(error); console.error('PAGE ERRORS:', errors); process.exit(1); });
