const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Main-page Mermaid bridge contract (native side lives in src/renderer.rs):
// invoke mermaid_render_request({ request: { id, source, theme: { variables } } }),
// listen mermaid-render-result BEFORE invoking, invoke mermaid_render_cancel({ id })
// for stale generations. Main inserts only ok && sanitized SVG; everything else
// is text plus the diagram source. The main page must never load Mermaid itself.
const fixtureRoot = path.join(os.tmpdir(), 'folio-mermaid-bridge');
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
let errors = [];

const docs = [
  { name: 'ok.md', content: '# Ok diagram\n\n```mermaid\ngraph TD;\nA-->B;\n```\n', source: 'graph TD;\nA-->B;' },
  { name: 'gate.md', content: '# Gated diagram\n\n```mermaid\ngraph TD;\nG-->H;\n```\n', source: 'graph TD;\nG-->H;' },
  { name: 'err.md', content: '# Broken diagram\n\n```mermaid\nnot a diagram\n```\n', source: 'not a diagram' },
  { name: 'offline.md', content: '# Offline diagram\n\n```mermaid\ngraph TD;\nO-->P;\n```\n', source: 'graph TD;\nO-->P;' },
  { name: 'timeout.md', content: '# Slow diagram\n\n```mermaid\ngraph TD;\nT-->O;\n```\n', source: 'graph TD;\nT-->O;' },
  { name: 'plain.md', content: '# Plain document\n\nNo diagrams here.\n', source: null },
  { name: 'big.md', content: '# Big diagram\n\n```mermaid\n' + 'z'.repeat(300 * 1024) + '\n```\n', source: null, big: true },
  { name: 'mathmix.md', content: '# Math mix\n\nInline $x^2$ here.\n\n```mermaid\ngraph TD;\nM-->N;\n```\n', source: 'graph TD;\nM-->N;', math: 'x^2' },
  { name: 'nomath.md', content: '# No math here\n\nNOMATH-DIAGRAM\n\n```mermaid\ngraph TD;\nM-->N;\n```\n', source: 'graph TD;\nM-->N;', math: null },
];
for (const doc of docs) doc.path = path.join(fixtureRoot, doc.name);

