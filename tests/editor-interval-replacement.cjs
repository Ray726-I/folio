const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { openEditor } = require('./editor-browser.cjs');

const scratchRoot = fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir();

async function buildBundle({ injectDivergence = false } = {}) {
  const directory = fs.mkdtempSync(path.join(scratchRoot, 'folio-interval-bundle-'));
  const outfile = path.join(directory, 'editor.js');
  const plugins = [];
  if (injectDivergence) {
    // Test-only build transform: no production hook or exposed view API. The
    // injected appendTransaction simulates a table repair that changes the
    // canonical parse after a source-first splice.
    plugins.push({
      name: 'inject-append-divergence',
      setup(build) {
        build.onLoad({ filter: /ui[\\/]editor[\\/]rich\.js$/ }, args => {
          const original = fs.readFileSync(args.path, 'utf8');
          const marker = 'plugins: [';
          assert.ok(original.includes(marker), 'injection point missing from rich.js');
          const contents = original.replace(marker,
            `plugins: [new Plugin({ appendTransaction(transactions, oldState, newState) { if (window.__folioTestAppendDivergence && transactions.some(tr => tr.getMeta('folio-source-commit'))) { return newState.tr.insertText('!', Math.min(1, newState.doc.content.size)); } return null; } }), `);
          return { contents, loader: 'js' };
        });
      }
    });
  }
  const options = {
    entryPoints: [path.resolve('ui/editor/entry.js')], bundle: true, format: 'iife', globalName: 'FolioEditor',
    target: ['es2022'], minify: true, legalComments: 'eof', outfile, logLevel: 'silent', plugins
  };
  if (injectDivergence) await esbuild.build(options);
  else esbuild.buildSync(options);
  return { directory, outfile };
}

// Run the edited engine from source without rewriting the shared vendor bundle.
async function openIsolated(source, outfile) {
  const session = await openEditor(source);
  let served = 0;
  await session.page.route(/\/vendor\/editor\/editor\.js(?:\?.*)?$/, route => {
    served++;
    return route.fulfill({ path: outfile, contentType: 'application/javascript' });
  });
  await session.page.reload();
  await session.page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
  assert.equal(served, 1, 'interval tests must run against the isolated editor bundle');
  return session;
}

async function showSource(page) {
  if (await page.evaluate(() => mode) === 'edit') return;
  await page.locator('#show-markdown').click();
  await page.waitForFunction(() => !busy && mode === 'edit');
}
async function showRich(page) {
  if (await page.evaluate(() => mode) === 'read') return;
  await page.locator('#view-formatted').click();
  await page.waitForFunction(() => !busy && mode === 'read');
}
async function selectSource(page, anchor, head = anchor) {
  await showSource(page);
  await page.evaluate(range => editor.selectRange(range.anchor, range.head), { anchor, head });
  await page.waitForFunction(range => {
    const selection = editor.getSelection();
    return selection.anchor === range.anchor && selection.head === range.head;
  }, { anchor, head });
}
const content = page => page.evaluate(() => current.content);
const selection = page => page.evaluate(() => editor.getSelection());
const expectedSplice = (source, from, to, insert) => source.slice(0, from) + insert + source.slice(to);

function pastePlainText(page, text) {
  return page.evaluate(value => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    document.querySelector('#preview .ProseMirror').dispatchEvent(event);
  }, text);
}

