const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const s = await openEditor('# Intro\n\n[Jump](#section)\n\n## Section\n\nBody.\n');
  try {
    const { page } = s;
    await page.evaluate(() => { const a = document.createElement('a'); a.href = '#section'; followPreviewLink(a); });
    await page.keyboard.type('X');
    assert.match(await page.evaluate(() => current.content), /\n## XSection\n/);
    assert.equal(await page.locator('#preview h2').textContent(), 'XSection');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
  console.log('PASS: heading-link caret preserves heading markers when typing');
})().catch(e => { console.error(e); process.exitCode = 1; });
