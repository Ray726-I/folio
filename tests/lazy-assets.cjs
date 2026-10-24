const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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
    content: '# Math and diagrams\n\nInline $x^2 + y^2$ and a diagram.',
    html: '<h1 id="doc-math">Math and diagrams</h1><p><span data-math-style="inline">x^2 + y^2</span></p><pre data-sourcepos="3:1-6:3"><code class="language-mermaid">graph TD;\nA--&gt;B;</code></pre>'
  },
  {
    path: secondMathPath,
    content: '# Second math document\n\nMore inline $a^2$ and another diagram.',
    html: '<h1 id="doc-math-two">Second math document</h1><p><span data-math-style="inline">a^2</span></p><pre data-sourcepos="3:1-6:3"><code class="language-mermaid">graph LR;\nC--&gt;D;</code></pre>'
  },
];

async function installMock(page) {
  await page.addInitScript(({ fixtures, platform }) => {
    window.bootstrapped = false;
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
          case 'path_is_directory': return false;
          case 'document_changed': return false;
          default: return null;
        }
      } },
      event: { listen: async () => () => {} },
      webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }
    };
  }, { fixtures, platform });
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

    // Startup and an ordinary document must not fetch or parse either renderer.
    assert.deepEqual(assetRequests, [], 'startup must not request KaTeX or Mermaid');
    assert.deepEqual(await moduleState(), { katex: 'undefined', mermaid: 'undefined', scripts: 0 }, 'startup must leave the renderers unloaded');

    await page.evaluate(path => requestOpenLocation(path), plainPath);
    await page.waitForFunction(() => document.querySelector('#preview h1')?.textContent === 'Plain document' && !busy);
    assert.deepEqual(assetRequests, [], 'a plain document must not request KaTeX or Mermaid');
    assert.deepEqual(await moduleState(), { katex: 'undefined', mermaid: 'undefined', scripts: 0 }, 'a plain document must leave the renderers unloaded');

    // A document with math and a diagram loads both modules and renders them.
    await page.evaluate(path => requestOpenLocation(path), mathPath);
    await page.waitForFunction(() => document.querySelector('#preview h1')?.textContent === 'Math and diagrams' && !busy);
    await page.waitForFunction(() => document.querySelector('#preview .katex') && document.querySelector('#preview .mermaid-host svg'));
    assert.equal(requestCount('vendor/katex/katex.min.js'), 1, 'KaTeX should load once on demand');
    assert.equal(requestCount('vendor/katex/katex.min.css'), 1, 'KaTeX styles should load once on demand');
    assert.equal(requestCount('vendor/mermaid/mermaid.min.js'), 1, 'Mermaid should load once on demand');
    assert.equal(await page.evaluate(() => typeof window.katex?.render), 'function', 'KaTeX should initialize after loading');
    assert.equal(await page.evaluate(() => typeof window.mermaid?.render), 'function', 'Mermaid should initialize after loading');
    assert.equal(await page.locator('#preview .katex').count() > 0, true, 'inline math should render');
    assert.equal(await page.locator('#preview .mermaid-host svg').count(), 1, 'the Mermaid diagram should render');
    const loadedScripts = await moduleState();

    // Later documents reuse the loaded modules instead of fetching them again.
    await page.evaluate(path => requestOpenLocation(path), plainPath);
    await page.waitForFunction(() => document.querySelector('#preview h1')?.textContent === 'Plain document' && !busy);
    await page.evaluate(path => requestOpenLocation(path), secondMathPath);
    await page.waitForFunction(() => document.querySelector('#preview h1')?.textContent === 'Second math document' && !busy);
    await page.waitForFunction(() => document.querySelector('#preview .katex') && document.querySelector('#preview .mermaid-host svg'));
    assert.equal(requestCount('vendor/katex/katex.min.js'), 1, 'later math documents should reuse loaded KaTeX');
    assert.equal(requestCount('vendor/katex/katex.min.css'), 1, 'later math documents should reuse loaded KaTeX styles');
    assert.equal(requestCount('vendor/mermaid/mermaid.min.js'), 1, 'later diagram documents should reuse loaded Mermaid');
    assert.deepEqual(await moduleState(), loadedScripts, 'later documents should not add duplicate asset elements');


    // Failed loads must leave the math and diagram source readable instead of breaking the document.
    const fallbackPage = await browser.newPage({ viewport: { width: 1120, height: 800 } });
    const fallbackErrors = [];
    fallbackPage.on('pageerror', error => fallbackErrors.push(String(error)));
    await fallbackPage.route('**/vendor/katex/**', route => route.abort());
    await fallbackPage.route('**/vendor/mermaid/**', route => route.abort());
    await installMock(fallbackPage);
    await fallbackPage.goto(pathToFileURL(path.resolve(__dirname, '../ui/index.html')).href);
    await fallbackPage.waitForFunction(() => window.bootstrapped && document.documentElement.dataset.documentWidth && !busy);
    await fallbackPage.evaluate(path => requestOpenLocation(path), mathPath);
    await fallbackPage.waitForFunction(() => document.querySelector('#preview h1')?.textContent === 'Math and diagrams' && !busy);
    assert.equal(await fallbackPage.evaluate(() => typeof window.katex), 'undefined');
    assert.equal(await fallbackPage.evaluate(() => typeof window.mermaid), 'undefined');
    assert.equal(await fallbackPage.locator('#preview [data-math-style]').textContent(), 'x^2 + y^2', 'math source should stay readable when KaTeX cannot load');
    assert.equal(await fallbackPage.locator('#preview pre code.language-mermaid').textContent(), 'graph TD;\nA-->B;', 'diagram source should stay readable when Mermaid cannot load');
    assert.equal(await fallbackPage.locator('#preview .katex, #preview .mermaid-host').count(), 0);
    assert.deepEqual(fallbackErrors, []);

    assert.deepEqual(errors, []);
    console.log('PASS: KaTeX and Mermaid stay unloaded for startup and plain documents, load once for math and diagrams, render both, are reused by later documents, and fall back to source when loading fails.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); console.error('PAGE ERRORS:', errors); process.exit(1); });
