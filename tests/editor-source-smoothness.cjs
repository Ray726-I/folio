const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { openEditor } = require('./editor-browser.cjs');

const scratchRoot = fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir();
const longDoc = '# Long\n\n' + Array.from({ length: 400 }, (_, i) => `Paragraph ${i} with enough text to form a scrolling line.`).join('\n\n') + '\n';

function buildBundle() {
  const directory = fs.mkdtempSync(path.join(scratchRoot, 'folio-source-smoothness-'));
  const outfile = path.join(directory, 'editor.js');
  esbuild.buildSync({
    entryPoints: [path.resolve('ui/editor/entry.js')], bundle: true, format: 'iife', globalName: 'FolioEditor',
    target: ['es2022'], minify: true, legalComments: 'eof', outfile, logLevel: 'silent'
  });
  return { directory, outfile };
}

// Exercise the edited engine without rewriting the shared vendor bundle. The
// real app shell, native renderer fixture and DOM are used.
async function openIsolatedEditor(source, outfile, viewport) {
  const session = await openEditor(source, viewport);
  let served = 0;
  await session.page.route(/\/vendor\/editor\/editor\.js(?:\?.*)?$/, route => {
    served++; return route.fulfill({ path: outfile, contentType: 'application/javascript' });
  });
  await session.page.reload();
  await session.page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
  assert.equal(served, 1, 'source smoothness tests must run against the isolated editor bundle');
  return session;
}

const sourceMode = page => page.waitForFunction(() => typeof mode !== 'undefined' && mode === 'edit');

async function showSource(page) {
  await page.locator('#show-markdown').click();
  await sourceMode(page);
  await page.locator('#source-editor .cm-content').waitFor({ state: 'visible' });
}

// Wait for the real rendered caret (not a sleep) and return its position.
function caretGeometry(page) {
  return page.evaluate(() => {
    const reader = document.querySelector('#reader-scroll');
    const caret = document.querySelector('#source-editor .cm-cursor');
    if (!reader || !caret) return null;
    const r = reader.getBoundingClientRect(), c = caret.getBoundingClientRect();
    return { scrollTop: reader.scrollTop, readerTop: r.top, readerBottom: r.bottom, top: c.top, bottom: c.bottom,
      visible: c.top >= r.top && c.bottom <= r.bottom };
  });
}

async function waitForCaretVisible(page) {
  await page.waitForFunction(() => {
    const reader = document.querySelector('#reader-scroll'), caret = document.querySelector('#source-editor .cm-cursor');
    if (!reader || !caret) return false;
    const r = reader.getBoundingClientRect(), c = caret.getBoundingClientRect();
    return c.top >= r.top && c.bottom <= r.bottom;
  });
  return caretGeometry(page);
}

// Wait for the table widget to be replaced by source lines and for the anchored
// reveal frame, never a fixed sleep. CodeMirror paints the transient pre-measure
// caret inside the replaced widget for one frame, so visibility alone is racy.
async function waitForTableReveal(page, clickedTop) {
  await page.waitForFunction(top => {
    const reader = document.querySelector('#reader-scroll'), caret = document.querySelector('#source-editor .cm-cursor');
    if (!reader || !caret || document.querySelector('#source-editor .source-table-preview')) return false;
    const r = reader.getBoundingClientRect(), c = caret.getBoundingClientRect();
    return c.top >= r.top && c.bottom <= r.bottom && Math.abs(c.top - top) < 80;
  }, clickedTop);
  return caretGeometry(page);
}

const content = page => page.evaluate(() => current.content);
const selection = page => page.evaluate(() => editor.getSelection());

