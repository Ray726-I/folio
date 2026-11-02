const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

// A rendered Mermaid diagram keeps its source behind an explicit disclosure.
// Opening that source is an editing action: it must not collapse again each
// time a keystroke changes the diagram, and focus plus caret must stay in the
// editable code surface while the diagram re-renders in the background.
(async () => {
  const bundle = buildEditorBundle();
  const source = '# Diagram\n\n```mermaid\ngraph TD;\nA-->B;\n```\n';
  const session = await openIsolatedEditor(source, bundle.outfile);
  const { page, errors } = session;
  const block = page.locator('.code-container[data-language="mermaid"]');
  const details = block.locator('details');
  const code = block.locator('.code-surface code');
  // ProseMirror focuses its root contenteditable; the caret still lives inside
  // the diagram source. Both must survive each edit.
  const focusInSource = () => page.evaluate(() => {
    const root = document.querySelector('.code-container[data-language="mermaid"] .code-surface');
    const active = document.activeElement;
    if (!root || !active || !active.closest?.('.ProseMirror')) return false;
    const node = window.getSelection()?.anchorNode;
    return Boolean(node && root.contains(node.nodeType === Node.TEXT_NODE ? node.parentNode : node));
  });
  try {
    await block.locator('svg').waitFor();
    assert.equal(await details.getAttribute('open'), null, 'a successfully rendered diagram starts with its source collapsed');

    await block.locator('summary').click();
    assert.notEqual(await details.getAttribute('open'), null, 'summary opens the editable source');
    await code.click();
    await page.keyboard.press('Control+End');

    // Type one character at a time so the assertion covers every keystroke, not
    // just the settled result after a whole string.
    for (const character of '\nC-->D;') {
      await page.keyboard.type(character);
      assert.notEqual(await details.getAttribute('open'), null,
        `source must stay open after typing ${JSON.stringify(character)}`);
      assert.equal(await focusInSource(), true,
        `focus must stay in the diagram source after typing ${JSON.stringify(character)}`);
    }

    await page.waitForFunction(() => current.content.includes('C-->D;'));
    await page.waitForFunction(() => document.querySelector('.code-container[data-language="mermaid"]')?.dataset.diagramState === 'rendered');
    await block.locator('svg').waitFor();
    assert.notEqual(await details.getAttribute('open'), null, 'source stays open after the diagram re-renders');
    assert.equal(await focusInSource(), true,
      'focus stays in the diagram source after the diagram re-renders');
    assert.equal(await block.locator('.code-surface code').innerText(), 'graph TD;\nA-->B;\nC-->D;',
      'the editable source shows the exact diagram text');

    // Undo is still the editor's history: one keystroke group goes away while
    // the source disclosure and focus stay usable.
    await page.keyboard.press('Control+Z');
    await page.waitForFunction(() => !current.content.includes('C-->D;'));
    await page.waitForFunction(() => document.querySelector('.code-container[data-language="mermaid"]')?.dataset.diagramState === 'rendered');
    assert.notEqual(await details.getAttribute('open'), null, 'source stays open after undo');
    assert.equal(await focusInSource(), true,
      'focus stays in the diagram source after undo');
    assert.ok((await page.evaluate(() => current.content)).includes('```mermaid\ngraph TD;\nA-->B;\n```'),
      'undo preserves the original fenced diagram source');

    // Lock still wins over an open source editor.
    await page.locator('#document-mode-button').click(); await page.locator('#lock-document').click();
    await code.click();
    await page.keyboard.type('Z');
    assert.equal(await page.evaluate(() => current.content), source, 'lock prevents diagram source edits');
    assert.notEqual(await details.getAttribute('open'), null, 'lock does not collapse the source editor');

    assert.deepEqual(errors, []);
    console.log('PASS: Mermaid diagram source stays open and focused across keystrokes, re-render, undo, and lock.');
  } catch (error) {
    console.error('PAGE ERRORS:', errors, 'URL:', page.url());
    throw error;
  } finally {
    await session.close();
    bundle.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
