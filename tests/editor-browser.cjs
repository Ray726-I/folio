const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

async function openEditor(source, viewport = { width: 1180, height: 900 }, options = {}) {
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
     // Path-keyed deferred open gate. Default opens stay immediate; a test opts
     // in with holdOpen() to pause a native open after the app has requested it.
     // A gate can also be rejected deterministically to simulate native failure.
     window.openGates = new Map();
     window.holdOpen = (path, content, failure = null) => {
      if (window.openGates.has(path)) throw new Error(`An open gate already exists for ${path}`);
      let release, reject;
      const promise = new Promise((resolve, refuse) => { release = resolve; reject = refuse; });
      window.openGates.set(path, { path, content, failure, promise, release, reject, pending: false, name: path.split(/[\\/]/).pop() || 'test.md' });
    };
    window.releaseOpen = path => {
      const gate = window.openGates.get(path);
      if (!gate || !gate.pending) return false;
      window.openGates.delete(path);
      gate.release();
      return true;
    };
    window.rejectOpen = (path, message = null) => {
      const gate = window.openGates.get(path);
      if (!gate || !gate.pending) return false;
      window.openGates.delete(path);
      gate.reject(new Error(message || gate.failure || 'SIMULATED_OPEN_FAILURE'));
      return true;
    };
    window.releaseAllOpens = () => {
      for (const gate of window.openGates.values()) { window.openGates.delete(gate.path); gate.release(); }
    };
    window.openGateState = path => {
      const gate = window.openGates.get(path);
      return gate ? { pending: gate.pending } : null;
    };
    // Same deferred-gate pattern for folder scans. A held folder returns the
    // supplied listing (or a deterministic failure) when released.
    window.folderGates = new Map();
    window.holdFolder = (path, listing, failure = null) => {
      if (window.folderGates.has(path)) throw new Error(`A folder gate already exists for ${path}`);
      let release, reject;
      const promise = new Promise((resolve, refuse) => { release = resolve; reject = refuse; });
      window.folderGates.set(path, { path, listing, failure, promise, release, reject, pending: false });
    };
    window.releaseFolder = path => {
      const gate = window.folderGates.get(path);
      if (!gate || !gate.pending) return false;
      window.folderGates.delete(path);
      gate.release();
      return true;
    };
    window.rejectFolder = (path, message = null) => {
      const gate = window.folderGates.get(path);
      if (!gate || !gate.pending) return false;
      window.folderGates.delete(path);
      gate.reject(new Error(message || gate.failure || 'SIMULATED_FOLDER_FAILURE'));
      return true;
    };
    window.releaseAllFolders = () => {
      for (const gate of window.folderGates.values()) { window.folderGates.delete(gate.path); gate.release(); }
    };
    window.folderGateState = path => {
      const gate = window.folderGates.get(path);
      return gate ? { pending: gate.pending } : null;
    };
    // Deferred gate for the native new-document reset used by Home and New.
    // The command itself carries no arguments, so gates form a FIFO queue and
    // each call consumes the next one. Default calls stay immediate.
    window.newDocumentGates = [];
    window.holdNewDocument = (failure = null) => {
      let release, reject;
      const promise = new Promise((resolve, refuse) => { release = resolve; reject = refuse; });
      window.newDocumentGates.push({ failure, promise, release, reject, pending: false });
    };
    const pendingNewDocument = () => window.newDocumentGates.find(gate => gate.pending);
    window.releaseNewDocument = () => {
      const gate = pendingNewDocument();
      if (!gate) return false;
      window.newDocumentGates = window.newDocumentGates.filter(item => item !== gate);
      gate.release();
      return true;
    };
    window.rejectNewDocument = (message = null) => {
      const gate = pendingNewDocument();
      if (!gate) return false;
      window.newDocumentGates = window.newDocumentGates.filter(item => item !== gate);
      gate.reject(new Error(message || gate.failure || 'SIMULATED_NEW_DOCUMENT_FAILURE'));
      return true;
    };
    window.releaseAllNewDocuments = () => {
      for (const gate of window.newDocumentGates) gate.release();
      window.newDocumentGates = [];
    };
    window.newDocumentGateState = () => {
      const gate = pendingNewDocument();
      return gate ? { pending: true } : null;
    };
    window.__TAURI__ = { core: { invoke: async (command, args = {}) => {
      window.calls.push({ command, args });
      if (command === 'bootstrap') return { paths: ['/tmp/test.md'], platform: 'linux', theme: null };
      if (command === 'open_document') {
        const gate = window.openGates.get(args.path);
        if (gate) {
          gate.pending = true;
          await gate.promise;
          return { path: args.path, name: gate.name, content: gate.content, lineEnding: 'LF' };
        }
        return { path: args.path, name: 'test.md', content: window.documentSource, lineEnding: 'LF' };
      }
      if (command === 'open_folder') {
        const gate = window.folderGates.get(args.path);
        if (gate) {
          gate.pending = true;
          await gate.promise;
          return { ...gate.listing, path: args.path };
        }
        return { path: args.path, name: args.path.split(/[\\/]/).pop() || 'folder', entries: [], truncated: false, skipped: 0 };
      }
      if (command === 'new_document') {
        const gate = window.newDocumentGates.find(item => !item.pending);
        if (gate) { gate.pending = true; await gate.promise; }
        return null;
      }
      if (command === 'render_markdown') return window.realRender(args);
      if (command === 'highlight_code') {
        const fence = '```' + (args.language || '') + '\n' + args.code + '\n```\n';
        const result = await window.realRender({ content: fence, remoteImages: false });
        const html = typeof result === 'string' ? result : result?.html || '';
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const node = parsed.querySelector('pre code');
        return { html: node ? node.innerHTML : '' };
      }
      if (command === 'save_document') { window.savedContent = args.content; return { path: '/tmp/test.md', name: 'test.md' }; }
      if (command === 'mermaid_render_request') {
        queueMicrotask(() => { for (const callback of window.listeners['mermaid-render-result'] || []) callback({ payload: { id: args.request.id, ok: true, sanitized: true, svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>' } }); });
      }
      return null;
    } }, event: { listen: async (name, callback) => { (window.listeners[name] ??= []).push(callback); return () => {}; } }, webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) } };
  }, source);
  await page.goto(pathToFileURL(path.resolve('ui/index.html')).href);
  await page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
  // Editor tests exercise editing; application tests can request Reading mode.
  if (options.reading) await page.evaluate(() => setDocumentMode('reading'));
  if (!options.reading && !options.defaultMode) await page.evaluate(() => { if (typeof setDocumentMode === 'function') setDocumentMode('edit'); });
  return {
    browser, page, errors, requests,
    async holdOpen(path, content, failure = null) { await page.evaluate(({ path, content, failure }) => holdOpen(path, content, failure), { path, content, failure }); },
    async releaseOpen(path) { return page.evaluate(path => releaseOpen(path), path); },
    async rejectOpen(path, message = null) { return page.evaluate(({ path, message }) => rejectOpen(path, message), { path, message }); },
    async holdFolder(path, listing, failure = null) { await page.evaluate(({ path, listing, failure }) => holdFolder(path, listing, failure), { path, listing, failure }); },
    async releaseFolder(path) { return page.evaluate(path => releaseFolder(path), path); },
    async rejectFolder(path, message = null) { return page.evaluate(({ path, message }) => rejectFolder(path, message), { path, message }); },
    async holdNewDocument(failure = null) { await page.evaluate(failure => holdNewDocument(failure), failure); },
    async releaseNewDocument() { return page.evaluate(() => releaseNewDocument()); },
    async rejectNewDocument(message = null) { return page.evaluate(message => rejectNewDocument(message), message); },
    async close() {
      try {
        await page.evaluate(() => { releaseAllOpens(); releaseAllFolders(); releaseAllNewDocuments(); });
        await page.waitForFunction(() => !busy, undefined, { timeout: 5000 });
      } catch {}
      await browser.close();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  };
}
module.exports = { openEditor };
