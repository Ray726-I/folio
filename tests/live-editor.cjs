const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

const source = '# Heading\n\nBefore **bold** café 😀.\n\n| First | Second |\n| --- | --- |\n| **one** | target |\n| `code` | value |\n| $\\frac{1}{2}$ | math |\n| ' + 'long '.repeat(35) + ' | tail |\n\nAfter the table.\n\n[route](https://example.com/original)\n\n- [ ] Task\n\n![Remote](https://example.com/tracker.png)\n\n$$\nx^2\n$$\n\n<!-- exact  spaces -->\n';
(async () => {
  const session = await openEditor(source);
  const { page, errors, requests } = session;
  const text = () => page.evaluate(() => current.content);
  try {
    // Disable smooth scrolling for deterministic pointer placement; the
    // production smooth scroll otherwise races Playwright's click after the
    // image region (taller with its Edit affordance) scrolls to the top.
    await page.addStyleTag({ content: '.reader-scroll{scroll-behavior:auto !important} *{scroll-behavior:auto !important}' });
    // The cases missed by the margin-based spike: downstream boundaries of
    // rich/long cells, not just the left edge of the first column.
    await page.locator('#preview .math-formula .katex').first().waitFor();
    const bounds = await page.locator('#preview tr').evaluateAll(rows => rows.map(row => [...row.cells].map(cell => ({ x: cell.getBoundingClientRect().x, right: cell.getBoundingClientRect().right }))));
    for (const column of [0, 1]) for (const edge of ['x', 'right']) {
      const positions = bounds.map(row => row[column][edge]);
      assert.ok(Math.max(...positions) - Math.min(...positions) <= 2, `rich-table ${column}/${edge} misaligned`);
    }
    const emptyCell = page.locator('#preview td').first();
    await emptyCell.click(); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End'); await page.keyboard.press('Delete');
    await page.keyboard.type('new');
    assert.ok((await emptyCell.innerText()).includes('new'));
    await page.keyboard.press('Tab'); await page.keyboard.type('Next');
    assert.ok((await page.locator('#preview td').nth(1).innerText()).includes('Next'));
    const beforeStructure = await text();
    await page.locator('.table-tools summary').click();
    await page.locator('[data-editor-command=row]').click();
    assert.equal(await page.locator('#preview tr').count(), 6);
    await page.keyboard.press('Control+z'); assert.equal(await text(), beforeStructure);
    await page.locator('.table-tools summary').click();

    // Both projections share the same source history; source mode performs
    // ordinary exact interval edits even through table syntax.
    await page.locator('#show-markdown').click(); await page.locator('#source-editor .cm-content').waitFor({ state: 'visible' });
    await page.keyboard.press('Control+a'); await page.keyboard.press('Delete');
    assert.equal(await text(), '', 'Select All/Delete must not leave protected table shells');
    await page.keyboard.press('Control+z'); assert.equal(await text(), beforeStructure);
    await page.locator('#view-formatted').click();
    // Links edit in place: clicking a link reveals its Markdown source in the
    // same buffer, with the URL selected for direct typing. No modal.
    await page.locator('#preview a').first().click();
    await page.locator('#source-editor .cm-content').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => editor.isSource()), true, 'link click reveals Markdown source in the same buffer');
    assert.equal(await page.locator('#editor-action-dialog').evaluate(node => node.open), false, 'link editing uses in-buffer source, not a modal');
    const linkSelection = await page.evaluate(() => editor.getSelection());
    const linkSelected = await page.evaluate(selection => {
      const value = editor.getText();
      return value.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head));
    }, linkSelection);
    assert.ok(linkSelected.includes('https://example.com/original'), `link URL is selected in source, got ${JSON.stringify(linkSelected)}`);
    await page.keyboard.type('https://example.com/changed');
    assert.ok((await text()).includes('https://example.com/changed'));
    assert.equal(await page.evaluate(() => editor.isSource()), true, 'link URL edit stays in the shared buffer');
    await page.locator('#view-formatted').click();
    assert.equal(await page.locator('#preview a').first().textContent(), 'route');
    assert.ok((await page.locator('#preview a').first().getAttribute('href')).includes('https://example.com/changed'));
    // Math edits locally without switching the document to Markdown.
    const beforeMath = await text();
    await page.locator('#preview .math-block .math-edit').click();
    const mathInput = page.locator('#preview .math-block textarea');
    await mathInput.waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => editor.isSource()), false, 'math edit stays in formatted mode');
    assert.equal(await page.locator('#editor-action-dialog').evaluate(node => node.open), false, 'math editing uses in-buffer source, not a modal');
    assert.ok((await mathInput.inputValue()).includes('x^2'));
    await mathInput.fill('\\frac{1}{');
    await page.locator('#preview .math-block button', { hasText: 'Apply' }).click();
    assert.ok((await text()).includes('\\frac{1}{'));
    await page.locator('#preview .math-error').waitFor();
    assert.ok((await text()).includes('\\frac{1}{'));
    await page.keyboard.press('Control+z'); assert.equal(await text(), beforeMath);
    // Image source is reachable in place, without a modal.
    await page.getByRole('button', { name: 'Edit image', exact: true }).click();
    await page.locator('#source-editor .cm-content').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => editor.isSource()), true, 'image edit reveals Markdown source in the same buffer');
    assert.equal(await page.locator('#editor-action-dialog').evaluate(node => node.open), false, 'image editing uses in-buffer source, not a modal');
    const imageSelection = await page.evaluate(() => editor.getSelection());
    const imageSelected = await page.evaluate(selection => {
      const value = editor.getText();
      return value.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head));
    }, imageSelection);
    assert.ok(imageSelected.includes('https://example.com/tracker.png'), `image source is selected in source, got ${JSON.stringify(imageSelected)}`);
    await page.locator('#view-formatted').click();
    assert.ok((await text()).includes('https://example.com/tracker.png'));

    // No requests on view/hover/focus. A deliberate Load remains possible
    // under Lock and must not become a source mutation or broad permission.
    await page.locator('.image-widget').hover(); assert.deepEqual(requests, []);
    await page.locator('#lock-document').click(); const locked = await text();
    await page.getByRole('button', { name: 'Load image', exact: true }).click();
    await page.waitForFunction(() => window.calls.some(call => call.command === 'render_markdown' && call.args.remoteImages === true));
    await page.waitForFunction(() => document.querySelector('.image-widget img') !== null);
    assert.equal(await text(), locked);
    assert.deepEqual(requests, ['https://example.com/tracker.png']);
    await page.locator('#lock-document').click();

    // Rich plain prose is continuous: split/join doesn't mount a textarea.
    // Place the caret deterministically in the first paragraph. Pointer
    // placement is already covered by the link/math/image reveals above, and
    // a pointer click here would race the smooth scroll from the image/lock
    // region on some runs.
    await page.evaluate(() => {
      const scroller = document.getElementById('reader-scroll');
      scroller.style.scrollBehavior = 'auto';
      scroller.scrollTop = 0;
      // "# Heading\n\n" is 11 chars; the first paragraph starts there.
      editor.selectRange(11, 11, true);
    });
    await page.waitForTimeout(300);
    await page.waitForFunction(() => { const selection = editor.getSelection(); return selection.anchor === selection.head; });
    await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => { const selection = editor.getSelection(); return selection.anchor === selection.head; });
    const beforeSplit = await text();
    await page.keyboard.press('Enter'); await page.keyboard.press('Backspace');
    assert.equal(await text(), beforeSplit);
    assert.equal(await page.locator('.live-editor, #source-fallback').count(), 0);
    // A saved buffer becomes clean again after undo, across presentations.
    await page.keyboard.press('Control+s'); await page.waitForFunction(() => !busy && document.getElementById('dirty-dot').hidden);
    const saved = await text(); await page.keyboard.type('EDIT'); assert.notEqual(await text(), saved);
    await page.keyboard.press('Control+z'); assert.equal(await text(), saved);
    assert.equal(await page.locator('#dirty-dot').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS: rich/long/math tables align, cell/row actions share undo, exact source deletion, in-buffer link/math/image source reveal, consent under Lock, continuous prose and saved-state restoration.');
  } catch (error) { console.error('PAGE ERRORS:', errors, 'URL:', page.url()); console.error(await page.locator('#toast').textContent({ timeout: 1000 }).catch(() => 'App document is unavailable')); throw error; }
  finally { await session.close(); }
})().catch(error => { console.error(error); process.exit(1); });
