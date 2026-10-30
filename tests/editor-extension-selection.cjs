const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// A footnote turns the whole paragraph into a raw_block. Its rendered
// projection is contenteditable=false, while the editable text lives in the
// collapsed source box. Dragging the projection must select the corresponding
// literal source, not a DOM-only range or the raw block's start.
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
          blockStart: current.content.indexOf('Press')
        }
      };
    });
    assert.ok(geometry.useStart && geometry.hereEnd && geometry.beforeStart, 'extension projection and surrounding text must be rendered');

    // A: drag wholly inside the projection. The selection endpoints must map
    // to the exact literal source, including the inline HTML between words.
    await page.mouse.move(geometry.useStart.x, geometry.useStart.y);
    await page.mouse.down();
    await page.mouse.move(geometry.hereEnd.x, geometry.hereEnd.y, { steps: 10 });
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => editor.getSelection()),
      { anchor: geometry.expected.use, head: geometry.expected.hereEnd },
      'a drag inside the projection must select the exact raw source text');
    assert.equal(await page.evaluate(({ anchor, head }) => current.content.slice(anchor, head), {
      anchor: geometry.expected.use, head: geometry.expected.hereEnd
    }), 'Use</kbd> to run and stop <samp>here.');

    // The mapped range must be real editable content: typing replaces exactly
    // that source interval, and undo restores the original bytes.
    await page.keyboard.type('X');
    assert.equal(await page.evaluate(() => current.content),
      source.slice(0, geometry.expected.use) + 'X' + source.slice(geometry.expected.hereEnd));
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => current.content), source);

    // B: drag from ordinary text outside the extension into the projection.
    // The endpoint must land on the targeted line instead of the raw block's
    // top/start.
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.mouse.move(geometry.beforeStart.x, geometry.beforeStart.y);
    await page.mouse.down();
    await page.mouse.move(geometry.hereEnd.x, geometry.hereEnd.y, { steps: 10 });
    await page.mouse.up();
    const crossBlock = await page.evaluate(() => editor.getSelection());
    assert.deepEqual(crossBlock, { anchor: geometry.expected.before, head: geometry.expected.hereEnd },
      'an outside drag must end at the targeted projection text, not the raw block start');
    assert.ok(crossBlock.head > geometry.expected.blockStart, 'the projection endpoint must be inside the raw block, not its top');
    assert.deepEqual(session.errors, []);
    console.log('PASS: extension-block pointer drags map projection text to exact editable raw source, including inside-out and outside-in selections.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
