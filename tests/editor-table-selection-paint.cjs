const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
 const source = '## Rich cells\n\n| Feature | Example |\n| --- | --- |\n| Formula | $E=mc^2$ |\n| Text | Last cell |\n\n## Next table\n\n| A | B |\n| --- | --- |\n| One | Two |\n\nAfter.\n';
 const session = await openEditor(source);
 try {
  const { page } = session;
  await page.locator('.katex-html').waitFor();
  const result = await page.evaluate(async () => {
   document.documentElement.dataset.theme = 'graphite';
   const root = document.querySelector('.ProseMirror');
   const range = document.createRange();
   range.setStart(root.querySelector('h2').firstChild, 1);
   const end = root.querySelectorAll('table')[1].querySelector('td').firstChild.firstChild;
   range.setEnd(end, end.length);
   window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
   document.dispatchEvent(new Event('selectionchange'));
   await new Promise(resolve => requestAnimationFrame(resolve));
   const ranges = [...CSS.highlights.get('folio-selection')];
   return { formula:ranges.some(r => r.startContainer.parentElement.closest('.katex-html')),
    hiddenMath:ranges.some(r => r.startContainer.parentElement.closest('.katex-mathml')),
    rootBackground:getComputedStyle(root,'::selection').backgroundColor,
    fragments:ranges.every(r=>r.startContainer === r.endContainer && r.startContainer.nodeType===3) };
  });
  assert.equal(result.formula, true, 'visible formula glyphs participate in selection paint');
  assert.equal(result.hiddenMath, false, 'accessible duplicate math is not painted');
  assert.equal(result.rootBackground, 'rgba(0, 0, 0, 0)', 'editor root cannot paint block gap selection');
  assert.equal(result.fragments, true);
  await page.screenshot({path:`/tmp/folio-table-selection-${process.env.FOLIO_BROWSER || 'chromium'}.png`});
  assert.equal(await page.evaluate(()=>current.content), source);
  assert.deepEqual(session.errors, []);
 } finally {await session.close();}
 console.log('PASS: table selection includes formulas and suppresses native block-gap paint');
})().catch(e=>{console.error(e);process.exitCode=1;});
