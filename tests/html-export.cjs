'use strict';
// Standalone HTML export regression:
// - the UI asks native for the exact render jobs and never scrapes preview DOM,
// - math uses the bundled KaTeX and Mermaid uses the isolated bridge,
// - failed or hostile assets become readable source fallback, not markup,
// - the actual native artifact is self-contained: no scripts, no network, the
//   selected theme, embedded local images, and blocked remote images.

const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const fixture = process.env.FOLIO_EXPORT_FIXTURE
  || path.join(root, 'target', 'debug', 'examples', process.platform === 'win32' ? 'export-fixture.exe' : 'export-fixture');
if (!fs.existsSync(fixture)) throw new Error(`Build the export fixture first: cargo build --example export-fixture (${fixture})`);

const source = `# Export\n\nInline $\\sqrt{x}$ and display $$y^2$$.\n\n\`\`\`math\nz^2\n\`\`\`\n\nInline $w^2$ too.\n\nInline $\\text{a url(x) b}$.\n\n![local](pixel.png)\n\n<img src="pixel.png" alt="raw">\n\n![remote](https://example.com/remote.png)\n\n\`\`\`mermaid\ngraph TD;\nA-->B;\n\`\`\`\n\n\`\`\`mermaid\nnot a diagram\n\`\`\`\n\n\`\`\`mermaid\ngraph TD;\nC-->D;\n\`\`\`\n`;

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lYQ5WQAAAABJRU5ErkJggg==',
  'base64'
);
const scratch = fs.mkdtempSync(path.join(fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir(), 'folio-export-'));
fs.writeFileSync(path.join(scratch, 'pixel.png'), png);
const exportFile = path.join(scratch, 'document.html');

const diagramSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text x="10" y="40">A to B</text></svg>';
const hostileSvg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="https://example.com/leak.png"/><text>evil</text></svg>';
const hostileMath = '<span class="katex"><script>alert(1)</script><img src="https://example.com/leak.png"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>z</mi></math></span>';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    const errors = [];
    const external = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('http://**/*', route => { external.push(route.request().url()); return route.abort(); });
    await page.route('https://**/*', route => { external.push(route.request().url()); return route.abort(); });
    await page.addInitScript(({ source }) => {
      localStorage.setItem('folio.theme', JSON.stringify('nord'));
      localStorage.setItem('folio.readingFont', JSON.stringify('serif'));
      window.__export = { calls: [], prepared: [], requests: [], listeners: {} };
      window.__TAURI__ = {
        core: {
          invoke: async (command, args = {}) => {
            const state = window.__export;
            if (command === 'bootstrap') return { paths: [], platform: 'linux', theme: null };
            if (command === 'open_document') return { path: '/tmp/export.md', name: 'export.md', content: source, lineEnding: 'LF' };
            if (command === 'render_markdown') return { html: '<p>preview</p>' };
            if (command === 'preview_check') return { limited: null };
            if (command === 'document_changed') return false;
            if (command === 'path_is_directory') return false;
            if (command === 'prepare_html_export') {
              state.prepared.push(args);
              const plan = { maxAssets: 512, jobs: [
                { id: 'math-0', kind: 'math', source: '\\sqrt{x}', display: false, block: false },
                { id: 'math-1', kind: 'math', source: 'y^2', display: true, block: false },
                { id: 'math-2', kind: 'math', source: 'z^2', display: true, block: true },
                { id: 'math-3', kind: 'math', source: 'w^2', display: false, block: false },
                { id: 'math-4', kind: 'math', source: '\\text{a url(x) b}', display: false, block: false },
                { id: 'diagram-0', kind: 'diagram', source: 'graph TD;\nA-->B;', display: false, block: true },
                { id: 'diagram-1', kind: 'diagram', source: 'not a diagram', display: false, block: true },
                { id: 'diagram-2', kind: 'diagram', source: 'graph TD;\nC-->D;', display: false, block: true }
              ] };
              state.plan = plan;
              return plan;
            }
            if (command === 'mermaid_render_request') {
              state.requests.push(args.request);
              if (state.mutateThemeOnNext) {
                state.mutateThemeOnNext = false;
                state.themeMutated = true;
                document.documentElement.style.setProperty('--bg', '#fdf6e3');
                document.documentElement.style.setProperty('--fg', '#111111');
                document.documentElement.style.setProperty('--accent', '#b58900');
              }
              const request = args.request;
              setTimeout(() => {
                const result = request.source.includes('not a diagram')
                  ? { id: request.id, ok: false, sanitized: false, error: { code: 'render_failed', message: 'boom' } }
                  : { id: request.id, ok: true, sanitized: true, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text>A to B</text></svg>' };
                for (const listener of state.listeners['mermaid-render-result'] || []) listener({ payload: result });
              }, 0);
              return null;
            }
            if (command === 'mermaid_render_cancel') return null;
            if (command === 'export_html') {
              state.calls.push(args);
              return '/tmp/exported.html';
            }
            return null;
          }
        },
        event: {
          listen: async (name, callback) => {
            (window.__export.listeners[name] ||= []).push(callback);
            return () => {};
          }
        },
        webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }
      };
    }, { source });
    await page.goto(pathToFileURL(path.join(root, 'ui/index.html')).href);
    await page.waitForFunction(() => typeof busy !== 'undefined' && !busy && window.__export);
    await page.evaluate(() => requestOpen('/tmp/export.md'));
    await page.waitForFunction(() => current.content.includes('Inline') && !busy);

    const theme = await page.evaluate(() => exportThemeSnapshot());
    const requestsBeforeExport = await page.evaluate(() => window.__export.requests.length);
    await page.evaluate(() => { window.__export.mutateThemeOnNext = true; runAppAction('html'); });
    await page.waitForFunction(() => window.__export.calls.length === 1, null, { timeout: 15000 });

    const state = await page.evaluate(() => ({
      prepared: window.__export.prepared,
      plan: window.__export.plan,
      requests: window.__export.requests,
      call: window.__export.calls[0],
      themeMutated: window.__export.themeMutated === true,
      mermaidLoaded: typeof window.mermaid !== 'undefined'
    }));
    const exportRequests = state.requests.slice(requestsBeforeExport);
    assert.equal(state.prepared.length, 1, 'native prepares the exact render job list');
    assert.equal(state.prepared[0].content, source, 'prepare receives the saved source snapshot');
    assert.equal(typeof state.plan.maxAssets, 'number', 'native also bounds the rendered asset count');
    assert.equal(exportRequests.length, 3, 'each diagram asks the isolated bridge');
    assert.equal(state.themeMutated, true, 'the test actually changed the page theme during export');
    assert.ok(exportRequests.every(request => typeof request.theme.variables === 'object'), 'bridge receives the active theme');
    assert.ok(exportRequests.every(request => request.theme.variables.background === '#2e3440'), 'every diagram uses the frozen palette');
    const cardColours = exportRequests.map(request => request.theme.variables.primaryColor);
    assert.equal(new Set(cardColours).size, 1, 'a later theme change does not leak into any diagram');
    assert.equal(exportRequests[0].theme.variables.background, '#2e3440', 'the frozen palette reaches the first diagram');
    assert.equal(exportRequests[0].source, 'graph TD;\nA-->B;', 'bridge receives the exact diagram source');
    assert.equal(state.mermaidLoaded, false, 'the main page never loads Mermaid');

    const call = state.call;
    assert.equal(call.content, source, 'export receives the same source snapshot');
    assert.match(call.theme.palette.background, /^#[0-9a-f]{6}$/i);
    assert.equal(call.theme.palette.background, '#2e3440', 'the selected Nord theme is exported');
    assert.equal(call.theme.font, 'serif', 'the current reading font is exported');
    assert.ok(Object.values(call.theme.palette).every(value => /^#[0-9a-f]{6}$/i.test(value)), 'every exported colour is solid');
    assert.equal(theme.palette.background, call.theme.palette.background, 'UI and export resolve the same palette');

    const byId = Object.fromEntries(call.assets.map(asset => [asset.id, asset]));
    assert.equal(call.assets.length, 8, 'one typed asset is returned per job');
    assert.match(byId['math-0'].html, /class="katex"/, 'inline math is typeset with KaTeX');
    assert.match(byId['math-0'].html, /<math /, 'KaTeX MathML is preserved');
    assert.match(byId['math-1'].html, /katex-display/, 'display math uses display mode');
    assert.match(byId['math-2'].html, /class="katex-block math-block"/, 'block math keeps the preview wrapper');
    assert.match(byId['math-4'].html, /url\(x\)/, 'harmless prose inside math is not rejected');
    assert.match(byId['diagram-0'].svg, /^<svg /, 'bridge SVG is forwarded as a typed asset');
    assert.match(byId['diagram-2'].svg, /^<svg /, 'a second successful diagram is forwarded');
    assert.equal(byId['diagram-1'].svg, undefined, 'a failed diagram explicitly falls back');

    // Generate the real native artifact from the captured assets, replacing the
    // hostile math and hostile diagram while leaving a real successful diagram.
    byId['math-3'].html = hostileMath;
    byId['diagram-2'].svg = hostileSvg;
    const request = {
      source,
      base: scratch,
      theme: call.theme,
      assets: call.assets
    };
    const artifact = execFileSync(fixture, [], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    fs.writeFileSync(exportFile, artifact);
    assert.ok(artifact.length > 100000, 'the artifact embeds the selected web fonts');

    const offline = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    const offlineRequests = [];
    const offlineErrors = [];
    offline.on('pageerror', error => offlineErrors.push(String(error)));
    await offline.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith('file:') || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return route.continue();
      offlineRequests.push(url);
      return route.abort();
    });
    await offline.goto(pathToFileURL(exportFile).href);
    await offline.waitForFunction(() => document.fonts.status === 'loaded');

    const rendered = await offline.evaluate(() => ({
      scripts: document.querySelectorAll('script').length,
      katex: document.querySelectorAll('.katex').length,
      mathBlocks: document.querySelectorAll('.math-block').length,
      mathFallback: document.querySelectorAll('.math-source').length,
      diagrams: document.querySelectorAll('.mermaid-host svg').length,
      diagramText: document.querySelector('.mermaid-host svg text')?.textContent || '',
      diagramFallback: document.querySelectorAll('.mermaid-source').length,
      localImage: document.querySelector('img[alt="local"]')?.getAttribute('src') || '',
      rawImage: document.querySelector('img[alt="raw"]')?.getAttribute('src') || '',
      remoteImage: document.querySelector('img[alt="remote"]')?.getAttribute('src') || '',
      background: getComputedStyle(document.body).backgroundColor,
      readingFont: getComputedStyle(document.body).fontFamily,
      readingFontLoaded: document.fonts.check('16px "Source Serif 4"'),
      katexFontLoaded: document.fonts.check('16px KaTeX_Main'),
      viewBox: document.querySelector('.katex-html svg')?.getAttribute('viewBox') || '',
      marker: document.body.innerHTML.includes('data-folio-export-job'),
      hostile: document.body.innerHTML.includes('alert(1)') || document.body.innerHTML.includes('leak.png')
    }));
    assert.equal(rendered.scripts, 0, 'the export contains no scripts');
    assert.equal(rendered.katex, 4, 'math renders like the preview');
    assert.equal(rendered.mathBlocks, 1, 'block math keeps its boxed preview style');
    assert.equal(rendered.mathFallback, 1, 'hostile math falls back to readable source');
    assert.equal(rendered.diagrams, 1, 'the successful diagram is present in the final artifact');
    assert.equal(rendered.diagramText, 'A to B', 'the successful diagram SVG renders offline');
    assert.equal(rendered.diagramFallback, 2, 'failed and hostile diagrams keep readable source');
    assert.match(rendered.localImage, /^data:image\/png;base64,/, 'local images are embedded');
    assert.match(rendered.rawImage, /^data:image\/png;base64,/, 'raw HTML local images are embedded too');
    assert.match(rendered.remoteImage, /^data:image\/svg\+xml;base64,/, 'remote images remain blocked placeholders');
    assert.equal(rendered.background, 'rgb(46, 52, 64)', 'the exported document keeps the Nord background');
    assert.match(rendered.readingFont, /Source Serif 4/, 'the selected reading font is embedded and applied');
    assert.equal(rendered.readingFontLoaded, true, 'the selected reading font is available offline');
    assert.equal(rendered.katexFontLoaded, true, 'KaTeX fonts are embedded and available offline');
    assert.ok(rendered.viewBox, 'KaTeX root SVG geometry survives sanitization');
    assert.equal(rendered.marker, false, 'no render markers leak into the file');
    assert.equal(rendered.hostile, false, 'no hostile markup or URL survives');
    assert.deepEqual(offlineRequests, [], 'viewing the export makes no network requests');

    // Real bundled-KaTeX corpus roundtrip. This catches presentation
    // attributes/styles that the native sanitizer must support without
    // weakening the dangerous-markup gate.
    const corpus = [
      String.raw`\Huge{x}`,
      String.raw`\smash{x}`,
      String.raw`\hphantom{x}`,
      String.raw`\raisebox{2pt}{x}`,
      String.raw`\rule{2em}{1em}`,
      String.raw`\colorbox{red}{x}`,
      String.raw`\llap{x}`,
      String.raw`\pmb{x}`,
      String.raw`\sqrt{x}`,
      String.raw`\frac{a}{b}`,
      String.raw`\sum_{i=0}^n i^2`,
      String.raw`\overbrace{a+b}^{n}`,
      String.raw`\text{a url(x) b}`
    ];
    const corpusHtml = await page.evaluate(formulas => formulas.map(formula => {
      const host = document.createElement('div');
      window.katex.render(formula, host, { displayMode: false, throwOnError: false, output: 'htmlAndMathml' });
      return host.innerHTML;
    }), corpus);
    const corpusSource = corpus.map(formula => `Inline $${formula}$.\n\n`).join('');
    const corpusArtifact = execFileSync(fixture, [], {
      input: JSON.stringify({
        source: corpusSource,
        base: scratch,
        theme,
        assets: corpusHtml.map((html, index) => ({ id: `math-${index}`, kind: 'math', html }))
      }),
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024
    });
    const corpusFile = path.join(scratch, 'corpus.html');
    fs.writeFileSync(corpusFile, corpusArtifact);
    const corpusPage = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    const corpusRequests = [];
    const corpusErrors = [];
    corpusPage.on('pageerror', error => corpusErrors.push(String(error)));
    await corpusPage.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith('file:') || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return route.continue();
      corpusRequests.push(url);
      return route.abort();
    });
    await corpusPage.goto(pathToFileURL(corpusFile).href);
    const corpusRendered = await corpusPage.evaluate(() => ({
      katex: document.querySelectorAll('.katex').length,
      fallback: document.querySelectorAll('.math-source').length
    }));
    assert.equal(corpusRendered.katex, corpus.length, 'the bundled KaTeX corpus all renders');
    assert.equal(corpusRendered.fallback, 0, 'no supported formula falls back');
    assert.deepEqual(corpusRequests, [], 'the corpus export needs no network');
    assert.deepEqual(corpusErrors, [], 'the corpus export raises no page errors');

    assert.deepEqual(external, [], 'the export flow makes no remote requests');
    assert.deepEqual(errors, [], 'the export flow raises no page errors');
    assert.deepEqual(offlineErrors, [], 'the exported document raises no page errors');
    console.log('PASS: HTML export renders math and diagrams from typed assets, preserves the selected theme, embeds local media and fonts, blocks remote media, and opens offline with no scripts or network.');
  } finally {
    await browser.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
