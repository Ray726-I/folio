const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

async function clickText(page, text) {
  const point = await page.evaluate(text => {
    const walker = document.createTreeWalker(document.querySelector('#preview'), NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) if (node.nodeValue.includes(text) && !node.parentElement.closest('.code-highlight')) {
      const range = document.createRange(); range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 3, y: rect.top + rect.height / 2 };
    }
    return null;
  }, text);
  assert.ok(point, `text ${text} is rendered`);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(180);
}

(async () => {
  // 1. Soft line breaks survive Enter and source-first bold formatting.
  {
    const session = await openEditor('Alpha beta\nGamma delta.\n', { width: 900, height: 650 });
    try {
      const { page, errors } = session;
      await clickText(page, 'Gamma');
      await page.keyboard.press('End');
      await page.waitForTimeout(120);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(220);
      await page.keyboard.type('X');
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => current.content), 'Alpha beta\nGamma delta.\n\nX\n', 'Enter preserves the existing soft break and starts a paragraph');
      assert.deepEqual(errors, []);
    } finally { await session.close(); }
  }
  {
    const session = await openEditor('Alpha beta\nGamma delta.\n', { width: 900, height: 650 });
    try {
      const { page } = session;
      await page.evaluate(() => editor.selectRange(0, 10));
      await page.waitForTimeout(150);
      await page.keyboard.press('Control+b');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => current.content), '**Alpha beta**\nGamma delta.\n', 'bold keeps the untouched soft break and exact selection');
    } finally { await session.close(); }
  }

  // 2. Outline navigation lands after the heading markers.
  {
    const session = await openEditor('# First\n\nAlpha.\n\n## Second\n\nBeta.\n', { width: 1100, height: 650 });
    try {
      const { page } = session;
      await page.waitForFunction(() => [...document.querySelectorAll('#outline-items .outline-link')].some(item => item.textContent === 'Second'));
      await page.evaluate(() => [...document.querySelectorAll('#outline-items .outline-link')].find(item => item.textContent === 'Second').click());
      await page.waitForTimeout(250);
      await page.keyboard.type('X');
      await page.waitForTimeout(220);
      assert.match(await page.evaluate(() => current.content), /^## XSecond$/m, 'typing after an outline jump keeps the heading');
    } finally { await session.close(); }
  }

  // 3. Block commands are rejected inside a code block and a table cell.
  {
    const session = await openEditor('```js\nconst x = 1;\n```\n\n| A | B |\n| --- | --- |\n| one | two |\n', { width: 900, height: 650 });
    try {
      const { page } = session;
      const code = await page.evaluate(() => { const el = document.querySelector('.code-surface code'); const r = el.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 10 }; });
      await page.mouse.click(code.x, code.y);
      await page.waitForTimeout(180);
      await page.evaluate(() => { for (const name of ['heading', 'bullet', 'quote']) editor.command(name); });
      await page.waitForTimeout(200);
      assert.match(await page.evaluate(() => current.content), /^```js\nconst x = 1;\n```/m, 'code fence survives block commands');
      const cell = await page.evaluate(() => { const el = document.querySelector('td p'); const r = el.getBoundingClientRect(); return { x: r.left + 6, y: r.top + r.height / 2 }; });
      await page.mouse.click(cell.x, cell.y);
      await page.waitForTimeout(180);
      await page.evaluate(() => { for (const name of ['heading', 'bullet', 'quote']) editor.command(name); });
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => current.content), '```js\nconst x = 1;\n```\n\n| A | B |\n| --- | --- |\n| one | two |\n', 'cell markdown stays intact');
    } finally { await session.close(); }
  }

  // 4. Insert > Table places the caret in the first cell.
  {
    const session = await openEditor('First paragraph.\n', { width: 900, height: 650 });
    try {
      const { page } = session;
      await clickText(page, 'First paragraph');
      await page.evaluate(() => editor.command('table'));
      await page.waitForTimeout(300);
      await page.keyboard.type('X');
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => document.querySelector('#preview th, #preview td')?.textContent), 'X', 'the caret is in the first cell');
      assert.match(await page.evaluate(() => current.content), /\|\s*X\s*\|/, 'the cell holds the typed source');
    } finally { await session.close(); }
  }

  // 5. Table paste uses <br>, cross-cell cut refuses to mutate, task toggles
  //    preserve loose-list blank lines.
  {
    const session = await openEditor('| A | B |\n| --- | --- |\n| one | two |\n\n- [ ] a\n\n- [ ] b\n', { width: 900, height: 650 });
    try {
      const { page } = session;
      await clickText(page, 'two');
      await page.keyboard.press('End');
      await page.waitForTimeout(120);
      await page.evaluate(() => {
        const data = new DataTransfer(); data.setData('text/plain', 'x\ny');
        document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      });
      await page.waitForTimeout(300);
      assert.ok((await page.evaluate(() => current.content)).includes('| one | twox<br>y |'), 'cell multiline paste stays in one cell');
      const checkbox = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll('#preview input[type=checkbox]')];
        const box = boxes[0];
        box.scrollIntoView({ block: 'center' });
        const rect = box.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await page.mouse.click(checkbox.x, checkbox.y);
      await page.waitForTimeout(350);
      assert.match(await page.evaluate(() => current.content), /- \[x\] a\n\n- \[ \] b\n/, 'task toggle changes only the marker and keeps the blank line');
    } finally { await session.close(); }
  }

  // 6. Visual copy is balanced, cut removes delimiters, and Cut All across an
  //    image is no longer a silent no-op.
  {
    const session = await openEditor('Prefix **bold** suffix.\n', { width: 900, height: 650 });
    try {
      const { page } = session;
      const result = await page.evaluate(() => {
        const strong = document.querySelector('#preview strong'), node = strong.firstChild;
        const selection = getSelection(); selection.removeAllRanges();
        const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, node.nodeValue.length); selection.addRange(range);
        const dt = new DataTransfer();
        document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
        return dt.getData('text/plain');
      });
      assert.equal(result, 'bold', 'visual copy is balanced visible text');
      const cut = await page.evaluate(() => {
        const strong = document.querySelector('#preview strong'), node = strong.firstChild;
        const selection = getSelection(); selection.removeAllRanges();
        const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, node.nodeValue.length); selection.addRange(range);
        const dt = new DataTransfer();
        document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('cut', { clipboardData: dt, bubbles: true, cancelable: true }));
        return dt.getData('text/plain');
      });
      await page.waitForTimeout(250);
      assert.equal(cut, 'bold');
      assert.equal(await page.evaluate(() => current.content), 'Prefix  suffix.\n', 'cut removes the mark delimiters with the word');
    } finally { await session.close(); }
  }
  {
    const session = await openEditor('Alpha.\n\n![alt](pic.png)\n\nOmega.\n', { width: 900, height: 650 });
    try {
      const { page } = session;
      await clickText(page, 'Alpha');
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(180);
      await page.keyboard.press('Control+x');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => current.content), '', 'Cut All across a rendered image deletes the document');
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => current.content), 'Alpha.\n\n![alt](pic.png)\n\nOmega.\n', 'undo restores the cut document');
    } finally { await session.close(); }
  }

  // 7. Formatted text keeps the normal word-selection double-click; images
  //    place a usable caret; a fence typed with Enter becomes a real fence.
  {
    const session = await openEditor('A **bold** word.\n', { width: 900, height: 650 });
    try {
      const { page } = session;
      const point = await page.evaluate(() => { const el = document.querySelector('#preview strong'); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.mouse.dblclick(point.x, point.y);
      await page.waitForTimeout(250);
      assert.equal(await page.locator('.folio-source-edit').count(), 0, 'double-click on bold keeps word selection');
      assert.equal(await page.evaluate(() => window.getSelection().toString()), 'bold');
    } finally { await session.close(); }
  }
  {
    const session = await openEditor('Before.\n\n![alt](pic.png)\n\nAfter.\n', { width: 900, height: 650 });
    try {
      const { page } = session;
      const point = await page.evaluate(() => { const el = document.querySelector('#preview .image-widget'); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(200);
      await page.keyboard.type('B');
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => current.content), 'Before.\n\n![alt](pic.png)B\n\nAfter.\n', 'image click places a usable adjacent caret');
    } finally { await session.close(); }
  }
  {
    const session = await openEditor('Start.\n', { width: 900, height: 650 });
    try {
      const { page } = session;
      await clickText(page, 'Start');
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      await page.keyboard.type('```js');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(250);
      await page.keyboard.type('const answer = 42;');
      await page.waitForTimeout(300);
      const content = await page.evaluate(() => current.content);
      assert.match(content, /```js\nconst answer = 42;\n```/, 'a typed fence becomes a real code block');
      assert.ok(!content.includes('\\`\\`\\`'), 'the fence is not escaped');
    } finally { await session.close(); }
  }

  {
    const session = await openEditor('Start.\n', { width: 900, height: 650 });
    try {
      const { page } = session;
      await clickText(page, 'Start');
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      await page.keyboard.type('2 * 3 * 4');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.querySelector('#preview .ProseMirror > p:last-of-type')?.textContent), '2 * 3 * 4', 'space-flanked asterisks stay literal');
      assert.ok(!(await page.evaluate(() => current.content)).includes('*3*'), 'the input rule does not invent emphasis');
    } finally { await session.close(); }
  }

  console.log('PASS: soft breaks, outline headings, block-command guards, table edits, task toggles and clipboard boundaries preserve exact Markdown.');
})().catch(error => { console.error(error); process.exit(1); });
