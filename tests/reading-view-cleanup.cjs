const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { openEditor } = require('./editor-browser.cjs');

// Focused UX cleanup regressions: the reading view (rich presentation) must
// not disclose Markdown source. Raw blocks render their sanitized projection
// plus a quiet hover/focus "Edit source" action; the literal Markdown lives
// only in the explicit source presentation. Reading selections — including
// ones crossing ordinary/projection boundaries in either direction — cover
// rendered text, never a duplicate source box, and copy serves the same.
const source = `# Showcase

A **bold** paragraph with *emphasis*.

Before word here.

Press <kbd>Use</kbd> to run and stop <samp>here.</samp>[^1]

[^1]: note about the hut

## Second heading

Plain closing paragraph.

Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to copy the <var>value</var>.

Open [<kbd>here</kbd>](https://example.com) for docs.
`;

async function geometry(page) {
  return page.evaluate(() => {
    const projection = document.querySelector('.extension-preview');
    const paragraph = [...document.querySelectorAll('.ProseMirror > p')].find(node => node.textContent.startsWith('Before'));
    const point = (word, end) => {
      const walker = document.createTreeWalker(projection, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) {
        const index = text.nodeValue.indexOf(word);
        if (index < 0) continue;
        const offset = end ? index + word.length : index;
        const range = document.createRange();
        range.setStart(text, offset); range.setEnd(text, offset);
        const rect = range.getBoundingClientRect();
        return { x: rect.left, y: (rect.top + rect.bottom) / 2 };
      }
      return null;
    };
    const before = document.createRange();
    before.setStart(paragraph.firstChild, 0); before.setEnd(paragraph.firstChild, 0);
    const beforeRect = before.getBoundingClientRect();
    return {
      from: { x: beforeRect.left, y: (beforeRect.top + beforeRect.bottom) / 2 },
      to: point('here.', true),
    };
  });
}