async function installMock(page) {
  await page.addInitScript(({ docs, platform }) => {
    window.bootstrapped = false;
    window.__bridge = { requests: [], cancels: [], callOrder: [], listeners: {} };
    const byPath = new Map(docs.map(doc => [doc.path, doc]));
    const byContent = new Map(docs.map(doc => [doc.content, doc]));
    const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    window.__TAURI__ = {
      core: { invoke: async (command, args = {}) => {
        window.__bridge.callOrder.push(`invoke:${command}`);
        switch (command) {
          case 'bootstrap':
            window.bootstrapped = true;
            return { paths: [], platform, theme: null };
          case 'render_markdown': {
            const doc = byContent.get(String(args.content || ''));
            if (!doc) return { html: '<p>Unknown document</p>', blocks: [] };
            const source = doc.big ? 'z'.repeat(300 * 1024) : doc.source;
            const mathHtml = doc.math == null ? '' : `<p><span data-math-style="inline">${escape(doc.math)}</span></p>`;
            const pre = source === null ? '' : `<pre data-sourcepos="3:1-5:3"><code class="language-mermaid">${escape(source)}</code></pre>`;
            return { html: `<h1 data-sourcepos="1:1-1:5">Title</h1>${mathHtml}${pre}`, blocks: [] };
          }
          case 'open_document': {
            const doc = byPath.get(args.path);
            return doc ? { path: doc.path, name: doc.name, content: doc.content, lineEnding: 'LF' } : null;
          }
          case 'mermaid_render_request': {
            const request = args.request;
            window.__bridge.requests.push({ id: request.id, source: request.source, theme: request.theme });
            return null;
          }
          case 'mermaid_render_cancel':
            window.__bridge.cancels.push(args.id);
            return null;
          case 'path_is_directory': return false;
          case 'document_changed': return false;
          case 'set_window_zoom': return null;
          case 'set_title': return null;
          case 'new_document': return null;
          default: return null;
        }
      } },
      event: { listen: async (name, callback) => { window.__bridge.callOrder.push(`listen:${name}`); (window.__bridge.listeners[name] ??= []).push(callback); return () => {}; } },
      webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }
    };
    window.mockSvg = tag => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text>${tag}</text></svg>`;
    window.deliverMermaid = payload => {
      for (const callback of window.__bridge.listeners['mermaid-render-result'] || []) callback({ payload });
    };
  }, { docs: docs.map(({ path, name, content, source, big, math }) => ({ path, name, content, source, big, math })), platform });
}

async function openDoc(page, docPath) {
  return page.evaluate(p => requestOpenLocation(p), docPath);
}

async function waitRequests(page, count) {
  await page.waitForFunction(n => window.__bridge.requests.length >= n, count);
}

async function deliver(page, payload) {
  await page.evaluate(p => window.deliverMermaid(p), payload);
}

async function deliverOk(page, id, tag) {
  await page.evaluate(({ id, tag }) => window.deliverMermaid({ id, ok: true, svg: window.mockSvg(tag), sanitized: true }), { id, tag });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
    errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const vendorMermaidRequests = [];
    page.on('request', request => { if (/\/vendor\/mermaid\//.test(request.url())) vendorMermaidRequests.push(request.url()); });
    await installMock(page);
    await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
    await page.waitForFunction(() => window.bootstrapped && document.documentElement.dataset.documentWidth && !busy);

    const requests = () => page.evaluate(() => window.__bridge.requests);
    const byName = name => docs.find(doc => doc.name === name);

    // 1. Request shape, listener-before-invoke ordering, unique ids.
    let opening = openDoc(page, byName('ok.md').path);
    await waitRequests(page, 1);
    const first = (await requests())[0];
    assert.match(first.id, /^[A-Za-z0-9_-]{1,64}$/, 'request ids fit the native token charset');
    assert.equal(first.source, 'graph TD;\nA-->B;', 'request carries the exact diagram source');
    assert.equal(typeof first.theme.variables, 'object', 'request carries theme variables');
    assert.equal(typeof first.theme.variables.background, 'string', 'theme variables include the background');
    const order = await page.evaluate(() => window.__bridge.callOrder);
    assert.ok(order.includes('listen:mermaid-render-result'), 'main listens for results');
    assert.ok(order.indexOf('listen:mermaid-render-result') < order.indexOf('invoke:mermaid_render_request'), 'main listens before invoking');
    await deliverOk(page, first.id, 'bridge-one');
    await opening;
    await page.waitForFunction(() => !busy && document.querySelector('#preview .mermaid-host svg'));
    assert.equal(await page.locator('#preview .mermaid-host svg text').textContent(), 'bridge-one', 'sanitized SVG is inserted');
    assert.equal(await page.evaluate(() => typeof window.mermaid), 'undefined', 'main never loads Mermaid itself');

    // 2. ok without sanitized is rejected: text fallback, no SVG.
    opening = openDoc(page, byName('gate.md').path);
    await waitRequests(page, 2);
    const gated = (await requests())[1];
    assert.ok(![first.id].includes(gated.id), 'request ids are unique');
    assert.match(gated.id, /^[A-Za-z0-9_-]{1,64}$/);
    await deliver(page, { id: gated.id, ok: true, svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>evil</text></svg>' });
    await opening;
    await page.waitForFunction(() => !busy && document.querySelector('#preview .mermaid-error'));
    assert.equal(await page.locator('#preview .mermaid-host svg').count(), 0, 'unsanitized payloads are never inserted');
    assert.equal(await page.locator('#preview .mermaid-error').textContent(), 'Mermaid diagram could not be rendered.', 'generic render failure message');
    assert.equal(await page.locator('#preview .mermaid-source').textContent(), 'graph TD;\nG-->H;', 'source stays available');

    // 3. Error results are text-only with the source.
    opening = openDoc(page, byName('err.md').path);
    await waitRequests(page, 3);
    const failed = (await requests())[2];
    await deliver(page, { id: failed.id, ok: false, sanitized: false, error: { code: 'render_failed', message: 'boom' } });
    await opening;
    await page.waitForFunction(() => !busy && document.querySelector('#preview .mermaid-error'));
    assert.equal(await page.locator('#preview .mermaid-host').count(), 1, 'error keeps its host');
    assert.equal(await page.locator('#preview .mermaid-host svg, #preview .mermaid-host script').count(), 0, 'errors insert no SVG or scripts');
    assert.equal(await page.locator('#preview .mermaid-source').textContent(), 'not a diagram', 'error keeps the source');
    await page.evaluate(() => editor.refreshMedia());
    assert.equal(await page.locator('#preview .mermaid-error').count(), 1, 'refreshing an unchanged failed diagram preserves its error state');
    opening = openDoc(page, byName('offline.md').path);
    await waitRequests(page, 4);
    const offline = (await requests())[3];
    await deliver(page, { id: offline.id, ok: false, sanitized: false, error: { code: 'unsupported_external_images', message: 'external' } });
    await opening;
    await page.waitForFunction(() => !busy && document.querySelector('#preview .mermaid-error'));
    assert.match(await page.locator('#preview .mermaid-error').textContent(), /offline|external images/i, 'offline diagrams get an explicit explanation');
    assert.equal(await page.locator('#preview .mermaid-source').textContent(), 'graph TD;\nO-->P;', 'offline diagrams keep the source');
    assert.equal(await page.locator('#preview .mermaid-host svg').count(), 0, 'offline diagrams insert no SVG');

    // 3b. Renderer timeouts degrade to the generic text fallback (native lane
    // owns timeout enforcement and renderer recycling; the main page only
    // renders the failure as text plus source).
    opening = openDoc(page, byName('timeout.md').path);
    await waitRequests(page, 5);
    const timedOut = (await requests())[4];
    await deliver(page, { id: timedOut.id, ok: false, sanitized: false, error: { code: 'timeout', message: 'The diagram renderer did not answer in time.' } });
    await opening;
    await page.waitForFunction(() => !busy && document.querySelector('#preview .mermaid-error'));
    assert.equal(await page.locator('#preview .mermaid-error').textContent(), 'Mermaid diagram could not be rendered.', 'timeouts use the generic failure text');
    assert.equal(await page.locator('#preview .mermaid-source').textContent(), 'graph TD;\nT-->O;', 'timed-out diagrams keep the source');
    assert.equal(await page.locator('#preview .mermaid-host svg').count(), 0, 'timeouts insert no SVG');

    // 4. Theme refresh re-requests; stale refreshes are cancelled on document change.
    await page.evaluate(() => applyTheme('graphite'));
    await waitRequests(page, 6);
    const refreshed = (await requests())[5];
    assert.equal(refreshed.source, 'graph TD;\nT-->O;', 'refresh re-requests the stale host');
    assert.notDeepEqual(refreshed.theme.variables, offline.theme.variables, 'refresh carries the new theme variables');
    await deliverOk(page, refreshed.id, 'themed');
    await page.waitForFunction(() => !busy && document.querySelector('#preview .mermaid-host svg text')?.textContent === 'themed');
    assert.equal(await page.evaluate(() => document.querySelector('.mermaid-host').dataset.themeRevision), await page.evaluate(() => String(diagramThemeRevision)), 'host tracks the refreshed theme');
    await page.evaluate(() => applyTheme('nord'));
    await waitRequests(page, 7);
    const stale = (await requests())[6];
    await openDoc(page, byName('plain.md').path);
    await page.waitForFunction(() => !busy && document.querySelector('#preview h1') && !document.querySelector('#preview .mermaid-host'));
    assert.deepEqual(await page.evaluate(() => window.__bridge.cancels), [stale.id], 'stale refresh request is cancelled');
    await deliverOk(page, stale.id, 'stale-svg');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#preview svg').count(), 0, 'late stale results are ignored');
    assert.equal(await page.evaluate(() => document.querySelector('#preview h1') !== null), true, 'plain document intact after stale delivery');

    // 5. Identical re-renders reuse the diagram DOM without a new request.
    opening = openDoc(page, byName('ok.md').path);
    await waitRequests(page, 8);
    const again = (await requests())[7];
    await deliverOk(page, again.id, 'reuse');
    await opening;
    await page.waitForFunction(() => !busy && document.querySelector('#preview .mermaid-host svg'));
    await page.evaluate(() => { window.reusedHost = document.querySelector('.mermaid-host'); });
    await page.evaluate(() => { previewSnapshot = null; return renderPreview(); });
    await page.waitForFunction(() => !busy);
    assert.equal((await requests()).length, 8, 'reused diagrams issue no new request');
    assert.equal(await page.evaluate(() => window.reusedHost === document.querySelector('.mermaid-host')), true, 'reused diagram DOM is preserved');
    assert.equal(await page.locator('#preview .mermaid-host svg text').textContent(), 'reuse', 'reused SVG survives');

    // 6. Oversize sources fall back without a bridge call.
    opening = openDoc(page, byName('big.md').path);
    await page.waitForFunction(() => !busy && document.querySelector('#preview .mermaid-error'));
    await opening;
    assert.equal((await requests()).length, 8, 'oversize sources never reach the bridge');
    assert.equal(await page.locator('#preview .mermaid-source').textContent().then(text => text.length), 300 * 1024, 'oversize source stays available');
    assert.equal(await page.locator('#preview .mermaid-host svg').count(), 0, 'oversize sources insert no SVG');

    // 7. Results for unknown ids are ignored.
    await deliverOk(page, 'ghost-9', 'ghost');
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.body.textContent.includes('ghost')), false, 'unknown-id results are ignored');

    // 8. Overlapping generations: a stale pass suspended in renderMath must not
    // cancel the current pass's Mermaid request. Suspension is gated on the
    // KaTeX loader itself (deterministic; file:// vendor loads cannot be
    // intercepted by request routing).
    await page.evaluate(() => {
      window.__katexCalled = false;
      window.__katexRelease = null;
      window.__katexGate = new Promise(resolve => { window.__katexRelease = resolve; });
      window.__origLoadKatex = loadKatex;
      loadKatex = () => { window.__katexCalled = true; return window.__katexGate.then(() => window.__origLoadKatex()); };
    });
    const openingMixed = openDoc(page, byName('mathmix.md').path);
    await page.waitForFunction(() => window.__katexCalled === true);
    const mathmixContent = byName('mathmix.md').content;
    const nomathContent = byName('nomath.md').content;
    assert.equal(await page.evaluate(() => current.content), mathmixContent, 'stale pass holds its content while suspended');
    await page.waitForFunction(() => window.__bridge.requests.at(-1)?.source === 'graph TD;\nM-->N;');
    await page.evaluate(text => { setDocumentMode('edit'); changeContent(text); }, nomathContent);
    await page.evaluate(() => renderPreview());
    const overlapped = (await requests()).at(-1);
    assert.equal(overlapped.source, 'graph TD;\nM-->N;', 'current pass issues its own request');
    await page.evaluate(() => { window.__katexRelease(); loadKatex = window.__origLoadKatex; });
    await page.waitForTimeout(300);
    assert.equal((await page.evaluate(() => window.__bridge.cancels)).includes(overlapped.id), false, 'stale pass cancels nothing');
    await deliverOk(page, overlapped.id, 'overlap');
    await openingMixed;
    await page.waitForFunction(() => !busy && document.querySelector('#preview .mermaid-host svg'));
    assert.equal(await page.locator('#preview .mermaid-host svg text').textContent(), 'overlap', 'current result is inserted after the stale pass resumes');
    assert.equal(await page.evaluate(() => current.content), nomathContent, 'current content survives');
    assert.equal(await page.evaluate(() => editor.getText()), nomathContent, 'editor buffer is current despite stale math work');

    // 9. Main never fetched or executed Mermaid; ids stayed unique.
    assert.deepEqual(vendorMermaidRequests, [], 'main never requests Mermaid vendor assets');
    assert.equal(await page.evaluate(() => typeof window.mermaid), 'undefined', 'main never executes Mermaid');
    assert.equal(await page.evaluate(() => document.querySelectorAll('script[src*="mermaid"]').length), 0, 'main adds no Mermaid script tags');
    const ids = (await requests()).map(request => request.id);
    assert.equal(new Set(ids).size, ids.length, 'every request id is unique');

    assert.deepEqual(errors, []);
    await browser.close();
    console.log('PASS: bridge request shape and listener ordering, sanitized-only insertion, text-only errors with offline explanation, stale cancellation, overlapping-generation isolation, reuse, oversize fallback, unknown-id tolerance, and zero main-page Mermaid execution.');
  } catch (error) { throw error; }
})().catch(error => { console.error(error); console.error('PAGE ERRORS:', errors); process.exit(1); });
