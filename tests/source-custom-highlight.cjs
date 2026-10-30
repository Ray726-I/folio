const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { openEditor } = require('./editor-browser.cjs');

// Focused regressions for the source presentation's Custom Highlight mirror
// (registry 'folio-source-selection' + ::highlight(folio-source-selection)).
// The real DOM range stays authoritative; the mirror repaints it per text
// fragment so engines that fill whole blocks paint the same calm per-line
// wash as everywhere else. CodeMirror's own drawn layer is hidden while the
// mirror paints; unsupported engines keep ordinary native painting.
const source = `# Heads

- item one
- item two

Press <kbd>Ctrl</kbd> to copy here.

Body paragraph closes the range.
`;

async function highlightState(page) {
  return page.evaluate(() => {
    try {
      const view = document.querySelector('#source-editor .cm-editor');
      return {
        supported: typeof Highlight === 'function' && !!(window.CSS && window.CSS.highlights),
        registered: CSS.highlights.has('folio-source-selection'),
        size: CSS.highlights.has('folio-source-selection') ? CSS.highlights.get('folio-source-selection').size : 0,
        painted: !!view && view.classList.contains('folio-source-paint'),
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
    await page.waitForFunction(() => document.querySelector('.ProseMirror'));
    await page.waitForTimeout(400);
    await page.locator('#show-markdown').click();
    await page.locator('#source-editor .cm-content').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);

    // 1. The registry contract is available in this engine.
    assert.equal((await highlightState(page)).supported, true, 'Custom Highlights supported here');

    // 2. A cross-line drag (heading into list) mirrors with text-shaped paint:
    // the CodeMirror-drawn full-width layer is hidden while the mirror owns it.
    const points = await page.evaluate(() => {
      const lines = [...document.querySelectorAll('#source-editor .cm-line')];
      const head = lines[0].firstChild, tail = lines[3].firstChild;
      const a = document.createRange(); a.setStart(head, 2); a.setEnd(head, 4);
      const ra = a.getBoundingClientRect();
      const b = document.createRange(); b.setStart(tail, 2); b.setEnd(tail, 6);
      const rb = b.getBoundingClientRect();
      return { from: { x: (ra.left + ra.right) / 2, y: (ra.top + ra.bottom) / 2 }, to: { x: (rb.left + rb.right) / 2, y: (rb.top + rb.bottom) / 2 } };
    });
    await page.mouse.move(points.from.x, points.from.y);
    await page.mouse.down();
    await page.mouse.move(points.to.x, points.to.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const active = await highlightState(page);
    assert.equal(active.registered, true, 'cross-line drag registers folio-source-selection');
    assert.ok(active.size >= 1, `mirror holds ranges, got ${active.size}`);
    assert.equal(active.painted, true, 'paint class suppresses only the native background');
    const rendered = await page.evaluate(() => window.getSelection().toString());
    assert.ok(rendered.includes('eads') && rendered.includes('- item one'), `native range spans heading into list text, got ${JSON.stringify(rendered.slice(0, 60))}`);
    assert.equal(await page.evaluate(() => current.content), source, 'mirror never mutates the document');
    const layersHidden = await page.evaluate(() => [...document.querySelectorAll('#source-editor .cm-selectionBackground')].every(node => getComputedStyle(node).display === 'none'));
    assert.ok(layersHidden, 'CodeMirror-drawn full-width layer stays hidden while the mirror paints');

    // 3. Native copy serves the same rendered source text.
    await page.evaluate(() => {
      window.copyProbe = [];
      document.addEventListener('copy', event => {
        window.copyProbe.push({ text: event.clipboardData ? event.clipboardData.getData('text/plain') : null });
      });
    });
    await page.keyboard.press('Control+c');
    const copied = await page.evaluate(() => window.copyProbe.at(-1));
    assert.equal(copied && copied.text, rendered, 'Control+C serves the exact rendered range');
    assert.ok(copied.text.includes('- item one'), 'source copy carries verbatim list markers');
    await page.screenshot({ path: path.join(os.tmpdir(), 'folio-source-highlight.png') });
    await page.evaluate(() => { const input = document.createElement('textarea'); input.id = 'clipboard-paste-probe'; document.body.append(input); input.focus(); });
    await page.keyboard.press('Control+v');
    assert.equal(await page.locator('#clipboard-paste-probe').inputValue(), rendered, 'system clipboard pastes the actual copied selection');
    await page.evaluate(() => document.querySelector('#clipboard-paste-probe').remove());
    assert.equal(await page.evaluate(() => current.content), source, 'copy never mutates the document');

    // 4. Clear on collapse.
    await page.mouse.move(points.from.x, points.from.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(300);
    const cleared = await highlightState(page);
    assert.equal(cleared.registered, false, 'collapse clears the registry');
    assert.equal(cleared.painted, false, 'collapse removes the paint class');

    // 5. Clear on blur; the next drag re-engages the live listener.
    await page.evaluate(() => { window.getSelection().removeAllRanges(); });
    await page.mouse.move(points.from.x, points.from.y);
    await page.mouse.down();
    await page.mouse.move(points.to.x, points.to.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert.equal((await highlightState(page)).registered, true, 'mirror re-engages for the next drag');
    await page.evaluate(() => document.querySelector('#source-editor .cm-content').blur());
    await page.waitForTimeout(300);
    const blurred = await highlightState(page);
    assert.equal(blurred.registered, false, 'blur clears the registry');
    assert.equal(blurred.painted, false, 'blur removes the paint class');

    // 6. Fallback: without the Highlight API the source keeps ordinary
    // native painting with no mirror machinery engaged.
    await page.addInitScript(() => { try { delete window.Highlight; } catch {} });
    await page.reload();
    await page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
    await page.locator('#show-markdown').click();
    await page.locator('#source-editor .cm-content').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
    const noApi = await highlightState(page);
    assert.equal(noApi.supported, false, 'Highlight API removed for the fallback pass');
    assert.equal(noApi.registered, false, 'no registry entry without the API');
    assert.equal(noApi.painted, false, 'no paint class without the API');
    await page.screenshot({ path: path.join(os.tmpdir(), 'folio-source-highlight-fallback.png') });

    assert.deepEqual(session.errors, []);
    console.log('PASS: source Custom Highlight mirror activates on reading ranges, preserves native selection and clipboard, hides the drawn layer, and clears on collapse, blur, and API fallback.');
  } catch (error) {
    console.error('PAGE ERRORS:', session.errors);
    await session.page.screenshot({ path: '/tmp/opencode/folio-source-highlight-failure.png', fullPage: true }).catch(() => {});
    throw error;
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exit(1); });
