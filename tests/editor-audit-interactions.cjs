const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  // Find refresh preserves a live counter and highlight while the document changes.
  {
    const session = await openEditor('Alpha beta. Gamma beta.\n', { width: 1000, height: 700 });
    try {
      const { page, errors } = session;
      await page.keyboard.press('Control+f');
      await page.waitForTimeout(150);
      await page.keyboard.type('beta');
      await page.waitForTimeout(350);
      assert.equal(await page.locator('#find-result').textContent(), '1 / 2', 'find starts with both hits');
      const point = await page.evaluate(() => { const p = document.querySelector('#preview p'); const r = p.getBoundingClientRect(); return { x: r.left + 8, y: r.top + r.height / 2 }; });
      await page.mouse.click(point.x, point.y);
      await page.keyboard.press('End');
      await page.keyboard.type(' beta');
      await page.waitForTimeout(550);
      assert.equal(await page.locator('#find-result').textContent(), '1 / 3', 'edits refresh the find counter without closing the bar');
      assert.deepEqual(errors, []);
    } finally { await session.close(); }
  }

  // Source-mode Find reveals a distant match and returns focus to the textarea.
  {
    const source = '# H\n\n' + 'filler line here.\n\n'.repeat(40) + 'NEEDLE here.\n\n' + 'tail line.\n\n'.repeat(10);
    const session = await openEditor(source, { width: 1000, height: 700 });
    try {
      const { page } = session;
      await page.evaluate(() => setDocumentMode('source'));
      await page.waitForTimeout(250);
      await page.keyboard.press('Control+f');
      await page.waitForTimeout(120);
      await page.keyboard.type('NEEDLE');
      await page.waitForTimeout(450);
      const found = await page.evaluate(() => {
        const input = document.querySelector('#document-source');
        return { start: input.selectionStart, end: input.selectionEnd, scrollTop: input.scrollTop, active: document.activeElement?.id };
      });
      assert.ok(found.end > found.start, 'the match is selected in the textarea');
      assert.ok(found.scrollTop > 0, 'a distant match is scrolled into view');
      assert.equal(found.active, 'find-input', 'the query field keeps focus');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'document-source', 'closing Find returns focus to source editing');
      await page.keyboard.type('ZZ');
      await page.waitForTimeout(250);
      assert.ok((await page.evaluate(() => current.content)).includes('ZZ'), 'typing after Escape reaches the source field');
    } finally { await session.close(); }
  }

  // The slash picker stays open with an empty state and restores results.
  {
    const session = await openEditor('Body.\n', { width: 1000, height: 700 });
    try {
      const { page, errors } = session;
      await page.locator('.editor-trailing-input').click();
      await page.keyboard.type('/');
      await page.locator('.folio-slash-menu').waitFor({ state: 'visible' });
      await page.keyboard.type('zzzz');
      await page.waitForTimeout(200);
      assert.equal(await page.locator('.folio-slash-menu').count(), 1, 'the picker stays open when nothing matches');
      assert.equal(await page.locator('.folio-slash-empty').textContent(), 'No blocks match');
      for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);
      assert.equal(await page.locator('.folio-slash-empty').count(), 0, 'the empty state clears');
      assert.ok(await page.locator('.folio-slash-row').count() > 0, 'results return after backspacing');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      assert.equal(await page.locator('.folio-slash-menu').count(), 0, 'Escape dismisses the picker');
      assert.deepEqual(errors, []);
    } finally { await session.close(); }
  }

  {
    const session = await openEditor('| A | B |\n| --- | --- |\n| one | two |\n');
    try {
      const { page, errors } = session;
      await page.locator('.ProseMirror td').last().click();
      await page.keyboard.press('End');
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { readText: async () => 'x|y' }
        });
      });
      await page.evaluate(() => editClipboard('paste'));
      assert.equal(await page.locator('.ProseMirror td').last().textContent(), 'twox|y');
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('.editor-trailing-input:focus').count(), 0);

      const caret = await page.evaluate(() => editor.getSelection().head);
      await page.evaluate(() => setDocumentMode('source'));
      const textarea = page.locator('#document-source');
      await textarea.waitFor();
      assert.equal(await textarea.evaluate(input => input.selectionStart), caret);
      await textarea.evaluate(input => input.setSelectionRange(2, 3, 'backward'));
      await page.evaluate(() => setDocumentMode('edit'));
      assert.deepEqual(await page.evaluate(() => editor.getSelection()), { anchor: 3, head: 2 });

      await page.evaluate(() => {
        setDocumentMode('source');
        openReplace();
        document.querySelector('#find-input').value = 'one';
        document.querySelector('#replace-input').value = 'changed';
        document.querySelector('#replace-all').click();
      });
      assert.match(await page.evaluate(() => current.content), /changed/);
      assert.deepEqual(errors, []);
    } finally { await session.close(); }
  }

  console.log('PASS: Find refreshes in place, source Find reveals and restores editing focus, and the slash picker has a recoverable empty state.');
})().catch(error => { console.error(error); process.exit(1); });
