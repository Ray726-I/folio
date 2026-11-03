const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

(async () => {
  const bundle = buildEditorBundle();
  const source = '# Parent\n\n## Child\n\nProse here.\n\n# Repeat\n\n# Repeat\n';
  const session = await openIsolatedEditor(source, bundle.outfile);
  const { page } = session;
  try {
    await page.evaluate(() => { if (document.getElementById('outline').hidden) setOutline(true); });
    await page.waitForFunction(() => outlineEntries.length === 4);
    await page.evaluate(() => {
      window.FolioEditor.headings = () => { throw new Error('ordinary outline refresh must reuse parsed metadata'); };
      window.originalOutlineButtons = outlineEntries.map(entry => entry.button);
      window.originalOutlineKeys = outlineEntries.map(entry => entry.key);
      toggleOutlineEntry(outlineEntries[0], false);
      editor.selectRange(current.content.indexOf('Prose') + 2);
    });
    await page.keyboard.type('added');
    await page.evaluate(() => { outlineEntries[0].button.focus(); refreshEditorOutline(); });
    assert.equal(await page.evaluate(() => outlineEntries.every((entry, index) => entry.button === originalOutlineButtons[index])), true,
      'prose edits retain outline rows instead of rebuilding');
    assert.equal(await page.evaluate(() => document.activeElement === originalOutlineButtons[0]), true, 'refresh preserves focused row');
    assert.equal(await page.evaluate(() => outlineEntries[1].row.hidden), true, 'collapse survives offset changes');
    assert.equal(await page.evaluate(() => outlineEntries[2].offset), (await page.evaluate(() => current.content)).indexOf('# Repeat'), 'offset shifts reach existing entries');
    await page.evaluate(() => { editor.selectRange(current.content.indexOf('Parent') + 6); });
    await page.keyboard.insertText('Renamed');
    await page.evaluate(() => refreshEditorOutline());
    assert.equal(await page.evaluate(() => outlineEntries[0].button === originalOutlineButtons[0]), true, 'renamed headings retain their row');
    assert.equal(await page.evaluate(() => outlineEntries[0].text), 'ParentRenamed');
    assert.equal(await page.evaluate(() => outlineEntries[1].row.hidden), true, 'rename retains collapsed descendants');
    await page.evaluate(() => { editor.selectRange(current.content.length); });
    await page.keyboard.insertText('\n\n# Inserted\n');
    await page.evaluate(() => refreshEditorOutline());
    assert.equal(await page.evaluate(() => outlineEntries.slice(0, 4).every((entry, index) => entry.button === originalOutlineButtons[index])), true,
      'inserting a heading preserves preceding duplicate identities');
    assert.equal(await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'tabIndex');
      let writes = 0;
      for (const entry of outlineEntries) Object.defineProperty(entry.button, 'tabIndex', {
        configurable: true, get() { return descriptor.get.call(this); },
        set(value) { writes++; descriptor.set.call(this, value); }
      });
      setActiveOutline(0); writes = 0; setActiveOutline(3);
      return writes;
    }), 2, 'active section changes update only the old and new tab stop');
    await page.evaluate(() => {
      outlineEntries[2].button.focus();
      editor.replaceContent(current.content.replace('# Repeat\n\n', ''));
      refreshEditorOutline();
    });
    assert.equal(await page.evaluate(() => document.activeElement === outlineEntries[2].button), true,
      'deleting the focused heading moves focus to the nearest surviving row');
    assert.deepEqual(session.errors, []);
    console.log('PASS: outline row reconciliation preserves focus, collapse and source offsets across edits');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
