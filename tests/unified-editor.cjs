const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

// Real editor engines and Rust renderer; only the OS IPC boundary is replaced.
const source = '# Alpine hut weekend\n\nA **bold** paragraph with *emphasis* and `code`.\n\n- [ ] Pack stove\n\n| First | Second |\n| :---: | ---: |\n| **one** | target |\n| plain | value |\n\nInline $t = d/v$.\n\n$$\nc = \\sqrt{a^2 + b^2}\n$$\n\n![Remote](https://example.com/tracker.png)\n\n<!-- preserve exactly: spaces  and syntax -->\n';
const fixture = process.env.FOLIO_FIXTURE || path.resolve('target/debug/examples', process.platform === 'win32' ? 'editor-fixture.exe' : 'editor-fixture');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('https://**/*', route => { external.push(route.request().url()); return route.abort(); });
  await page.exposeFunction('nativeRender', content => {
    const input = path.join(os.tmpdir(), 'folio-unified-input.md'); fs.writeFileSync(input, content);
    return JSON.parse(execFileSync(fixture, [input], { encoding: 'utf8' }));
  });
  const notePath = path.join(os.tmpdir(), 'folio-note.md');
  await page.addInitScript(({ source, notePath }) => {
    window.savedContent = null;
    window.__TAURI__ = {
      core: { invoke: async (command, args = {}) => {
        if (command === 'bootstrap') return { paths: [notePath], platform: 'linux', theme: null };
        if (command === 'open_document') return { path: notePath, name: 'note.md', content: source, lineEnding: 'LF' };
        if (command === 'render_markdown') return window.nativeRender(args.content);
        if (command === 'save_document') { window.savedContent = args.content; return { path: notePath, name: 'note.md' }; }
        return null;
      } },
      event: { listen: async () => () => {} },
      webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }
    };
  }, { source, notePath });
  try {
    await page.goto(pathToFileURL(path.resolve('ui/index.html')).href);
    await page.waitForFunction(() => typeof busy !== 'undefined' && !busy);
    assert.equal(await page.locator('#show-markdown').count(), 1, 'one Show Markdown toggle replaces preview/edit');
    await page.locator('#preview .ProseMirror').waitFor();
    assert.equal(await page.locator('#show-markdown').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => current.content), source, 'opening preserves exact Markdown');
    await page.locator('#preview h1').click();
    await page.keyboard.press('End'); await page.keyboard.type(' edited');
    assert.match(await page.evaluate(() => current.content), /^# Alpine hut weekend edited\n/);
    assert.ok((await page.evaluate(() => current.content)).includes('<!-- preserve exactly: spaces  and syntax -->'));
    await page.locator('#preview input[type=checkbox]').first().check();
    assert.ok((await page.evaluate(() => current.content)).includes('- [x] Pack stove'));
    await page.keyboard.press('Control+z');
    assert.ok((await page.evaluate(() => current.content)).includes('- [ ] Pack stove'));
    const cell = page.locator('#preview td').first();
    await cell.click(); await page.keyboard.press('End'); await page.keyboard.type('X');
    assert.ok((await cell.innerText()).includes('X'));
    assert.equal(await page.locator('#preview tr').first().locator('th,td').first().evaluate(el => getComputedStyle(el).textAlign), 'center', 'center-aligned table delimiter opens in the rich view');
    const edges = await page.locator('#preview tr').evaluateAll(rows => rows.map(row => [...row.cells].map(c => c.getBoundingClientRect().left)));
    assert.ok(Math.max(...edges.map(row => row[1])) - Math.min(...edges.map(row => row[1])) < 2, 'rich-table columns align');
    const beforeToggle = await page.evaluate(() => current.content);
    await page.locator('#show-markdown').click();
    await page.locator('#source-editor .cm-editor').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => current.content), beforeToggle, 'toggle does not rewrite source');
    await page.keyboard.type('Y');
    assert.ok((await page.evaluate(() => current.content)).includes('Y'));
    await page.locator('#show-markdown').click();
    assert.ok((await page.locator('#preview td').first().innerText()).includes('Y'), 'source caret maps back to the same cell');
    await page.locator('#source-snapshot').click();
    const snapshot = await page.locator('#source-snapshot-text').inputValue();
    assert.equal(snapshot, await page.evaluate(() => current.content));
    assert.equal(await page.locator('#source-snapshot-text').getAttribute('readonly'), '');
    await page.locator('#source-snapshot-close').click();
    await page.locator('#lock-document').click();
    assert.equal(await page.locator('#preview .ProseMirror').getAttribute('contenteditable'), 'false');
    const locked = await page.evaluate(() => current.content);
    await page.locator('#preview h1').click(); await page.keyboard.type('NO'); await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => current.content), locked);
    assert.equal(await page.locator('#preview input[type=checkbox]').first().isDisabled(), true);
    assert.equal(external.length, 0, 'blocked remote image never fetches implicitly');
    await page.locator('#lock-document').click();
    await page.keyboard.press('Control+s'); await page.waitForFunction(() => !busy && savedContent !== null);
    assert.equal(await page.evaluate(() => savedContent), await page.evaluate(() => current.content));
    assert.equal(await page.locator('#dirty-dot').isVisible(), false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(os.tmpdir(), 'folio-unified-app.png'), fullPage: true });
    console.log('PASS: real unified rich/source editing, tasks, aligned tables, shared undo, exact snapshot, lock, image privacy and save.');
  } catch (error) {
    console.error('PAGE ERRORS:', errors);
    console.error('APP:', await page.locator('#toast').textContent().catch(() => ''));
    await page.screenshot({ path: '/tmp/opencode/folio-unified-failure.png', fullPage: true }).catch(() => {});
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
