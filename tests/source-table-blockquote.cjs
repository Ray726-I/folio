const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// A GFM table inside a blockquote starts after the quote marker on its first
// line, but later lines keep the marker inside the Lezer table node. The source
// preview must still render a real table and map every cell back to its exact
// Markdown source instead of showing a broken half-rendered slice.
const source = `# T

> | A | B |
> |---|---|
> | one | two |

After table.
`;

async function reset(page) {
  await page.evaluate(() => editor.selectRange(0, 0, false));
  await page.waitForFunction(() => !!document.querySelector('#source-editor .source-table-preview'));
  await page.waitForTimeout(250);
}

async function clickCell(page, text) {
  const point = await page.evaluate(cellText => {
    const cell = [...document.querySelectorAll('#source-editor .source-table-preview td, #source-editor .source-table-preview th')]
      .find(node => node.textContent.trim() === cellText);
    if (!cell) return null;
    const rect = cell.getBoundingClientRect();
    return [(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2];
  }, text);
  assert.ok(point, `rendered preview exposes the ${text} cell`);
  await page.mouse.click(point[0], point[1]);
  await page.waitForTimeout(250);
  return page.evaluate(() => editor.getSelection().anchor);
}

(async () => {
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.waitForFunction(() => document.querySelector('.ProseMirror'));
    await page.waitForTimeout(300);
    await page.locator('#show-markdown').click();
    await page.locator('#source-editor .cm-content').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);

    assert.equal(await page.locator('#source-editor .source-table-preview table').count(), 1, 'blockquoted table renders as a real table');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#source-editor .cm-line')]
      .map(line => line.textContent.trim()).filter(text => text === '>')), [], 'the hidden quote marker does not remain beside the preview');
    await reset(page);
    assert.equal(await clickCell(page, 'one'), source.indexOf('one'), 'body cell maps to its exact source');
    await reset(page);
    assert.equal(await clickCell(page, 'two'), source.indexOf('two'), 'second-column body cell maps exactly');
    await reset(page);
    assert.equal(await clickCell(page, 'A'), source.indexOf('A'), 'header cell maps to the header line');
    await reset(page);
    await clickCell(page, 'one');
    await page.keyboard.type('X');
    assert.ok((await page.evaluate(() => current.content)).includes('Xone'), 'typing edits the clicked blockquoted cell');
    assert.deepEqual(session.errors, []);
    console.log('PASS: blockquoted source tables render and map every cell to exact editable source.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
