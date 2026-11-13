const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');

// Cylinder preview-boundary regression: flowchart cylinder labels
// (Save result) are positioned from the measured text bbox. Chromium's
// getBBox reflects text-anchor:middle, but the native WebKit webview
// returns the unanchored box, leaving the label half a width left of the
// shape. Isolated renderer tests miss this because they measure and
// display in the same Chromium engine without the real preview host.
// This test renders with the real theme, simulates the native WebKit
// measurement, and inserts via the real preview boundary
// (.mermaid-host inside .markdown with styles.css plus preview.js
// showDiagramSvg width handling) before measuring centering.
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const appPage = await browser.newPage({ viewport: { width: 1120, height: 800 } });
    await appPage.goto(pathToFileURL(path.resolve('ui/index.html')).href);
    await appPage.waitForTimeout(1200);
    const theme = await appPage.evaluate(() => {
      try { return { variables: mermaidThemeVariables(), css: mermaidThemeCSS() }; }
      catch { return { variables: {}, css: '' }; }
    });
    await appPage.close();

    const rendererPage = await browser.newPage();
    await rendererPage.goto(pathToFileURL(path.resolve('ui/mermaid-renderer.html')).href);
    const source = 'flowchart TD\n A[Start] --> B[(Save result)]';
    const svg = await rendererPage.evaluate(async ({ source, theme }) => {
      const original = SVGGraphicsElement.prototype.getBBox;
      SVGGraphicsElement.prototype.getBBox = function () {
        const box = original.call(this);
        const tag = (this.tagName || '').toLowerCase();
        if (tag === 'g' && this.classList.contains('label')) {
          return { x: 0, y: box.y, width: box.width, height: box.height };
        }
        if (tag === 'text') {
          try {
            if (window.getComputedStyle(this).textAnchor === 'middle') {
              return { x: 0, y: box.y, width: box.width, height: box.height };
            }
          } catch {}
        }
        return box;
      };
      try {
        return (await FolioMermaidRenderer.renderRequest({ source, theme })).svg;
      } finally {
        SVGGraphicsElement.prototype.getBBox = original;
      }
    }, { source, theme });
    await rendererPage.close();

    const styles = fs.readFileSync(path.resolve('ui/styles.css'), 'utf8');
    const diagramCss = fs.readFileSync(path.resolve('ui/diagram-viewer.css'), 'utf8');
    const harnessPath = path.resolve('node_modules/.cache/folio-cylinder-harness.html');
    fs.mkdirSync(path.dirname(harnessPath), { recursive: true });
    fs.writeFileSync(harnessPath, `<!doctype html><html><head><meta charset="utf-8"><style>${styles}\n${diagramCss}</style></head><body><article id="preview" class="markdown" style="width:800px;margin:0 auto"></article></body></html>`);
    const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
    await page.goto(pathToFileURL(harnessPath).href);
    const geometry = await page.evaluate(async (svg) => {
      const preview = document.querySelector('#preview');
      const pre = document.createElement('pre');
      pre.append(Object.assign(document.createElement('code'), { className: 'language-mermaid', textContent: 'x' }));
      preview.append(pre);
      const host = document.createElement('div');
      host.className = 'mermaid-host';
      host.innerHTML = svg;
      const drawing = host.querySelector('svg');
      const width = drawing?.viewBox?.baseVal?.width;
      if (width > 0) {
        drawing.style.width = `clamp(clamp(${Math.ceil(width * .5)}px, calc(${Math.ceil(width)}px - 100%), ${Math.ceil(width * .75)}px), 100%, ${Math.ceil(width)}px)`;
        drawing.style.maxWidth = 'none';
      }
      pre.replaceWith(host);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return ['Start', 'Save result'].map(label => {
        const node = [...host.querySelectorAll('.node')].find(candidate => candidate.textContent.trim() === label);
        const shape = node.querySelector('.label-container, .node-bkg');
        const text = node.querySelector('text');
        const shapeBox = shape.getBoundingClientRect();
        const textBox = text.getBoundingClientRect();
        return { label, shape: { left: shapeBox.left, right: shapeBox.right }, text: { left: textBox.left, right: textBox.right } };
      });
    }, svg);

    for (const { label, shape, text } of geometry) {
      assert.ok(text.left >= shape.left - 1 && text.right <= shape.right + 1,
        `${label}: label must fit inside shape: ${JSON.stringify({ shape, text })}`);
      const offset = Math.abs((text.left + text.right) - (shape.left + shape.right));
      assert.ok(offset < 4, `${label}: label must be centered (offset ${offset}): ${JSON.stringify({ shape, text })}`);
    }
    console.log('PASS: cylinder preview boundary labels are centered (native WebKit simulation)');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
