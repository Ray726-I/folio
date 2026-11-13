const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const remote = [];
    await page.route(/^https?:/, route => { remote.push(route.request().url()); return route.abort(); });
    await page.goto(pathToFileURL(path.resolve('ui/mermaid-renderer.html')).href);
    const result = await page.evaluate(async () => {
      const source = 'mindmap\n  root((Center))\n    Alpha\n      One\n      Two\n    Beta\n      Three\n    Gamma\n      Four\n    Delta\n      Five';
      const { svg } = await FolioMermaidRenderer.renderRequest({ source });
      const host = document.createElement('div'); host.innerHTML = svg; document.body.append(host);
      const positions = Object.fromEntries([...host.querySelectorAll('.mindmap-node')].map(node => {
        const box = node.getBoundingClientRect();
        return [node.textContent.trim(), { x: box.x + box.width / 2, y: box.y + box.height / 2 }];
      }));
      const paths = [...host.querySelectorAll('.edgePaths path')].map(p => p.getAttribute('d'));
      const root = [...host.querySelectorAll('.mindmap-node')].find(n => n.textContent.trim() === 'Center');
      const circle = root.querySelector('circle');
      const circleBox = circle.getBoundingClientRect();
      const rootEdges = [...host.querySelectorAll('.edgePaths path[data-id^="edge_0_"]')].map(path => {
        const start = path.getPointAtLength(0).matrixTransform(path.getScreenCTM());
        const cx = circleBox.x + circleBox.width / 2, cy = circleBox.y + circleBox.height / 2;
        return { dx: start.x - cx, distance: Math.hypot(start.x - cx, start.y - cy), radius: circleBox.width / 2 };
      });
      host.remove();
      return { positions, paths, rootEdges };
    });
    const { positions: p, paths } = result;
    assert.ok(['Alpha', 'Beta', 'Gamma', 'Delta'].every(x => p[x]), JSON.stringify(result));
    assert.equal(['Alpha', 'Beta', 'Gamma', 'Delta'].filter(x => p[x].x < p.Center.x).length, 2, JSON.stringify(result));
    assert.equal(['Alpha', 'Beta', 'Gamma', 'Delta'].filter(x => p[x].x > p.Center.x).length, 2, JSON.stringify(result));
    for (const [parent, child] of [['Alpha', 'One'], ['Alpha', 'Two'], ['Beta', 'Three'], ['Gamma', 'Four'], ['Delta', 'Five']]) {
      assert.ok(Math.abs(p[child].x - p.Center.x) > Math.abs(p[parent].x - p.Center.x), `${parent}/${child}: ${JSON.stringify(result)}`);
    }
    assert.ok(paths.length >= 9 && paths.every(d => /[CQ]/i.test(d)), JSON.stringify(paths));
    assert.ok(result.rootEdges.some(e => e.dx < 0) && result.rootEdges.some(e => e.dx > 0), JSON.stringify(result.rootEdges));
    assert.ok(result.rootEdges.every(e => e.distance <= e.radius + 0.5), `root connectors must meet the circle: ${JSON.stringify(result.rootEdges)}`);
    const compatibility = await page.evaluate(async () => {
      const source = 'mindmap\n  root((Center))\n    box[Box]\n      :::special\n      ::icon(fa fa-book)\n    round(Rounded)\n    hex{{Hex}}';
      const { svg } = await FolioMermaidRenderer.renderRequest({ source, theme: { variables: { primaryColor: '#123456' } } });
      const host = document.createElement('div'); host.innerHTML = svg;
      const nodes = [...host.querySelectorAll('.mindmap-node')];
      const node = label => nodes.find(n => n.textContent.trim() === label);
      const shapes = { circle: !!node('Center').querySelector('circle'), box: !!node('Box').querySelector('rect.label-container'), rounded: !!node('Rounded').querySelector('rect[rx]'), hex: !!node('Hex').querySelector('polygon'), className: node('Box').classList.contains('special') };
      const flow = await FolioMermaidRenderer.renderRequest({ source: 'flowchart LR\n A[Start] --> B[End]' });
      return { shapes, themed: svg.includes('#123456'), flow: flow.svg.includes('Start') && flow.svg.includes('End') };
    });
    assert.deepEqual(compatibility.shapes, { circle: true, box: true, rounded: true, hex: true, className: true });
    assert.ok(compatibility.themed && compatibility.flow, JSON.stringify(compatibility));
    assert.deepEqual(remote, [], 'mindmap must not request network resources');
    console.log('PASS: mindmap uses a balanced horizontal tree with curved connectors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
