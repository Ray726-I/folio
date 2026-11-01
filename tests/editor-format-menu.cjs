const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('# Heading\n\nSelected text\n');
  try {
    const { page } = session;
    const trigger = page.locator('#format-more');
    const menu = page.locator('#format-menu');
    const navigationStyles = await page.evaluate(() => {
      const outline = document.createElement('button');
      outline.className = 'outline-link'; outline.dataset.level = '2';
      const deep = document.createElement('button');
      deep.className = 'outline-link'; deep.dataset.level = '4';
      const folder = document.createElement('div'); folder.className = 'folder-entry directory';
      folder.innerHTML = '<svg class="icon"></svg>';
      document.body.append(outline, deep, folder);
      const result = {
        guide: getComputedStyle(outline, '::before').content,
        levelWeight: [getComputedStyle(outline).fontWeight, getComputedStyle(deep).fontWeight],
        folderIcon: getComputedStyle(folder.firstElementChild).color,
        neutralIcon: getComputedStyle(document.querySelector('#folder-refresh .icon')).color,
      };
      outline.remove(); deep.remove(); folder.remove(); return result;
    });
    assert.equal(navigationStyles.guide, 'none', 'outline carries hierarchy through indentation and type, not level badges');
    assert.notEqual(navigationStyles.levelWeight[0], navigationStyles.levelWeight[1], 'shallower headings keep more weight than deep ones');
    assert.equal(navigationStyles.folderIcon, navigationStyles.neutralIcon, 'folder icons use neutral icon color');
    await page.evaluate(() => {
      const start = current.content.indexOf('Selected text');
      editor.selectRange(start, start + 'Selected text'.length, true);
    });
    await trigger.click();
    assert.equal(await menu.isVisible(), true, 'additional actions are grouped in a menu');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    await page.locator('[data-editor-command="math"]').click();
    await page.waitForFunction(() => current.content.includes('$Selected text$'));
    await menu.waitFor({ state: 'hidden' });
    assert.equal(await menu.isHidden(), true, 'choosing an action closes the menu');
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await menu.isVisible(), true, 'keyboard can open the menu');
    await page.keyboard.press('Escape');
    assert.equal(await menu.isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'format-more');
    await page.locator('#lock-document').click();
    assert.equal(await trigger.isDisabled(), true, 'additional formatting is unavailable when locked');
    assert.deepEqual(session.errors, []);
    console.log('PASS: additional formatting actions preserve selection, keyboard access and lock behavior.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
