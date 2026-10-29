'use strict';
// Deterministic browser harness for the offline Mermaid renderer.
//
// This test does NOT prove Tauri/Wry IPC isolation. It proves:
// - the renderer document's actual CSP (read from src/renderer.rs) blocks
//   external image/network requests before they reach the network,
// - hostile Mermaid labels and image metadata produce no external request,
// - the structured SVG sanitizer removes scripts/images/event handlers/CSS
//   URL references before a result is handed to the parent,
// - the renderer's bounded result transport receives sanitized SVG or a
//   structured failure,
// - a control page without the renderer CSP does issue the external request,
//   so the harness would fail if the boundary regressed.

const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = path.join(root, 'ui');
const rust = fs.readFileSync(path.join(root, 'src/renderer.rs'), 'utf8');
const cspMatch = /pub const RENDERER_CSP: &str = "([^"]+)";/.exec(rust);
assert.ok(cspMatch, 'renderer CSP must be present in src/renderer.rs');
const rendererCsp = cspMatch[1];
const rendererHtml = fs.readFileSync(path.join(ui, 'mermaid-renderer.html'), 'utf8');
assert.ok(rendererHtml.includes(`content="${rendererCsp}"`), 'renderer HTML must repeat the actual CSP before scripts');
const tauriConfig = JSON.parse(fs.readFileSync(path.join(root, 'tauri.conf.json'), 'utf8'));
const mainCsp = tauriConfig.app.security.csp;
assert.ok(mainCsp.includes("img-src 'self' data: https:"), 'main CSP must remain permissive for document images');
const nativeSanitizedCommentBypass = fs.readFileSync(
  path.join(root, 'tests/fixtures/native-sanitized-comment-bypass.svg'),
  'utf8'
).trim();
const nativeSanitizedEscapedUrl = fs.readFileSync(
  path.join(root, 'tests/fixtures/native-sanitized-escaped-url.svg'),
  'utf8'
).trim();

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

