const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
const source = Array.from({ length: 12 }, (_, i) => `# :smile: Section ${i}\n\nParagraph ${i}.\n`).join('\n');
(async () => {
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.evaluate(() => {
      window.fullProjectionParses = 0;
      const original = DOMParser.prototype.parseFromString;
      DOMParser.prototype.parseFromString = function(text, type) {
        if (String(text).includes('Section 0') && String(text).includes('Section 11')) window.fullProjectionParses++;
        return original.call(this, text, type);
      };
    });
    await page.evaluate(() => openPath('/tmp/test.md', true));
    await page.waitForFunction(() => document.querySelectorAll('#preview .extension-block h1').length === 12);
    const count = await page.evaluate(() => window.fullProjectionParses);
    assert.equal(count, 1, `native whole-document HTML should be parsed once per revision, not once per extension (${count})`);
    console.log('PASS: extension blocks share one parsed native document per revision.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
