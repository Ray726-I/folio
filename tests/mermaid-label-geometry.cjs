const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.resolve('ui/mermaid-renderer.html')).href);
    for (const [name, source, label] of [
      ['cylinder', 'flowchart TD\n A[Start] --> B[(Save result)]', 'Save result'],
      ['mindmap circle', 'mindmap\n root((Markdown))\n   Branch\n     Leaf', 'Markdown'],
      ['mindmap rounded', 'mindmap\n root(Root topic)\n   Ideas\n     First leaf', 'Root topic'],
      ['mindmap explicit child', 'mindmap\n Root\n   Branch\n     child((Child circle))\n   Other\n     More', 'Child circle'],
      ['mindmap default box', 'mindmap\n Root\n   Branch\n     Leaf', 'Branch']
    ]) {
      const geometry = await page.evaluate(async ({ source, label }) => {
        const result = await FolioMermaidRenderer.renderRequest({ source });
        const host = document.createElement('div'); host.innerHTML = result.svg; document.body.append(host);
        const node = [...host.querySelectorAll('.node')].find(n => n.textContent.trim() === label);
        const shape = node.querySelector('.label-container, .node-bkg');
        const text = node.querySelector('text');
        const a = shape.getBoundingClientRect(), b = text.getBoundingClientRect();
        host.remove();
        return { shape: { left: a.left, right: a.right }, text: { left: b.left, right: b.right } };
      }, { source, label });
      assert.ok(geometry.text.left >= geometry.shape.left - 1 && geometry.text.right <= geometry.shape.right + 1,
        `${name}: label must fit inside shape: ${JSON.stringify(geometry)}`);
      assert.ok(Math.abs((geometry.text.left + geometry.text.right) - (geometry.shape.left + geometry.shape.right)) < 4,
        `${name}: label must be centered: ${JSON.stringify(geometry)}`);
    }
    console.log('PASS: Mermaid shape labels are centered and fit');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
