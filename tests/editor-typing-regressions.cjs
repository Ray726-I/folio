const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { openEditor } = require('./editor-browser.cjs');

const scratchRoot = fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir();

function buildTypingBundle() {
  const directory = fs.mkdtempSync(path.join(scratchRoot, 'folio-typing-bundle-'));
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
  assert.equal(served, 1, 'typing regressions must run against the isolated editor bundle');
  return session;
}

async function replaceParagraph(page, marker) {
  await page.locator(`#preview p:text-is("${marker}")`).click({ clickCount: 3 });
}

(async () => {
  const bundle = buildTypingBundle();
  process.on('exit', () => fs.rmSync(bundle.directory, { recursive: true, force: true }));
  const source = '# T\n\np1\n\np2\n\np3\n\np4\n\np5\n\np6\n\np7\n\np8\n\np9\n';
  const session = await openIsolatedEditor(source, bundle.outfile);
  const { page, errors, requests } = session;
  const text = () => page.evaluate(() => current.content);
  try {
    // Markdown emphasis must complete, not half-complete at the first of two
    // closing asterisks. A single `*` is not a valid closing delimiter for `**`.
    await replaceParagraph(page, 'p1');
    await page.keyboard.type('**hello');
    assert.equal(await page.locator('#preview strong').count(), 0, 'unfinished bold must stay literal');
    assert.equal(await page.locator('#preview em').count(), 0, 'unfinished bold must not become italic');
    await page.keyboard.type('*');
    assert.equal(await page.locator('#preview em').count(), 0, 'the first closing * must not complete italic inside **');
    assert.equal(await page.locator('#preview strong').count(), 0, 'bold needs both closing asterisks');
    await page.keyboard.type('*');
    assert.equal(await page.locator('#preview strong').filter({ hasText: 'hello' }).count(), 1, 'bold completes on the second closing *');
    assert.equal(await page.locator('#preview em').count(), 0, 'completed bold must not contain an italic artifact');
    assert.match(await text(), /(^|\n)\*\*hello\*\*(\n|$)/, 'source keeps the Markdown bold delimiter');

    await replaceParagraph(page, 'p2');
    await page.keyboard.type('*italic*');
    assert.equal(await page.locator('#preview em').filter({ hasText: 'italic' }).count(), 1);
    assert.match(await text(), /(^|\n)\*italic\*(\n|$)/);

    await replaceParagraph(page, 'p3');
    await page.keyboard.type('__bold__');
    assert.equal(await page.locator('#preview strong').filter({ hasText: 'bold' }).count(), 1);
    assert.match(await text(), /(^|\n)(?:__bold__|\*\*bold\*\*)(\n|$)/);

    await replaceParagraph(page, 'p4');
    await page.keyboard.type('`code`');
    assert.equal(await page.locator('#preview p code').filter({ hasText: 'code' }).count(), 1);
    assert.match(await text(), /`code`/);

    // A divider completed with Space becomes a real horizontal rule; the caret
    // must remain after it so the next keystroke creates prose, not source text.
    await replaceParagraph(page, 'p5');
    await page.keyboard.type('---');
    assert.equal(await page.locator('#preview hr').count(), 0, 'divider waits for a completion trigger');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#preview hr').count(), 1, 'space completes a `---` divider');
    assert.doesNotMatch(await text(), /\\-\\-\\-/, 'divider source must not be escaped');
    await page.keyboard.type('after divider');
    const afterDivider = await page.locator('#preview hr').first().evaluate(node => node.closest('div')?.nextElementSibling?.textContent?.trim() ?? '');
    assert.equal(afterDivider, 'after divider', 'caret continues after the divider');
    assert.match(await text(), /---\n\nafter divider/);

    // Typed Markdown links become real link marks, and following text stays
    // outside the link rather than inheriting it.
    await replaceParagraph(page, 'p6');
    await page.keyboard.type('[label](https://example.com)');
    const anchor = page.locator('#preview a[href="https://example.com"]');
    assert.equal(await anchor.count(), 1, 'link syntax becomes one anchor');
    assert.equal(await anchor.textContent(), 'label');
    assert.match(await text(), /\[label\]\(https:\/\/example\.com\)/);
    await page.keyboard.type(' tail');
    assert.match(await text(), /\[label\]\(https:\/\/example\.com\) tail/, 'typing after a link remains outside it');
    assert.equal(await anchor.textContent(), 'label');

    // A typed image becomes the existing privacy-preserving image widget. The
    // remote host must not be fetched, and the caret continues after the atom.
    await replaceParagraph(page, 'p7');
    await page.keyboard.type('![alt](https://example.com/image.png)');
    assert.equal(await page.locator('#preview .image-widget').count(), 1, 'image syntax becomes the image widget');
    assert.equal(await page.locator('#preview .image-widget .image-caption').textContent(), 'alt');
    assert.equal(await page.locator('#preview .image-widget img').count(), 0, 'remote image stays blocked without consent');
    await page.keyboard.type(' tail');
    assert.match(await text(), /!\[alt\]\(https:\/\/example\.com\/image\.png\) tail/, 'typing after an image remains outside the atom');
    assert.equal(await page.locator('#preview .image-widget').count(), 1);

    // Ordinary task syntax must continue to work in the same document.
    await replaceParagraph(page, 'p8');
    await page.keyboard.type('- [ ] task');
    const checkbox = page.locator('#preview li.task-item input[type=checkbox]');
    assert.equal(await checkbox.count(), 1, 'task syntax creates a task item');
    assert.equal(await checkbox.isChecked(), false);
    assert.match(await text(), /- \[ \] task/);

    // Unsafe destinations must not become active link attributes.
    await replaceParagraph(page, 'p9');
    await page.keyboard.type('[bad](javascript:alert)');
    assert.equal(await page.locator('#preview a[href*="javascript:"]').count(), 0, 'unsafe link destination is not activated');
    assert.equal(await page.locator('#preview p:text-is("[bad](javascript:alert)")').count(), 1, 'unsafe link stays literal text');

    assert.deepEqual(requests, [], 'typing a remote image syntax must not fetch it');
    assert.deepEqual(errors, []);
    console.log('PASS: typed bold/italic/code/tasks, divider with Space, links and privacy-preserving images complete without source escaping or caret loss.');
  } finally { await session.close(); }

  // Enter is the other sane divider completion trigger.
  const enterSession = await openIsolatedEditor('# T\n\np\n', bundle.outfile);
  try {
    const { page, errors } = enterSession;
    const text = () => page.evaluate(() => current.content);
    await replaceParagraph(page, 'p');
    await page.keyboard.type('---');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#preview hr').count(), 1, 'Enter completes a `---` divider');
    assert.doesNotMatch(await text(), /\\-\\-\\-/, 'divider source must not be escaped');
    await page.keyboard.type('after enter');
    const afterDivider = await page.locator('#preview hr').first().evaluate(node => node.closest('div')?.nextElementSibling?.textContent?.trim() ?? '');
    assert.equal(afterDivider, 'after enter', 'caret continues after an Enter-completed divider');
    assert.match(await text(), /---\n\nafter enter/);
    assert.deepEqual(errors, []);
    console.log('PASS: Enter completes a divider and keeps the caret in the following paragraph.');
  } finally { await enterSession.close(); }
})().catch(error => { console.error(error); process.exit(1); });
