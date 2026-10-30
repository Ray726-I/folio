const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Focused regressions for the source-mode table preview (click-to-reveal).
// Clicking anywhere that belongs to the rendered table — cell centers,
// corners, borders between cells, the header row — selects the exact source
// of the nearest cell. Clicks outside the table element are left alone so
// scrollbars and stray clicks never yank the caret.
const source = `# T

Intro text here.

| Alpha | Beta |
| --- | --- |
| one | two |
| three | four |

After table text.
`;

// Source offsets of interest (verified against the fixture above).
const CELL = { one: 56, two: 62, three: 70, alpha: 25 };

async function resetWidget(page) {
  await page.evaluate(() => { editor.selectRange(0, 0, false); });
  await page.waitForFunction(() => !!document.querySelector('#source-editor .source-table-preview'));
  await page.waitForTimeout(250);
}

async function click(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(250);
  const anchor = await page.evaluate(() => editor.getSelection().anchor);
  await page.mouse.up();
  await page.waitForTimeout(150);
  return anchor;
}

(async () => {
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.waitForFunction(() => document.querySelector('.ProseMirror'));
    await page.waitForTimeout(400);
    await page.locator('#show-markdown').click();
    await page.locator('#source-editor .cm-content').waitFor({ state: 'visible' });
    await page.waitForTimeout(600);

    const box = await page.evaluate(() => {
      const cells = {};
      for (const cell of document.querySelectorAll('#source-editor .source-table-preview td, #source-editor .source-table-preview th')) {
        const r = cell.getBoundingClientRect();
        cells[cell.textContent.trim()] = { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      const w = document.querySelector('#source-editor .source-table-preview').getBoundingClientRect();
      return { cells, wrap: { x: w.x, y: w.y, w: w.width, h: w.height } };
    });
    const center = key => {
      const c = box.cells[key];
      return [(c.x + c.w / 2), (c.y + c.h / 2)];
    };

    // 1. Cell centers land on the exact cell source.
    await resetWidget(page);
    assert.equal(await click(page, ...center('one')), CELL.one, 'center cell maps to its exact source');
    await resetWidget(page);
    assert.equal(await click(page, ...center('four')), 78, 'second-column body cell maps exactly');

    // 2. Corners resolve to the touched cell, not the table start.
    const one = box.cells['one'];
    await resetWidget(page);
    assert.equal(await click(page, one.x + 2, one.y + 2), CELL.one, 'top-left corner maps to that cell');
    await resetWidget(page);
    assert.equal(await click(page, one.x + one.w - 2, one.y + one.h / 2), CELL.one, 'right edge maps to the same cell');

    // 3. Borders between cells map to the nearest cell on the correct row.
    // (Points sit just inside an edge; the exact shared pixel is hit-test
    // ambiguous across engines.)
    await resetWidget(page);
    assert.equal(await click(page, one.x + one.w - 3, one.y + one.h / 2), CELL.one, 'near the right edge maps to the left cell');
    await resetWidget(page);
    assert.equal(await click(page, one.x + one.w + 3, one.y + one.h / 2), CELL.two, 'near the left edge maps to the right cell');
    await resetWidget(page);
    assert.equal(await click(page, one.x + one.w / 2, one.y + one.h - 3), CELL.one, 'near the bottom edge maps to the cell above');

    // 3b. A mousedown whose target is the wrapper background (not the table)
    // is ignored: no reveal, no caret jump into the table.
    await resetWidget(page);
    const beforeBackground = await page.evaluate(() => editor.getSelection().anchor);
    const backgroundIgnored = await page.evaluate(() => {
      const wrapper = document.querySelector('#source-editor .source-table-preview');
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 });
      wrapper.dispatchEvent(event);
      return {
        defaultPrevented: event.defaultPrevented,
        widgetAlive: !!document.querySelector('#source-editor .source-table-preview'),
      };
    });
    assert.equal(backgroundIgnored.defaultPrevented, false, 'wrapper background mousedown is not hijacked');
    assert.equal(backgroundIgnored.widgetAlive, true, 'wrapper background mousedown does not reveal');
    assert.equal(await page.evaluate(() => editor.getSelection().anchor), beforeBackground, 'wrapper background mousedown moves no caret');

    // 4. Header row maps to its own line, not the body.
    await resetWidget(page);
    assert.equal(await click(page, ...center('Alpha')), CELL.alpha, 'header cell maps to the header line');

    // 5. Revealing shows the source and keeps the caret in the cell.
    await resetWidget(page);
    await click(page, ...center('two'));
    const revealed = await page.evaluate(() => !!document.querySelector('#source-editor .source-table-preview'));
    assert.equal(revealed, false, 'clicking a cell reveals the Markdown source');
    assert.equal(await page.evaluate(() => current.content), source, 'reveal never mutates the document');

    // 6. Locked editing still selects the cell without mutating anything.
    // (Recompute geometry: the lock banner shifts the document down.)
    await page.locator('#lock-document').click();
    await page.waitForTimeout(400);
    await page.evaluate(() => { editor.selectRange(0, 0, false); });
    await page.waitForTimeout(250);
    const lockedPoint = await page.evaluate(() => {
      const cell = [...document.querySelectorAll('#source-editor .source-table-preview td')].find(node => node.textContent.trim() === 'one');
      const r = cell.getBoundingClientRect();
      return [(r.left + r.right) / 2, (r.top + r.bottom) / 2];
    });
    const widgetBack = await page.evaluate(() => !!document.querySelector('#source-editor .source-table-preview'));
    assert.ok(widgetBack, 'widget returns after caret leaves under lock');
    const beforeLock = await page.evaluate(() => current.content);
    await click(page, lockedPoint[0], lockedPoint[1]);
    assert.equal(await page.evaluate(() => editor.getSelection().anchor), CELL.one, 'locked click still selects the cell');
    await page.keyboard.type('ZZZ');
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => current.content), beforeLock, 'locked click never edits');
    await page.locator('#lock-document').click();
    await page.waitForTimeout(250);

    assert.deepEqual(session.errors, []);
    console.log('PASS: source table preview maps every in-table click to the exact cell source, ignores outside clicks, and preserves content under lock.');
  } catch (error) {
    console.error('PAGE ERRORS:', session.errors);
    await session.page.screenshot({ path: '/tmp/opencode/folio-source-table-failure.png', fullPage: true }).catch(() => {});
    throw error;
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exit(1); });
