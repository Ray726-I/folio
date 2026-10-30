const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// KaTeX stays lazy in the main page. Mermaid must never load or execute in the
// main page: diagrams render through the mocked native bridge
// (mermaid_render_request / mermaid-render-result / mermaid_render_cancel).
const fixtureRoot = path.join(os.tmpdir(), 'folio-lazy-assets');
const plainPath = path.join(fixtureRoot, 'plain.md');
const mathPath = path.join(fixtureRoot, 'math.md');
const secondMathPath = path.join(fixtureRoot, 'math-two.md');
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
let errors = [];

const fixtures = [
  {
    path: plainPath,
    content: '# Plain document\n\nNo math or diagrams here.',
    html: '<h1 id="doc-plain">Plain document</h1><p>No math or diagrams here.</p>'
  },
  {
    path: mathPath,
    content: '# Math and diagrams\n\nInline $x^2 + y^2$ and a diagram.\n\n```mermaid\ngraph TD;\nA-->B;\n```',
    html: '<h1 id="doc-math">Math and diagrams</h1><p><span data-math-style="inline">x^2 + y^2</span></p><pre data-sourcepos="3:1-6:3"><code class="language-mermaid">graph TD;\nA--&gt;B;</code></pre>'
  },
  {
    path: secondMathPath,
    content: '# Second math document\n\nMore inline $a^2$ and another diagram.\n\n```mermaid\ngraph LR;\nC-->D;\n```',
    html: '<h1 id="doc-math-two">Second math document</h1><p><span data-math-style="inline">a^2</span></p><pre data-sourcepos="3:1-6:3"><code class="language-mermaid">graph LR;\nC--&gt;D;</code></pre>'
  },
  {
    path: path.join(fixtureRoot, 'malformed.md'),
    content: '# Malformed diagram\n\n```mermaid\nnot a diagram\n```',
    html: '<h1 id="doc-malformed">Malformed diagram</h1><pre><code class="language-mermaid">not a diagram</code></pre>'
  }
];