(async () => {
  const bundle = buildBundle();
  process.on('exit', () => fs.rmSync(bundle.directory, { recursive: true, force: true }));

  // 1. Caret movement and typing must drive #reader-scroll, not just
  // CodeMirror's overflow:visible inner scroller.
  {
    const session = await openIsolatedEditor(longDoc, bundle.outfile, { width: 1000, height: 700 });
    try {
      const { page, errors, requests } = session;
      await showSource(page);
      await page.locator('#source-editor .cm-content').click();
      await page.keyboard.press('Control+End');
      const jumped = await waitForCaretVisible(page);
      assert.ok(jumped.scrollTop > 0, 'Ctrl+End must scroll the outer reader');
      await page.keyboard.type('ZZ');
      const typed = await waitForCaretVisible(page);
      assert.ok(typed.visible, 'typing at the document end must keep the caret visible');
      assert.match(await content(page), /ZZ$/);
      assert.deepEqual(requests, []);
      assert.deepEqual(errors, []);
      console.log('PASS: source caret movement and typing scroll the outer reader.');
    } finally { await session.close(); }
  }

  // 2. Find navigation selects and reveals the match in source presentation.
  {
    const session = await openIsolatedEditor(longDoc, bundle.outfile, { width: 1000, height: 700 });
    try {
      const { page, errors } = session;
      await showSource(page);
      await page.keyboard.press('Control+f');
      await page.locator('#find-input').fill('Paragraph 350');
      await page.waitForFunction(() => document.querySelector('#find-result').textContent.trim() === '1 / 1');
      await page.keyboard.press('Escape');
      const found = await waitForCaretVisible(page);
      assert.ok(found.scrollTop > 0, 'find must scroll the outer reader to the match');
      const expected = await page.evaluate(() => current.content.indexOf('Paragraph 350'));
      assert.deepEqual(await selection(page), { anchor: expected, head: expected + 'Paragraph 350'.length });

      await page.locator('#view-formatted').click();
      await page.waitForFunction(() => mode === 'read');
      await page.locator('#show-markdown').click();
      await sourceMode(page);
      await waitForCaretVisible(page);
      assert.deepEqual(await selection(page), { anchor: expected, head: expected + 'Paragraph 350'.length },
        'find selection survives a source/read presentation round trip');
      assert.deepEqual(errors, []);
      console.log('PASS: find selection scrolls into view and survives presentation switches.');
    } finally { await session.close(); }
  }

  // 3. Paste is its own undo intent; only the pasted text is undone.
  {
    const session = await openIsolatedEditor('base\n', bundle.outfile);
    try {
      const { page, errors } = session;
      await showSource(page);
      await page.locator('#source-editor .cm-content').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type('abc');
      await page.evaluate(() => {
        const content = document.querySelector('#source-editor .cm-content');
        const data = new DataTransfer(); data.setData('text/plain', 'XYZ');
        content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      });
      await page.waitForFunction(() => current.content === 'base\nabcXYZ');
      await page.keyboard.press('Control+z');
      await page.waitForFunction(() => current.content === 'base\nabc');
      await page.keyboard.press('Control+z');
      await page.waitForFunction(() => current.content === 'base\n');
      assert.deepEqual(errors, []);
      console.log('PASS: paste breaks the typing undo group instead of merging intents.');
    } finally { await session.close(); }
  }

  // 4. Clicking a rendered table maps to the cell's first content character
  // and keeps the revealed row near the clicked position.
  {
    const session = await openIsolatedEditor('# T\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n', bundle.outfile, { width: 1000, height: 700 });
    try {
      const { page, errors } = session;
      await showSource(page);
      const first = page.locator('#source-editor .source-table-preview td').first();
      await first.waitFor();
      const clickedTop = await first.evaluate(node => node.getBoundingClientRect().top);
      await first.click();
      const geometry = await waitForTableReveal(page, clickedTop);
      let selected = await selection(page);
      assert.equal(await page.evaluate(offset => current.content[offset], selected.anchor), '1',
        'clicking the "1" cell must target the start of its source text');
      assert.ok(Math.abs(geometry.top - clickedTop) < 80,
        `revealed row should stay near the clicked cell (clicked ${clickedTop}, caret ${geometry.top})`);

      await page.evaluate(() => editor.selectRange(0));
      await page.locator('#source-editor .source-table-preview td').nth(1).waitFor();
      await page.locator('#source-editor .source-table-preview td').nth(1).click();
      await page.waitForFunction(() => {
        const selected = editor.getSelection();
        return current.content[selected.anchor] === '2';
      });
      selected = await selection(page);
      assert.equal(await page.evaluate(offset => current.content[offset], selected.anchor), '2',
        'clicking the "2" cell must target the start of its source text');
      assert.deepEqual(errors, []);
      console.log('PASS: table widget clicks map to cell content and keep the revealed row in place.');
    } finally { await session.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
