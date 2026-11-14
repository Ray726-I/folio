const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Preventive hardening invariant (MITIGATION, not a reproduction: the
// torn-wash report never reproduced in Chromium or native WebKitGTK 2.54.2).
// The JS selection logic mirrors active/ancestor state onto explicit row
// classes in the same synchronous paint, so the unified full-row wash never
// depends on :has() invalidation alone. This test pins that contract:
// single active row, atomic moves, collapse/expand lifecycle, and untouched
// hover, focus, keyboard, transition and scroll behavior.
const source = [
  '# Handbook',
  '',
  '## 8.1 Overview',
  '',
  'Text.',
  '',
  '## 8.2 Details',
  '',
  'Text.',
  '',
  '### 8.2.1 Sub detail',
  '',
  'Text.',
  '',
  '## 8.3 Next steps',
  '',
  'Text.',
  '',
].join('\n');

(async () => {
  const session = await openEditor(source, { width: 1180, height: 900 });
  const { page } = session;
  try {
    await page.waitForFunction(() => outlineEntries.length === 5, null, { timeout: 10000 });
    await page.evaluate(() => suppressOutlineFollow(3600000));
    const rows = () => page.evaluate(() => [...document.querySelectorAll('.outline-row')].map(row => {
      const btn = row.querySelector('.outline-link');
      return {
        text: btn.textContent.trim(),
        btn: btn.classList.contains('active'),
        row: row.classList.contains('is-active'),
        ancestorBtn: btn.classList.contains('active-ancestor'),
        ancestorRow: row.classList.contains('is-active-ancestor'),
        current: btn.getAttribute('aria-current'),
        hidden: row.hidden,
        rowBg: getComputedStyle(row).backgroundColor,
        btnBg: getComputedStyle(btn).backgroundColor,
      };
    }));

    // Active state lands on button AND row synchronously; exactly one wash.
    await page.evaluate(() => setActiveOutline(2, { instant: true }));
    await page.waitForTimeout(60);
    let state = await rows();
    assert.equal(state[2].btn, true, 'active button marked');
    assert.equal(state[2].current, 'location', 'aria-current preserved');
    assert.equal(state[2].row, true, 'active row carries explicit state');
    assert.deepEqual(state.map(r => r.row), [false, false, true, false, false], 'exactly one active row');
    const TRANSPARENT = 'rgba(0, 0, 0, 0)';
    assert.notEqual(state[2].rowBg, TRANSPARENT, 'active row carries the full-row wash');
    assert.equal(state[2].btnBg, TRANSPARENT, 'active label stays transparent: one unified wash, never doubled');

    // Moving active clears the previous row in the same paint (no double wash).
    await page.evaluate(() => setActiveOutline(4, { instant: true }));
    await page.waitForTimeout(60);
    state = await rows();
    assert.deepEqual(state.map(r => r.row), [false, false, false, false, true], 'previous row state clears atomically');
    assert.equal(state[2].btn, false, 'previous button clears too');

    // Collapse lifecycle: hidden true position marks the visible parent row.
    await page.evaluate(() => { toggleOutlineEntry(outlineEntries[2]); });
    await page.evaluate(() => setActiveOutline(3, { instant: true }));
    await page.waitForTimeout(60);
    state = await rows();
    assert.equal(state[3].hidden, true, 'child hides inside the collapsed parent');
    assert.equal(state[2].ancestorRow, true, 'collapsed parent row carries explicit ancestor state');
    assert.equal(state[2].ancestorBtn, true, 'ancestor button class preserved');
    assert.notEqual(state[2].rowBg, TRANSPARENT, 'ancestor row keeps its faint wash');
    await page.evaluate(() => { toggleOutlineEntry(outlineEntries[2], true); });
    await page.waitForTimeout(60);
    state = await rows();
    assert.equal(state[2].ancestorRow, false, 'expanding clears ancestor row state');
    assert.equal(state[3].hidden, false, 'child visible again');

    // Keyboard, focus, transitions and hover behavior are untouched.
    await page.evaluate(() => setActiveOutline(1, { instant: true }));
    await page.waitForTimeout(60);
    await page.locator('.outline-link').filter({ hasText: '8.1 Overview' }).focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(120);
    const kb = await page.evaluate(() => ({
      focused: document.activeElement?.textContent?.trim(),
      actives: [...document.querySelectorAll('.outline-link.active')].map(b => b.textContent.trim()),
      transition: getComputedStyle(document.querySelector('.outline-link')).transition,
      disclosure: getComputedStyle(document.querySelector('.outline-disclosure > .icon')).transition,
    }));
    assert.equal(kb.focused, '8.2 Details', 'ArrowDown moves outline focus');
    assert.deepEqual(kb.actives, ['8.1 Overview'], 'keyboard focus never moves the reading highlight');
    assert.match(kb.transition, /color/, 'link keeps its color-only transition (washes still swap instantly)');
    assert.ok(!/background/.test(kb.transition), 'no background transition added');
    assert.match(kb.disclosure, /transform/, 'disclosure chevron animation preserved');
    const next = page.locator('.outline-link').nth(2);
    await next.hover();
    await page.waitForTimeout(180);
    const hover = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.outline-row')];
      const info = row => {
        const btn = row.querySelector('.outline-link');
        const r = row.getBoundingClientRect();
        return { rowBg: getComputedStyle(row).backgroundColor, btnBg: getComputedStyle(btn).backgroundColor,
                 left: Math.round(r.left) };
      };
      return { active: info(rows[1]), hovered: info(rows[2]) };
    });
    assert.notEqual(hover.hovered.rowBg, TRANSPARENT, 'hovered neighbour keeps its full-row wash');
    assert.equal(hover.hovered.btnBg, TRANSPARENT, 'hovered label stays transparent');
    assert.equal(hover.hovered.left, hover.active.left, 'hover and active washes share the same left edge');

    assert.deepEqual(session.errors, []);
    console.log('PASS: outline active/ancestor state lives on rows as well as buttons; washes stay unified through moves, collapse and keyboard use.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
