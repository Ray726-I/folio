const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

const source = `- [x] Done **bold**
  - [ ] Child open
- [ ] Open task
`;

(async () => {
  for (const reading of [false, true]) {
    const session = await openEditor(source, undefined, { reading });
    try {
      for (const theme of ['graphite', 'solarized']) {
        await session.page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const rows = await session.page.evaluate(() => [...document.querySelectorAll('#preview li.task-item')].map(li => {
          const text = li.querySelector(':scope > .list-content > p');
          const style = getComputedStyle(text);
          return { color: style.color, decoration: style.textDecorationLine, checked: li.querySelector(':scope > input').checked };
        }));
        const label = `${reading ? 'reading' : 'edit'} ${theme}`;
        assert.equal(rows.length, 3, label);
        assert.deepEqual(rows.map(row => row.checked), [true, false, false], label);
        assert.notEqual(rows[0].color, rows[2].color, `${label}: completed text is muted`);
        assert.equal(rows[1].color, rows[2].color, `${label}: nested open text stays normal`);
        assert.match(rows[0].decoration, /line-through/, `${label}: completed text is struck through`);
        assert.equal(rows[1].decoration, 'none', `${label}: nested open text is not struck through`);
        assert.equal(rows[2].decoration, 'none', `${label}: open text is not struck through`);
      }
      if (!reading) {
        await session.page.locator('#preview li.task-item > input').nth(2).click({ force: true });
        await session.page.waitForFunction(() => document.querySelectorAll('#preview li.task-item > input')[2].checked);
        const decoration = await session.page.locator('#preview li.task-item > .list-content > p').nth(2).evaluate(el => getComputedStyle(el).textDecorationLine);
        assert.match(decoration, /line-through/, 'toggling a task updates its styling');
      }
      assert.deepEqual(session.errors, []);
    } finally { await session.close(); }
  }
  console.log('PASS: task completion styling in edit and reading modes.');
})().catch(error => { console.error(error); process.exitCode = 1; });
