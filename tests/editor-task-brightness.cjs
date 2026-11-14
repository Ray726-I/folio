const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

const source = `- [x] Done **bold** [done link](https://example.com)
  - [ ] Child open [child link](https://example.com)
- [ ] Open task
`;

(async () => {
  for (const reading of [false, true]) {
    const session = await openEditor(source, undefined, { reading });
    try {
      for (const theme of ['graphite', 'solarized']) {
        await session.page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const { rows, muted } = await session.page.evaluate(() => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--muted)';
          probe.textContent = 'x';
          probe.setAttribute('aria-hidden', 'true');
          document.body.append(probe);
          const muted = getComputedStyle(probe).color;
          probe.remove();
          const rows = [...document.querySelectorAll('#preview li.task-item')].map(li => {
            const text = li.querySelector(':scope > .list-content > p');
            const link = text ? text.querySelector('a') : null;
            const style = getComputedStyle(text);
            return {
              color: style.color,
              decoration: style.textDecorationLine,
              linkColor: link ? getComputedStyle(link).color : null,
              checked: li.querySelector(':scope > input').checked,
            };
          });
          return { rows, muted };
        });
        const label = `${reading ? 'reading' : 'edit'} ${theme}`;
        assert.equal(rows.length, 3, label);
        assert.deepEqual(rows.map(row => row.checked), [true, false, false], label);
        assert.equal(rows[0].color, muted, `${label}: completed text uses the muted tone`);
        assert.equal(rows[0].linkColor, rows[0].color, `${label}: link in completed text inherits the muted tone`);
        assert.equal(rows[1].color, rows[2].color, `${label}: nested open text stays normal`);
        assert.notEqual(rows[1].linkColor, rows[0].linkColor, `${label}: nested open link keeps its accent`);
        assert.match(rows[0].decoration, /line-through/, `${label}: completed text is struck through`);
        assert.equal(rows[1].decoration, 'none', `${label}: nested open text is not struck through`);
        assert.equal(rows[2].decoration, 'none', `${label}: open text is not struck through`);
      }
      if (!reading) {
        const openStyle = await session.page.locator('#preview li.task-item > .list-content > p').nth(2).evaluate(el => getComputedStyle(el).color);
        await session.page.locator('#preview li.task-item > input').nth(2).click({ force: true });
        await session.page.waitForFunction(() => document.querySelectorAll('#preview li.task-item > input')[2].checked);
        const toggled = await session.page.locator('#preview li.task-item > .list-content > p').nth(2).evaluate(el => ({ color: getComputedStyle(el).color, decoration: getComputedStyle(el).textDecorationLine }));
        assert.match(toggled.decoration, /line-through/, 'toggling a task updates its styling');
        assert.notEqual(toggled.color, openStyle, 'toggling a task mutes its text');
        await session.page.locator('#preview li.task-item > input').nth(2).click({ force: true });
        await session.page.waitForFunction(() => !document.querySelectorAll('#preview li.task-item > input')[2].checked);
        const restored = await session.page.locator('#preview li.task-item > .list-content > p').nth(2).evaluate(el => ({ color: getComputedStyle(el).color, decoration: getComputedStyle(el).textDecorationLine }));
        assert.equal(restored.color, openStyle, 'untoggling a task restores its text');
        assert.equal(restored.decoration, 'none', 'untoggling a task removes its strike-through');
      }
      assert.deepEqual(session.errors, []);
    } finally { await session.close(); }
  }
  console.log('PASS: task completion styling in edit and reading modes.');
})().catch(error => { console.error(error); process.exitCode = 1; });