(async () => {
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.waitForFunction(() => document.querySelector('.extension-preview')?.textContent.includes('Use'));
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => document.querySelector('.extension-preview')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(400);

    // 1. No source disclosure or duplicate selectable hidden text in reading view.
    assert.equal(await page.evaluate(() => editor.isSource()), false, 'starts in the reading view');
    const summaries = await page.evaluate(() => [...document.querySelectorAll('#preview summary')].map(node => node.textContent));
    assert.ok(!summaries.includes('Markdown source'), `no 'Markdown source' disclosure in reading view, got ${JSON.stringify(summaries)}`);
    assert.ok(!summaries.includes('Front matter'), `no 'Front matter' disclosure in reading view, got ${JSON.stringify(summaries)}`);
    assert.equal(await page.locator('#preview .source-block').count(), 0, 'no source text blocks in reading view');
    assert.equal(await page.locator('#preview #source-fallback').count(), 0, 'no source fallback in reading view');
    assert.ok(await page.locator('#preview .extension-block').count() >= 1, 'unsupported content still renders its projection');
    const previewText = await page.evaluate(() => document.querySelector('#preview').textContent);
    assert.ok(!previewText.includes('<kbd>'), 'raw markup is not leaked as text in reading view');
    assert.ok(!previewText.includes('[^1]:'), 'raw footnote definition is not leaked as text in reading view');
    assert.ok(previewText.includes('Use'), 'rendered projection text is present');

    // 2. Normal selection: a paragraph drag covers rendered text only.
    const paragraphSelection = await page.evaluate(() => {
      const paragraph = [...document.querySelectorAll('#preview .ProseMirror > p')].find(node => node.textContent.includes('bold'));
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    });
    assert.equal(paragraphSelection, 'A bold paragraph with emphasis.', 'paragraph selection covers rendered text only');
    await page.evaluate(() => window.getSelection().removeAllRanges());

    // 2b. Inline author HTML renders as real elements, not literal tags.
    // The footnote-free paragraph below stays a regular paragraph whose
    // <kbd>/<var> pairs become single raw_inline atoms with real content.
    assert.equal(await page.locator('#preview .ProseMirror > p .html-inline kbd').count(), 3, 'kbd pairs render as real elements');
    assert.equal(await page.locator('#preview .ProseMirror > p .html-inline var').count(), 1, 'var pairs render as real elements');
    assert.equal(await page.locator('#preview .source-inline').count(), 0, 'no literal-tag code chips in reading view');
    // A Markdown link around inline HTML stays a working link: the pair
    // renders wrapped in an anchor that reveals the exact source on click.
    assert.equal(await page.locator('#preview .ProseMirror > p .html-inline > a[href="https://example.com"] kbd').count(), 1, 'link-wrapped pair renders a real anchor');
    await page.locator('#preview .ProseMirror > p .html-inline > a').first().click();
    await page.waitForFunction(() => document.getElementById('editor-action-dialog').open);
    assert.equal(await page.evaluate(() => editor.isSource()), false, 'link click edits the destination in place');
    assert.equal(await page.locator('#editor-action-value').inputValue(), '<kbd>here</kbd>', 'the dialog holds the exact inline source that was clicked');
    await page.locator('#editor-action-cancel').click();
    await page.waitForFunction(() => !document.getElementById('editor-action-dialog').open);
    await page.waitForTimeout(200);
    // A mouse drag across the rendered keys selects text, and Control+C
    // serves that rendered text with no markup leaking into the clipboard.
    const keysGeometry = await page.evaluate(() => {
      const paragraph = [...document.querySelectorAll('#preview .ProseMirror > p')].find(node => node.textContent.includes('to copy the'));
      const range = document.createRange();
      range.setStart(paragraph.firstChild, 0); range.setEnd(paragraph.firstChild, 0);
      const start = range.getBoundingClientRect();
      const keys = [...paragraph.querySelectorAll('kbd')].pop().getBoundingClientRect();
      return { from: { x: start.left, y: (start.top + start.bottom) / 2 }, to: { x: keys.right, y: (keys.top + keys.bottom) / 2 } };
    });
    await page.mouse.move(keysGeometry.from.x, keysGeometry.from.y);
    await page.mouse.down();
    await page.mouse.move(keysGeometry.to.x, keysGeometry.to.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const keysSelection = await page.evaluate(() => window.getSelection().toString());
    assert.ok(keysSelection.includes('Press Ctrl+C'), `inline drag selects rendered keys, got ${JSON.stringify(keysSelection.slice(0, 60))}`);
    assert.ok(!keysSelection.includes('<kbd>') && !keysSelection.includes('</'), 'inline selection carries no literal tags');
    await page.evaluate(() => {
      window.copyProbe = [];
      for (const type of ['copy', 'cut']) document.addEventListener(type, event => {
        window.copyProbe.push({ type, text: event.clipboardData ? event.clipboardData.getData('text/plain') : null });
      });
    });
    await page.keyboard.press('Control+c');
    const keysCopy = await page.evaluate(() => window.copyProbe.at(-1));
    assert.equal(keysCopy?.type, 'copy', 'Control+C fires a native copy event over inline HTML');
    assert.ok(keysCopy.text.includes('Press Ctrl+C'), `Control+C serves rendered keys, got ${JSON.stringify(keysCopy.text?.slice(0, 60))}`);
    assert.ok(!keysCopy.text.includes('<kbd>') && !keysCopy.text.includes('</'), 'native copy carries no literal tags');
    assert.equal(await page.evaluate(() => current.content), source, 'copy over inline HTML never mutates the document');
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.waitForTimeout(650);

    // 3. Cross-boundary selections span rendered text in both directions.
    // (Gestures sharing an endpoint are spaced out: ProseMirror treats two
    // same-spot presses within 500 ms as a double-click word selection.)
    const points = await geometry(page);
    assert.ok(points.from && points.to, 'projection text is laid out for pointing');
    await page.mouse.move(points.from.x, points.from.y);
    await page.mouse.down();
    await page.mouse.move(points.to.x, points.to.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const forward = await page.evaluate(() => window.getSelection().toString());
    assert.ok(forward.startsWith('Before word here.'), `ordinary-to-projection drag starts in rendered paragraph text, got ${JSON.stringify(forward.slice(0, 60))}`);
    assert.ok(forward.includes('Press Use to run and stop here.'), `ordinary-to-projection drag reaches rendered projection text, got ${JSON.stringify(forward.slice(-60))}`);
    assert.ok(!forward.includes('<kbd>') && !forward.includes('[^1]:'), 'cross selection carries no Markdown source');
    assert.equal(await page.evaluate(() => current.content), source, 'reading selection never mutates the document');

    // 3a. The highlight hugs text: the last line ends mid-line (not snapped
    // to the block edge, which is what an atom-boundary rewrite paints) and
    // no selection fragment covers the margin gap between the blocks.
    const shape = await page.evaluate(() => {
      const sel = window.getSelection();
      const rects = [...sel.getRangeAt(0).getClientRects()].map(box => ({ top: box.top, bottom: box.bottom, right: box.right }));
      const paragraph = [...document.querySelectorAll('#preview .ProseMirror > p')].find(node => node.textContent.startsWith('Before'));
      const block = document.querySelector('#preview .extension-block');
      const paraBox = paragraph.getBoundingClientRect(), blockBox = block.getBoundingClientRect();
      return { rects, paraBottom: paraBox.bottom, blockTop: blockBox.top, blockRight: blockBox.right };
    });
    assert.ok(shape.rects.length >= 2, `cross selection spans lines, got ${shape.rects.length} fragment(s)`);
    const lastFragment = shape.rects[shape.rects.length - 1];
    assert.ok(lastFragment.right < shape.blockRight - 30, `last highlight line hugs the text end instead of the block edge, got right=${Math.round(lastFragment.right)} vs block=${Math.round(shape.blockRight)}`);
    assert.ok(shape.rects.every(box => box.bottom <= shape.paraBottom + 4 || box.top >= shape.blockTop - 4),
      `no highlight fragment covers the gap between blocks ${JSON.stringify(shape.rects.map(box => Math.round(box.top) + '-' + Math.round(box.bottom)))}`);

    // 3b. The browser's own clipboard path must serve the rendered range:
    // a real drag is followed by keyboard modifier-only and copy chords. A
    // modifier-only keydown must not resync/truncate the guarded selection,
    // and Control+C must deliver that same rendered text through the browser
    // copy event while leaving both selection and Markdown unchanged.
    await page.evaluate(() => {
      window.copyProbe = [];
      for (const type of ['copy', 'cut']) document.addEventListener(type, event => {
        window.copyProbe.push({ type, text: event.clipboardData ? event.clipboardData.getData('text/plain') : null });
      });
    });
    await page.keyboard.down('Control');
    await page.keyboard.up('Control');
    assert.equal(await page.evaluate(() => window.getSelection().toString()), forward, 'modifier-only keydown keeps the rendered reading range');
    await page.keyboard.press('Control+c');
    const controlCopy = await page.evaluate(() => window.copyProbe.at(-1));
    assert.equal(controlCopy?.type, 'copy', 'Control+C fires a native copy event');
    assert.equal(controlCopy.text, forward, `Control+C serves the exact rendered range, got ${JSON.stringify(controlCopy.text?.slice(0, 80))}`);
    assert.ok(!controlCopy.text.includes('<kbd>') && !controlCopy.text.includes('[^1]:'), 'native copy carries no Markdown source');
    assert.equal(await page.evaluate(() => window.getSelection().toString()), forward, 'copy keeps the rendered reading range selected');
    assert.equal(await page.evaluate(() => current.content), source, 'copy never mutates the document');

    // 3c. The Meta variant takes the same guarded path; the platform may not
    // fire a native clipboard event, but keydown must still preserve the range.
    await page.keyboard.press('Meta+c');
    assert.equal(await page.evaluate(() => window.getSelection().toString()), forward, 'Meta+C keeps the rendered reading range selected');
    assert.equal(await page.evaluate(() => current.content), source, 'Meta+C never mutates the document');
    const metaCopy = await page.evaluate(() => window.copyProbe.at(-1));
    if (metaCopy?.type === 'copy') assert.equal(metaCopy.text, forward, 'Meta+C serves the exact rendered range when the platform copies');

    // 3d. Mod+X preserves the guarded-cut-as-copy contract: the rendered
    // range reaches the clipboard and the Markdown is untouched.
    await page.keyboard.press('Control+x');
    const guardedCut = await page.evaluate(() => window.copyProbe.at(-1));
    assert.equal(guardedCut?.type, 'cut', 'Control+X fires the browser cut event');
    assert.equal(guardedCut.text, forward, `guarded cut serves the exact rendered range, got ${JSON.stringify(guardedCut.text?.slice(0, 80))}`);
    assert.equal(await page.evaluate(() => window.getSelection().toString()), forward, 'guarded cut keeps the rendered reading range selected');
    assert.equal(await page.evaluate(() => current.content), source, 'guarded cut never deletes rendered source');

    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.waitForTimeout(650);
    await page.mouse.move(points.to.x, points.to.y);
    await page.mouse.down();
    await page.mouse.move(points.from.x, points.from.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const backward = await page.evaluate(() => window.getSelection().toString());
    assert.ok(backward.includes('Press Use to run and stop here.'), `projection-to-ordinary drag starts in rendered projection text, got ${JSON.stringify(backward.slice(0, 60))}`);
    assert.ok(backward.includes('Before word here.'), `projection-to-ordinary drag reaches rendered paragraph text, got ${JSON.stringify(backward.slice(-60))}`);
    assert.ok(!backward.includes('<kbd>') && !backward.includes('[^1]:'), 'reverse cross selection carries no Markdown source');
    assert.equal(await page.evaluate(() => current.content), source, 'reverse reading selection never mutates the document');
    await page.evaluate(() => window.getSelection().removeAllRanges());

    // 4. Headings and footnotes stay consistent in the calm reading view.
    assert.equal(await page.locator('#preview h1').textContent(), 'Showcase', 'h1 renders');
    assert.equal(await page.locator('#preview h2').textContent(), 'Second heading', 'h2 renders');
    assert.ok(await page.locator('#preview .footnote-ref, #preview sup').count() >= 1, 'footnote marker renders');
    const headingColors = await page.evaluate(() => {
      const color = selector => getComputedStyle(document.querySelector(selector)).color;
      return {
        h1: color('#preview h1'),
        h2: color('#preview h2'),
        strong: color('#preview strong'),
        link: color('#preview a'),
      };
    });
    assert.equal(headingColors.h1, headingColors.strong, `h1 uses the foreground, got ${headingColors.h1} vs ${headingColors.strong}`);
    assert.equal(headingColors.h2, headingColors.strong, `h2 uses the foreground, got ${headingColors.h2} vs ${headingColors.strong}`);
    assert.notEqual(headingColors.link, headingColors.strong, 'link accents are retained');
    await page.screenshot({ path: path.join(os.tmpdir(), 'folio-reading-cleanup.png'), fullPage: true });

    // 5. Source edit access still works through the deliberate edit action,
    // which reveals itself on hover/focus without reserving layout.
    const firstBlock = page.locator('#preview .extension-block').first();
    await firstBlock.hover();
    await page.waitForFunction(() => {
      const button = document.querySelector('#preview .extension-block .extension-edit');
      return button && getComputedStyle(button.parentElement).opacity === '1';
    });
    await page.locator('#preview .extension-edit').first().click();
    const panelInput = page.locator('#preview .extension-block').first().locator('.extension-source-editor textarea');
    await panelInput.waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => editor.isSource()), false, 'edit action stays in the formatted editor');
    const rawValue = await panelInput.inputValue();
    assert.ok(rawValue.includes('Press <kbd>Use</kbd>'), `the in-place editor holds the exact block source, got ${JSON.stringify(rawValue.slice(0, 80))}`);
    await panelInput.fill(rawValue.replace('Press <kbd>Use</kbd>', 'Press X <kbd>Use</kbd>'));
    await page.locator('#preview .extension-block').first().getByRole('button', { name: 'Apply' }).click();
    await page.waitForFunction(() => current.content.includes('Press X <kbd>Use</kbd>'));
    assert.ok((await page.evaluate(() => current.content)).includes('Press X <kbd>Use</kbd>'), 'the in-place edit applies to the exact Markdown');
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => current.content), source, 'source undo restores the exact document');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#preview .source-block').count(), 0, 'the reading view shows no source disclosure');
    assert.ok(await page.evaluate(() => document.querySelector('.extension-preview')?.textContent.includes('Use')), 'projection re-renders after the round trip');

    // 6. Read-only mode keeps the same reading selection behavior.
    await page.locator('#lock-document').click();
    assert.equal(await page.evaluate(() => document.querySelector('.extension-edit').disabled), true, 'edit action is disabled while locked');
    const lockedPoints = await geometry(page);
    await page.mouse.move(lockedPoints.from.x, lockedPoints.from.y);
    await page.mouse.down();
    await page.mouse.move(lockedPoints.to.x, lockedPoints.to.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const lockedSelection = await page.evaluate(() => window.getSelection().toString());
    assert.ok(lockedSelection.includes('Before word here.') && lockedSelection.includes('Press Use to run and stop here.'),
      `locked cross selection still spans rendered text, got ${JSON.stringify(lockedSelection.slice(0, 80))}`);
    assert.equal(await page.evaluate(() => current.content), source, 'locked reading selection never mutates the document');
    await page.locator('#lock-document').click();
    assert.equal(await page.evaluate(() => document.querySelector('.extension-edit').disabled), false, 'edit action returns after unlock');

    assert.deepEqual(session.errors, []);
    console.log('PASS: reading view shows no Markdown source disclosure, inline HTML renders as real elements, cross-boundary selection/native copy cover rendered text in both directions and under lock, and source editing stays one deliberate action away.');
  } catch (error) {
    console.error('PAGE ERRORS:', session.errors);
    await session.page.screenshot({ path: '/tmp/opencode/folio-reading-cleanup-failure.png', fullPage: true }).catch(() => {});
    throw error;
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exit(1); });
