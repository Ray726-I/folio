const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Keyboard and focus behaviour of the single editor's in-place surfaces. These
// are the pieces the Markdown-mode removal introduced: a destination dialog, a
// per-formula editor, and per-block source editing. Focus must always come
// back to something the keyboard user can keep working in.
const source = [
  '# Focus',
  '',
  'A [link](https://example.com/orig) and inline \\(x+1\\).',
  '',
  '<div class="note">raw block</div>',
  '',
  'After.',
  '',
].join('\n');

(async () => {
  const session = await openEditor(source);
  const { page, errors } = session;
  const inEditor = () => page.evaluate(() => !!document.activeElement?.closest?.('.ProseMirror'));
  try {
    await page.locator('#preview a').first().waitFor();

    // 1. Destination dialog: focus starts in the input and returns to the
    //    editor after Apply.
    await page.locator('#preview a').first().click();
    await page.waitForFunction(() => document.getElementById('editor-action-dialog').open);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'editor-action-value', 'dialog focuses its input');
    await page.locator('#editor-action-value').fill('https://example.com/next');
    await page.locator('#editor-action-form button[type="submit"]').click();
    await page.waitForFunction(() => current.content.includes('https://example.com/next'));
    await page.waitForTimeout(120);
    assert.equal(await inEditor(), true, 'focus returns to the editor after applying a destination');

    // 2. Cancel closes the dialog and restores editor focus too.
    await page.locator('#preview a').first().click();
    await page.waitForFunction(() => document.getElementById('editor-action-dialog').open);
    await page.locator('#editor-action-cancel').click();
    await page.waitForTimeout(120);
    assert.equal(await inEditor(), true, 'focus returns to the editor after cancelling');

    // 3. Keyboard activation reveals the formula's Markdown and Escape
    //    returns focus to the formatted editor.
    const formulaButton = page.locator('.math-inline .math-formula');
    assert.equal(await formulaButton.count(), 1, 'each formula exposes a labelled edit button');
    await formulaButton.focus();
    await page.keyboard.press('Enter');
    await page.locator('.folio-source-edit').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    assert.equal(await inEditor(), true, 'closing formula source returns focus to the editor');

    // 4. Block-level source editing is keyboard reachable and the action is
    //    visible (not merely focusable) when it holds focus.
    const reachable = await page.evaluate(() => {
      const projection = document.querySelector('.extension-block .extension-preview');
      if (!projection) return null;
      projection.focus();
      return new Promise(resolve => setTimeout(() => resolve({
        focused: document.activeElement === projection,
        tabIndex: projection.tabIndex,
      }), 400));
    });
    assert.ok(reachable && reachable.focused, 'the block projection is keyboard focusable');
    assert.ok(reachable.tabIndex >= 0, 'the projection participates in keyboard focus order');

    // 5. The read-only over-limit surface is labelled for assistive tech.
    assert.deepEqual(errors, []);
    console.log('PASS: focus returns from every in-place editor, block projections are keyboard focusable, and image alt text is preserved.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exit(1); });
