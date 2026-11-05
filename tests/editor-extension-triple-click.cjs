const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// A rendered block (alert, footnote, raw HTML, Mermaid) is one atom in the
// editor model. ProseMirror's triple-click default therefore selected the
// whole block, title and all, instead of the rendered paragraph under the
// pointer. A triple click on rendered text must select that paragraph, the
// same text a drag inside the projection already produces.
const source = `# Showcase

> [!CAUTION]
> This is sample content. There is no actual danger or destructive action here.

After paragraph here.
`;

const BODY = 'This is sample content. There is no actual danger or destructive action here.';

async function pointIn(page, selector, word) {
  return page.evaluate(({ selector, word }) => {
    const scope = document.querySelector(selector);
    if (!scope) return null;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      const index = text.nodeValue.indexOf(word);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(text, index + 1);
      range.setEnd(text, index + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left, y: (rect.top + rect.bottom) / 2 };
    }
    return null;
  }, { selector, word });
}

// A real triple click sends press counts 1, 2 and 3, which is how the browser
// reports three rapid presses at the same point.
async function tripleClick(page, point) {
  for (const clickCount of [1, 2, 3]) {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down({ clickCount });
    await page.mouse.up({ clickCount });
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(250);
}

(async () => {
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.waitForFunction(() => document.querySelector('.extension-preview')?.textContent.includes('sample'));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);

    // Triple click on the rendered alert body selects that paragraph only.
    const body = await pointIn(page, '.extension-preview p:not(.markdown-alert-title)', 'sample');
    assert.ok(body, 'the alert body must be rendered inside the projection');
    await tripleClick(page, body);
    const selected = await page.evaluate(() => window.getSelection().toString());
    assert.equal(selected, BODY, `a triple click selects the rendered paragraph, got ${JSON.stringify(selected.slice(0, 80))}`);
    assert.ok(!selected.includes('Caution'), 'the alert title is not part of the paragraph selection');
    assert.equal(await page.evaluate(() => current.content), source, 'selecting rendered text leaves the Markdown untouched');
    await page.evaluate(() => window.getSelection().removeAllRanges());

    // A triple click on ordinary text still selects that paragraph.
    const paragraph = await pointIn(page, '.ProseMirror > p', 'paragraph');
    assert.ok(paragraph, 'the ordinary paragraph must be rendered');
    await tripleClick(page, paragraph);
    assert.equal(await page.evaluate(() => window.getSelection().toString()), 'After paragraph here.', 'a triple click on prose still selects the paragraph');
    assert.equal(await page.evaluate(() => current.content), source, 'the paragraph selection leaves the Markdown untouched');

    assert.deepEqual(session.errors, []);
    console.log('PASS: triple click selects the rendered paragraph inside a projection and never the whole block.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
