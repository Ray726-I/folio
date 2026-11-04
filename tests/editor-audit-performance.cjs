const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Ordinary typing must never fall back to a document-wide parse. The editor
// exposes counters so this is a behavioral contract, not a timing guess.
const source = [
  '# Heading',
  '',
  'A top-level paragraph.',
  '',
  '- list alpha',
  '- list beta',
  '',
  '| A | B |',
  '| --- | --- |',
  '| one | two |',
  '',
  '> quote line',
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
].join('\n');

async function reset(page) {
  await page.evaluate(() => {
    editor.resetStats();
    const debug = editor.stats().edit;
    debug.full = 0; debug.local = 0; debug.incremental = 0; debug.reason = '';
  });
}
async function typeIn(page, selector) {
  const point = await page.evaluate(selector => {
    const element = document.querySelector(selector);
    if (!element) return null;
    element.scrollIntoView({ block: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + 4, y: rect.top + rect.height / 2 };
  }, selector);
  assert.ok(point, `target ${selector} exists`);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press('End');
  await page.waitForTimeout(120);
  await reset(page);
  const before = await page.evaluate(() => ({ content: current.content, caret: editor.getSelection().head }));
  await page.keyboard.type('x');
  await page.waitForTimeout(220);
  const after = await page.evaluate(() => ({ content: current.content, stats: editor.stats() }));
  assert.equal(after.content, before.content.slice(0, before.caret) + 'x' + before.content.slice(before.caret), `${selector} splices exactly one source byte`);
  assert.equal(after.stats.edit.full, 0, `${selector} avoids the whole-document parse fallback`);
  assert.ok(after.stats.edit.local > 0, `${selector} takes the local slice path`);
}

(async () => {
  const session = await openEditor(source, { width: 1000, height: 700 });
  try {
    const { page, errors } = session;
    await typeIn(page, '#preview .ProseMirror > p');
    await typeIn(page, '#preview li p');
    await typeIn(page, '#preview td p');
    await typeIn(page, '#preview blockquote p');
    await typeIn(page, '#preview .code-surface code');

    // Source mode must not synchronize the hidden rich editor per keystroke.
    const before = await page.evaluate(() => current.content);
    await page.evaluate(() => setDocumentMode('source'));
    await page.waitForTimeout(250);
    await page.evaluate(() => { const t = document.querySelector('#document-source'); t.focus(); t.setSelectionRange(5, 5); });
    await reset(page);
    for (let i = 0; i < 5; i++) { await page.keyboard.type('Z'); await page.waitForTimeout(25); }
    await page.waitForTimeout(250);
    const typed = await page.evaluate(() => ({ content: current.content, stats: editor.stats(), caret: document.querySelector('#document-source').selectionStart }));
    assert.equal(typed.content.length, before.length + 5, 'source mode updates the canonical buffer');
    assert.equal(typed.stats.edit.full, 0, 'source mode does not parse the document per key');
    assert.equal(typed.stats.sourceParses, 0, 'source mode performs no source parse per key');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    const undone = await page.evaluate(() => ({ content: current.content, caret: document.querySelector('#document-source').selectionStart }));
    assert.equal(undone.content, before, 'one undo restores the whole source typing run');
    assert.equal(undone.caret, 5, 'source undo restores the pre-typing caret');
    await page.evaluate(() => setDocumentMode('edit'));
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => current.content), before, 'switching back to Edit does not rewrite the buffer');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => current.content === '');
    await reset(page);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(value => current.content === value, before);
    assert.equal(await page.evaluate(() => editor.stats().sourceParses), 0,
      'undo after replacing the entire document reuses its previous parsed model');
    assert.deepEqual(errors, []);
    console.log('PASS: nested blocks and source mode avoid document-wide parsing, preserve source, and undo in typing groups.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exit(1); });
