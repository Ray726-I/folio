const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

async function openEditor(source, viewport = { width: 1180, height: 900 }) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('https://**/*', route => { requests.push(route.request().url()); return route.abort(); });
  const scratch = fs.mkdtempSync(path.join(fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir(), 'folio-editor-test-'));
  const fixture = process.env.FOLIO_FIXTURE || path.resolve('target/debug/examples', process.platform === 'win32' ? 'editor-fixture.exe' : 'editor-fixture');
  await page.exposeFunction('realRender', args => {
    const input = path.join(scratch, 'input.md'); fs.writeFileSync(input, args.content);
    return JSON.parse(execFileSync(fixture, [input, ...(args.remoteImages ? ['--allow-remote'] : [])], { encoding: 'utf8', maxBuffer: 80 * 1024 * 1024 }));
  });
  await page.addInitScript(source => {
    window.documentSource = source; window.savedContent = null; window.calls = []; window.listeners = {};
    window.__TAURI__ = { core: { invoke: async (command, args = {}) => {
      window.calls.push({ command, args });
      if (command === 'bootstrap') return { paths: ['/tmp/test.md'], platform: 'linux', theme: null };
      if (command === 'open_document') return { path: args.path, name: 'test.md', content: window.documentSource, lineEnding: 'LF' };
      if (command === 'render_markdown') return window.realRender(args);
      if (command === 'save_document') { window.savedContent = args.content; return { path: '/tmp/test.md', name: 'test.md' }; }
      if (command === 'mermaid_render_request') {
        queueMicrotask(() => { for (const callback of window.listeners['mermaid-render-result'] || []) callback({ payload: { id: args.request.id, ok: true, sanitized: true, svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>' } }); });
      }
      return null;
    } }, event: { listen: async (name, callback) => { (window.listeners[name] ??= []).push(callback); return () => {}; } }, webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) } };
  }, source);
  await page.goto(pathToFileURL(path.resolve('ui/index.html')).href);
  await page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
  return { browser, page, errors, requests, async close() { await browser.close(); fs.rmSync(scratch, { recursive: true, force: true }); } };
}
module.exports = { openEditor };
