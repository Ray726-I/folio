const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const source = '| A | B |\n| --- | --- |\n| one | two |\n';
  const session = await openEditor(source);
  try {
    const { page } = session;
    await page.evaluate(() => {
      const offset = current.content.indexOf('one');
      editor.selectRange(offset, offset, true);
      editor.openBlockMenu();
    });
    const table = page.locator('#preview table');
    await table.hover();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.tableWrapper > .diagram-expand').evaluate(node => getComputedStyle(node).opacity), '1', 'hovering the table reveals expand');
    // A block picker must refuse nested table content rather than prefix a row.
    assert.equal(await page.locator('.folio-slash-menu').count(), 0, 'block picker is unavailable within a table cell');
    assert.equal(await page.evaluate(() => current.content), source);
    await page.evaluate(() => {
      const original = window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = async (command, args) => {
        if (command === 'resolve_document_link') return '/other.md';
        if (command === 'open_document') return { documentId: 'other', path: '/other.md', name: 'other.md', content: '# Other\n\nOpening text.\n\n## Section\n\nTarget text.\n', writable: true };
        return original(command, args);
      };
      const anchor = document.createElement('a'); anchor.href = 'other.md#section';
      followPreviewLink(anchor);
    });
    await page.waitForFunction(() => current.path === '/other.md' && !busy);
    assert.equal(await page.evaluate(() => editor.getSelection().head), await page.evaluate(() => current.content.indexOf('## Section')), 'cross-file link selects its heading');
    await page.keyboard.press('Control+Shift+P');
    const search = page.getByRole('combobox', { name: 'Search commands' });
    const listId = await search.getAttribute('aria-controls');
    assert.equal(await page.locator(`#${listId}`).getAttribute('role'), 'listbox', 'command combobox controls its owning listbox');
    assert.ok(await page.locator(`#${listId} [role=option]`).count() > 0);
    await page.keyboard.press('Escape');
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
  const graphemes = await openEditor('```text\ne\u0301 👩‍💻 🇮🇳\n```\n');
  try {
    const { page } = graphemes;
    const { openMarkdown } = require('./editor-test-actions.cjs');
    await openMarkdown(page.locator('.code-container'));
    for (const text of ['e\u0301', '👩‍💻', '🇮🇳']) {
      const before = await page.evaluate(() => current.content);
      await page.evaluate(text => { const offset = current.content.indexOf(text) + text.length; editor.selectRange(offset, offset, true); }, text);
      await page.keyboard.press('Backspace');
      assert.equal(await page.evaluate(() => current.content), before.replace(text, ''), 'source-card Backspace removes a complete grapheme');
    }
    await page.keyboard.press('Escape');
    await page.evaluate(() => editor.replaceContent('```text\ne\u0301\n```\n'));
    await openMarkdown(page.locator('.code-container'));
    await page.evaluate(() => { const offset = current.content.indexOf('e\u0301'); editor.selectRange(offset, offset, true); });
    await page.keyboard.press('Delete');
    assert.equal(await page.evaluate(() => current.content), '```text\n\n```\n', 'source-card Delete removes a complete grapheme');
  } finally { await graphemes.close(); }
  for (const language of ['mermaid', 'Mermaid', 'MERMAID']) {
    const source = '```' + language + '\ngraph TD; A-->B;\n```\n';
    const diagram = await openEditor(source);
    try {
      const { page } = diagram;
      await page.waitForFunction(() => document.querySelector('#preview .mermaid-host svg'), null, { timeout: 3000 });
      await page.evaluate(() => setDocumentMode('reading'));
      await page.waitForFunction(() => document.querySelector('#preview .mermaid-host svg'), null, { timeout: 3000 });
      await page.evaluate(() => showReadingCompanion());
      await page.waitForFunction(() => document.querySelector('#companion-preview .mermaid-host svg'), null, { timeout: 3000 });
      assert.equal(await page.evaluate(() => current.content), source, 'diagram rendering preserves fence spelling');
      assert.deepEqual(diagram.errors, []);
    } finally { await diagram.close(); }
  }
  console.log('PASS: review regressions');
})().catch(error => { console.error(error); process.exitCode = 1; });