const controlPage = `<!doctype html>
<html><body>
<script src="/vendor/mermaid/mermaid.min.js"></script>
<script>
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', htmlLabels: true });
  mermaid.render('control', 'flowchart TD\\n A["<img src=\\'https://example.com/control.png\\'>"]')
    .then(({ svg }) => { document.body.insertAdjacentHTML('beforeend', svg); });
</script>
</body></html>`;

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url, 'http://127.0.0.1');
      if (requestUrl.pathname === '/control.html') {
        response.writeHead(200, { 'content-type': contentTypes['.html'] });
        response.end(controlPage);
        return;
      }
      if (requestUrl.pathname === '/main-csp.html') {
        response.writeHead(200, {
          'content-type': contentTypes['.html'],
          'content-security-policy': mainCsp
        });
        response.end('<!doctype html><html><body></body></html>');
        return;
      }
      const relative = decodeURIComponent(requestUrl.pathname === '/' ? '/mermaid-renderer.html' : requestUrl.pathname);
      const file = path.resolve(ui, `.${relative}`);
      if (!file.startsWith(`${ui}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      fs.readFile(file, (error, data) => {
        if (error) {
          response.writeHead(404).end();
          return;
        }
        const headers = { 'content-type': contentTypes[path.extname(file)] || 'application/octet-stream' };
        if (relative.endsWith('mermaid-renderer.html')) headers['content-security-policy'] = rendererCsp;
        response.writeHead(200, headers);
        response.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function installTransport(page) {
  await page.addInitScript(() => {
    window.__results = [];
    window.__listeners = {};
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      window.__cspViolations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
    });
    window.__TAURI__ = {
      core: {
        invoke: async (command, args = {}) => {
          if (command === 'mermaid_renderer_ready') return null;
          if (command === 'mermaid_render_result') { window.__results.push(args); return null; }
          throw new Error(`Command ${command} is not available to the renderer`);
        }
      },
      event: {
        listen: async (name, callback) => {
          (window.__listeners[name] ||= []).push(callback);
          return () => {};
        }
      }
    };
  });
}

async function interruptExternal(page, origin, external) {
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) {
      await route.continue();
      return;
    }
    external.push(url);
    await route.abort('blockedbyclient');
  });
}

async function requestDiagram(page, request) {
  const count = await page.evaluate(() => window.__results.length);
  await page.evaluate(payload => {
    for (const listener of window.__listeners['mermaid-render-request'] || []) listener({ payload });
  }, request);
  await page.waitForFunction(previous => window.__results.length > previous, count, { timeout: 15000 });
  return page.evaluate(() => window.__results[window.__results.length - 1]);
}

(async () => {
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  const external = [];
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await installTransport(page);
    await interruptExternal(page, origin, external);

    const response = await page.goto(`${origin}/mermaid-renderer.html`);
    assert.equal(response.headers()['content-security-policy'], rendererCsp, 'renderer response must carry the strict CSP');
    await page.waitForFunction(() => window.FolioMermaidRenderer && window.__listeners['mermaid-render-request']?.length);

    const sanitizer = await page.evaluate(() => window.FolioMermaidRenderer.sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
        '<script>alert(1)</script>' +
        '<image href="https://example.com/pixel.png"/>' +
        '<foreignObject><img src="https://example.com/inner.png"/></foreignObject>' +
        '<g style="fill:url(https://example.com/fill.png)" href="javascript:alert(1)">' +
          '<path d="M0 0" onclick="alert(1)" fill="url(#local)"/>' +
        '</g>' +
      '</svg>'
    ));
    assert.equal(sanitizer.external, true, 'sanitizer must report external resources');
    const sanitizedLower = sanitizer.svg.toLowerCase();
    for (const forbidden of ['<script', '<image', '<foreignobject', '<img', 'onload=', 'onclick=', 'javascript:', 'https://', 'url(http', 'url(https']) {
      assert.ok(!sanitizedLower.includes(forbidden), `sanitized SVG must not contain ${forbidden}`);
    }
    assert.ok(sanitizedLower.includes('url(#local)'), 'local gradient references must survive sanitization');

    const safe = await page.evaluate(() => window.FolioMermaidRenderer.sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><g fill="url(#g)"><path d="M0 0"/></g></svg>'
    ));
    assert.equal(safe.external, false, 'ordinary local SVG must remain usable');
    assert.ok(safe.svg.includes('url(#g)'));

    const commentBypass = await page.evaluate(() => window.FolioMermaidRenderer.sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="background-image:u/**/rl(h/**/ttps:example.com/leak.png)"/><path fill="u/**/rl(h/**/ttps:example.com/fill.png)"/></svg>'
    ));
    const commentLower = commentBypass.svg.toLowerCase();
    assert.ok(!commentLower.includes('url('), 'comments must become spaces, not join into url()');
    assert.ok(!commentLower.includes('https:'), 'joined scheme must not survive comment stripping');
    assert.ok(commentLower.includes('u rl('), 'comment replacement must leave a separator');

    const escapedUrl = await page.evaluate(() => window.FolioMermaidRenderer.sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style=\'background-image:url("ht\\a tps:example.com/p.png")\'/></svg>'
    ));
    const escapedLower = escapedUrl.svg.toLowerCase();
    assert.ok(!escapedLower.includes('url('), 'escaped quoted URL must be neutralised');
    assert.ok(!escapedLower.includes('example.com'), 'escaped quoted URL must not keep the host');

    const escapedFunction = await page.evaluate(() => window.FolioMermaidRenderer.sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style=\'background-image:image("ht\\a tps:example.com/p.png")\'/></svg>'
    ));
    assert.ok(!escapedFunction.svg.toLowerCase().includes('example.com'), 'escaped quoted function string must not keep the host');

    const cssTimings = await page.evaluate(() => {
      const timings = {};
      for (const size of [32768, 65536, 131072, 262144]) {
        const css = 'fill:#fff;'.repeat(Math.ceil(size / 10)).slice(0, size);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style></svg>`;
        const started = performance.now();
        window.FolioMermaidRenderer.sanitizeSvg(svg);
        timings[size] = performance.now() - started;
      }
      return timings;
    });
    assert.ok(cssTimings[262144] < 1000, `renderer CSS sanitizer must be linear; got ${JSON.stringify(cssTimings)}`);
    console.log(`renderer CSS sanitizer ms: ${JSON.stringify(cssTimings)}`);

    // The response header/meta CSP itself must block a renderer-side fetch and
    // image load, not merely our source pre-check or sanitizer.
    const blocked = await page.evaluate(async () => {
      let fetchBlocked = false;
      try { await fetch('https://example.com/connect'); } catch { fetchBlocked = true; }
      const image = document.createElement('img');
      image.src = 'https://example.com/csp-probe.png';
      document.body.append(image);
      await new Promise(resolve => setTimeout(resolve, 200));
      image.remove();
      return {
        fetchBlocked,
        directives: window.__cspViolations.map(violation => violation.directive)
      };
    });
    assert.equal(blocked.fetchBlocked, true, 'connect-src must block renderer fetch');
    assert.ok(blocked.directives.some(directive => directive.includes('img-src')), 'img-src must report a blocked image');
    assert.deepEqual(external, [], 'CSP-blocked probe traffic must not reach the network');

    // Exercise Mermaid itself with an HTML label containing a remote image,
    // bypassing the source pre-check. The renderer CSP must still prevent the
    // network request even during mermaid.render and when the raw SVG is
    // inserted locally.
    const direct = await page.evaluate(async () => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', htmlLabels: true });
      const { svg } = await mermaid.render('direct-image-probe', `flowchart TD
 A["<img src='https://example.com/direct.png'>"]`);
      document.body.insertAdjacentHTML('beforeend', svg);
      await new Promise(resolve => setTimeout(resolve, 200));
      return svg;
    });
    assert.ok(direct.includes('svg'));
    assert.deepEqual(external, [], 'mermaid.render must not reach the network under the renderer CSP');
    await page.evaluate(() => {
      document.querySelectorAll('svg').forEach(svg => {
        if (!svg.closest('.keep')) svg.remove();
      });
    });

    // Hostile HTML label: rejected before Mermaid can request the image.
    const label = await requestDiagram(page, {
      id: 'mermaid-label',
      source: 'flowchart TD\n A["<img src=\'https://example.com/label.png\'>"]',
      theme: { variables: { background: '#ffffff' } }
    });
    assert.equal(label.id, 'mermaid-label');
    assert.equal(label.result.error.code, 'unsupported_external_images');
    assert.deepEqual(external, [], 'hostile label must cause zero external requests');

    // Mermaid image-node metadata is likewise unsupported offline.
    const imageNode = await requestDiagram(page, {
      id: 'mermaid-image-node',
      source: 'flowchart LR\n A@{ img: "https://example.com/node.png", label: "Node" } --> B',
      theme: { variables: { background: '#ffffff' } }
    });
    assert.equal(imageNode.result.error.code, 'unsupported_external_images');
    assert.deepEqual(external, [], 'image-node metadata must cause zero external requests');

    // Ordinary diagram, repeated render (theme refresh) and repeat IDs.
    const first = await requestDiagram(page, {
      id: 'mermaid-normal',
      source: 'flowchart TD\n A[Start] --> B[Finish]',
      theme: { variables: { background: '#ffffff', primaryColor: '#eeeeee', darkMode: false } }
    });
    assert.ok(first.result.svg.startsWith('<svg'), 'ordinary diagram must return sanitized SVG');
    assert.ok(!first.result.svg.toLowerCase().includes('example.com'), 'ordinary diagram must contain no external resources');

    const second = await requestDiagram(page, {
      id: 'mermaid-normal-refresh',
      source: 'flowchart TD\n A[Start] --> B[Finish]',
      theme: { variables: { background: '#101010', primaryColor: '#333333', darkMode: true } }
    });
    assert.ok(second.result.svg.startsWith('<svg'), 'theme refresh must return SVG');

    const sequence = await requestDiagram(page, {
      id: 'mermaid-sequence',
      source: 'sequenceDiagram\n Alice->>Bob: Hello\n Bob-->>Alice: Hi',
      theme: { variables: { background: '#ffffff', primaryColor: '#eeeeee' } }
    });
    assert.ok(sequence.result.svg && sequence.result.svg.includes('Hello'), 'ordinary sequence diagram must render text');

    const pie = await requestDiagram(page, {
      id: 'mermaid-pie',
      source: 'pie title Pets\n "Dogs": 3\n "Cats": 2',
      theme: { variables: { background: '#ffffff' } }
    });
    assert.ok(pie.result.svg && pie.result.svg.includes('Dogs'), 'ordinary pie diagram must render labels');

    const klass = await requestDiagram(page, {
      id: 'mermaid-class',
      source: 'classDiagram\n class Animal\n Animal : +String name',
      theme: { variables: { background: '#ffffff' } }
    });
    assert.ok(klass.result.svg && klass.result.svg.includes('Animal'), 'ordinary class diagram must render labels');

    assert.deepEqual(external, [], 'repeat renders must cause zero external requests');

    const malformed = await requestDiagram(page, {
      id: 'mermaid-broken',
      source: 'flowchart TD\n A -->',
      theme: { variables: {} }
    });
    assert.equal(malformed.result.error && malformed.result.error.code, 'render_failed');

    await page.evaluate(svg => document.body.insertAdjacentHTML('beforeend', svg), first.result.svg);
    await page.waitForTimeout(250);
    assert.deepEqual(external, [], 'inserting the sanitized SVG must not cause a request');
    assert.equal(await page.locator('svg').count() > 0, true);

    // Cancel-active watchdog: a hung Mermaid promise must not block the queue
    // after the cancellation grace, even if native recycling is delayed.
    const watchdog = await page.evaluate(async () => {
      const originalRender = window.mermaid.render;
      window.mermaid.render = () => new Promise(() => {});
      const dispatch = (name, payload) => {
        for (const listener of window.__listeners[name] || []) listener({ payload });
      };
      dispatch('mermaid-render-request', {
        id: 'watchdog-hang',
        source: 'flowchart TD\n Hang-->Forever',
        theme: { variables: {} }
      });
      await new Promise(resolve => setTimeout(resolve, 60));
      dispatch('mermaid-render-cancel', { id: 'watchdog-hang' });
      await new Promise(resolve => setTimeout(resolve, 1000));
      window.mermaid.render = originalRender;
      dispatch('mermaid-render-request', {
        id: 'watchdog-next',
        source: 'flowchart TD\n A-->B',
        theme: { variables: {} }
      });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const next = window.__results.find(item => item && item.id === 'watchdog-next');
        if (next) return { next };
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return { next: null };
    });
    assert.ok(watchdog.next && watchdog.next.result && watchdog.next.result.svg, 'cancel-active watchdog must release the queue');

    // The result path is bounded: the renderer only returns SVG or a structured
    // error and never invokes file/native commands (the mock throws for those).
    const calls = await page.evaluate(() => window.__results.map(result => Object.keys(result).sort().join(',')));
    assert.ok(calls.every(keys => keys === 'id,result'));

    assert.deepEqual(pageErrors, [], `renderer page errors: ${pageErrors.join('; ')}`);
    console.log(`offline renderer: ${external.length} external requests (expected 0)`);

    // Insert the sanitizer output under the actual MAIN document CSP. The
    // restricted renderer CSP would mask a leak; here the main CSP permits
    // https images, so any surviving external URL would be intercepted.
    const mainPage = await browser.newPage();
    const mainExternal = [];
    await interruptExternal(mainPage, origin, mainExternal);
    await mainPage.goto(`${origin}/main-csp.html`);
    await mainPage.evaluate(svg => document.body.insertAdjacentHTML('beforeend', svg), commentBypass.svg);
    await mainPage.evaluate(svg => document.body.insertAdjacentHTML('beforeend', svg), nativeSanitizedCommentBypass);
    await mainPage.evaluate(svg => document.body.insertAdjacentHTML('beforeend', svg), nativeSanitizedEscapedUrl);
    await mainPage.waitForTimeout(400);
    assert.deepEqual(mainExternal, [], 'sanitized SVG must not request under the main CSP');

    // Prove this main-CSP harness observes a leak if sanitization regresses.
    await mainPage.evaluate(svg => document.body.insertAdjacentHTML('beforeend', svg),
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="background-image:url(https://example.com/main-leak.png)"/></svg>');
    await mainPage.waitForTimeout(700);
    assert.ok(mainExternal.some(url => url.includes('example.com/main-leak.png')), `main-CSP leak probe should be intercepted; saw ${JSON.stringify(mainExternal)}`);
    console.log(`main CSP insertion: sanitized=0 raw-leak=${mainExternal.length} (all aborted)`);
    await mainPage.close();

    // Control page: no renderer CSP, so the same browser harness must observe
    // an aborted external image request. This is the regression signal.
    const control = await browser.newPage();
    const controlExternal = [];
    await interruptExternal(control, origin, controlExternal);
    await control.goto(`${origin}/control.html`);
    await control.waitForTimeout(1500);
    assert.ok(controlExternal.some(url => url.includes('example.com/control.png')), `control page should attempt an external image request; saw ${JSON.stringify(controlExternal)}`);
    console.log(`control renderer: ${controlExternal.length} external request(s) intercepted and aborted`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
