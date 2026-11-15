const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

const body = Array.from({ length: 12 }, (_, i) => `Body paragraph ${i + 1}.`).join('\n\n');
const source = `# Handbook\n\n## 8.5 YouTube embed\n\nParagraph to promote.\n\n${body}\n\n## 9. HTML Elements Inside Markdown\n\n${body}\n\n### 9.1 Inline elements\n\n${body}\n\n## 10. Callouts and Admonitions\n\n${body}\n`;

(async () => {
  const bundle = buildEditorBundle();
  const session = await openIsolatedEditor(source, bundle.outfile);
  const { page } = session;
  const state = () => page.evaluate(() => ({
    active: outlineActiveIndex,
    entries: outlineEntries.map(entry => ({
      text: entry.text, hidden: entry.row.hidden,
      button: entry.button.classList.contains('active'),
      row: entry.row.classList.contains('is-active'),
      current: entry.button.getAttribute('aria-current'),
      ancestorButton: entry.button.classList.contains('active-ancestor'),
      ancestorRow: entry.row.classList.contains('is-active-ancestor'),
    })),
  }));
  const assertSingle = (value, message) => {
    assert.equal(value.entries.filter(entry => entry.button).length, 1, `${message}: one active button`);
    assert.equal(value.entries.filter(entry => entry.row).length, 1, `${message}: one active row`);
    assert.equal(value.entries.filter(entry => entry.current === 'location').length, 1, `${message}: one current location`);
    value.entries.forEach((entry, index) => {
      assert.equal(entry.button, index === value.active, `${message}: button ${index} matches the active index`);
      assert.equal(entry.row, entry.button, `${message}: row ${index} matches its button`);
      assert.equal(entry.ancestorRow, entry.ancestorButton, `${message}: ancestor state stays unified`);
      if (entry.ancestorRow) assert.equal(entry.hidden, false, `${message}: context ancestor is visible`);
    });
  };
  try {
    await page.waitForFunction(() => outlineEntries.length === 5);
    await page.evaluate(() => {
      suppressOutlineFollow(3600000);
      setActiveOutline(4, { instant: true });
      window.retainedActiveOutlineEntry = outlineEntries[4];
      editor.selectRange(current.content.indexOf('Paragraph to promote.'));
      editor.command('heading', { level: 3 });
      refreshEditorOutline();
    });
    await page.waitForFunction(() => outlineEntries.length === 6);
    assert.equal(await page.evaluate(() => outlineEntries[outlineActiveIndex] === retainedActiveOutlineEntry), true,
      'adding a heading retains the current section identity');
    assertSingle(await state(), 'reconciliation preserves the current full row');
    await page.evaluate(() => setActiveOutline(outlineActiveIndex, { instant: true }));
    assertSingle(await state(), 'reasserting the current section');

    const editedSource = await page.evaluate(() => current.content);
    // Rapid reversals exercise the real scroll spy while queued scroll frames
    // also run. The reading position must never leave a previous peer current.
    for (const text of ['9. HTML Elements Inside Markdown', '10. Callouts and Admonitions', '8.5 YouTube embed', '9.1 Inline elements', '10. Callouts and Admonitions']) {
      await page.evaluate(text => {
        outlineSuppressUntil = 0;
        const entry = outlineEntries.find(entry => entry.text === text);
        const reader = document.getElementById('reader-scroll');
        reader.scrollTop += entry.element.getBoundingClientRect().top - reader.getBoundingClientRect().top - OUTLINE_SPY_OFFSET + 1;
        updateActiveOutline({ instant: true });
      }, text);
      const value = await state();
      assertSingle(value, `following ${text}`);
      assert.equal(value.entries[value.active].text, text, 'the scroll spy selects the section on its line');
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assertSingle(await state(), 'after queued scroll frames');

    await page.evaluate(() => {
      suppressOutlineFollow(3600000);
      const child = outlineEntries.findIndex(entry => entry.text === '9.1 Inline elements');
      setActiveOutline(child, { instant: true });
      toggleOutlineEntry(outlineEntries.find(entry => entry.text === '9. HTML Elements Inside Markdown'), false);
    });
    let value = await state();
    assertSingle(value, 'collapsed active child');
    assert.equal(value.entries[value.active].hidden, true, 'the true current section is hidden by collapse');
    assert.deepEqual(value.entries.filter(entry => entry.ancestorRow).map(entry => entry.text), ['9. HTML Elements Inside Markdown'],
      'only the visible ancestor represents a hidden current section');
    await page.evaluate(() => {
      // A structural edit while the active section is collapsed also rebuilds
      // reused rows; both true-current and ancestor state must survive.
      editor.selectRange(current.content.indexOf('Paragraph to promote.'));
      editor.command('heading', { level: 4 });
      refreshEditorOutline();
    });
    assertSingle(await state(), 'reconciliation under a collapsed ancestor');
    await page.evaluate(() => toggleOutlineEntry(outlineEntries.find(entry => entry.text === '9. HTML Elements Inside Markdown'), true));
    value = await state();
    assertSingle(value, 'expanded active child');
    assert.equal(value.entries.some(entry => entry.ancestorRow), false, 'expanding clears ancestor context');
    // Only the deliberate heading-level change above may alter source.
    assert.equal(await page.evaluate(() => current.content), editedSource.replace('### Paragraph to promote.', '#### Paragraph to promote.'));
    assert.deepEqual(session.errors, []);
    console.log('PASS: one current outline row survives reconciliation, rapid scroll reversals and collapsed ancestors');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
