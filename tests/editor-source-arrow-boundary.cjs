const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
const { openMarkdown } = require('./editor-test-actions.cjs');

(async () => {
  const source = 'Before.\n\n```text\nalpha beta\ndelta epsilon\n```\n\nAfter.\n';
  const session = await openEditor(source);
  try {
    const { page } = session;
    await openMarkdown(page.locator('.code-surface code'));
    const card = page.locator('.folio-source-edit');
    const bounds = await card.evaluate(element => {
      const text = element.querySelector('code').firstChild;
      document.querySelector('.ProseMirror').focus();
      window.getSelection().collapse(text, text.length - 1);
      return { start: documentSource.indexOf('```'), length: text.length };
    });
    const caret = () => page.evaluate(() => {
      const dom = window.getSelection();
      return { inside: !!dom.anchorNode?.parentElement?.closest('.folio-source-edit'), offset: dom.anchorOffset };
    });
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await caret(), { inside: true, offset: bounds.length }, 'Right reaches the final source character');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    assert.deepEqual(await caret(), { inside: true, offset: bounds.length }, 'repeated Right stays at the source card end');
    assert.deepEqual(await page.evaluate(() => editor.getSelection()), { anchor: bounds.start + bounds.length, head: bounds.start + bounds.length });
    await page.keyboard.press('ArrowLeft');
    assert.deepEqual(await caret(), { inside: true, offset: bounds.length - 1 }, 'Left still moves inside the source card');
    await card.evaluate(element => window.getSelection().collapse(element.querySelector('code').firstChild, 1));
    await page.keyboard.press('ArrowLeft');
    assert.deepEqual(await caret(), { inside: true, offset: 0 }, 'Left reaches the first source character');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
    assert.deepEqual(await caret(), { inside: true, offset: 0 }, 'repeated Left stays at the source card start');
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await caret(), { inside: true, offset: 1 }, 'Right still moves inside the source card');
    await card.evaluate(element => { const text = element.querySelector('code').firstChild; window.getSelection().collapse(text, text.length); });
    await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await page.evaluate(() => !!window.getSelection().focusNode?.parentElement?.closest('.folio-source-edit')), false, 'Shift+Right can extend the selection out of the source card');
    await card.evaluate(element => { const text = element.querySelector('code').firstChild; window.getSelection().collapse(text, text.length); });
    await page.keyboard.press('Control+Shift+End');
    assert.match(await page.evaluate(() => window.getSelection().toString()), /After\./, 'modified selection can still cross source card boundaries');
    assert.equal(await page.evaluate(() => current.content), source, 'navigation never changes Markdown');
    assert.deepEqual(session.errors, []);
    console.log('PASS: unmodified horizontal arrows stop at source card edges while document selections can cross.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
