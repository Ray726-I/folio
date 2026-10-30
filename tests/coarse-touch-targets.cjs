const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

// P3 regression: the accepted unified-editor design spec requires 44px touch
// targets (spec section 3, "Touch: 44px targets"), but the coarse-pointer
// overrides shipped 36px/30px boxes with 34px/32px/30px heights
// (ui/styles.css @media(pointer:coarse)). This check loads the real page over
// a local server, reads the live stylesheet through the CSSOM (so the cascade
// the browser actually applies is what gets verified), and fails if any
// coarse-pointer size for the touch controls is below 44px. Desktop styling
// must stay compact, so it also asserts the fine-pointer rendering is still
// under 44px.
const TARGET = 44;
const SELECTORS = ['.icon-button', '.icon-button.tiny', '.segmented button', '.outline-link', '.folder-entry'];
const SIZE_PROPS = ['width', 'height', 'minWidth', 'minHeight'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
};

function startServer() {
  const server = http.createServer((req, res) => {
    const file = path.normalize(path.join(REPO_ROOT, decodeURIComponent(req.url.split('?')[0])));
    if (!file.startsWith(REPO_ROOT)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const px = value => {
  const match = /([\d.]+)px/.exec(value || '');
  return match ? parseFloat(match[1], 10) : null;
};

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const port = server.address().port;
    const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
      window.docContent = '# Doc\n\nText\n';
      window.__TAURI__ = {
        core: { invoke: async (command, args = {}) => {
          if (command === 'bootstrap') return { paths: [], platform: 'linux', theme: null };
          if (command === 'open_document') return { path: '/tmp/doc.md', name: 'doc.md', content: window.docContent, lineEnding: 'LF' };
          if (command === 'render_markdown') return { html: '<h1 id="doc">Doc</h1><p>Text</p>', blocks: [] };
          return null;
        } },
        event: { listen: async () => () => {} },
        webview: { getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }
      };
    });
    await page.goto(`http://127.0.0.1:${port}/ui/index.html`);
    await page.waitForFunction(() => typeof busy !== 'undefined' && !busy, null, { timeout: 15000 });

    const { coarse, coarsePointer } = await page.evaluate(() => {
      const found = [];
      for (const sheet of document.styleSheets) {
        let rules = null;
        try { rules = sheet.cssRules; } catch { continue; }
        if (!rules) continue;
        for (const rule of rules) {
          if (rule.type === CSSRule.MEDIA_RULE && /pointer\s*:\s*coarse/.test(rule.conditionText)) {
            for (const inner of rule.cssRules) {
              if (inner.type === CSSRule.STYLE_RULE) {
                found.push({
                  selector: inner.selectorText,
                  width: inner.style.getPropertyValue('width'),
                  height: inner.style.getPropertyValue('height'),
                  minWidth: inner.style.getPropertyValue('min-width'),
                  minHeight: inner.style.getPropertyValue('min-height')
                });
              }
            }
          }
        }
      }
      return { coarse: found, coarsePointer: window.matchMedia('(pointer:coarse)').matches };
    });

    assert(coarse.length > 0, 'expected @media(pointer:coarse) rules in the live stylesheet');
    assert.equal(coarsePointer, false, 'the test viewport should be a fine-pointer context so desktop rendering stays verifiable');

    for (const selector of SELECTORS) {
      const matches = coarse.filter(entry => entry.selector.split(',').map(part => part.trim()).includes(selector));
      assert(matches.length > 0, `expected an @media(pointer:coarse) rule for ${selector}`);
      const declared = [];
      for (const match of matches) {
        for (const prop of SIZE_PROPS) {
          const value = px(match[prop]);
          if (value !== null) declared.push({ prop, value });
        }
      }
      assert(declared.length > 0, `expected a coarse-pointer size for ${selector}`);
      for (const { prop, value } of declared) {
        assert(
          value >= TARGET,
          `coarse-pointer ${selector} declares ${prop}: ${value}px, expected at least ${TARGET}px`
        );
      }
      const heights = declared.filter(entry => entry.prop === 'height' || entry.prop === 'minHeight');
      assert(heights.length > 0, `expected a coarse-pointer height for ${selector}`);
      assert(
        heights.some(entry => entry.value >= TARGET),
        `coarse-pointer ${selector} needs a height of at least ${TARGET}px`
      );
    }

    // Desktop (fine pointer) keeps the compact chrome: the coarse 44px floor
    // must not leak into the base rules. #palette-open is always visible,
    // unlike the document controls that stay hidden until a file opens.
    const desktopBox = await page.locator('#palette-open.icon-button').boundingBox();
    assert(desktopBox, 'expected the header icon button to be measurable on desktop');
    assert(
      desktopBox.width < TARGET && desktopBox.height < TARGET,
      `desktop icon button should stay compact, got ${Math.round(desktopBox.width)}x${Math.round(desktopBox.height)}px`
    );

    assert.deepEqual(errors, []);
    console.log('PASS: coarse-pointer icon, segmented, outline, and folder controls all declare >=44px targets while desktop chrome stays compact.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
