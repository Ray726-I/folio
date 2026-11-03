const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
 const source = '```c\nint first = 1;\n```\n\n## Next\n\n```cpp\nint second = 2;\nreturn second;\n```\n\nAfter.\n';
 const session = await openEditor(source);
 try {
  const { page } = session;
  await page.locator('.code-container.code-highlighted').first().waitFor();
  await page.locator('.code-container').first().dblclick();
  await page.locator('.folio-source-edit').waitFor();
  await page.locator('.code-container.code-highlighted').waitFor();
  const state = await page.evaluate(async () => {
   const first = document.querySelector('.folio-source-edit code').firstChild;
   const last = document.querySelector('.code-surface code').firstChild;
   const range = document.createRange(); range.setStart(first, 1); range.setEnd(last, last.length - 1);
   const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
   document.dispatchEvent(new Event('selectionchange'));
   await new Promise(resolve => requestAnimationFrame(resolve));
   const ranges = [...CSS.highlights.get('folio-selection')];
   const code = document.querySelector('.code-surface code');
   return { text:selection.toString(), fragmentOnly:ranges.every(r => r.startContainer === r.endContainer && r.startContainer.nodeType === Node.TEXT_NODE),
    codeCovered:ranges.some(r => code.contains(r.startContainer)),
    nativeBackground:getComputedStyle(code, '::selection').backgroundColor,
    codeColor:getComputedStyle(code).color,
    overlayVisibility:getComputedStyle(document.querySelector('.code-highlight')).visibility };
  });
  assert.equal(state.fragmentOnly, true, 'mirror paints text fragments, never block rectangles');
  assert.equal(state.codeCovered, true, 'rendered code uses the same mirror');
  assert.equal(state.nativeBackground, 'rgba(0, 0, 0, 0)', 'native code highlight cannot overlap mirror');
  assert.notEqual(state.codeColor, 'rgba(0, 0, 0, 0)', 'selected source glyphs remain visible');
  assert.equal(state.overlayVisibility, 'hidden', 'duplicate syntax glyph layer is hidden during selection');
  assert.match(state.text, /first[\s\S]*second/);
  assert.equal(await page.evaluate(() => current.content), source);
  await page.screenshot({ path:'/tmp/folio-selection-paint-selected.png' });
  await page.evaluate(() => document.documentElement.dataset.theme = 'graphite');
  await page.screenshot({ path:'/tmp/folio-selection-paint-dark.png' });
  assert.equal(await page.locator('.code-surface code').evaluate(code => getComputedStyle(code, '::selection').backgroundColor), 'rgba(0, 0, 0, 0)', 'dark themes also have one paint layer');
  await page.evaluate(() => { window.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
  assert.equal(await page.locator('.code-selection-painted').count(), 0, 'collapse restores ordinary syntax paint');
  assert.deepEqual(session.errors, []);
  await page.screenshot({ path:'/tmp/folio-selection-paint.png' });
 } finally { await session.close(); }
 console.log('PASS: one text-fragment selection paint across source and rendered code');
})().catch(e => { console.error(e); process.exitCode=1; });
