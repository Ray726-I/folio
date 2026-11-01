const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Composition (IME) handling. This is NOT an IME-engine test — it cannot stand
// in for driving fcitx5/mozc — but it does verify the contract the editor
// depends on: while a composition session is active, the document's keymap must
// not act on Enter or Mod-B, because those keys belong to the input method
// (candidate commit / IME shortcuts). ProseMirror's view is what marks the
// session, so a bare synthetic key without `compositionstart` is still handled
// normally — the control case below proves the events reach the editor.

const keysWhileComposing = () => {
  const target = document.querySelector('#preview .ProseMirror');
  target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  for (const init of [
    { key: 'Enter', code: 'Enter' },
    { key: 'b', code: 'KeyB', ctrlKey: true },
  ]) {
    target.dispatchEvent(new KeyboardEvent('keydown', { ...init, isComposing: true, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { ...init, isComposing: true, bubbles: true, cancelable: true }));
  }
  target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
};

(async () => {
  const session = await openEditor('# Title\n\nHello world\n');
  const { page, errors } = session;
  const content = () => page.evaluate(() => current.content);
  try {
    await page.locator('#preview .ProseMirror p').first().waitFor();
    await page.locator('#preview .ProseMirror p').first().click();

    // 1. During composition, Enter and Mod-B must leave the document alone.
    const before = await content();
    await page.evaluate(keysWhileComposing);
    await page.waitForTimeout(150);
    assert.equal(await content(), before, 'keys pressed during an IME composition must not edit the document');

    // 2. Control: the same synthetic Enter outside a composition DOES split the
    //    paragraph, so case 1 was a real assertion and not a no-op.
    await page.evaluate(() => {
      const target = document.querySelector('#preview .ProseMirror');
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(150);
    assert.notEqual(await content(), before, 'the same key outside a composition reaches the editor (control)');

    // 3. Composition must not corrupt anything or leave the editor wedged.
    assert.deepEqual(errors, []);
    await page.evaluate(keysWhileComposing);
    await page.locator('#preview .ProseMirror p').first().click();
    await page.keyboard.type('z');
    assert.ok((await content()).includes('z'), 'typing still works after a composition ended');
    console.log('PASS: Enter and Mod-B are ignored while an IME composition is active, and the editor recovers after it ends.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exit(1); });
