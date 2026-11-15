'use strict';
const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const source = '# Large document\n\nEditable opening paragraph.\n\n' + 'A paragraph with **bold** and a [link](https://example.com).\n\n'.repeat(1800);
  const session = await openEditor(source);
  try {
    const { page, errors } = session;
    await page.addInitScript(() => {
      let delivery = false;
      window.__selectionReadsDuringMutation = 0;
      const Observer = window.MutationObserver;
      window.MutationObserver = class extends Observer {
        constructor(callback) { super((records, observer) => { const previous = delivery; delivery = true; try { callback(records, observer); } finally { delivery = previous; } }); }
      };
      const selection = window.getSelection.bind(window);
      window.getSelection = () => {
        if (delivery && new Error().stack.includes('affordances.js')) window.__selectionReadsDuringMutation++;
        return selection();
      };
    });
    await page.reload();
    await page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
    await page.evaluate(() => { setDocumentMode('edit'); editor.selectRange(current.content.indexOf('opening') + 3, current.content.indexOf('opening') + 3); });
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      __selectionReadsDuringMutation = 0;
      window.__selectionPaintScans = 0;
      const query = Element.prototype.querySelectorAll;
      Element.prototype.querySelectorAll = function(selector) {
        if (this.matches('.ProseMirror') && ['.mermaid-host, .math-block, .math-inline, .image-widget', '.code-selection-painted', '.code-container'].includes(selector)) __selectionPaintScans++;
        return query.call(this, selector);
      };
    });
    await page.keyboard.type('xyz');
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => __selectionReadsDuringMutation), 0, 'typing affordances do not force selection/layout reads during mutation delivery');
    assert.equal(await page.evaluate(() => __selectionPaintScans), 0, 'collapsed typing does not scan document widgets to clear an empty highlight');
    assert.ok(await page.evaluate(() => current.content.includes('opexyzning')), 'typing still publishes the exact source');
    assert.deepEqual(errors, []);
    console.log('PASS: large-document typing defers selection-dependent affordances until the animation frame.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
