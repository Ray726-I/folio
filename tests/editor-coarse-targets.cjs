const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Coarse-pointer touch targets for the audited editor controls.
//
// On fine pointers, task checkboxes measure 16x16, math edit buttons
// ~34x28, and the Open split controls 40x32 high. ui/styles.css keeps those
// compact desktop visuals and grows each hit box to at least 44x44 only
// under @media(pointer:coarse), with the checkbox glyph staying 16px inside
// a transparent 44px native box.
//
// This check renders the production chrome (same header/article
// class names as ui/index.html and the editor widgets) against the real
// stylesheet, then measures the actual clickable boxes: >=44x44 under a
// coarse pointer, compact under a fine pointer, non-overlapping at 1120px
// and at a narrow 360px viewport, with the checkbox still toggling when the
// transparent padding zone is tapped.
const TARGET = 44;
const TOLERANCE = 2;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
};

const FIXTURE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/ui/styles.css">
</head>
<body>
<header class="headerbar">
  <div class="header-start">
    <div class="open-group" id="open-group">
      <button id="open" class="button ghost open-main"><svg class="icon" aria-hidden="true"></svg><span>Open</span></button>
      <button id="open-chevron" class="button ghost open-chevron" aria-label="More open options"><svg class="icon" aria-hidden="true"></svg></button>
    </div>
  </div>
  <div class="window-title"><div class="window-title-line"><span>Folio</span></div></div>
  <div class="header-end"><button id="home" class="icon-button" aria-label="Go to welcome screen"><svg class="icon" aria-hidden="true"></svg></button></div>
</header>
<main id="workspace">
  <div class="reader-scroll">
    <article class="markdown" id="preview">
      <div class="ProseMirror">
      <h1>Targets</h1>
      <ul>
        <li class="task-item"><input type="checkbox" id="t1"> task one</li>
        <li class="task-item"><input type="checkbox" id="t2" checked> task two
          <ul>
            <li class="task-item"><input type="checkbox" id="t3"> nested task</li>
          </ul>
        </li>
      </ul>
      <ul>
        <li><input type="checkbox" id="r1"> raw task</li>
      </ul>
      <p>Formula <span class="math-inline"><span class="math-formula">x^2</span><button class="math-edit" id="m1">Edit</button></span> tail.</p>
      <p>Second paragraph keeps its distance.</p>
      </div>
    </article>
  </div>
</main>
</body>
</html>`;

function startServer() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/__coarse_fixture__') {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(FIXTURE);
      return;
    }
    const file = path.normalize(path.join(REPO_ROOT, url));
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

const SELECTORS = [
  '#t1',
  '#t2',
  '#t3',
  '#r1',
  '#m1',
  '#open',
  '#open-chevron'
];

async function boxes(page) {
  const found = {};
  for (const selector of SELECTORS) {
    const box = await page.locator(selector).boundingBox();
    assert(box, `expected ${selector} to be measurable`);
    found[selector] = box;
  }
  return found;
}

function overlapping(a, b) {
  const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return x > TOLERANCE && y > TOLERANCE;
}

async function assertNoOverlaps(rects) {
  const keys = Object.keys(rects);
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      assert(
        !overlapping(rects[keys[i]], rects[keys[j]]),
        `${keys[i]} overlaps ${keys[j]}: touch targets must not cover each other`
      );
    }
  }
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/__coarse_fixture__`;

    // Desktop (fine pointer): compact chrome, no 44px floor leaking in.
    {
      const context = await browser.newContext({ viewport: { width: 1120, height: 800 } });
      const page = await context.newPage();
      await page.goto(url);
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => matchMedia('(pointer:coarse)').matches), false);
      const rects = await boxes(page);
      for (const selector of SELECTORS) {
        if (selector === '#open') {
          assert(rects[selector].height < TARGET, `desktop ${selector} stays compact, got ${Math.round(rects[selector].height)}px tall`);
          continue;
        }
        assert(
          rects[selector].width < TARGET && rects[selector].height < TARGET,
          `desktop ${selector} stays compact, got ${Math.round(rects[selector].width)}x${Math.round(rects[selector].height)}px`
        );
      }
      // Native desktop glyphs: 16px task boxes, small inline buttons.
      assert(Math.round(rects['#t1'].width) <= 20, 'desktop task checkbox keeps its small visual');
      await context.close();
    }

    // Touch (coarse pointer): every audited control reaches 44x44.
    for (const viewport of [{ width: 1120, height: 800 }, { width: 360, height: 800 }]) {
      const context = await browser.newContext({ viewport, hasTouch: true });
      const page = await context.newPage();
      await page.goto(url);
      await page.waitForTimeout(500);
      assert.equal(
        await page.evaluate(() => matchMedia('(pointer:coarse)').matches),
        true,
        `viewport ${viewport.width}px should emulate a coarse pointer`
      );
      const rects = await boxes(page);
      for (const selector of SELECTORS) {
        const box = rects[selector];
        assert(
          box.width >= TARGET && box.height >= TARGET,
          `coarse-pointer ${selector} needs a ${TARGET}px hit box at ${viewport.width}px, got ${Math.round(box.width)}x${Math.round(box.height)}px`
        );
      }
      await assertNoOverlaps(rects);

      // The checkbox hit box must not cover its own label text.
      const textOverlap = await page.evaluate(() => {
        const input = document.getElementById('t1');
        const box = input.getBoundingClientRect();
        const text = [...input.closest('li').childNodes].find(node => node.nodeType === 3 && node.textContent.trim());
        const range = document.createRange();
        range.selectNodeContents(text);
        const label = range.getBoundingClientRect();
        return { boxRight: box.right, labelLeft: label.left };
      });
      assert(
        textOverlap.boxRight <= textOverlap.labelLeft + 1,
        `task hit box must not cover its label (box ends ${textOverlap.boxRight}, label starts ${textOverlap.labelLeft})`
      );

      // Narrow viewports must not gain a sideways scrollbar from the growth.
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth
      }));
      assert(
        overflow.scroll <= overflow.inner + 1,
        `no horizontal overflow at ${viewport.width}px (scrollWidth ${overflow.scroll})`
      );
      await context.close();
    }

    // The enlarged checkbox still toggles, including taps on the transparent
    // padding zone (6px inside the 44px box, outside the 16px glyph).
    {
      const context = await browser.newContext({ viewport: { width: 1120, height: 800 }, hasTouch: true });
      const page = await context.newPage();
      await page.goto(url);
      await page.waitForTimeout(500);
      await page.evaluate(() => { document.getElementById('t1').checked = false; });
      const box = await page.locator('#t1').boundingBox();
      await page.mouse.click(box.x + 6, box.y + box.height / 2);
      assert.equal(await page.evaluate(() => document.getElementById('t1').checked), true, 'tapping the hit-box padding checks the task');
      await page.mouse.click(box.x + 6, box.y + box.height / 2);
      assert.equal(await page.evaluate(() => document.getElementById('t1').checked), false, 'tapping again unchecks the task');
      await page.locator('#t1').click();
      assert.equal(await page.evaluate(() => document.getElementById('t1').checked), true, 'clicking the glyph still toggles the task');
      await context.close();
    }

    console.log('PASS: task checkbox, math edit, and Open controls reach 44x44 hit boxes on coarse pointers, stay compact on desktop, never overlap, and tasks keep toggling.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
