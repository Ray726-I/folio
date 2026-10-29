const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(os.tmpdir(), 'folio-preview-limits');
const docPath = path.join(root, 'doc.md');
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
let errors = [];

const NORMAL = '# Title\n\nA short paragraph for the normal preview.\n';
const UNICODE = 'Café naïve façade\n\n日本語のテキスト 🌍🚀\n\ne\u0301_combining_\n';
const BIG_LINES = `# Big document\n\nLIMIT:lines\n\n${UNICODE}\n\n${'A fairly long line of text to add weight. '.repeat(40)}\n`;
const BIG_NODES = `# Big document\n\nLIMIT:nodes\n\n${UNICODE}\n\n${'Another long line of text to add weight. '.repeat(40)}\n`;
const SMALL = '# Small again\n\nBack under the limit.\n';

async function installMock(page) {
  await page.addInitScript(({ docPath, platform }) => {
    window.nativeCalls = [];
    window.docContent = '';
    window.savedContent = null;
    const escape = v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    window.__TAURI__ = {
      core: { invoke: async (command, args = {}) => {
        window.nativeCalls.push({ command, args });
        switch (command) {
          case 'bootstrap': return { paths: [], platform, theme: null };
          case 'render_markdown': {
            const content = String(args.content || '');
            const limited = content.match(/LIMIT:([a-z-]+)/);
            if (limited) {
              const kind = limited[1];
              return { html: `<div class="preview-limit" data-preview-limit="${kind}" role="status"><p class="preview-limit-title">Preview unavailable</p><p class="preview-limit-message">This document is too complex to preview (${kind}).</p><p class="preview-limit-source-note">Your source is intact and editable in Edit mode.</p></div>`, blocks: [] };
            }
            return { html: `<h1 data-sourcepos="1:1-1:8">Title</h1><p data-sourcepos="3:1-3:20">${escape(content.slice(0, 60))}</p>`, blocks: [{ start: 0, end: content.length, sourcepos: '1:1-1:8', nodes: [] }] };
          }
          case 'path_is_directory': return false;
          case 'open_document': return { path: args.path, name: window.FolioPaths.basename(args.path), content: window.docContent, lineEnding: 'LF' };
          case 'save_document': window.savedContent = args.content; return { path: docPath, name: 'doc.md' };
          case 'document_changed': return false;
          case 'set_window_zoom': return null;
          case 'set_title': return null;
          case 'new_document': return null;
          default: return null;
        }
      } },
      event: { listen: async () => () => {} },
      webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }
    };
  }, { docPath, platform });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
    errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await installMock(page);
    await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
    await page.waitForFunction(() => typeof busy !== 'undefined' && !busy && document.documentElement.dataset.documentWidth);
    const contentOf = () => page.evaluate(() => current.content);

    // 1. Normal preview first.
    await page.evaluate((text) => { window.docContent = text; }, NORMAL);
    await page.evaluate((p) => requestOpenLocation(p), docPath);
    await page.waitForFunction(() => !busy && document.querySelector('#preview h1') !== null);
    assert.equal(await contentOf(), NORMAL, 'normal open keeps exact source');

    // 2. Normal -> over-limit: diagnostic replaces preview, source intact, no stale DOM.
    await page.evaluate((text) => { window.docContent = text; }, BIG_LINES);
    await page.evaluate((p) => requestOpenLocation(p), docPath);
    await page.waitForFunction(() => !busy && document.querySelector('#preview [data-preview-limit]') !== null);
    assert.equal(await page.locator('#preview .preview-limit').getAttribute('data-preview-limit'), 'lines', 'diagnostic carries the limit kind');
    assert.equal(await page.locator('#preview .preview-limit').getAttribute('role'), 'status', 'diagnostic is a live status');
    assert.ok(await page.locator('#preview .preview-limit-title').count(), 'diagnostic has a title');
    assert.ok(await page.locator('#preview .preview-limit-message').count(), 'diagnostic has a message');
    assert.ok(await page.locator('#preview .preview-limit-source-note').count(), 'diagnostic has a source note');
    assert.equal(await contentOf(), BIG_LINES, 'over-limit open keeps exact Unicode source');
    assert.equal(await page.locator('#preview h1').count(), 0, 'no stale previous-document preview remains');
    assert.equal(await page.evaluate(() => previewBlocks.length), 0, 'over-limit render reports no blocks');
    assert.equal(await page.locator('#outline-count').textContent(), 'No headings', 'outline resets on limit diagnostic');

    // 3. Read shows diagnostic; Edit provides a labeled full-source textarea.
    assert.equal(await page.locator('#source-fallback').isVisible().catch(() => false), false, 'read mode shows no source editor');
    await page.locator('#edit-mode').click();
    await page.waitForFunction(() => !busy && !document.getElementById('source-fallback').hidden);
    assert.match(await page.locator('#source-fallback label').textContent(), /source/i, 'fallback editor is labeled');
    assert.equal(await page.locator('#source-fallback textarea').inputValue(), BIG_LINES, 'fallback textarea holds the exact source');
    assert.equal(await page.locator('#preview .preview-limit').count(), 1, 'diagnostic stays visible in Edit mode');

    // 4. Editing the fallback updates the document normally.
    await page.locator('#source-fallback textarea').fill(`${BIG_LINES}\nAppended line.\n`);
    const edited = `${BIG_LINES}\nAppended line.\n`;
    assert.equal(await contentOf(), edited, 'fallback edit updates exact source');
    await page.waitForFunction(() => document.getElementById('dirty-dot').hidden === false);

    // 5. Undo/redo integrate with the fallback.
    await page.keyboard.press('Control+Z');
    await page.waitForFunction(() => !busy);
    assert.equal(await contentOf(), BIG_LINES, 'undo restores pre-edit source');
    assert.equal(await page.locator('#source-fallback textarea').inputValue(), BIG_LINES, 'undo restores the textarea');
    await page.keyboard.press('Control+Shift+Z');
    await page.waitForFunction(() => !busy);
    assert.equal(await contentOf(), edited, 'redo restores the edit');

    // 6. Saving persists the exact source.
    await page.keyboard.press('Control+S');
    await page.waitForFunction(() => !busy);
    assert.equal(await page.evaluate(() => window.savedContent), edited, 'save persists the exact edited source');
    assert.equal(await contentOf(), edited, 'source intact after save');

    // 7. A different limit kind is handled generically with source intact.
    await page.evaluate((text) => { window.docContent = text; }, BIG_NODES);
    await page.evaluate((p) => requestOpenLocation(p), docPath);
    await page.waitForFunction(() => !busy && document.querySelector('#preview [data-preview-limit="nodes"]') !== null);
    assert.equal(await contentOf(), BIG_NODES, 'second limit kind keeps exact source');

    // 8. Reducing complexity recovers the normal preview with no stale diagnostic.
    await page.locator('#edit-mode').click();
    await page.waitForFunction(() => !busy && !document.getElementById('source-fallback').hidden);
    await page.locator('#source-fallback textarea').fill(SMALL);
    await page.locator('#read-mode').click();
    await page.waitForFunction(() => !busy && document.querySelector('#preview h1') !== null);
    assert.equal(await page.locator('#preview [data-preview-limit]').count(), 0, 'no stale diagnostic after recovery');
    assert.equal(await page.locator('#source-fallback').isVisible().catch(() => false), false, 'fallback hidden after recovery');
    assert.equal(await contentOf(), SMALL, 'recovered source is exact');
    assert.ok(await page.evaluate(() => previewBlocks.length) > 0, 'recovered preview restores blocks');

    // 9. Mode switches retain the exact source.
    await page.locator('#edit-mode').click();
    await page.waitForFunction(() => !busy);
    await page.locator('#read-mode').click();
    await page.waitForFunction(() => !busy);
    assert.equal(await contentOf(), SMALL, 'mode switches retain exact source');

    // 10. Caret clicks in the fallback commit nothing; Tab/Shift+Tab behave.
    // (Driven via changeContent+renderPreview: identical fallback states to a
    // fresh open, without another full open cycle.)
    await page.evaluate((text) => { changeContent(text); }, BIG_LINES);
    await page.evaluate(() => renderPreview());
    await page.waitForFunction(() => !busy && document.querySelector('#preview [data-preview-limit]') !== null);
    assert.equal(await contentOf(), BIG_LINES, 'limited state entered with exact source');
    await page.locator('#edit-mode').click();
    await page.waitForFunction(() => !busy && !document.getElementById('source-fallback').hidden);
    const area = page.locator('#source-textarea');
    await area.waitFor();
    // Plain Tab inserts spaces and stays put.
    await page.keyboard.press('Tab');
    assert.ok((await contentOf()).endsWith('  '), 'plain Tab inserts spaces in the fallback');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'source-textarea', 'Tab keeps focus');
    await page.keyboard.press('Control+Z');
    await page.waitForFunction(() => !busy);
    assert.equal(await contentOf(), BIG_LINES, 'tab indent undoes cleanly');
    // Shift+Tab leaves the textarea.
    await page.keyboard.press('Shift+Tab');
    assert.notEqual(await page.evaluate(() => document.activeElement.id), 'source-textarea', 'Shift+Tab leaves the fallback');
    // Real pointer caret clicks while dirty: no redundant render, grouping intact.
    await area.click({ position: { x: 12, y: 12 } });
    await page.keyboard.type('X');
    assert.ok((await contentOf()).includes('X'), 'typing after refocus edits the source');
    await page.evaluate(() => { window.renderCountBefore = window.nativeCalls.filter(c => c.command === 'render_markdown').length; });
    await area.click({ position: { x: 12, y: 60 } });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'source-textarea', 'caret click keeps focus');
    const caret = await page.evaluate(() => document.getElementById('source-textarea').selectionStart);
    assert.ok(caret < (await contentOf()).length, 'caret click moves the caret');
    await page.keyboard.type('Y');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.nativeCalls.filter(c => c.command === 'render_markdown').length), await page.evaluate(() => window.renderCountBefore), 'caret clicks trigger no re-render');
    await page.keyboard.press('Control+Z');
    await page.waitForFunction(() => !busy);
    assert.equal(await contentOf(), BIG_LINES, 'one undo removes both keystrokes across the caret click');
    assert.equal(await page.locator('#source-textarea').inputValue(), BIG_LINES, 'textarea matches after grouped undo');
    // Mode switch still commits.
    await page.keyboard.type('MID');
    assert.ok((await contentOf()).includes('MID'), 'typing continues after grouped undo');
    await page.locator('#read-mode').click();
    await page.waitForFunction(() => !busy && document.getElementById('source-fallback').hidden);
    assert.ok((await contentOf()).includes('MID'), 'mode switch commits fallback edits');
    assert.equal(await page.locator('#preview [data-preview-limit]').count(), 1, 'diagnostic shown after commit');

    assert.deepEqual(errors, []);
    await browser.close();
    console.log('PASS: over-limit diagnostic replaces stale preview, source stays exact Unicode, fallback edit/undo/redo/save integrate, caret clicks commit nothing, Tab indents while Shift+Tab leaves, recovery restores normal preview.');
  } catch (e) { throw e; }
})().catch(e => { console.error(e); console.error('PAGE ERRORS:', errors); process.exit(1); });
