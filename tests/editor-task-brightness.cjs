const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// A checked task line reads brighter than an open one, so progress through a
// list is legible at a glance. The checkbox keeps its own checked/unchecked
// states; only the line's text colour changes.
const source = `# Tasks

- [x] Source file
- [ ] Renderer comparison
`;

const alphaOf = color => {
  const rgba = /rgba?\(\s*[\d.]+\s*[, ]\s*[\d.]+\s*[, ]\s*[\d.]+\s*(?:[,/]\s*([\d.]+))?\s*\)/.exec(color);
  if (rgba) return rgba[1] === undefined ? 1 : Number(rgba[1]);
  const slash = /\/\s*([\d.]+)\s*\)/.exec(color);
  return slash ? Number(slash[1]) : 1;
};

(async () => {
  for (const reading of [false, true]) {
    const session = await openEditor(source, undefined, { reading });
    const { page } = session;
    try {
      await page.waitForFunction(() => document.querySelectorAll('#preview li input[type="checkbox"]').length === 2);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(200);
      const rows = await page.evaluate(() => [...document.querySelectorAll('#preview li')]
        .filter(li => li.querySelector('input[type="checkbox"]'))
        .map(li => ({ checked: li.querySelector('input').checked, color: getComputedStyle(li).color })));
      const mode = reading ? 'reading' : 'edit';

      assert.equal(rows.length, 2, `${mode}: both task rows render`);
      const checked = rows.find(row => row.checked);
      const open = rows.find(row => !row.checked);
      assert.ok(checked && open, `${mode}: one checked and one open task`);
      assert.notEqual(checked.color, open.color, `${mode}: checked and open lines must not share one colour`);
      assert.equal(alphaOf(checked.color), 1, `${mode}: a checked line is fully opaque, got ${checked.color}`);
      assert.ok(alphaOf(open.color) < 0.9, `${mode}: an open line is dimmed, got ${open.color}`);
      assert.deepEqual(session.errors, []);
    } finally { await session.close(); }
  }
  console.log('PASS: checked task lines are brighter than open ones in both edit and reading modes.');
})().catch(error => { console.error(error); process.exitCode = 1; });
