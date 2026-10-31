const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');
const source = '# Code\n\n```js\nconst longExample = "' + 'a'.repeat(150) + 'END_MARKER";\n```\n';
(async () => {
  const bundle = buildEditorBundle();
  const session = await openIsolatedEditor(source, bundle.outfile, { width: 600, height: 700 });
  try {
    const { page } = session;
    await page.waitForFunction(() => document.querySelector('.code-container')?.classList.contains('code-highlighted'));
    const result = await page.locator('.code-container').evaluate(async container => {
      const surface = container.querySelector('.code-surface'), highlight = container.querySelector('.code-highlight');
      surface.scrollLeft = surface.scrollWidth;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { surface: surface.scrollLeft, highlight: highlight.scrollLeft, maximum: surface.scrollWidth - surface.clientWidth };
    });
    assert.ok(result.surface > 0 && result.maximum > 0, 'fixture must overflow horizontally');
    assert.ok(Math.abs(result.highlight - result.surface) <= 1, `highlight must follow editable source (${JSON.stringify(result)})`);
    const back = await page.locator('.code-container').evaluate(async container => {
      const surface = container.querySelector('.code-surface'), highlight = container.querySelector('.code-highlight');
      surface.scrollLeft = 0;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return highlight.scrollLeft;
    });
    assert.equal(back, 0, 'highlight returns to the start when scrolling back');
    assert.equal(await page.evaluate(() => current.content), source, 'scrolling must not change the document');
    console.log('PASS: highlighted code scrolls with the editable surface to the line end.');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
