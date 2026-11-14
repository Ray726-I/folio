const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const s = await openEditor('# Main\n\n## Main child\n', { width: 1200, height: 800 });
  const { page } = s;
  try {
    await page.evaluate(() => { showReadingCompanion({ active: true, documentId: 'pinned', name: 'Pinned.md', content: '# One\n\n## Two\n\n### Three\n\n## Four\n', saved: '', revision: 0 }, false); });
    await page.waitForSelector('#companion-preview h3');
    await page.evaluate(() => { setOutline(true); focusPane('companion'); });
    await page.waitForTimeout(600);
    const row = text => page.locator('#outline-items .outline-link').filter({ hasText: new RegExp(`^${text}$`) });
    await row('One').focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await row('Two').evaluate(node => document.activeElement === node), true, 'companion ArrowDown moves to next heading');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await row('Three').isVisible(), false, 'companion parents collapse with ArrowLeft');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    assert.equal(await row('Three').evaluate(node => document.activeElement === node), true, 'ArrowRight expands and enters child');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await row('Two').evaluate(node => document.activeElement === node), true);
    await page.keyboard.press('End'); assert.equal(await row('Four').evaluate(node => document.activeElement === node), true);
    await page.keyboard.press('Home'); assert.equal(await row('One').evaluate(node => document.activeElement === node), true);
    await page.evaluate(() => refreshCompanionOutline());
    assert.equal(await row('One').evaluate(node => document.activeElement === node), true, 'outline refresh preserves keyboard focus');
    await page.evaluate(() => closeReadingCompanion());
    await page.waitForFunction(() => $('outline-items').textContent.includes('Main child'));
    assert.equal(await row('Main child').isVisible(), true, 'companion collapse state does not hide main headings');
    await page.evaluate(() => showReadingCompanion({ active: true, documentId: 'duplicate-headings', name: 'Duplicate.md', content: '<h1 id="same">One</h1>\n\n<h2 id="same">Two</h2>\n\n<h1 id="other">Three</h1>\n', saved: '', revision: 0 }, false));
    await page.waitForFunction(() => $('companion-preview').textContent.includes('Three'));
    await page.evaluate(() => { focusPane('companion'); refreshCompanionOutline(); });
    assert.deepEqual(await page.locator('#outline-items .outline-link').allTextContents(), ['One', 'Two', 'Three'], 'duplicate author heading IDs retain distinct outline rows after refresh');
    await row('One').focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await row('Two').evaluate(node => document.activeElement === node), true);
    assert.deepEqual(s.errors, []);
    console.log('PASS: companion outline shares hierarchy, collapse, keyboard movement and focus preservation');
  } finally { await s.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
