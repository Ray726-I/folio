'use strict';
// Isolated browser regression for transient empty ProseMirror paragraphs.
// These paragraphs have no Markdown token; typing must stay in the newly
// created paragraph instead of jumping back to the previous block.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { openEditor } = require('./editor-browser.cjs');

const scratchRoot = fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir();

function buildEmptyParagraphBundle() {
  const directory = fs.mkdtempSync(path.join(scratchRoot, 'folio-empty-paragraphs-'));
  const outfile = path.join(directory, 'editor.js');
  esbuild.buildSync({
    entryPoints: [path.resolve('ui/editor/entry.js')],
    bundle: true,
    format: 'iife',
    globalName: 'FolioEditor',
    target: ['es2022'],
    minify: true,
    legalComments: 'eof',
    outfile,
    logLevel: 'silent'
  });
  return { directory, outfile };
}

async function openIsolatedEditor(source, outfile) {
  const session = await openEditor(source);
  let served = 0;
  await session.page.route(/\/vendor\/editor\/editor\.js(?:\?.*)?$/, route => {
    served++;
    return route.fulfill({ path: outfile, contentType: 'application/javascript' });
  });
  await session.page.reload();
  await session.page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
  await session.page.evaluate(() => setDocumentMode('edit'));
  assert.equal(served, 1, 'empty-paragraph regression must use the isolated bundle');
  return session;
}

async function selectSourceRange(page, offset) {
  await page.evaluate(position => { editor.selectRange(position); }, offset);
  await page.waitForFunction(position => {
    const selection = editor.getSelection();
    return selection.anchor === position && selection.head === position;
  }, offset);
}

(async () => {
  const bundle = buildEmptyParagraphBundle();
  process.on('exit', () => fs.rmSync(bundle.directory, { recursive: true, force: true }));
  const source = '# Heading\n\nText paragraph\n';
  const session = await openIsolatedEditor(source, bundle.outfile);
  const { page, errors } = session;
  const text = () => page.evaluate(() => current.content);
  try {
    // 1. Enter at the end of an existing paragraph creates a transient empty
    //    paragraph. Typing must not move the caret back into "Text paragraph".
    await selectSourceRange(page, source.indexOf('Text paragraph') + 'Text paragraph'.length);
    await page.keyboard.press('Enter');
    const afterEnter = await text();
    assert.notEqual(afterEnter, source, 'Enter must update the source');
    assert.equal(await page.locator('#preview .ProseMirror > p').count(), 2, 'Enter creates a second rich paragraph');

    await page.keyboard.type('X');
    const ended = await text();
    assert.match(ended, /Text paragraph\n\nX\n?$/, `typing must stay in the new paragraph: ${JSON.stringify(ended)}`);
    assert.equal(await page.locator('#preview .ProseMirror > p').last().textContent(), 'X');

    // 2. Enter at the start of a paragraph creates an empty paragraph before it.
    //    Typing must stay in that new paragraph.
    await selectSourceRange(page, source.indexOf('Text paragraph'));
    await page.keyboard.press('Enter');
    const afterStart = await text();
    await selectSourceRange(page, afterStart.indexOf('Text paragraph') - 1);
    await page.keyboard.type('Y');
    const started = await text();
    assert.match(started, /# Heading\n\nY\n\nText paragraph/, `typing must stay in the inserted start paragraph: ${JSON.stringify(started)}`);
    assert.notEqual(started, afterStart, 'typing changes source');

    // 3. Repeated Enter/Backspace around transient empties keeps the final
    //    caret in the new paragraph.
    const repeatedSession = await openIsolatedEditor(source, bundle.outfile);
    try {
      await selectSourceRange(repeatedSession.page, source.indexOf('Text paragraph') + 'Text paragraph'.length);
      await repeatedSession.page.keyboard.press('Enter');
      await repeatedSession.page.keyboard.press('Enter');
      await repeatedSession.page.keyboard.press('Backspace');
      await repeatedSession.page.keyboard.press('Enter');
      await repeatedSession.page.keyboard.type('Z');
      const repeated = await repeatedSession.page.evaluate(() => current.content);
      assert.match(repeated, /Text paragraph\n(?:[ \t]*\n)*Z\n?$/, `typing must stay in the final transient paragraph: ${JSON.stringify(repeated)}`);
      assert.equal(await repeatedSession.page.locator('#preview .ProseMirror > p').last().textContent(), 'Z');
      assert.deepEqual(repeatedSession.errors, []);
    } finally { await repeatedSession.close(); }

    // 4. Empty paragraph between headings: splitting a paragraph at its start
    //    leaves an editable empty block under the first heading.
    const betweenSession = await openIsolatedEditor('# H\n\nText\n\n## I\n', bundle.outfile);
    try {
      await selectSourceRange(betweenSession.page, '# H\n\nText\n\n## I\n'.indexOf('Text'));
      await betweenSession.page.keyboard.press('Enter');
      const beforeTyping = await betweenSession.page.evaluate(() => current.content);
      await selectSourceRange(betweenSession.page, beforeTyping.indexOf('Text') - 1);
      await betweenSession.page.keyboard.type('Q');
      const between = await betweenSession.page.evaluate(() => current.content);
      assert.match(between, /# H\n\nQ\n\nText\n\n## I/, `typing must stay between headings: ${JSON.stringify(between)}`);
      assert.deepEqual(betweenSession.errors, []);
    } finally { await betweenSession.close(); }

    assert.deepEqual(errors, []);
    console.log('PASS: transient empty paragraphs keep source/rich caret association across Enter at start/end, repeated Enter/Backspace and between-heading splits.');
  } catch (error) {
    console.error('PAGE ERRORS:', errors, 'URL:', page.url());
    throw error;
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exit(1); });
