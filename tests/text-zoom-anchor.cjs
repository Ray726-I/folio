const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

const source = '# Zoom anchor\n\n' + Array.from({ length: 80 }, (_, index) => `Paragraph ${index}. ` + 'Readable prose keeps the reader anchored. '.repeat(4)).join('\n\n') + '\n';

(async () => {
  const session = await openEditor(source, { width: 1000, height: 700 });
  const { page, errors } = session;
  try {
    await page.waitForFunction(() => !busy && editor && !editor.isSource());
    await page.evaluate(() => { const scroller = document.getElementById('reader-scroll'); scroller.style.scrollBehavior = 'auto'; scroller.scrollTop = 1800; });
    await page.waitForFunction(() => document.getElementById('reader-scroll').scrollTop > 1000);

    const before = await page.evaluate(() => {
      const scroller = document.getElementById('reader-scroll');
      const top = scroller.getBoundingClientRect().top + 24;
      const block = [...document.querySelectorAll('#preview .ProseMirror > *')].find(element => element.getBoundingClientRect().bottom > top);
      return { text: block?.textContent, top: block?.getBoundingClientRect().top, scrollTop: scroller.scrollTop, fontSize: getComputedStyle(document.documentElement).getPropertyValue('--text-size') };
    });
    assert.ok(before.text, 'the fixture must put a block at the viewport top');

    await page.evaluate(() => zoomText(1));
    const after = await page.evaluate(text => {
      const scroller = document.getElementById('reader-scroll');
      const block = [...document.querySelectorAll('#preview .ProseMirror > *')].find(element => element.textContent === text);
      return { top: block?.getBoundingClientRect().top, scrollTop: scroller.scrollTop, fontSize: getComputedStyle(document.documentElement).getPropertyValue('--text-size') };
    }, before.text);

    assert.notEqual(after.fontSize, before.fontSize, 'the text size must change');
    assert.ok(Math.abs(after.top - before.top) < 2,
      `the block at the viewport top must stay anchored (${before.top} -> ${after.top})`);
    assert.ok(Math.abs(after.scrollTop - before.scrollTop) > 1, 'the scroller must compensate for the reflow');
    assert.deepEqual(errors, []);
    console.log('PASS: text zoom preserves the block at the viewport top.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
