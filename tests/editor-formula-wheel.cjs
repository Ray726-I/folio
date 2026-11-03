const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

// Scrolling the local formula source must stay inside the textarea while it has
// room, and must fall back to the reader when it does not. A gesture that began
// outside the formula keeps the page even if the pointer drifts over the box.
const filler = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} keeps the reader scrollable.\n`).join('\n');
const formula = Array.from({ length: 40 }, (_, i) => `a_{${i}} + b_{${i}} \\\\`).join('\n');
const source = `# Formula\n\n${filler}\n\\[\n${formula}\n\\]\n\n${filler}\n`;

(async () => {
  const bundle = buildEditorBundle();
  const session = await openIsolatedEditor(source, bundle.outfile, { width: 900, height: 700 });
  try {
    const { page } = session;
    await page.locator('.math-block .katex').waitFor();
    await page.locator('.math-block .math-formula').click();
    const input = page.locator('.math-block textarea');
    await input.waitFor({ timeout: 4000 });

    const dispatchWheel = (selector, deltaY) => page.evaluate(([selector, deltaY]) => {
      const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
      document.querySelector(selector).dispatchEvent(event);
      return event.defaultPrevented;
    }, [selector, deltaY]);
    const sourceState = () => page.evaluate(() => {
      const area = document.querySelector('.math-block textarea');
      return { top: area.scrollTop, maximum: area.scrollHeight - area.clientHeight };
    });

    // Focusing the source leaves the caret (and scroll position) at its end.
    const initial = await sourceState();
    assert.ok(initial.maximum > 0 && initial.top > 0, `fixture formula must overflow (${JSON.stringify(initial)})`);

    assert.equal(await dispatchWheel('.math-block textarea', -60), true, 'scrolling up inside the source is consumed');
    assert.ok((await sourceState()).top < initial.top, 'the formula source moved up');
    assert.equal(await dispatchWheel('.math-block textarea', 60), true, 'scrolling back down is consumed');

    // At either edge the formula hands the wheel to the reader instead of
    // swallowing it (an engine treats the textarea as a scroll container).
    const atEnd = await page.evaluate(() => {
      const area = document.querySelector('.math-block textarea'), reader = document.getElementById('reader-scroll');
      reader.style.scrollBehavior = 'auto'; reader.scrollTop = 0;
      area.scrollTop = area.scrollHeight;
      const event = new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true });
      area.dispatchEvent(event);
      return { reader: reader.scrollTop, top: area.scrollTop, maximum: area.scrollHeight - area.clientHeight };
    });
    assert.ok(atEnd.reader > 0, 'the reader takes over at the formula last line');
    assert.ok(atEnd.top >= atEnd.maximum - 1, 'the formula stays at its last line');

    await page.waitForTimeout(250);
    const atStart = await page.evaluate(() => {
      const area = document.querySelector('.math-block textarea'), reader = document.getElementById('reader-scroll');
      reader.scrollTop = 500;
      area.scrollTop = 0;
      const event = new WheelEvent('wheel', { deltaY: -60, bubbles: true, cancelable: true });
      area.dispatchEvent(event);
      return { reader: reader.scrollTop, top: area.scrollTop };
    });
    assert.ok(atStart.reader < 500, 'the reader takes over at the formula first line');
    assert.equal(atStart.top, 0, 'the formula stays at its first line');

    await page.evaluate(() => {
      const area = document.querySelector('.math-block textarea');
      window.formulaSource = area.value; area.value = 'x'; area.scrollTop = 0;
    });
    await page.waitForTimeout(250);
    const empty = await page.evaluate(() => {
      const area = document.querySelector('.math-block textarea'), reader = document.getElementById('reader-scroll');
      reader.scrollTop = 0;
      const event = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
      area.dispatchEvent(event);
      return { reader: reader.scrollTop, top: area.scrollTop };
    });
    assert.ok(empty.reader > 0, 'a formula with nothing to scroll passes the wheel to the reader');
    assert.equal(empty.top, 0, 'nothing moved inside the formula');

    await page.evaluate(() => { const area = document.querySelector('.math-block textarea'); area.value = window.formulaSource; area.scrollTop = 0; });
    await page.waitForTimeout(250);
    const drift = await page.evaluate(() => {
      const area = document.querySelector('.math-block textarea'), reader = document.getElementById('reader-scroll');
      reader.style.scrollBehavior = 'auto'; reader.scrollTop = 300;
      const before = area.scrollTop;
      document.querySelector('#preview p').dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true }));
      area.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true }));
      return { reader: reader.scrollTop, moved: area.scrollTop !== before };
    });
    assert.ok(drift.reader > 300, 'a gesture that began outside keeps scrolling the page');
    assert.equal(drift.moved, false, 'the formula must not move for an outside gesture');

    // Real wheel input over a scrollable source: the source moves, the reader
    // does not.
    await page.evaluate(async () => {
      const area = document.querySelector('.math-block textarea'), reader = document.getElementById('reader-scroll');
      area.scrollTop = area.scrollHeight;
      reader.style.scrollBehavior = 'auto';
      reader.scrollTop += area.getBoundingClientRect().top - 200;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.waitForTimeout(250);
    const box = await input.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const readerBefore = await page.evaluate(() => document.getElementById('reader-scroll').scrollTop);
    const beforeWheel = await sourceState();
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -120);
    const scrolling = await page.evaluate(() => ({
      reader: document.getElementById('reader-scroll').scrollTop,
      top: document.querySelector('.math-block textarea').scrollTop
    }));
    assert.equal(scrolling.reader, readerBefore, 'wheel over the formula must not scroll the reader');
    assert.ok(scrolling.top < beforeWheel.top, `formula source should scroll itself (${JSON.stringify(scrolling)})`);

    // With no overflow the wheel reaches the reader immediately.
    await page.evaluate(async () => {
      const area = document.querySelector('.math-block textarea'), reader = document.getElementById('reader-scroll');
      area.value = 'x'; area.scrollTop = 0;
      reader.scrollTop = 0;
      reader.scrollTop += area.getBoundingClientRect().top - 200;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.waitForTimeout(250);
    const shortBox = await input.boundingBox();
    const readerBeforeShort = await page.evaluate(() => document.getElementById('reader-scroll').scrollTop);
    await page.mouse.move(shortBox.x + shortBox.width / 2, shortBox.y + shortBox.height / 2);
    await page.mouse.wheel(0, 200);
    const short = await page.evaluate(() => ({
      reader: document.getElementById('reader-scroll').scrollTop,
      top: document.querySelector('.math-block textarea').scrollTop
    }));
    assert.ok(short.reader > readerBeforeShort, 'a formula with no overflow lets the reader scroll');
    assert.equal(short.top, 0, 'nothing to scroll inside the formula');
    assert.equal(await page.evaluate(() => current.content), source, 'scrolling must not change the document');
    assert.deepEqual(session.errors, []);
    console.log('PASS: formula source owns its wheel only while it can scroll and owns the gesture.');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
