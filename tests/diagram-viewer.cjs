const assert = require('node:assert/strict');
const path = require('node:path');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const source = '# Diagram\n\n```mermaid\ngraph TD;\nA-->B;\n```\n';
  const session = await openEditor(source);
  const { page } = session;
  try {
    const host = page.locator('#preview .mermaid-host');
    const expand = host.getByRole('button', { name: 'Expand diagram', exact: true });
    await host.locator('svg').waitFor();
    await expand.waitFor({ timeout: 2000 });
    assert.equal(await expand.textContent(), '', 'expand control is icon-only');
    assert.equal(await expand.getAttribute('title'), 'Expand diagram', 'icon retains a tooltip');
    assert.equal(await expand.getAttribute('contenteditable'), 'false', 'the action is outside the editable document');
    assert.equal(await expand.evaluate(button => getComputedStyle(button).opacity), '0', 'the action stays quiet at rest');
    await host.hover();
    assert.equal(await expand.evaluate(button => getComputedStyle(button).opacity), '1', 'hover reveals the action');
    if (process.env.FOLIO_DIAGRAM_SCREENSHOT) await expand.screenshot({ path: `${process.env.FOLIO_DIAGRAM_SCREENSHOT}.control.png` });
    await page.mouse.move(0, 0);
    await expand.focus();
    assert.equal(await expand.evaluate(button => getComputedStyle(button).opacity), '1', 'keyboard focus reveals the action');

    // The editor deliberately retains an old SVG during a pending re-render.
    // Only the successful current projection may be expanded.
    await host.evaluate(node => { node.dataset.diagramState = 'rendering'; });
    await expand.waitFor({ state: 'detached' });
    await host.evaluate(node => { node.dataset.diagramState = 'error'; });
    assert.equal(await expand.count(), 0, 'failed diagrams have no expand action');
    await host.evaluate(node => { node.dataset.diagramState = 'rendered'; });
    await expand.waitFor();
    await host.locator('svg').evaluate(svg => {
      svg.setAttribute('viewBox', '0 0 2400 1000');
      svg.setAttribute('id', 'test-diagram');
      svg.setAttribute('aria-labelledby', 'diagram-title');
      svg.innerHTML = '<title id="diagram-title">Example flow</title><style>#test-diagram text { fill:currentColor; }</style><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs><rect x="100" y="300" width="700" height="300" rx="30" fill="none" stroke="currentColor" stroke-width="8"/><rect x="1600" y="300" width="700" height="300" rx="30" fill="none" stroke="currentColor" stroke-width="8"/><path d="M 800 450 H 1580" stroke="currentColor" stroke-width="8" marker-end="url(#arrow)"/><text x="260" y="480" font-size="96">diagram</text>';
    });

    // Create an undo entry before opening: viewer actions must not consume or
    // create editor history, even while the editor DOM observer is running.
    await page.evaluate(() => { editor.selectRange(0); editor.focus(); });
    await page.keyboard.type('X');
    const before = await page.evaluate(() => current.content);
    const renders = await page.evaluate(() => calls.filter(call => call.command === 'mermaid_render_request').length);
    await expand.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Expanded diagram', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    assert.equal(await dialog.locator('svg text').textContent(), 'diagram', 'viewer reuses the rendered projection');
    assert.notEqual(await dialog.locator('svg').getAttribute('id'), 'test-diagram', 'cloned SVG ids do not collide');
    assert.equal(await dialog.locator('svg').evaluate(svg => svg.getAttribute('aria-labelledby') === svg.querySelector('title').id), true, 'accessible name references follow the cloned IDs');
    assert.equal(await dialog.locator('path[marker-end]').evaluate(node => node.getAttribute('marker-end') === `url(#${node.closest('svg').querySelector('marker').id})`), true, 'SVG fragment references follow cloned IDs');
    assert.equal(await dialog.getByRole('button', { name: 'Close diagram' }).evaluate(node => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => calls.filter(call => call.command === 'mermaid_render_request').length), renders, 'opening does not render again');
    const viewport = dialog.getByRole('region', { name: 'Diagram. Use arrow keys to scroll.' });
    assert.ok(await viewport.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1), 'initial fit stays within the viewport');
    if (process.env.FOLIO_DIAGRAM_SCREENSHOT) await page.screenshot({ path: `${process.env.FOLIO_DIAGRAM_SCREENSHOT}.light.png` });
    await dialog.getByRole('button', { name: 'Actual size' }).click();
    assert.ok(await viewport.evaluate(node => node.scrollWidth > node.clientWidth), 'actual size allows scrolling a large diagram');
    await viewport.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('.diagram-viewer-viewport').scrollLeft > 0);
    const actualWidth = await dialog.locator('svg').evaluate(node => node.getBoundingClientRect().width);
    await dialog.getByRole('button', { name: 'Zoom in' }).click();
    assert.ok(await dialog.locator('svg').evaluate(node => node.getBoundingClientRect().width) > actualWidth, 'zoom changes the diagram scale');
    await dialog.getByRole('button', { name: 'Fit diagram' }).click();
    assert.ok(await viewport.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Fit restores the overview');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await expand.evaluate(node => node === document.activeElement), true, 'Escape restores focus to the invoking action');
    assert.equal(await page.evaluate(() => current.content), before, 'viewer interactions leave Markdown unchanged');
    await expand.click();
    await dialog.waitFor();
    const panel = await dialog.boundingBox();
    const inside = { x: panel.x + 30, y: panel.y + 100 };
    await page.mouse.click(inside.x, inside.y);
    assert.equal(await dialog.isVisible(), true, 'clicks inside the panel keep it open');
    await page.mouse.move(inside.x, inside.y); await page.mouse.down();
    await page.mouse.move(1, 1, { steps: 8 }); await page.mouse.up();
    assert.equal(await dialog.isVisible(), true, 'dragging out of the panel does not dismiss it');
    await page.mouse.click(1, 1);
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await expand.evaluate(node => node === document.activeElement), true, 'backdrop dismissal restores opener focus');
    assert.equal(await page.evaluate(() => current.content), before, 'backdrop dismissal preserves the document');

    await page.evaluate(() => { editor.selectRange(0); editor.focus(); });
    await page.keyboard.press('Control+z');
    await page.waitForFunction(expected => current.content === expected, source);
    assert.equal(await page.evaluate(() => current.content), source, 'viewer interactions preserve the prior undo entry');

    // Native dialog focus containment, narrow themes, and file replacement.
    await expand.click();
    await dialog.waitFor();
    await page.setViewportSize({ width: 500, height: 700 });
    await page.evaluate(() => document.documentElement.dataset.theme = 'graphite');
    await viewport.focus();
    await page.keyboard.press('Tab');
    assert.equal(await dialog.getByRole('button', { name: 'Fit diagram' }).evaluate(node => node === document.activeElement), true, 'keyboard traversal wraps inside the native modal');
    assert.ok(await dialog.evaluate(node => node.getBoundingClientRect().width <= innerWidth), 'dialog fits a narrow window');
    if (process.env.FOLIO_DIAGRAM_SCREENSHOT) await page.screenshot({ path: process.env.FOLIO_DIAGRAM_SCREENSHOT });
    await page.evaluate(() => { window.documentSource = '# Another file\n'; return requestOpenLocation('/tmp/other.md'); });
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await dialog.locator('svg').count(), 0, 'switching files clears the cloned diagram');
    assert.deepEqual(session.errors, []);
    assert.deepEqual(session.requests, [], 'viewer makes no network requests');

    // The non-editor preview path has no diagram-state attribute. It uses
    // the same sanitized SVG host, and touch still exposes a usable action.
    const touchPage = await session.browser.newPage({ hasTouch: true, viewport: { width: 375, height: 700 } });
    await touchPage.setContent('<article id="preview" class="markdown" style="width:100%;box-sizing:border-box"><div class="mermaid-host"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text x="10" y="50">Preview diagram</text></svg></div></article>');
    await touchPage.addStyleTag({ path: path.resolve('ui/styles.css') });
    await touchPage.addStyleTag({ path: path.resolve('ui/diagram-viewer.css') });
    await touchPage.addScriptTag({ path: path.resolve('ui/diagram-viewer.js') });
    assert.equal(await touchPage.evaluate(() => matchMedia('(pointer:coarse)').matches), true);
    const touchExpand = touchPage.getByRole('button', { name: 'Expand diagram' });
    assert.equal(await touchExpand.evaluate(node => getComputedStyle(node).opacity), '1', 'touch exposes the action without hover');
    assert.ok(await touchExpand.evaluate(node => node.offsetWidth >= 44 && node.offsetHeight >= 44), 'Expand has a 44px touch target');
    await touchExpand.tap();
    const touchDialog = touchPage.getByRole('dialog', { name: 'Expanded diagram' });
    await touchDialog.waitFor();
    assert.equal(await touchDialog.locator('svg text').textContent(), 'Preview diagram');
    assert.ok(await touchDialog.getByRole('button').evaluateAll(nodes => nodes.every(node => node.offsetWidth >= 44 && node.offsetHeight >= 44)), 'all viewer controls have 44px touch targets');
    await touchDialog.getByRole('button', { name: 'Close diagram' }).tap();
    await touchDialog.waitFor({ state: 'hidden' });
    await touchExpand.tap();
    await touchDialog.waitFor();
    await touchPage.touchscreen.tap(1, 1);
    await touchDialog.waitFor({ state: 'hidden' });
    assert.equal(await touchExpand.evaluate(node => node === document.activeElement), true, 'touch backdrop dismissal restores focus');
    const cloneCost = await touchPage.evaluate(async () => {
      const svg = document.querySelector('.mermaid-host svg');
      // A legitimate ID can equal a hex color; only references to the ID may
      // change. Thousands of IDs should still open without blocking the UI.
      svg.innerHTML = '<defs><linearGradient id="fff"><stop stop-color="#fff"/></linearGradient></defs><style>#fff { color:#fff; } @media screen { #fff { stroke:#fff; } }</style><rect id="colored" fill="#fff" style="stroke:#fff;fill:url(#fff)"/>';
      const nodes = document.createDocumentFragment();
      for (let index = 0; index < 2000; index++) {
        const node = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        node.id = `many-${index}`; node.setAttribute('fill', '#fff');
        nodes.append(node);
      }
      svg.append(nodes);
      const viewer = document.querySelector('.diagram-viewer');
      const opener = document.querySelector('.diagram-expand');
      const start = performance.now();
      opener.click();
      const closed = new Promise(resolve => viewer.addEventListener('close', resolve, { once: true }));
      viewer.close(); opener.click();
      await closed; // Flush the old native close event after the new open.
      return performance.now() - start;
    });
    const clonedColor = touchDialog.locator('rect[id$="-colored"]');
    assert.equal(await clonedColor.getAttribute('fill'), '#fff', 'hex color values are not fragment references');
    assert.match(await clonedColor.getAttribute('style'), /stroke:\s*#fff/, 'inline color values are preserved');
    const css = await touchDialog.locator('svg style').textContent();
    assert.match(css, /#folio-expanded-\d+-fff\s*\{\s*color:#fff/, 'CSS selectors change while declaration colors stay intact');
    assert.match(css, /@media screen\s*\{\s*#folio-expanded-\d+-fff\s*\{\s*stroke:#fff/, 'nested selectors keep their colors');
    assert.ok(cloneCost < 2000, `opening a 2000-ID diagram should remain responsive (took ${Math.round(cloneCost)}ms)`);
    await touchDialog.getByRole('button', { name: 'Close diagram' }).tap();
    await touchPage.waitForFunction(() => !document.querySelector('.diagram-viewer svg') && document.activeElement.matches('.diagram-expand'));
    await touchPage.close();
    console.log('PASS: rendered diagram expansion, fit/zoom/scroll, keyboard focus, undo preservation, and file-switch cleanup.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
