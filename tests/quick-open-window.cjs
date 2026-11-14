const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const s = await openEditor('# Test\n');
  const { page } = s;
  try {
    const created = await page.evaluate(() => {
      activeFolder = { path: '/docs', name: 'docs' };
      folderEntries = Array.from({ length: 5000 }, (_, i) => { const name = `note-${String(i).padStart(5, '0')}.md`; return { path: `/docs/${name}`, name, depth: 0, directory: false }; });
      const original = document.createElement; let buttons = 0;
      document.createElement = function(tag, ...args) { if (tag === 'button') buttons++; return original.call(this, tag, ...args); };
      try { openCommands('files'); } finally { document.createElement = original; }
      return buttons;
    });
    assert.ok(created <= 80, `Quick Open must lazily create rows; created ${created}`);
    assert.ok(await page.locator('#command-list .command-item').count() <= 80);
    await page.keyboard.press('ArrowUp');
    const active = () => page.evaluate(() => { const id = $('command-search').getAttribute('aria-activedescendant'); const row = document.getElementById(id); return { text: row?.querySelector('.command-label').textContent, position: row?.getAttribute('aria-posinset'), size: row?.getAttribute('aria-setsize') }; });
    assert.deepEqual(await active(), { text: 'note-04999.md', position: '5000', size: '5000' }, 'keyboard wrap mounts the last option with correct accessibility positions');
    await page.keyboard.press('ArrowDown');
    assert.equal((await active()).text, 'note-00000.md');
    await page.evaluate(() => { $('command-results').scrollTop = $('command-results').scrollHeight; });
    await page.waitForFunction(() => [...$('command-list').querySelectorAll('.command-label')].some(row => row.textContent === 'note-04999.md'));
    assert.ok(await page.locator('#command-list .command-item').count() <= 80, 'scrolling keeps the DOM bounded');
    await page.locator('#command-search').fill('note-04999');
    assert.equal(await page.locator('#command-list .command-label').first().textContent(), 'note-04999.md', 'filtering searches all 5000 files');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => current.path === '/docs/note-04999.md' && !busy);
    assert.deepEqual(s.errors, []);
    console.log('PASS: Quick Open bounds row creation and preserves filtering, scroll, keyboard wrap and activation');
  } finally { await s.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
