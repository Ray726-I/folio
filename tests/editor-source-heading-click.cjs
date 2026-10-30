const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Page-7-style report fixture: enough content above the target heading that a
// vertical-margin drift in CodeMirror's height map shifts the click target by
// more than a line.
const pages = [];
for (let p = 1; p <= 7; p++) {
  pages.push(`## Page ${p} — Section ${p}`, '');
  for (let i = 0; i < 5; i++) pages.push(`Paragraph ${p}.${i} ` + 'word '.repeat(30).trim() + '.');
  pages.push('');
}
pages.push('## Page 7 — Project Objectives', '', 'Objectives body text.');
const source = '# Master Document\n\n' + pages.join('\n') + '\n';

// Wait for the heading's geometry to stop changing. CodeMirror measures lazily
// after a scroll, so a rect read a single frame after scrolling can move again
// before the mouse click and send the click to a neighbouring line.
async function settledHeadingRect(page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const scroller = document.getElementById('reader-scroll');
    let previous = null, stableFrames = 0;
    for (let frame = 0; frame < 240; frame++) {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const line = [...document.querySelectorAll('#source-editor .cm-line')]
        .find(item => item.textContent.includes('Page 7 — Project Objectives'));
      if (!line) return null;
      const rect = line.getBoundingClientRect();
      if (rect.top < 110 || rect.bottom > innerHeight - 20) return null;
      const key = [scroller.scrollTop, scroller.scrollHeight, rect.x, rect.y, rect.width, rect.height].join(':');
      if (key === previous) stableFrames++;
      else { previous = key; stableFrames = 0; }
      if (stableFrames >= 2) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    return null;
  });
}

(async () => {
  const session = await openEditor(source, { width: 1180, height: 800 });
  try {
    const { page } = session;
    await page.evaluate(() => editor.setPresentation(true, true));
    await page.waitForFunction(() => editor.isSource() && mode === 'edit');

    // Scroll the target heading fully into view, mirroring a reader looking at
    // the last section of a long source document.
    let heading = null;
    for (let top = 0; top < 10000 && !heading; top += 150) {
      await page.evaluate(value => {
        const scroller = document.getElementById('reader-scroll');
        scroller.style.scrollBehavior = 'auto';
        scroller.scrollTop = value;
      }, top);
      await page.waitForTimeout(25);
      heading = await settledHeadingRect(page);
    }
    assert.ok(heading, 'the Page 7 heading must be visible in the source editor');

    const point = {
      x: heading.x + Math.min(150, heading.width / 3),
      y: heading.y + heading.height / 2
    };
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(100);

    const result = await page.evaluate(() => {
      const anchor = editor.getSelection().anchor;
      const lines = current.content.split('\n');
      const lineIndex = current.content.slice(0, anchor).split('\n').length - 1;
      const lineStart = lines.slice(0, lineIndex).join('\n').length + (lineIndex ? 1 : 0);
      const lineText = lines[lineIndex];
      const target = window.FolioEditor.headings(current.content)
        .find(item => item.text.includes('Page 7 — Project Objectives'));
      return {
        anchor,
        lineIndex,
        lineText,
        headingLineIndex: target ? current.content.slice(0, target.offset).split('\n').length - 1 : -1,
        withinHeadingLine: anchor >= lineStart && anchor <= lineStart + lineText.length
      };
    });

    assert.equal(result.headingLineIndex, 58, 'fixture must place the target heading on the expected line');
    assert.equal(result.lineIndex, result.headingLineIndex,
      'a click inside the heading line must select that heading line, not the line below it');
    assert.ok(result.withinHeadingLine, 'the selected offset must fall inside the heading line');
    assert.deepEqual(session.errors, []);
    console.log('PASS: clicking a source heading selects within the heading line.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
