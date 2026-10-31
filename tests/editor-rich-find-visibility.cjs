const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { openEditor } = require('./editor-browser.cjs');

const scratchRoot = fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir();
const FIND = 'FINDNEEDLE';
const LOCKED_FIND = 'LOCKEDNEEDLE';
const prose = 'Readable prose keeps the rendered document tall and calm.';
const longDoc = '# Rich find\n\n'
  + Array.from({ length: 120 }, (_, i) => `Paragraph ${i}. ${prose} ${prose}`).join('\n\n')
  + `\n\nA unique **${FIND}** target appears here.\n\nA second ${LOCKED_FIND} target appears here.\n`;

function buildBundle() {
  const directory = fs.mkdtempSync(path.join(scratchRoot, 'folio-rich-find-'));
  const outfile = path.join(directory, 'editor.js');
  esbuild.buildSync({
    entryPoints: [path.resolve('ui/editor/entry.js')], bundle: true, format: 'iife', globalName: 'FolioEditor',
    target: ['es2022'], minify: true, legalComments: 'eof', outfile, logLevel: 'silent'
  });
  return { directory, outfile };
}

// Exercise the edited engine without rewriting the shared vendor bundle. The
// real app shell, native renderer fixture, find bar and DOM are used.
async function openIsolatedEditor(source, outfile, viewport) {
  const session = await openEditor(source, viewport);
  let served = 0;
  await session.page.route(/\/vendor\/editor\/editor\.js(?:\?.*)?$/, route => {
    served++; return route.fulfill({ path: outfile, contentType: 'application/javascript' });
  });
  await session.page.reload();
  await session.page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
  assert.equal(served, 1, 'rich find tests must run against the isolated editor bundle');
  return session;
}

// The rendered target's range, not a DOM block, so the assertion covers the
// match's actual text box inside the rich presentation.
function richFindState(page, needle) {
  return page.evaluate(needle => {
    const scroller = document.getElementById('reader-scroll');
    const preview = document.getElementById('preview');
    const viewport = scroller.getBoundingClientRect();
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
    let rect = null, node;
    while ((node = walker.nextNode())) {
      const index = node.nodeValue.indexOf(needle);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      rect = range.getBoundingClientRect();
      break;
    }
    const from = current.content.indexOf(needle);
    return {
      rect: rect ? { top: rect.top, bottom: rect.bottom } : null,
      viewport: { top: viewport.top, bottom: viewport.bottom },
      scrollTop: scroller.scrollTop,
      selection: editor.getSelection(),
      from,
      to: from + needle.length,
      locked: editor.isLocked()
    };
  }, needle);
}

function waitForRichFindVisible(page, needle) {
  return page.waitForFunction(needle => {
    const scroller = document.getElementById('reader-scroll');
    const preview = document.getElementById('preview');
    if (!scroller || !preview) return false;
    const viewport = scroller.getBoundingClientRect();
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.nodeValue.indexOf(needle);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      const rect = range.getBoundingClientRect();
      return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
    }
    return false;
  }, needle);
}

(async () => {
  const bundle = buildBundle();
  process.on('exit', () => fs.rmSync(bundle.directory, { recursive: true, force: true }));

  const session = await openIsolatedEditor(longDoc, bundle.outfile, { width: 1000, height: 700 });
  try {
    const { page, errors } = session;
    await page.waitForFunction(() => editor && !editor.isSource());

    const initial = await richFindState(page, FIND);
    assert.ok(initial.rect, 'the find target must be rendered in the rich view');
    assert.ok(initial.rect.top > initial.viewport.bottom + 1000,
      'fixture must place the target far below the visible rich viewport');

    await page.keyboard.press('Control+f');
    await page.locator('#find-input').fill(FIND);
    await page.waitForFunction(() => document.getElementById('find-result').textContent.trim() === '1 / 1');
    await waitForRichFindVisible(page, FIND);

    const found = await richFindState(page, FIND);
    assert.deepEqual(found.selection, { anchor: found.from, head: found.to },
      'rich find must select the exact source range');
    assert.ok(found.scrollTop > 0, 'rich find must scroll the outer reader to an offscreen match');

    // Re-running a find for a match that is already visible must not move the
    // scroller: reveal is conditional, not a focus jump.
    await page.locator('#find-input').press('Enter');
    await page.waitForTimeout(50);
    const again = await richFindState(page, FIND);
    assert.ok(Math.abs(again.scrollTop - found.scrollTop) < 1,
      `re-finding a visible match must not move the scroller (${found.scrollTop} -> ${again.scrollTop})`);
    assert.deepEqual(again.selection, { anchor: found.from, head: found.to });

    // A query that includes Markdown syntax must keep its exact source range
    // even though the rich view renders only the formatted text.
    const syntaxQuery = `**${FIND}**`;
    await page.locator('#find-input').fill(syntaxQuery);
    await page.waitForFunction(() => document.getElementById('find-result').textContent.trim() === '1 / 1');
    const syntax = await page.evaluate(needle => {
      const from = current.content.indexOf(needle);
      return { selection: editor.getSelection(), scrollTop: document.getElementById('reader-scroll').scrollTop, from, to: from + needle.length };
    }, syntaxQuery);
    assert.deepEqual(syntax.selection, { anchor: syntax.from, head: syntax.to },
      'rich find must retain the exact source range, including Markdown delimiters');
    assert.ok(Math.abs(syntax.scrollTop - found.scrollTop) < 1,
      'a formatted match already in view must not move the scroller');

    await page.locator('#find-input').fill(FIND);
    await page.waitForFunction(() => document.getElementById('find-result').textContent.trim() === '1 / 1');

    // The selected range must survive the source presentation round trip.
    await page.locator('#show-markdown').click();
    await page.waitForFunction(() => !busy && mode === 'edit');
    await page.waitForFunction(needle => [...document.querySelectorAll('#source-editor .cm-line')]
      .some(item => item.textContent.includes(needle)), FIND);
    const source = await page.evaluate(needle => {
      const from = current.content.indexOf(needle);
      return { content: current.content, selection: editor.getSelection(), from, to: from + needle.length };
    }, FIND);
    assert.deepEqual(source.selection, { anchor: source.from, head: source.to },
      'find selection must stay exact when moving to Markdown');

    await page.locator('#view-formatted').click();
    await page.waitForFunction(() => !busy && mode === 'read');
    const back = await richFindState(page, FIND);
    assert.equal(back.locked, false);
    assert.deepEqual(back.selection, { anchor: found.from, head: found.to },
      'find selection must stay exact when returning to the rich view');

    // Locking protects edits, not navigation: find must still select and reveal.
    await page.evaluate(() => editor.setLocked(true));
    await page.locator('#find-input').fill(LOCKED_FIND);
    await page.waitForFunction(() => document.getElementById('find-result').textContent.trim() === '1 / 1');
    await waitForRichFindVisible(page, LOCKED_FIND);
    const locked = await richFindState(page, LOCKED_FIND);
    assert.equal(locked.locked, true);
    assert.deepEqual(locked.selection, { anchor: locked.from, head: locked.to },
      'find must select the exact range while the document is locked');
    assert.ok(locked.scrollTop > found.scrollTop, 'locked find must still scroll to its offscreen match');

    assert.deepEqual(errors, []);
    console.log('PASS: rich find selects exactly, reveals offscreen matches, and survives mode/lock changes.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
