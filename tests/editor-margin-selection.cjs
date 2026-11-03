const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// The formatted text sits in a narrow reading column. The ProseMirror surface
// spans the reader and carries the gutters as padding, so a drag that starts
// in the empty side margin must still select from the nearest text position.
(async () => {
  const source = '# Head\n\nAlpha beta gamma delta epsilon zeta.\n\nSecond paragraph here.\n';
  const session = await openEditor(source);
  try {
    const { page, errors } = session;
    await page.waitForTimeout(300);
    const geometry = await page.evaluate(() => {
      const paragraph = document.querySelector('#preview .ProseMirror p');
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const text = range.getBoundingClientRect();
      const surface = document.querySelector('#preview .ProseMirror').getBoundingClientRect();
      return {
        left: surface.left + 2,
        textLeft: text.left,
        right: surface.right - 2,
        y: (text.top + text.bottom) / 2
      };
    });
    assert.ok(geometry.textLeft - geometry.left > 20,
      `the test needs a real left gutter, got ${geometry.textLeft - geometry.left}px`);

    await page.mouse.move(geometry.left, geometry.y);
    await page.mouse.down();
    await page.mouse.move(geometry.textLeft + 150, geometry.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const forward = await page.evaluate(() => window.getSelection().toString());
    assert.ok(forward.startsWith('Alpha beta'),
      `a drag from the left margin selects from the line start, got ${JSON.stringify(forward)}`);

    await page.mouse.move(geometry.right, geometry.y);
    await page.mouse.down();
    await page.mouse.move(geometry.textLeft, geometry.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const backward = await page.evaluate(() => window.getSelection().toString());
    assert.ok(backward.startsWith('Alpha beta'),
      `a drag from the right margin also selects the paragraph, got ${JSON.stringify(backward)}`);

    assert.equal(await page.evaluate(() => current.content), source, 'margin selection never mutates the document');
    assert.deepEqual(errors, []);
    console.log('PASS: dragging from either side margin selects the nearest text line.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exit(1); });
