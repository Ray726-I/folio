const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('# Heading\n\nSelected text\n');
  try {
    const { page } = session;
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
    assert.deepEqual(session.errors, []);
    console.log('PASS: navigation styles preserve outline hierarchy and neutral folder icons.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
