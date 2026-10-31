const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const limited = '# Large document\n\nLIMIT\n\nCafé 日本語 😀 é\n\n' + 'Full source, never truncated. '.repeat(80) + '\n';
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
        if (command === 'save_document') { window.savedContent = args.content; return { path: '/tmp/doc.md', name: 'doc.md' }; }
        return null;
      } }, event: { listen: async () => () => {} }, webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) } };
    });
    await page.goto(pathToFileURL(path.resolve('ui/index.html')).href);
    await page.waitForFunction(() => typeof busy !== 'undefined' && !busy);
    await page.evaluate(text => { window.docContent = text; return requestOpen('/tmp/doc.md'); }, limited);
    await page.locator('#source-editor .cm-content').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#editor-notice').isVisible(), true);
    assert.equal(await page.evaluate(() => current.content), limited);
    await page.locator('#source-editor .cm-content').click();
    await page.keyboard.press('Control+End'); await page.keyboard.type('APPENDED');
    assert.equal(await page.evaluate(() => current.content), limited + 'APPENDED');
    await page.keyboard.press('Control+z'); assert.equal(await page.evaluate(() => current.content), limited);
    await page.keyboard.press('Control+Shift+z'); assert.equal(await page.evaluate(() => current.content), limited + 'APPENDED');
    await page.keyboard.press('Control+s'); await page.waitForFunction(() => !busy && savedContent !== null);
    assert.equal(await page.evaluate(() => savedContent), limited + 'APPENDED');
    await page.locator('#view-menu-button').click();
    await page.locator('#source-snapshot').click();
    assert.equal(await page.locator('#source-snapshot-text').inputValue(), limited + 'APPENDED');
    await page.locator('#source-snapshot-close').click();
    await page.locator('#lock-document').click();
    assert.equal(await page.locator('#source-editor .cm-content').getAttribute('contenteditable'), 'false');
    const before = await page.evaluate(() => current.content); await page.keyboard.type('NO'); await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => current.content), before);
    await page.locator('#lock-document').click();
    await page.evaluate(text => { changeContent(text); return renderPreview(); }, small);
    await page.locator('#preview .ProseMirror h1').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#editor-notice').isVisible(), false);
    assert.equal(await page.evaluate(() => current.content), small);
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => current.content), before);
    assert.equal(await page.locator('#source-editor').isVisible(), true, 'undo to a known-complex document keeps safe source editing');
    assert.deepEqual(errors, []);
    console.log('PASS: complexity fallback is complete, editable and explicit; Unicode, undo/redo, exact save/snapshot, Lock and rich recovery remain safe.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
