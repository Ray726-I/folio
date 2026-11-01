const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// An over-limit document opens as complete, read-only Markdown: nothing is
// truncated, Save still writes the exact bytes, and a document back under the
// limit restores the formattable editor.
const limited = '# Large document\n\nLIMIT\n\nCafé 日本語 😀 é\n\n' + 'Full source, never truncated. '.repeat(80) + '\n';
const small = '# Small again\n\nBack under the limit.\n';
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
      window.docContent = ''; window.savedContent = null;
      window.__TAURI__ = { core: { invoke: async (command, args = {}) => {
        if (command === 'bootstrap') return { paths: [], platform: 'linux', theme: null };
        if (command === 'open_document') return { path: '/tmp/doc.md', name: 'doc.md', content: window.docContent, lineEnding: 'LF' };
        if (command === 'preview_check') return { limited: args.content.includes('LIMIT') ? 'nodes' : null };
        if (command === 'render_markdown') return { html: '<p>Safe render</p>' };
        if (command === 'highlight_code') return { html: '' };
        if (command === 'save_document') { window.savedContent = args.content; return { path: '/tmp/doc.md', name: 'doc.md' }; }
        return null;
      } }, event: { listen: async () => () => {} }, webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) } };
    });
    await page.goto(pathToFileURL(path.resolve('ui/index.html')).href);
    await page.waitForFunction(() => typeof busy !== 'undefined' && !busy);
    await page.evaluate(text => { window.docContent = text; return requestOpen('/tmp/doc.md'); }, limited);
    const shown = page.locator('#preview pre.document-over-limit');
    await shown.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#editor-notice').isVisible(), true, 'the read-only notice is explicit');
    assert.equal(await page.evaluate(() => current.content), limited, 'the canonical buffer is complete');
    assert.equal(await shown.innerText(), limited, 'the complete Markdown is shown, not truncated');
    // Read-only: typing cannot change the document.
    await shown.click();
    await page.keyboard.type('NO');
    assert.equal(await page.evaluate(() => current.content), limited, 'the over-limit view is read-only');
    // Save still writes the exact source.
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => savedContent !== null);
    assert.equal(await page.evaluate(() => savedContent), limited, 'save writes the exact bytes');
    // The snapshot remains copyable without a mounted editor.
    await page.locator('#view-menu-button').click();
    await page.locator('#source-snapshot').click();
    assert.equal(await page.locator('#source-snapshot-text').inputValue(), limited, 'the snapshot shows the exact buffer');
    await page.locator('#source-snapshot-close').click();
    // A document the native probe accepts can still be too large for the JS
    // editor; the single-editor build must keep refusing to parse it.
    const huge = '# Huge\n\n' + 'x'.repeat(2 * 1024 * 1024 + 16);
    await page.evaluate(text => { window.docContent = text; return requestOpen('/tmp/huge.md'); }, huge);
    await shown.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#editor-notice').isVisible(), true, 'an oversized document still shows the read-only notice');
    assert.equal(await page.evaluate(() => document.querySelector('#preview pre.document-over-limit').textContent.length > 2 * 1024 * 1024), true, 'the oversized source is shown in full');

    // Dropping back under the limit restores the editor.
    await page.evaluate(text => { changeContent(text); return renderPreview(); }, small);
    await page.locator('#preview .ProseMirror h1').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#editor-notice').isVisible(), false, 'the notice clears for a normal document');
    assert.equal(await page.evaluate(() => current.content), small);
    assert.deepEqual(errors, []);
    console.log('PASS: an over-limit document shows complete read-only Markdown, saves exact bytes, keeps the snapshot copyable, and restores the editor under the limit.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
