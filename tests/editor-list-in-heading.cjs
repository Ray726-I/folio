const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// List/quote markers typed inside a heading are literal text: wrapping the
// heading in a list serialized the markers out of order (`## 1. Title`
// became `1. ## Title`). Plain paragraphs still convert as before.
(async () => {
  const session = await openEditor('', { width: 1100, height: 700 });
  try {
    const { page } = session;
    await page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
    const typeFresh = async text => {
      await page.evaluate(() => { editor.replaceContent(''); editor.focus(); });
      await page.waitForTimeout(150);
      await page.keyboard.type(text);
      await page.waitForTimeout(400);
      return page.evaluate(() => current.content);
    };
    assert.equal(await typeFresh('## 1. Title'), '## 1. Title\n', 'ordered marker stays literal in headings');
    assert.equal(await typeFresh('## - item'), '## - item\n', 'bullet marker stays literal in headings');
    assert.equal(await typeFresh('## > quoted'), '## > quoted\n', 'quote marker stays literal in headings');
    assert.ok((await typeFresh('- item')).startsWith('- item'), 'paragraph bullets still list');
    assert.ok((await typeFresh('> quoted')).startsWith('> quoted'), 'paragraph quotes still quote');
    assert.deepEqual(session.errors, []);
    console.log('PASS: list and quote markers stay literal inside headings');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
