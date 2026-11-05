const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { openEditor } = require('./editor-browser.cjs');

const scratchRoot = fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir();

function buildTableBundle() {
  const directory = fs.mkdtempSync(path.join(scratchRoot, 'folio-table-bundle-'));
  const outfile = path.join(directory, 'editor.js');
  esbuild.buildSync({
    entryPoints: [path.resolve('ui/editor/entry.js')], bundle: true, format: 'iife', globalName: 'FolioEditor',
    target: ['es2022'], minify: true, legalComments: 'eof', outfile, logLevel: 'silent'
  });
  return { directory, outfile };
}

// Exercise the edited engine without rewriting the shared vendor bundle owned by
// integration. The real app shell, native renderer fixture and DOM are used.
async function openIsolatedEditor(source, outfile) {
  const session = await openEditor(source);
  let served = 0;
  await session.page.route(/\/vendor\/editor\/editor\.js(?:\?.*)?$/, route => {
    served++; return route.fulfill({ path: outfile, contentType: 'application/javascript' });
  });
  await session.page.reload();
  await session.page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
  await session.page.evaluate(() => setDocumentMode('edit'));
  assert.equal(served, 1, 'table keyboard tests must run against the isolated editor bundle');
  // Real async work only: fixture render plus view mount. No sleeps anywhere.
  await session.page.locator('#preview table').first().waitFor();
  return session;
}

// A click (or a browser-native key like End/Home/arrows) lands the native
// caret immediately while ProseMirror converges its state asynchronously.
// Wait for that real condition, never a sleep, before keys that read state
// without a capture sync — and assert the target so a wrong cell fails loudly
// instead of testing the wrong content. Enter/Tab/Mod-Enter capture the DOM
// target synchronously in the engine, so chains of those keys need no wait.
async function awaitCaretIn(page, lo, hi) {
  await page.waitForFunction(([lo, hi]) => {
    const s = editor.getSelection();
    return s.anchor === s.head && s.anchor >= lo && s.anchor <= hi;
  }, [lo, hi]);
}

const text = page => page.evaluate(() => current.content);
const sel = page => page.evaluate(() => editor.getSelection());
const sliceOf = (page, s) => page.evaluate(range => editor.getText().slice(Math.min(range.anchor, range.head), Math.max(range.anchor, range.head)), s);
const rows = page => page.locator('#preview table tr').count();
const cells = page => page.locator('#preview table td').allInnerTexts();

