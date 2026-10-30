const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

const source = Array.from({ length: 24 }, (_, i) => `## Section ${i}\n\nA paragraph preceding the table.\n\n`).join('') + `| Feature | Example | Status |
|:---|:---:|---:|
| Emphasis | **bold** and *italic* | Ready |
| Inline math | $E=mc^2$ | 42 |
| Code | \`Result<T, E>\` | 3 |
| Escaped pipe | left \\| right | 1 |
| Empty cell | | 0 |

# Wide table

| Process | Arrival time | CPU burst | Priority | Waiting time | Turnaround time | Response time | Explanation |
|---|---:|---:|---:|---:|---:|---:|---|
| **P1** | 0 ms | 12 ms | 2 | 8 ms | 20 ms | 0 ms | A long explanation checks horizontal scrolling in narrow windows |
| **P2** | 3 ms | 7 ms | 1 | 4 ms | 11 ms | 4 ms | Headers and cells should stay aligned while you scroll |
| **P3** | 5 ms | 4 ms | 3 | 10 ms | 14 ms | 10 ms | Bold labels should be distinct from ordinary cells |

After table.
`;

(async () => {
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.locator('#show-markdown').click();
    await page.evaluate(pos => editor.selectRange(pos, pos, true), source.indexOf('**P3**'));
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const lines = [...document.querySelectorAll('#source-editor .cm-line')];
      lines.find(line => line.textContent.includes('ordinary cells')).scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(300);
    const point = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelector('#source-editor .cm-content'), NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) {
        const at = text.data.indexOf('ordinary cells');
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(text, at + 3); range.setEnd(text, at + 3);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, y: (rect.top + rect.bottom) / 2 };
      }
      return null;
    });
    assert.ok(point, 'ordinary cells is visible in the revealed table source');
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#source-editor .source-table-preview').filter({ hasText: 'Bold labels should be distinct' }).count(), 0, 'clicking wrapped source keeps the table editable');
    const selection = await page.evaluate(() => editor.getSelection());
    assert.ok(Math.abs(selection.head - (source.indexOf('ordinary cells') + 3)) <= 1, `caret should land in ordinary cells, got ${selection.head}`);
    await page.keyboard.type('X');
    assert.ok((await page.evaluate(() => current.content)).includes('ordXinary cells'), 'typing edits at the clicked position');
    assert.deepEqual(session.errors, []);
    console.log('PASS: clicking a wrapped table source line places an editable caret.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
