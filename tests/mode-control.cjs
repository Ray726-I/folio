const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('# Document\n\nText\n', undefined, { reading: true });
  try {
    const { page, errors } = session;
    const state = () => page.evaluate(() => {
      const group = document.getElementById('document-mode-group');
      const main = document.getElementById('document-mode-button');
      const menu = document.getElementById('document-mode-menu-button');
      return {
        mode: documentMode,
        label: document.getElementById('document-mode-label').textContent,
        groupMode: group.dataset.mode,
        color: getComputedStyle(main).color,
        background: getComputedStyle(main).backgroundColor,
        caretWidth: document.getElementById('document-mode-menu-button').getBoundingClientRect().width,
        menuHidden: document.getElementById('document-mode-menu').hidden,
        expanded: menu.getAttribute('aria-expanded'),
        mainExpanded: main.getAttribute('aria-expanded'),
        mainHasPopup: main.getAttribute('aria-haspopup')
      };
    });

    // Separate targets: the label cycles modes; the caret opens the menu.
    const box = await page.evaluate(() => {
      const main = document.getElementById('document-mode-button').getBoundingClientRect();
      const caret = document.getElementById('document-mode-menu-button').getBoundingClientRect();
      return { mainTop: main.top, mainBottom: main.bottom, caretTop: caret.top, caretBottom: caret.bottom };
    });
    assert.ok(Math.abs(box.mainTop - box.caretTop) < 1 && Math.abs(box.mainBottom - box.caretBottom) < 1, 'the caret and label share one continuous height');
    let current = await state();
    assert.equal(current.label, 'Read');
    assert.equal(current.groupMode, 'reading');
    assert.equal(current.menuHidden, true);
    assert.equal(current.mainExpanded, null, 'the cycling button is not the menu trigger');
    assert.equal(current.mainHasPopup, null, 'the cycling button does not advertise a popup');
    const readColor = current.color;
    assert.equal(current.background, 'rgba(0, 0, 0, 0)', 'mode color stays on the text and icon');
    assert.ok(current.caretWidth >= 24 && current.caretWidth <= 32, 'the caret meets the minimum target size while staying compact');

    await page.locator('#document-mode-button').click();
    await page.mouse.move(0, 0);
    current = await state();
    assert.equal(current.mode, 'edit');
    assert.equal(current.label, 'Edit');
    assert.equal(current.groupMode, 'edit');
    assert.equal(current.menuHidden, true, 'toggling never opens the dropdown');
    assert.equal(current.background, 'rgba(0, 0, 0, 0)', 'toggling does not tint the button background');
    const editColor = current.color;

    await page.locator('#document-mode-button').click();
    await page.mouse.move(0, 0);
    current = await state();
    assert.equal(current.mode, 'reading', 'the toggle stops at Read instead of cycling into Source');

    // Source lives in the caret menu only.
    await page.locator('#document-mode-menu-button').click();
    current = await state();
    assert.equal(current.menuHidden, false, 'the caret still opens the dropdown');
    assert.equal(current.expanded, 'true');
    await page.getByRole('menuitemradio', { name: 'Source', exact: true }).click();
    // The menu closes under the pointer; move clear of the split control so a
    // lingering :hover tint cannot stand in for the selected-mode colour.
    await page.mouse.move(0, 0);
    current = await state();
    assert.equal(current.mode, 'source');
    assert.equal(current.label, 'Source');
    assert.equal(current.groupMode, 'source');
    assert.equal(current.background, 'rgba(0, 0, 0, 0)', 'source keeps a transparent button background');
    const sourceColor = current.color;
    assert.equal(new Set([readColor, editColor, sourceColor]).size, 3, 'each mode has its own selected color');

    await page.locator('#document-mode-button').click();
    await page.mouse.move(0, 0);
    current = await state();
    assert.equal(current.mode, 'edit', 'leaving Source with the toggle returns to Edit');
    assert.equal(current.menuHidden, true, 'the toggle never opens the dropdown');

    await page.locator('#document-mode-menu-button').click();
    await page.getByRole('menuitemradio', { name: 'Read', exact: true }).click();
    current = await state();
    assert.equal(current.mode, 'reading');
    assert.equal(current.label, 'Read');
    assert.equal(current.menuHidden, true);
    assert.equal(current.expanded, 'false', 'selecting a mode closes the dropdown');
    await page.locator('#document-mode-menu-button').click();
    await page.keyboard.press('Escape');
    const focusState = await page.evaluate(() => {
      const group = document.getElementById('document-mode-group');
      const caret = document.getElementById('document-mode-menu-button');
      return { groupOutline: getComputedStyle(group).outlineStyle, caretOutline: getComputedStyle(caret).outlineStyle };
    });
    assert.equal(focusState.caretOutline, 'none', 'the caret does not draw a second focus box');
    assert.equal(focusState.groupOutline, 'solid', 'the split control focuses as one shape');
    assert.deepEqual(errors, []);
    console.log('PASS: the main mode control toggles Read/Edit while the caret owns Source, with distinct selected colors.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
