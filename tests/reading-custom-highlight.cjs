const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { openEditor } = require('./editor-browser.cjs');

// Focused regressions for the mirrored Custom Highlight reading paint
// (CSS.highlights 'folio-selection' + ::highlight(folio-selection), with the
// native ::selection background suppressed only while the mirror paints).
// The real DOM range stays authoritative: selection, copy and editing behave
// exactly as without the mirror; only the painted shape changes.
const source = `# Shortcuts

Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to copy the value here.

Second paragraph where the span ends.

\`\`\`js
const answer = 42;
\`\`\`

Closing paragraph after the code.
`;

async function highlightState(page) {
  return page.evaluate(() => {
    try {
      return {
        supported: typeof Highlight === 'function' && !!(window.CSS && window.CSS.highlights),
        registered: CSS.highlights.has('folio-selection'),
        size: CSS.highlights.has('folio-selection') ? CSS.highlights.get('folio-selection').size : 0,
        painted: document.querySelector('#preview .ProseMirror').classList.contains('folio-paint'),
      };
    } catch (error) {
      return { supported: false, error: String(error) };
    }
  });
}

(async () => {
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.waitForFunction(() => document.querySelector('.html-inline'));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);

    // 1. The engine supports the registry contract used by the mirror.
    const support = await highlightState(page);
    assert.equal(support.supported, true, 'Custom Highlights registry is available in this engine');

    // 2. Activation: a cross-block drag registers the mirror and marks the
    // view, while the real native selection is untouched.
    const points = await page.evaluate(() => {
      const paragraphs = [...document.querySelectorAll('#preview .ProseMirror > p')];
      const first = paragraphs[0].firstChild, last = paragraphs[1].firstChild;
      // Aim clearly inside words: exact boundary points can resolve backward.
      const start = document.createRange(); start.setStart(first, 2); start.setEnd(first, 6);
      const end = document.createRange(); end.setStart(last, 2); end.setEnd(last, 6);
      const a = start.getBoundingClientRect(), b = end.getBoundingClientRect();
      return { from: { x: (a.left + a.right) / 2, y: (a.top + a.bottom) / 2 }, to: { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 } };
    });
    const before = await page.evaluate(() => ({
      text: window.getSelection().toString(),
      anchor: window.getSelection().anchorOffset,
    }));
    assert.equal(before.text, '', 'starts with a collapsed selection');
    await page.mouse.move(points.from.x, points.from.y);
    await page.mouse.down();
    await page.mouse.move(points.to.x, points.to.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const active = await highlightState(page);
    assert.equal(active.registered, true, 'cross-block drag registers folio-selection');
    assert.ok(active.size >= 1, `mirror holds ranges, got ${active.size}`);
    assert.equal(active.painted, true, 'paint class suppresses only the native background');
    const rendered = await page.evaluate(() => window.getSelection().toString());
    assert.ok(rendered.includes('Ctrl+C to copy the value here.'), `native range is unchanged by the mirror, got ${JSON.stringify(rendered.slice(0, 60))}`);
    assert.ok(!rendered.includes('<kbd>') && !rendered.includes('</'), 'mirrored selection carries no literal tags');
    assert.equal(await page.evaluate(() => current.content), source, 'mirror never mutates the document');

    // 3. Native copy serves the same rendered text through the real chord.
    await page.evaluate(() => {
      window.copyProbe = [];
      document.addEventListener('copy', event => {
        window.copyProbe.push({ text: event.clipboardData ? event.clipboardData.getData('text/plain') : null });
      });
    });
    await page.keyboard.press('Control+c');
    const copied = await page.evaluate(() => window.copyProbe.at(-1));
    assert.ok(copied && copied.text.includes('<kbd>Ctrl</kbd>'), `Control+C serves the exact rendered range, got ${JSON.stringify(copied && copied.text && copied.text.slice(0, 60))}`);
    assert.equal(await page.evaluate(() => current.content), source, 'copy never mutates the document');
    await page.screenshot({ path: path.join(os.tmpdir(), 'folio-custom-highlight.png') });

    // 4. Clear on collapse: a plain click removes the mirror and the class.
    await page.locator('#preview .ProseMirror > p').filter({ hasText: 'Second paragraph' }).click();
    await page.waitForTimeout(300);
    const cleared = await highlightState(page);
    assert.equal(cleared.registered, false, 'collapse clears the registry');
    assert.equal(cleared.painted, false, 'collapse removes the paint class');

    // Markdown mode removed in the single-editor migration.

    // 5. Clicking an inline atom reveals its Markdown in the shared surface
    // with a collapsed caret, so the old reading highlight clears.
    await page.locator('#preview .html-inline').first().dblclick();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.folio-source-edit').count(), 1, 'atom click reveals editable Markdown');
    const onNode = await highlightState(page);
    assert.equal(onNode.registered, false, 'node selection keeps the registry clear');
    assert.equal(onNode.painted, false, 'node selection keeps the paint class off');

    // 6. Fallback: without the Highlight API the reader keeps ordinary
    // native painting with no mirror machinery engaged.
    await page.addInitScript(() => { try { delete window.Highlight; } catch {} });
    await page.reload();
    await page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
    await page.evaluate(() => setDocumentMode('edit'));
    await page.waitForFunction(() => document.querySelector('.html-inline'));
    await page.waitForTimeout(400);
    const noApi = await highlightState(page);
    assert.equal(noApi.supported, false, 'Highlight API removed for the fallback pass');
    assert.equal(noApi.registered, false, 'no registry entry without the API');
    assert.equal(noApi.painted, false, 'no paint class without the API');
    await page.mouse.move(points.from.x, points.from.y);
    await page.mouse.down();
    await page.mouse.move(points.to.x, points.to.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const fallbackSelection = await page.evaluate(() => window.getSelection().toString());
    assert.ok(fallbackSelection.includes('Ctrl+C to copy'), `native selection still spans without the mirror, got ${JSON.stringify(fallbackSelection.slice(0, 60))}`);
    assert.equal(await page.evaluate(() => { try { return CSS.highlights.has('folio-selection'); } catch { return false; } }), false, 'no registry entry after fallback drag');
    assert.equal(await page.evaluate(() => document.querySelector('#preview .ProseMirror').classList.contains('folio-paint')), false, 'no paint class after fallback drag');
    assert.equal(await page.evaluate(() => current.content), source, 'fallback drag never mutates the document');

    assert.deepEqual(session.errors, []);
    console.log('PASS: custom highlight mirror activates on reading ranges, preserves the real selection and clipboard, and clears on collapse, node selection and API fallback.');
  } catch (error) {
    console.error('PAGE ERRORS:', session.errors);
    await session.page.screenshot({ path: '/tmp/opencode/folio-custom-highlight-failure.png', fullPage: true }).catch(() => {});
    throw error;
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exit(1); });
