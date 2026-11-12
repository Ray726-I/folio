const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Contextual selection toolbar: real states, pane-aware positioning, stable
// selection while formatting, and no companion overlap.
(async () => {
  const source = [
    '# Top heading',
    '',
    'plain and **bold** words here.',
    '',
    'Unformatted paragraph for keyboard formatting.',
    '',
    '| A | B |',
    '|---|---|',
    '| 1 | 2 |',
    '',
  ].join('\n');
  const session = await openEditor(source, { width: 1100, height: 700 });
  try {
    const { page } = session;
    await page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
    await page.waitForTimeout(250);
    const selectSource = async (needle, length) => {
      await page.evaluate(({ needle, length }) => {
        const at = current.content.indexOf(needle);
        editor.selectRange(at, at + length, true);
      }, { needle, length });
      await page.waitForTimeout(600);
    };
    const toolbar = () => page.evaluate(() => {
      const bubble = document.querySelector('.selection-format');
      const button = id => document.querySelector(`.selection-format-button[data-action="${id}"]`);
      const rect = bubble.getBoundingClientRect();
      return {
        hidden: bubble.hidden,
        side: bubble.dataset.side,
        pointer: parseFloat(bubble.style.getPropertyValue('--pointer-left')),
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        bold: { pressed: button('bold').getAttribute('aria-pressed'), mixed: button('bold').dataset.mixed === 'true' },
        quoteDisabled: button('quote').disabled,
        bulletDisabled: button('bullet').disabled,
        buttons: bubble.querySelectorAll('.selection-format-button').length,
        separators: bubble.querySelectorAll('.selection-format-separator').length,
      };
    });

    // Appears with the full mixed-capable control set.
    await selectSource('Unformatted', 11);
    const shown = await toolbar();
    assert.equal(shown.hidden, false, 'selection shows the bubble');
    assert.equal(shown.buttons, 9, 'all formatting actions are present');
    assert.equal(shown.separators, 3, 'actions are grouped by separators');
    assert.equal(shown.bold.pressed, 'false', 'plain text is not bold');
    const pointer = await page.evaluate(() => {
      const range = getSelection().getRangeAt(0);
      let first = range.getClientRects()[0];
      // A block-level selection reports a full-column line box before the
      // actual text rect; the toolbar anchors to the first selected text.
      const start = range.startContainer;
      const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT);
      let node = start.nodeType === Node.TEXT_NODE ? start : walker.nextNode();
      while (node) {
        if (range.intersectsNode(node)) {
          const probe = document.createRange();
          const offset = node === start ? range.startOffset : 0;
          probe.setStart(node, Math.min(offset, node.textContent.length));
          probe.setEnd(node, node.textContent.length);
          const rects = [...probe.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
          if (rects.length) { first = rects[0]; break; }
        }
        node = walker.nextNode();
      }
      const bubble = document.querySelector('.selection-format');
      const box = bubble.getBoundingClientRect();
      const expected = Math.max(14, Math.min(box.width - 14, first.left + first.width / 2 - box.left));
      return { expected: Math.round(expected), actual: Math.round(parseFloat(bubble.style.getPropertyValue('--pointer-left'))) };
    });
    assert.ok(Math.abs(pointer.expected - pointer.actual) <= 2, 'pointer follows the selection anchor');

    // Bold applies through the toolbar, bubble stays, state flips, selection stays.
    const before = await page.evaluate(() => editor.getSelection());
    await page.locator('.selection-format-button[data-action="bold"]').click();
    await page.waitForTimeout(400);
    const bolded = await toolbar();
    assert.ok((await page.evaluate(() => current.content)).includes('**Unformatted**'), 'bold writes Markdown');
    assert.equal(bolded.hidden, false, 'bubble stays visible after formatting');
    assert.equal(bolded.bold.pressed, 'true', 'bold state refreshes');
    const after = await page.evaluate(() => editor.getSelection());
    assert.ok(after.head > after.anchor, 'selection survives the command');
    assert.ok(after.head - after.anchor >= before.head - before.anchor, 'selection still covers the formatted words');

    // Mixed selection reports an indeterminate state and applies consistently.
    await selectSource('plain and **bold**', 'plain and **bold**'.length);
    const mixed = await toolbar();
    assert.equal(mixed.hidden, false, 'mixed selection keeps the bubble');
    assert.equal(mixed.bold.mixed, true, 'partial bold is indeterminate');
    await page.locator('.selection-format-button[data-action="bold"]').click();
    await page.waitForTimeout(400);
    const plainText = await page.evaluate(() => current.content.replace(/\*\*/g, ''));
    assert.ok(plainText.includes('plain and bold'), 'content preserved after mixed formatting');
    const mixedAfter = await toolbar();
    assert.equal(mixedAfter.bold.mixed, false, 'mixed state resolves after applying');

    // Table cells disable block actions.
    await page.evaluate(() => {
      const cell = document.querySelector('#preview table td');
      const range = document.createRange(); range.selectNodeContents(cell);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.waitForTimeout(400);
    const table = await toolbar();
    assert.equal(table.quoteDisabled, true, 'quote is disabled inside tables');
    assert.equal(table.bulletDisabled, true, 'list is disabled inside tables');

    // No room above the first line flips the bubble below it.
    await page.evaluate(() => {
      const heading = document.querySelector('#preview h1');
      const range = document.createRange(); range.selectNodeContents(heading);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.waitForTimeout(400);
    const flipped = await toolbar();
    assert.equal(flipped.side, 'below', 'top-edge selection flips below');

    // The bubble never overlaps the companion pane.
    await page.evaluate(() => { showReadingCompanion(); });
    await page.waitForFunction(() => !$('reading-companion').hidden);
    await selectSource('Unformatted', 11);
    const pane = await page.evaluate(() => {
      const bubble = document.querySelector('.selection-format').getBoundingClientRect();
      const reader = $('reader-scroll').getBoundingClientRect();
      const companion = $('reading-companion').getBoundingClientRect();
      return { bubbleRight: bubble.right, readerRight: reader.right, readerLeft: reader.left, bubbleLeft: bubble.left, companionLeft: companion.left };
    });
    assert.ok(pane.bubbleRight <= pane.companionLeft + 1, 'bubble stays clear of the companion');
    assert.ok(pane.bubbleLeft >= pane.readerLeft - 1, 'bubble clamped inside the reader pane');

    // Escape dismisses it and returns focus to the editor.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    assert.equal((await toolbar()).hidden, true, 'Escape hides the bubble');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest?.('.ProseMirror')), true, 'Escape restores editor focus');

    // Keyboard formatting keeps the selection round-trip intact.
    await selectSource('keyboard', 8);
    await page.keyboard.press('Control+b');
    await page.waitForFunction(() => current.content.includes('**keyboard**'));
    await page.waitForTimeout(300);
    const keyboard = await page.evaluate(() => { const s = editor.getSelection(); return { length: s.head - s.anchor, bold: document.querySelector('.selection-format-button[data-action="bold"]').getAttribute('aria-pressed') }; });
    assert.ok(keyboard.length > 0, 'keyboard formatting preserves the range');
    assert.equal(keyboard.bold, 'true', 'keyboard formatting refreshes the active state');

    // More opens the existing block picker, anchored to its button, and block
    // actions convert the current line instead of replacing the selection.
    await page.locator('.selection-format-button[data-action="more"]').click();
    const picker = page.locator('.folio-slash-menu');
    await picker.waitFor({ state: 'visible' });
    const pickerLabels = await picker.locator('.folio-slash-row').allTextContents();
    for (const label of ['Paragraph', 'Heading', 'List', 'Quote', 'Code block', 'Table']) assert.ok(pickerLabels.some(text => text.startsWith(label)), `${label} is offered in the block menu`);
    await picker.locator('.folio-slash-row').filter({ hasText: 'Heading' }).first().click();
    await page.locator('.folio-slash-sublist .folio-slash-row').filter({ hasText: 'Heading 3' }).click();
    await page.waitForTimeout(400);
    assert.ok(/\n### .*\*\*keyboard\*\*/.test(await page.evaluate(() => current.content)), 'block menu applies heading syntax to the line');
    assert.equal(await page.locator('.folio-slash-menu').count(), 0, 'choosing a block closes the picker');

    // The overflow keeps image insertion out, and Escape closes it.
    await selectSource('keyboard', 8);
    await page.locator('.selection-format-button[data-action="more"]').click();
    const picker2 = page.locator('.folio-slash-menu');
    await picker2.waitFor({ state: 'visible' });
    await picker2.locator('.folio-slash-row').filter({ hasText: 'More' }).click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.folio-slash-menu .folio-slash-row').filter({ hasText: 'Image' }).count(), 0, 'image insertion stays out of the toolbar overflow');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.folio-slash-menu').count(), 0, 'Escape closes the block picker');

    // Hovering the overflow button opens the picker without a click, and the
    // editor root is an anchor rather than a trigger: outside clicks dismiss.
    await selectSource('keyboard', 8);
    await page.locator('.selection-format-button[data-action="more"]').hover();
    await page.locator('.folio-slash-menu').waitFor({ state: 'visible', timeout: 2500 });
    assert.equal(await page.locator('.folio-slash-menu').count(), 1, 'hover opens the block picker');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')), true, 'hover does not steal editor focus');
    await page.locator('#reader-scroll').click({ position: { x: 40, y: 300 } });
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.folio-slash-menu').count(), 0, 'outside click dismisses the hover-opened picker');
    await selectSource('keyboard', 8);
    await page.locator('.selection-format-button[data-action="more"]').hover();
    await page.locator('.folio-slash-menu').waitFor({ state: 'visible', timeout: 2500 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.folio-slash-menu').count(), 0, 'Escape closes a hover-opened picker and it stays closed');
    await selectSource('keyboard', 8);
    await page.locator('.selection-format-button[data-action="more"]').click();
    await page.locator('.folio-slash-menu').waitFor({ state: 'visible' });
    await page.keyboard.press('Control+Shift+p');
    await page.waitForSelector('#command-dialog[open]');
    assert.equal(await page.locator('.folio-slash-menu').count(), 0, 'opening the command window closes the block picker');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    // Dismissal is synchronous, not deferred to the dialog's queued toggle
    // event; otherwise a visible check racing that task still sees the picker.
    await selectSource('keyboard', 8);
    const synchronousDismissal = await page.evaluate(() => {
      const button = document.querySelector('.selection-format-button[data-action="more"]');
      editor.openBlockMenu(button.getBoundingClientRect(), button, false);
      const opened = document.querySelectorAll('.folio-slash-menu').length;
      openCommands();
      const dismissed = document.querySelectorAll('.folio-slash-menu').length;
      $('command-dialog').close();
      return { opened, dismissed };
    });
    assert.equal(synchronousDismissal.opened, 1, 'block picker opens for the synchronous dismissal check');
    assert.equal(synchronousDismissal.dismissed, 0, 'opening the command window dismisses the block picker in the same task');
    assert.deepEqual(session.errors, []);
    console.log('PASS: selection toolbar states, positioning, persistence and Escape');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