(async () => {
  const bundle = buildTableBundle();
  process.on('exit', () => fs.rmSync(bundle.directory, { recursive: true, force: true }));

  // 1. The reported data loss: Tab selects a cell value, Enter must enter the
  // cell for editing without deleting it. Before the fix this cleared "2".
  // Tab/Enter capture the click target synchronously, so this chain runs with
  // no convergence wait at all.
  {
    const session = await openIsolatedEditor('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n', bundle.outfile);
    try {
      const { page, errors, requests } = session;
      await page.locator('#preview table td').first().click();
      await page.keyboard.press('Tab');
      let s = await sel(page);
      assert.equal(await sliceOf(page, s), '2', `Tab from the clicked cell selects the next cell value, got ${JSON.stringify(s)}`);
      await page.keyboard.press('Shift+Tab');
      s = await sel(page);
      assert.equal(await sliceOf(page, s), '1', `Shift+Tab returns to the previous cell value, got ${JSON.stringify(s)}`);
      await page.keyboard.press('Tab');
      s = await sel(page);
      assert.equal(await sliceOf(page, s), '2', `Tab selects the next cell value again, got ${JSON.stringify(s)}`);
      await page.keyboard.press('Enter');
      assert.match(await text(page), /\|\s*1\s*\|\s*2\s*\|/, 'existing cell content survives a Tab-selected Enter');
      assert.equal(await rows(page), 3, 'entering a Tab-selected cell adds no row');
      assert.deepEqual(await cells(page), ['1', '2', '3', '4'], 'no cell value is cleared');
      assert.deepEqual(requests, []);
      assert.deepEqual(errors, []);
      console.log('PASS: Tab-selected Enter enters the cell without deleting its value; Tab/Shift-Tab still navigate.');
    } finally { await session.close(); }
  }

  // 2. Collapsed Enter inside a cell inserts an editable hard break (<br>),
  // not a second paragraph, and keeps both halves.
  let breakText;
  {
    const session = await openIsolatedEditor('| A | B |\n|---|---|\n| hello | 2 |\n', bundle.outfile);
    try {
      const { page, errors, requests } = session;
      await page.locator('#preview table td').first().click();
      await awaitCaretIn(page, 22, 27);
      let s = await sel(page);
      assert.ok(s.anchor >= 22 && s.anchor <= 27, `click targets the "hello" cell, got ${JSON.stringify(s)}`);
      await page.keyboard.press('Home');
      await awaitCaretIn(page, 22, 22);
      s = await sel(page);
      assert.equal(s.anchor, 22, `Home moves to the start of the cell text, got ${JSON.stringify(s)}`);
      await page.keyboard.press('ArrowRight');
      await awaitCaretIn(page, 23, 23);
      await page.keyboard.press('ArrowRight');
      await awaitCaretIn(page, 24, 24);
      s = await sel(page);
      assert.equal(s.anchor, 24, `ArrowRight moves inside the cell text, got ${JSON.stringify(s)}`);
      await page.keyboard.press('Enter');
      breakText = await text(page);
      assert.ok(breakText.includes('<br>'), `middle-cell Enter keeps a Markdown <br> in the cell, got ${JSON.stringify(breakText)}`);
      assert.ok(breakText.includes('he') && breakText.includes('llo'), `both halves survive, got ${JSON.stringify(breakText)}`);
      assert.equal(await page.locator('#preview table td').first().locator('br').count(), 1, 'hard break renders as an editable <br>, not a second paragraph');
      assert.equal(await page.locator('#preview table td').first().locator('p').count(), 1, 'cell keeps a single paragraph around the break');
      assert.deepEqual(requests, []);
      assert.deepEqual(errors, []);
      console.log('PASS: collapsed middle-cell Enter inserts a hard break and both halves survive.');
    } finally { await session.close(); }
  }

  // 3. The middle-cell newline survives a save/reopen round trip: the exact
  // buffer reparses to the same source with a real hard break intact.
  // KNOWN FAILURE (model/ledger serializer): reopened cell currently holds
  // escaped literal text (td br count 0 vs 1) until the serializer fix lands.
  {
    assert.ok(breakText && breakText.includes('<br>'), 'needs the break buffer from the previous step');
    const session = await openIsolatedEditor(breakText, bundle.outfile);
    try {
      const { page, errors } = session;
      assert.equal(await text(page), breakText, 'reopened buffer is byte-identical (no silent normalization)');
      const reopened = await cells(page);
      assert.ok(reopened[0].includes('he') && reopened[0].includes('llo'), `reopened first cell keeps both halves, got ${JSON.stringify(reopened[0])}`);
      assert.equal(await page.locator('#preview table td').first().locator('br').count(), 1,
        'reopened cell must contain a real hard break, not escaped literal <br> text');
      assert.deepEqual(errors, []);
      console.log('PASS: middle-cell newline saves and reopens with identical source and intact content.');
    } finally { await session.close(); }
  }

  // 4. Collapsed Enter at the end of the last cell adds a row and undo
  // removes exactly that row.
  {
    const original = '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n';
    const session = await openIsolatedEditor(original, bundle.outfile);
    try {
      const { page, errors } = session;
      await page.locator('#preview table td').nth(3).click();
      await awaitCaretIn(page, 36, 37);
      let s = await sel(page);
      assert.ok(s.anchor >= 36 && s.anchor <= 37, `click targets the "4" cell, got ${JSON.stringify(s)}`);
      await page.keyboard.press('End');
      await awaitCaretIn(page, 37, 37);
      s = await sel(page);
      assert.equal(s.anchor, 37, `End moves to the end of the cell text, got ${JSON.stringify(s)}`);
      const before = await text(page);
      await page.keyboard.press('Enter');
      assert.equal(await rows(page), 4, 'last-cell Enter adds one row');
      const after = await text(page);
      assert.notEqual(after, before, 'new row changes the buffer');
      assert.match(after, /\n\|\s+\|\s+\|\s*\n?$/, 'new empty row is appended as Markdown');
      await page.keyboard.press('Control+z');
      assert.equal(await rows(page), 3, 'undo removes the inserted row');
      assert.equal(await text(page), before, 'undo removes exactly the inserted row');
      assert.deepEqual(errors, []);
      console.log('PASS: last-cell Enter adds a row and Ctrl+Z removes exactly that row.');
    } finally { await session.close(); }
  }

  // 5. Mod-Enter exits forward into the following paragraph (no new row) and
  // Shift-Mod-Enter exits backward; a table at the document end gains a
  // paragraph instead of trapping focus.
  {
    const session = await openIsolatedEditor('# T\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nAfter\n', bundle.outfile);
    try {
      const { page, errors } = session;
      assert.equal(await rows(page), 2, 'fixture renders header plus one data row');
      await page.locator('#preview table td').nth(1).click();
      await awaitCaretIn(page, 31, 32);
      let s = await sel(page);
      assert.ok(s.anchor >= 31 && s.anchor <= 32, `click targets the "2" cell, got ${JSON.stringify(s)}`);
      await page.keyboard.press('End');
      await awaitCaretIn(page, 32, 32);
      s = await sel(page);
      assert.equal(s.anchor, 32, `End moves to the end of the cell text, got ${JSON.stringify(s)}`);
      const exitBase = await text(page);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
      assert.equal(await rows(page), 2, 'Mod-Enter exits instead of adding a row');
      assert.equal(await text(page), exitBase, 'forward exit is pure navigation, not a mutation');
      const afterExit = await sel(page);
      const afterOffset = exitBase.indexOf('After');
      assert.ok(afterExit.anchor >= afterOffset && afterExit.head >= afterOffset,
        `forward exit lands in the following paragraph, got ${JSON.stringify(afterExit)}`);
      await page.locator('#preview table td').first().click();
      await awaitCaretIn(page, 27, 28);
      s = await sel(page);
      assert.ok(s.anchor >= 27 && s.anchor <= 28, `click targets the "1" cell, got ${JSON.stringify(s)}`);
      await page.keyboard.press(process.platform === 'darwin' ? 'Shift+Meta+Enter' : 'Shift+Control+Enter');
      const backExit = await sel(page);
      const tableOffset = exitBase.indexOf('| A |');
      assert.ok(backExit.anchor < tableOffset && backExit.head < tableOffset,
        `backward exit lands before the table, got ${JSON.stringify(backExit)}`);
      assert.deepEqual(errors, []);
      console.log('PASS: Mod-Enter exits forward and Shift-Mod-Enter exits backward without mutating.');
    } finally { await session.close(); }
  }

  {
    const session = await openIsolatedEditor('| A |\n|---|\n| 1 |\n', bundle.outfile);
    try {
      const { page, errors } = session;
      await page.locator('#preview table td').first().click();
      await awaitCaretIn(page, 14, 15);
      let s = await sel(page);
      assert.ok(s.anchor >= 14 && s.anchor <= 15, `click targets the "1" cell, got ${JSON.stringify(s)}`);
      await page.keyboard.press('End');
      await awaitCaretIn(page, 15, 15);
      s = await sel(page);
      assert.equal(s.anchor, 15, `End moves to the end of the cell text, got ${JSON.stringify(s)}`);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
      const exited = await text(page);
      assert.notEqual(exited, '| A |\n|---|\n| 1 |\n', 'exiting at the document end creates a paragraph');
      const exitedSel = await sel(page);
      const tableEnd = exited.indexOf('| 1 |') + '| 1 |'.length;
      assert.ok(exitedSel.anchor > tableEnd, `caret continues after the table, got ${JSON.stringify(exitedSel)}`);
      assert.equal(await rows(page), 2, 'exit creates a paragraph, not a row');
      assert.deepEqual(errors, []);
      console.log('PASS: exiting a trailing table creates a following paragraph for the caret.');
    } finally { await session.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
