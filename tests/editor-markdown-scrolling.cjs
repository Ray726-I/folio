const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');
const source = '# Scroll\n\n' + Array.from({ length: 100 }, (_, i) => `## Section ${i}\n\n${'A paragraph of text that wraps to several lines. '.repeat(8)}\n\n| First | Second |\n| --- | --- |\n| One | Two |\n\n`).join('');
(async () => {
  const bundle = buildEditorBundle();
  const session = await openIsolatedEditor(source, bundle.outfile, { width: 1000, height: 700 });
  try {
    const { page } = session;
    await page.locator('#show-markdown').click();
    assert.equal(await page.locator('#reader-scroll').evaluate(e => getComputedStyle(e).scrollBehavior), 'auto', 'Markdown scrolling must not queue smooth-scroll animations');
    await page.mouse.move(700, 400);
    await page.waitForTimeout(500);
    for (let i = 0; i < 12; i++) {
      const before = await page.locator('#reader-scroll').evaluate(e => e.scrollTop);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(140);
      const after = await page.locator('#reader-scroll').evaluate(e => e.scrollTop);
      assert.ok(after > before + 40, `wheel ${i} must advance through Markdown (${before} -> ${after})`);
    }
    console.log('PASS: repeated wheel scrolling advances through Markdown with rendered tables.');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
