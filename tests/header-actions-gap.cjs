const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('# Header\n\nText.\n', { width: 1200, height: 800 });
  try {
    const { page, errors } = session;
    const gap = await page.evaluate(() => {
      const mode = document.querySelector('#document-mode-group').getBoundingClientRect();
      const view = document.querySelector('#view-menu-button').getBoundingClientRect();
      return view.left - mode.right;
    });
    assert.ok(gap >= 10, `the mode dropdown and the document icons keep breathing room (gap: ${gap}px)`);
    assert.deepEqual(errors, []);
    console.log('PASS: the document mode dropdown has extra room before the top-right icons.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
