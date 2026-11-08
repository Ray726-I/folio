const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Clicking an outline row must select that row and keep it selected: the jump
// lands the heading on the scroll-spy line so the spy converges on the click
// instead of overriding it with the heading above, and exactly one row reads
// as selected (no competing ancestor highlight).
(async () => {
  const source = Array.from({ length: 40 }, (_, i) => `## Section ${i + 1}\n\nBody text for section ${i + 1}.\n`).join('\n');
  const session = await openEditor(source, { width: 1100, height: 600 });
  try {
    const { page } = session;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => outlineEntries.length === 40);
    await page.waitForFunction(() => outlineActiveIndex >= 0);
    await page.evaluate(() => { $('reader-scroll').scrollTop = 0; });
    await page.waitForTimeout(150);
    await page.locator('.outline-link').nth(29).click();
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => outlineActiveIndex), 29, 'click selects Section 30 and the spy keeps it');
    const state = await page.evaluate(() => {
      const reader = $('reader-scroll').getBoundingClientRect();
      const el = outlineEntries[29].element;
      return {
        top: el ? el.getBoundingClientRect().top - reader.top : null,
        actives: [...document.querySelectorAll('.outline-link.active')].map(button => button.textContent),
        ancestors: [...document.querySelectorAll('.outline-link.active-ancestor')].filter(button => button.offsetParent !== null).map(button => button.textContent),
      };
    });
    assert.ok(Math.abs(state.top - 88) < 4, `heading lands on the spy line, got ${state.top}`);
    assert.deepEqual(state.actives, ['Section 30'], `exactly one active row, got ${JSON.stringify(state.actives)}`);
    assert.deepEqual(state.ancestors, [], `no visible ancestor highlight, got ${JSON.stringify(state.ancestors)}`);
    assert.deepEqual(session.errors, []);
    console.log('PASS: outline click holds its highlight and lands on the spy line');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
