const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Opening a menu with the pointer must not park a focus ring on its first row:
// hover is the only state a pointer user should see until they move. Keyboard
// opens still start on the first item so arrows, Home and End have a place to
// move from, and the ring stays visible for that path.
const activeId = page => page.evaluate(() => document.activeElement.id || document.activeElement.className);
const ringedItems = page => page.evaluate(() => [...document.querySelectorAll('.menu-item')]
  .filter(item => item.matches(':focus-visible') && getComputedStyle(item).outlineStyle !== 'none')
  .map(item => item.textContent.trim()));

(async () => {
  const session = await openEditor('# A title\n\nSome text.\n', undefined, { reading: true });
  try {
    const { page } = session;
    await page.evaluate(() => preferences.set('recent', ['/tmp/Notes.md', '/tmp/Plan.md']));

    // Pointer open: focus lands on the menu itself, never on a row.
    await page.locator('#menu-file-button').click();
    assert.equal(await activeId(page), 'open-menu', 'a clicked menu takes focus itself');
    assert.deepEqual(await ringedItems(page), [], 'no row is ringed before the pointer moves');
    const firstRow = await page.locator('#open-menu > .menu-item').first().evaluate(el => getComputedStyle(el).outlineStyle);
    assert.equal(firstRow, 'none', 'the first row has no focus outline');

    // Arrows still work from the container and show the ring.
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('#open-menu > .menu-item').first().evaluate(el => el === document.activeElement), true, 'ArrowDown moves into the menu');
    assert.deepEqual(await ringedItems(page), ['New documentCtrl+N'], 'keyboard focus is visible on a row');
    await page.keyboard.press('Escape');
    assert.equal(await activeId(page), 'menu-file-button', 'Escape returns focus to the trigger');

    // Keyboard open keeps the first item focused.
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('#open-menu > .menu-item').first().evaluate(el => el === document.activeElement), true, 'a keyboard open lands on the first item');
    assert.deepEqual(await ringedItems(page), ['New documentCtrl+N'], 'a keyboard open keeps the focus ring');
    await page.keyboard.press('Escape');

    // The recent flyout follows the same rule for pointer and keyboard opens.
    await page.locator('#menu-file-button').click();
    await page.locator('#open-recent-button').click();
    assert.equal(await activeId(page), 'open-recent-menu', 'a clicked flyout takes focus itself');
    assert.deepEqual(await page.locator('#open-recent-menu button').evaluateAll(buttons => buttons.map(button => button.matches(':focus-visible'))), [false, false], 'recent files are not pre-highlighted');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('#open-recent-menu button').first().evaluate(el => el === document.activeElement), true, 'arrows enter the flyout');
    await page.keyboard.press('Escape');
    assert.equal(await activeId(page), 'open-recent-button', 'Escape returns to the parent item');
    await page.keyboard.press('Escape');

    // Header menus share setupMenu.
    await page.locator('#document-more-button').click();
    assert.equal(await activeId(page), 'document-more-menu', 'the document menu also opens without a row ring');
    assert.deepEqual(await ringedItems(page), [], 'no document action is ringed before the pointer moves');
    await page.keyboard.press('Escape');
    assert.equal(await activeId(page), 'document-more-button', 'closing returns focus to its trigger');

    // Hover-open must not move focus out of the document, and typing dismisses it.
    await page.locator('#reader-scroll').focus();
    await page.mouse.move(600, 400);
    await page.locator('#document-more-button').hover();
    await page.waitForFunction(() => !document.getElementById('document-more-menu').hidden);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'reader-scroll', 'hover-open keeps document focus');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('document-more-menu').hidden);
    await page.locator('#document-more-button').click();
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim().endsWith('Close document')), true, 'ArrowUp from the menu container reaches the last item');
    await page.keyboard.press('Escape');

    assert.deepEqual(session.errors, []);
    console.log('PASS: pointer-opened menus show no focus ring until keyboard focus enters them.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
