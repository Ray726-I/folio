'use strict';
const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const source = '# Stable typing\n\nA paragraph to edit.\n\n| A | B |\n| --- | --- |\n| one | two |\n';
  const session = await openEditor(source);
  try {
    const { page, errors } = session;
    await page.evaluate(() => { window.__tail = document.querySelector('.editor-trailing-input'); editor.selectRange(current.content.indexOf('paragraph') + 3); });
    await page.keyboard.type('xyz');
    assert.ok(await page.evaluate(() => __tail === document.querySelector('.editor-trailing-input')), 'typing preserves the trailing input DOM instead of replacing it on every transaction');
    await page.keyboard.press('ArrowLeft');
    assert.ok(await page.evaluate(() => __tail === document.querySelector('.editor-trailing-input')), 'caret navigation preserves the trailing input DOM');
    await page.locator('.editor-trailing-input').click();
    await page.keyboard.type('Tail');
    assert.ok(await page.evaluate(() => current.content.endsWith('\n\nTail')), 'reused trailing input still inserts an exact new paragraph');
    assert.deepEqual(errors, []);
    console.log('PASS: typing and caret movement reuse the trailing input widget without breaking end-of-document editing.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
