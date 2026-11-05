const { openMarkdown } = require('./editor-test-actions.cjs');
const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Footnote markup uses a rendered projection. Dragging can span prose and
// the projection. The context menu reveals the exact source.
const source = `# Showcase

Before word here.

Press <kbd>Use</kbd> to run and stop <samp>here.</samp>[^1]

[^1]: note
`;

(async () => {
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.waitForFunction(() => document.querySelector('.extension-preview')?.textContent.includes('Use'));
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => document.querySelector('.extension-preview')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);

    // Reading view: projection renders, but no source disclosure exists.
    assert.equal(await page.evaluate(() => editor.isSource()), false, 'starts in the reading view');
    assert.equal(await page.locator('#preview .source-block').count(), 0, 'no source text in reading view');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#preview summary')].map(node => node.textContent)), [], 'no disclosures in reading view');

    const geometry = await page.evaluate(() => {
      const projection = document.querySelector('.extension-preview');
      const paragraph = [...document.querySelectorAll('.ProseMirror > p')].find(element => element.textContent.startsWith('Before'));
      const point = (word, end) => {
        const walker = document.createTreeWalker(projection, NodeFilter.SHOW_TEXT);
        let text;
        while ((text = walker.nextNode())) {
          const index = text.nodeValue.indexOf(word);
          if (index < 0) continue;
          const offset = end ? index + word.length : index;
          const range = document.createRange();
          range.setStart(text, offset); range.setEnd(text, offset);
          const rect = range.getBoundingClientRect();
          return { x: rect.left, y: (rect.top + rect.bottom) / 2 };
        }
        return null;
      };
      const before = document.createRange();
      before.setStart(paragraph.firstChild, 0); before.setEnd(paragraph.firstChild, 0);
      const beforeRect = before.getBoundingClientRect();
      return {
        useStart: point('Use', false),
        hereEnd: point('here.', true),
        beforeStart: { x: beforeRect.left, y: (beforeRect.top + beforeRect.bottom) / 2 },
        expected: {
          use: current.content.indexOf('Use'),
          hereEnd: current.content.indexOf('here.', 30) + 'here.'.length,
          before: current.content.indexOf('Before'),
        }
      };
    });
    assert.ok(geometry.useStart && geometry.hereEnd && geometry.beforeStart, 'extension projection and surrounding text must be rendered');

    // A: a drag wholly inside the projection selects the rendered text for
    // reading and copy. It must not splice the literal source inline.
    await page.mouse.move(geometry.useStart.x, geometry.useStart.y);
    await page.mouse.down();
    await page.mouse.move(geometry.hereEnd.x, geometry.hereEnd.y, { steps: 10 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.getSelection().toString()), 'Use to run and stop here.', 'a drag inside the projection selects the rendered text');
    assert.equal(await page.evaluate(() => current.content), source, 'reading selection leaves the Markdown untouched');
    await page.evaluate(() => window.getSelection().removeAllRanges());

    // B: a drag from ordinary text into the projection spans rendered text
    // on both sides and never mutates the document.
    await page.mouse.move(geometry.beforeStart.x, geometry.beforeStart.y);
    await page.mouse.down();
    await page.mouse.move(geometry.hereEnd.x, geometry.hereEnd.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const cross = await page.evaluate(() => window.getSelection().toString());
    assert.ok(cross.includes('Before word here.'), `cross drag starts in rendered paragraph text, got ${JSON.stringify(cross.slice(0, 60))}`);
    assert.ok(cross.includes('Press Use to run and stop here.'), `cross drag reaches rendered projection text, got ${JSON.stringify(cross.slice(-60))}`);
    assert.ok(!cross.includes('<kbd>') && !cross.includes('[^1]:'), 'cross selection carries no Markdown source');
    assert.ok((await page.evaluate(() => current.content)) === source, 'an outside drag leaves the Markdown untouched');
    await page.evaluate(() => window.getSelection().removeAllRanges());

    // C: the context menu reveals exact source in the shared editor.
    await openMarkdown(page.locator('.extension-preview samp').first());
    const sourceBlock = page.locator('.folio-source-edit');
    await sourceBlock.waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => editor.isSource()), false);
    assert.match(await sourceBlock.textContent(), /Press <kbd>Use<\/kbd>/);
    assert.equal(await page.evaluate(() => current.content), source);
    await sourceBlock.evaluate(element => window.getSelection().selectAllChildren(element));
    await page.waitForFunction(() => { const selection = editor.getSelection(); return selection.anchor !== selection.head; });
    await page.keyboard.insertText('In-place block edit.');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => current.content.includes('In-place block edit.'));
    assert.ok(!(await page.evaluate(() => current.content)).includes('Press <kbd>Use</kbd>'));
    await page.keyboard.press('Control+z');
    await page.waitForFunction(text => current.content === text, source);
    assert.deepEqual(session.errors, []);
    console.log('PASS: extension-block reading shows no source disclosure, projection drags select rendered text, and the edit action opens the exact block source in place.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
