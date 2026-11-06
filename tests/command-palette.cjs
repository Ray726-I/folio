const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async()=>{
  const s = await openEditor('# Heading\n\nText **bold** and [link](https://x.y).\n');
  const { page } = s;
  try {
    await page.evaluate(() => applyTheme('graphite', false));
    await page.keyboard.press('Control+Shift+P');
    assert.equal(await page.evaluate(() => document.getElementById('command-dialog').open), true);

    // The palette reads as part of the UI, not as a code field: sans input,
    // elevated surface, and a list that never cuts a command's text.
    const look = await page.evaluate(() => {
      const input = document.querySelector('#command-search');
      const dialog = document.querySelector('#command-dialog');
      const results = document.querySelector('#command-results').getBoundingClientRect();
      const clipped = [...document.querySelectorAll('#command-list .command-item .command-label')].filter(label => {
        const box = label.getBoundingClientRect();
        const overlapsViewport = box.bottom > results.top && box.top < results.bottom;
        return overlapsViewport && (box.top < results.top || box.bottom > results.bottom);
      }).map(label => label.textContent);
      return {
        inputFont: getComputedStyle(input).fontFamily,
        shadow: getComputedStyle(dialog).boxShadow,
        clipped
      };
    });
    assert.match(look.inputFont, /^Inter/, 'the search field uses the interface typeface, not the mono stack');
    assert.notEqual(look.shadow, 'none', 'the floating palette carries elevation');
    assert.deepEqual(look.clipped, [], 'no command label is cut off by the scrolling box');

    // Filtering moves the built rows instead of recreating the whole list on
    // every keystroke.
    const before = await page.evaluateHandle(() => [...document.querySelectorAll('#command-list .command-item')].find(el => el.querySelector('.command-label').textContent === 'Change theme…'));
    await page.locator('#command-search').fill('theme');
    const after = await page.evaluateHandle(() => [...document.querySelectorAll('#command-list .command-item')].find(el => el.querySelector('.command-label').textContent === 'Change theme…'));
    assert.equal(await page.evaluate(([a,b]) => a === b, [before, after]), true, 'typing reuses row nodes');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#command-list .command-item')].map(el => el.querySelector('.command-label').textContent)), [
      'Change theme…','Theme: System','Theme: Adwaita Light','Theme: Adwaita Dark','Theme: Nord','Theme: Catppuccin Mocha','Theme: Rosé Pine','Theme: Solarized Light'
    ]);
    const activeId = await page.locator('#command-search').getAttribute('aria-activedescendant');
    assert.equal(await page.locator(`#${activeId} .command-label`).textContent(), 'Change theme…', 'active id follows the visible row');

    // The theme list replaces the commands in place; no close/reopen flash.
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.getElementById('command-dialog').open), true, 'submenu keeps the palette open');
    assert.equal(await page.locator('#command-scope').textContent(), 'Appearance');
    assert.equal(await page.locator('#command-search').inputValue(), '');
    const activeTheme = await page.evaluate(() => {
      const id = document.querySelector('#command-search').getAttribute('aria-activedescendant');
      return document.getElementById(id)?.querySelector('.command-label')?.textContent;
    });
    assert.equal(activeTheme, 'Theme: Adwaita Dark', 'the theme list starts on the applied theme');
    assert.equal(await page.locator('#palette-hint').isVisible(), true, 'back affordance shown in the theme list');

    // The back affordance works by pointer and by keyboard without selecting
    // the highlighted theme.
    await page.locator('#palette-hint').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#command-scope').textContent(), 'Commands');
    assert.equal(await page.locator('#command-list .command-item').count(), 40);
    await page.locator('#command-search').fill('theme');
    await page.keyboard.press('Enter');
    await page.locator('#palette-hint').click();
    assert.equal(await page.locator('#command-scope').textContent(), 'Commands');

    // Empty state.
    await page.locator('#command-search').fill('zzzz');
    assert.equal(await page.locator('#command-list .command-item').count(), 0);
    assert.equal(await page.locator('#command-empty').isVisible(), true);
    await page.locator('#command-search').fill('');

    // Selecting a theme closes the palette immediately and applies the theme
    // after the dismissal has painted.
    await page.locator('#command-search').fill('theme');
    await page.keyboard.press('Enter');
    await page.locator('#command-list .command-item', { hasText: 'Theme: Nord' }).click();
    assert.equal(await page.evaluate(() => document.getElementById('command-dialog').open), false, 'closes immediately');
    await page.waitForFunction(() => selectedTheme === 'nord' && document.documentElement.dataset.theme === 'nord');
    await page.keyboard.press('Control+Shift+P');
    await page.evaluate(() => openCommands('themes'));
    const checked = await page.evaluate(() => [...document.querySelectorAll('#command-list .command-item')].filter(row => row.querySelector('.command-check svg')).map(row => row.querySelector('.command-label').textContent));
    assert.deepEqual(checked, ['Theme: Nord']);
    const activeAfterSwitch = await page.evaluate(() => {
      const id = document.querySelector('#command-search').getAttribute('aria-activedescendant');
      return document.getElementById(id)?.querySelector('.command-label')?.textContent;
    });
    assert.equal(activeAfterSwitch, 'Theme: Nord', 'reopening Appearance lands on the applied theme');
    const detailEdges = await page.evaluate(() => [...document.querySelectorAll('#command-list .command-item .command-detail')].map(el => Math.round(el.getBoundingClientRect().right)));
    assert.equal(new Set(detailEdges).size, 1, 'theme descriptions share one right edge');

    // Actions, not just appearance: the lock command says what it does.
    await page.evaluate(() => openCommands());
    const lockIcon = await page.evaluate(() => {
      const row = [...document.querySelectorAll('#command-list .command-item')].find(item => item.textContent.startsWith('Lock document'));
      return row?.querySelector('svg use')?.getAttribute('href');
    });
    assert.equal(lockIcon, '#i-lock');

    // Escape and a backdrop click both dismiss.
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.getElementById('command-dialog').open), false);
    await page.keyboard.press('Control+Shift+P');
    await page.mouse.click(20, 500);
    assert.equal(await page.evaluate(() => document.getElementById('command-dialog').open), false, 'clicking the backdrop closes');
    assert.deepEqual(s.errors, []);
    console.log('PASS: command palette search, in-place theme submenu, back affordance, deferred theme apply, empty state and dismissal');
  } finally { await s.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