(async () => {
  const bundle = await buildBundle();
  process.on('exit', () => fs.rmSync(bundle.directory, { recursive: true, force: true }));

  // 1. A non-injective source offset inside an entity survives zero-write
  // presentation round trips, and a selected marked run replaces its exact
  // source delimiters and undo restores the bytes.
  {
    const source = 'A &amp; B\n\nA **bold** B\n';
    const session = await openIsolated(source, bundle.outfile);
    try {
      const { page, errors } = session;
      await selectSource(page, 4);
      await showRich(page);
      await showSource(page);
      assert.deepEqual(await selection(page), { anchor: 4, head: 4 },
        'raw source entity offset must survive a zero-write presentation round trip');

      const start = source.indexOf('**bold**');
      await selectSource(page, start, start + 8);
      await showRich(page);
      await page.keyboard.type('X');
      assert.equal(await content(page), expectedSplice(source, start, start + 8, 'X'),
        'typed replacement must remove the selected bold delimiters exactly');
      await page.keyboard.press('Control+z');
      assert.equal(await content(page), source, 'undo must restore the exact source bytes');
      assert.deepEqual(errors, []);
      console.log('PASS: source bookmark survives entity projection; selected markers replace and undo exactly.');
    } finally { await session.close(); }
  }

  // 2. Forward/backward source intervals across table cells and across
  // prose/table/prose boundaries match the literal source splice.
  {
    const source = '# H\n\nProse A\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nTail\n';
    {
      const session = await openIsolated(source, bundle.outfile);
      try {
        const { page, errors } = session;
        const from = source.indexOf('1');
        const to = source.indexOf('2') + 1;
        await selectSource(page, from, to);
        await showRich(page);
        await page.keyboard.type('X');
        assert.equal(await content(page), expectedSplice(source, from, to, 'X'),
          'a forward selection across cells must splice the exact source interval');
        assert.deepEqual(errors, []);
      } finally { await session.close(); }
    }
    {
      const session = await openIsolated(source, bundle.outfile);
      try {
        const { page, errors } = session;
        const from = source.indexOf('1');
        const to = source.indexOf('2') + 1;
        await selectSource(page, to, from);
        await showRich(page);
        await page.keyboard.type('Y');
        assert.equal(await content(page), expectedSplice(source, from, to, 'Y'),
          'a backward selection across cells must splice the same literal interval');
        assert.deepEqual(errors, []);
      } finally { await session.close(); }
    }
    {
      const session = await openIsolated(source, bundle.outfile);
      try {
        const { page, errors } = session;
        const from = source.indexOf('Prose A');
        const to = source.indexOf('Tail') + 4;
        await selectSource(page, from, to);
        await showRich(page);
        await page.keyboard.type('Q');
        assert.equal(await content(page), expectedSplice(source, from, to, 'Q'),
          'a prose/table/prose selection must preserve the literal slice boundaries');
        assert.deepEqual(errors, []);
        console.log('PASS: forward, backward and cross-block source intervals match literal splices.');
      } finally { await session.close(); }
    }
  }

  // 3. Delete, Backspace, Enter, plain-text paste and SelectAll use the same
  // logical source interval semantics.
  {
    const source = '# H\n\nProse A\n\nTail\n';
    for (const key of ['Backspace', 'Delete']) {
      const session = await openIsolated(source, bundle.outfile);
      try {
        const { page, errors } = session;
        const from = source.indexOf('Prose A');
        await selectSource(page, from, from + 'Prose A'.length);
        await showRich(page);
        await page.keyboard.press(key);
        assert.equal(await content(page), expectedSplice(source, from, from + 'Prose A'.length, ''),
          `${key} over a selected logical range must delete exactly that source interval`);
        assert.deepEqual(errors, []);
      } finally { await session.close(); }
    }
    {
      const session = await openIsolated(source, bundle.outfile);
      try {
        const { page, errors } = session;
        const from = source.indexOf('Prose A');
        await selectSource(page, from, from + 'Prose A'.length);
        await showRich(page);
        await page.keyboard.press('Enter');
        assert.equal(await content(page), expectedSplice(source, from, from + 'Prose A'.length, '\n'),
          'Enter over a selected logical range must splice a newline, not collapse the range');
        assert.deepEqual(errors, []);
      } finally { await session.close(); }
    }
    {
      const session = await openIsolated(source, bundle.outfile);
      try {
        const { page, errors } = session;
        const from = source.indexOf('Prose A');
        const expected = expectedSplice(source, from, from + 'Prose A'.length, 'PASTE');
        await selectSource(page, from, from + 'Prose A'.length);
        await showRich(page);
        await pastePlainText(page, 'PASTE');
        await page.waitForFunction(value => current.content === value, expected);
        assert.equal(await content(page), expected, 'plain-text paste must replace the logical interval');
        assert.deepEqual(errors, []);
      } finally { await session.close(); }
    }
    {
      const source = '# H\n\nProse A\n';
      const session = await openIsolated(source, bundle.outfile);
      try {
        const { page, errors } = session;
        const from = source.indexOf('Prose A');
        await selectSource(page, from, from + 'Prose A'.length);
        await showRich(page);
        await page.keyboard.press('Control+x');
        await page.waitForFunction(value => current.content === value, expectedSplice(source, from, from + 'Prose A'.length, ''));
        assert.equal(await content(page), expectedSplice(source, from, from + 'Prose A'.length, ''),
          'cut must remove exactly the logical source interval');
        assert.deepEqual(errors, []);
      } finally { await session.close(); }
    }
    {
      const sourceWithReferences = '[a][ref]\n\n[ref]: https://example.com\n';
      const session = await openIsolated(sourceWithReferences, bundle.outfile);
      try {
        const { page, errors } = session;
        await showRich(page);
        await page.keyboard.press('Control+a');
        assert.deepEqual(await selection(page), { anchor: 0, head: sourceWithReferences.length },
          'SelectAll must map the whole source, including reference definitions');
        await page.keyboard.type('Z');
        assert.equal(await content(page), 'Z', 'typing after SelectAll replaces the whole source, including retained definitions');
        assert.deepEqual(errors, []);
        console.log('PASS: Delete, Backspace, Enter, paste and SelectAll all use logical source intervals.');
      } finally { await session.close(); }
    }
  }

  // 4. An explicit caret click releases the logical bookmark even when it
  // lands on the projection of the bookmarked source position.
  {
    const session = await openIsolated('A &amp; B\n', bundle.outfile);
    try {
      const { page, errors } = session;
      await selectSource(page, 4);
      await showRich(page);
      assert.deepEqual(await selection(page), { anchor: 4, head: 4 });
      const point = await page.evaluate(() => {
        const paragraph = document.querySelector('#preview .ProseMirror p');
        const node = paragraph.firstChild;
        const range = document.createRange();
        range.setStart(node, 4);
        range.setEnd(node, 4);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y + rect.height / 2 };
      });
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(() => {
        const current = editor.getSelection();
        return !(current.anchor === 4 && current.head === 4);
      });
      await showSource(page);
      const released = await selection(page);
      assert.notDeepEqual(released, { anchor: 4, head: 4 }, 'an explicit same-projection click must release the logical bookmark');
      assert.deepEqual(errors, []);
      console.log('PASS: an explicit caret click releases the source bookmark.');
    } finally { await session.close(); }
  }

  // 5. Lock prevents logical source-first mutations; unlocking restores them.
  {
    const source = '# H\n\nProse A\n';
    const session = await openIsolated(source, bundle.outfile);
    try {
      const { page, errors } = session;
      const from = source.indexOf('Prose A');
      await selectSource(page, from, from + 'Prose A'.length);
      await showRich(page);
      await page.locator('#lock-document').click();
      await page.waitForFunction(() => editor.isLocked());
      await pastePlainText(page, 'BLOCKED');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await content(page), source, 'Lock must reject a source-first paste');
      await page.keyboard.type('X');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await content(page), source, 'Lock must reject source-first typing');
      await page.locator('#lock-document').click();
      await page.waitForFunction(() => !editor.isLocked());
      assert.deepEqual(errors, []);
      console.log('PASS: Lock blocks logical source-first mutations.');
    } finally { await session.close(); }
  }

  // 6. If an appendTransaction plugin diverges from the canonical parse, the
  // exact splice must fail closed: no model/source, selection, history or view
  // rewrite, with an explicit status message.
  {
    const injected = await buildBundle({ injectDivergence: true });
    process.on('exit', () => fs.rmSync(injected.directory, { recursive: true, force: true }));
    const source = '# H\n\nProse A\n';
    const session = await openIsolated(source, injected.outfile);
    try {
      const { page, errors } = session;
      const from = source.indexOf('Prose A');
      const to = from + 'Prose A'.length;
      await selectSource(page, from, to);
      await showRich(page);
      const beforeSelection = await selection(page);
      await page.evaluate(() => { window.__folioTestAppendDivergence = true; });
      await page.keyboard.type('X');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await content(page), source, 'a divergent appendTransaction must not rewrite canonical source');
      assert.deepEqual(await selection(page), beforeSelection, 'a rejected splice must keep the logical selection bookmarked');
      assert.match(await page.locator('#toast').textContent(), /preserved/, 'a rejected splice must report why nothing changed');
      await page.keyboard.press('Control+x');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await content(page), source, 'a rejected cut must not fall through to schema deletion');
      assert.deepEqual(await selection(page), beforeSelection, 'a rejected cut must keep the logical selection bookmarked');
      await page.keyboard.press('Control+z');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await content(page), source, 'a rejected splice must not add a history entry');
      assert.deepEqual(errors, []);
      console.log('PASS: divergent appendTransaction repairs fail closed without source/history/selection changes.');
    } finally { await session.close(); }
  }

  // 7. Basic table keyboard and typing behavior remains intact after replacing
  // stock tableEditing with a fixTables appendTransaction plugin.
  {
    const source = '| A | B |\n|---|---|\n| 1 | 2 |\n';
    const session = await openIsolated(source, bundle.outfile);
    try {
      const { page, errors } = session;
      await page.locator('#preview table td').first().click();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      assert.equal(await content(page), source, 'Tab-selected Enter must not delete the cell value');
      await page.locator('#preview table td').first().click();
      await page.waitForFunction(() => {
        const current = editor.getSelection();
        return current.anchor >= 22 && current.anchor <= 23;
      });
      await page.keyboard.press('End');
      await page.keyboard.type('9');
      assert.match(await content(page), /\|\s*19\s*\|/, 'ordinary typing in a cell must still update the source');
      assert.deepEqual(errors, []);
      console.log('PASS: basic table Tab/Enter protection and typing remain intact.');
    } finally { await session.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