async function installMock(page, bridgeFail = null) {
  await page.addInitScript(({ fixtures, platform, bridgeFail }) => {
    window.bootstrapped = false;
    window.__bridge = { requests: [], cancels: [], listeners: {} };
    const byPath = new Map(fixtures.map(fixture => [fixture.path, fixture]));
    const byContent = new Map(fixtures.map(fixture => [fixture.content, fixture]));
    window.__TAURI__ = {
      core: { invoke: async (command, args = {}) => {
        switch (command) {
          case 'bootstrap':
            window.bootstrapped = true;
            return { paths: [], platform, theme: null };
          case 'open_document': {
            const fixture = byPath.get(args.path);
            return fixture ? { path: fixture.path, name: window.FolioPaths.basename(fixture.path), content: fixture.content, lineEnding: 'LF' } : null;
          }
          case 'render_markdown': return { html: byContent.get(args.content)?.html || '<p>Unknown document</p>', blocks: [] };
          case 'mermaid_render_request': {
            const request = args.request;
            window.__bridge.requests.push({ id: request.id, source: request.source, theme: request.theme });
            setTimeout(() => {
              const callbacks = window.__bridge.listeners['mermaid-render-result'] || [];
              const payload = request.source.includes('not a diagram')
                ? { id: request.id, ok: false, sanitized: false, error: { code: 'render_failed', message: 'diagram syntax is not valid' } }
                : bridgeFail === 'unsupported'
                  ? { id: request.id, ok: false, sanitized: false, error: { code: 'unsupported_external_images', message: 'diagram references external images' } }
                  : { id: request.id, ok: true, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text>${request.source.includes('LR') ? 'lr-ok' : 'td-ok'}</text></svg>`, sanitized: true };
              for (const callback of callbacks) callback({ payload });
            }, 0);
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
      event: { listen: async (name, callback) => { (window.__bridge.listeners[name] ??= []).push(callback); return () => {}; } },
      webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }
    };
  }, { fixtures, platform, bridgeFail });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
    errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const assetRequests = [];
    page.on('request', request => {
      const url = request.url();
      if (/\/vendor\/(?:katex|mermaid)\//.test(url)) assetRequests.push(url);
    });
    await installMock(page);

    await page.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
    await page.waitForFunction(() => window.bootstrapped && document.documentElement.dataset.documentWidth && !busy);

    const requestCount = fragment => assetRequests.filter(url => url.includes(fragment)).length;
    const moduleState = () => page.evaluate(() => ({
      katex: typeof window.katex,
      mermaid: typeof window.mermaid,
      scripts: document.querySelectorAll('script[src*="vendor/katex"], script[src*="vendor/mermaid"], link[href*="vendor/katex"]').length
    }));
    const bridgeRequests = () => page.evaluate(() => window.__bridge.requests);

    // Startup and an ordinary document must not fetch KaTeX, and Mermaid must
    // never load in the main page at all.
    assert.deepEqual(assetRequests, [], 'startup must not request KaTeX or Mermaid');
    assert.deepEqual(await moduleState(), { katex: 'undefined', mermaid: 'undefined', scripts: 0 }, 'startup must leave the renderers unloaded');

    await page.evaluate(path => requestOpenLocation(path), plainPath);
    await page.waitForFunction(() => document.querySelector('#preview h1')?.textContent === 'Plain document' && !busy);
    assert.deepEqual(assetRequests, [], 'a plain document must not request KaTeX or Mermaid');
    assert.deepEqual(await moduleState(), { katex: 'undefined', mermaid: 'undefined', scripts: 0 }, 'a plain document must leave the renderers unloaded');
    assert.deepEqual(await bridgeRequests(), [], 'a plain document issues no bridge requests');

    // A document with math and a diagram loads KaTeX once and renders the
    // diagram through the native bridge without touching Mermaid vendor code.
    await page.evaluate(path => requestOpenLocation(path), mathPath);
    await page.waitForFunction(() => document.querySelector('#preview h1')?.textContent === 'Math and diagrams' && !busy);
    await page.waitForFunction(() => document.querySelector('#preview .katex') && document.querySelector('#preview .mermaid-host svg'));
    assert.equal(requestCount('vendor/katex/katex.min.js'), 1, 'KaTeX should load once on demand');
    assert.equal(requestCount('vendor/katex/katex.min.css'), 1, 'KaTeX styles should load once on demand');
    assert.equal(requestCount('vendor/mermaid/mermaid.min.js'), 0, 'the main page must never fetch Mermaid vendor code');
    assert.equal(await page.evaluate(() => typeof window.katex?.render), 'function', 'KaTeX should initialize after loading');
    assert.equal(await page.evaluate(() => typeof window.mermaid), 'undefined', 'the main page must never execute Mermaid');
    assert.equal(await page.locator('#preview .katex').count() > 0, true, 'inline math should render');
    assert.equal(await page.locator('#preview .mermaid-host svg').count(), 1, 'the Mermaid diagram should render via the bridge');
    const [diagramRequest] = await bridgeRequests();
    assert.match(diagramRequest.id, /^[A-Za-z0-9_-]{1,64}$/, 'bridge request ids fit the native token charset');
    assert.equal(diagramRequest.source, 'graph TD;\nA-->B;', 'bridge requests carry the exact diagram source');
    assert.equal(typeof diagramRequest.theme.variables.background, 'string', 'bridge requests carry theme variables');

    // Re-rendering identical content reuses the diagram DOM without a new request.
    await page.evaluate(() => { window.diagram = document.querySelector('.mermaid-host'); });
    await page.evaluate(() => { previewSnapshot = null; return renderPreview(); });
    await page.waitForFunction(() => !busy && document.querySelector('#preview .mermaid-host svg'));
    assert.equal((await bridgeRequests()).length, 1, 'reused diagrams issue no new bridge request');
    assert.equal(await page.evaluate(() => window.diagram === document.querySelector('.mermaid-host')), true, 'reused diagram DOM is preserved');

    // Later documents reuse loaded KaTeX and render new diagrams via the bridge.
    await page.evaluate(path => requestOpenLocation(path), plainPath);
    await page.waitForFunction(() => document.querySelector('#preview h1')?.textContent === 'Plain document' && !busy);
    await page.evaluate(path => requestOpenLocation(path), secondMathPath);
    await page.waitForFunction(() => document.querySelector('#preview h1')?.textContent === 'Second math document' && !busy);
    await page.waitForFunction(() => document.querySelector('#preview .katex') && document.querySelector('#preview .mermaid-host svg'));
    assert.equal(requestCount('vendor/katex/katex.min.js'), 1, 'later math documents should reuse loaded KaTeX');
    assert.equal(requestCount('vendor/katex/katex.min.css'), 1, 'later math documents should reuse loaded KaTeX styles');
    assert.equal(requestCount('vendor/mermaid/mermaid.min.js'), 0, 'later diagrams must not fetch Mermaid vendor code');
    assert.equal((await bridgeRequests()).length, 2, 'each new diagram source issues one bridge request');
    assert.equal(await page.evaluate(() => typeof window.mermaid), 'undefined', 'diagrams must not execute Mermaid in the main page');

    // Bridge errors keep the message text and the diagram source readable.
    await page.evaluate(path => requestOpenLocation(path), fixtures[3].path);
    await page.waitForFunction(() => document.querySelector('#preview h1')?.textContent === 'Malformed diagram' && !busy);
    await page.waitForFunction(() => document.querySelector('#preview .mermaid-error'));
    assert.equal(await page.locator('#preview .mermaid-error').textContent(), 'Mermaid diagram could not be rendered.', 'bridge errors show the failure text');
    assert.equal(await page.locator('#preview .mermaid-source').textContent(), 'not a diagram', 'invalid Mermaid source should remain available');
    assert.equal(await page.locator('#preview .mermaid-host svg').count(), 0, 'failed renders insert no SVG');
    assert.equal((await bridgeRequests()).length, 3, 'showing a source fallback must not recreate the node or loop render requests');
    assert.equal(await page.locator('#preview h1').textContent(), 'Malformed diagram', 'the preview should remain usable after a syntax error');

    // Failed loads must leave the math and diagram source readable instead of breaking the document.
    const fallbackPage = await browser.newPage({ viewport: { width: 1120, height: 800 } });
    const fallbackErrors = [];
    fallbackPage.on('pageerror', error => fallbackErrors.push(String(error)));
    await fallbackPage.route('**/vendor/katex/**', route => route.abort());
    await installMock(fallbackPage, 'unsupported');
    await fallbackPage.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
    await fallbackPage.waitForFunction(() => window.bootstrapped && document.documentElement.dataset.documentWidth && !busy);
    await fallbackPage.evaluate(path => requestOpenLocation(path), mathPath);
    await fallbackPage.waitForFunction(() => document.querySelector('#preview h1')?.textContent === 'Math and diagrams' && !busy);
    await fallbackPage.waitForFunction(() => document.querySelector('#preview .mermaid-error'));
    assert.equal(await fallbackPage.evaluate(() => typeof window.katex), 'undefined');
    assert.equal(await fallbackPage.evaluate(() => typeof window.mermaid), 'undefined');
    assert.equal(await fallbackPage.locator('#preview .math-formula').textContent(), 'x^2 + y^2', 'math source should stay readable when KaTeX cannot load');
    assert.match(await fallbackPage.locator('#preview .mermaid-error').textContent(), /offline|external images/i, 'offline diagrams get an explicit explanation');
    assert.equal(await fallbackPage.locator('#preview .mermaid-source').textContent(), 'graph TD;\nA-->B;', 'diagram source should stay readable when rendering is offline');
    assert.equal(await fallbackPage.locator('#preview .mermaid-host svg').count(), 0, 'offline diagrams insert no SVG');
    assert.deepEqual(fallbackErrors, []);

    assert.deepEqual(errors, []);
    console.log('PASS: KaTeX stays lazy, Mermaid never loads in the main page, diagrams render through the native bridge with reuse, errors and offline diagrams keep text plus source.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); console.error('PAGE ERRORS:', errors); process.exit(1); });
