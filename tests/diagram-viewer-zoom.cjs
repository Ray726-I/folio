const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

// Focused regression for expanded-viewer zoom interaction:
// - buttons preserve viewport-center position at nonzero scroll (no reset to 0,0)
// - Ctrl+wheel zooms at pointer, ordinary wheel only scrolls
// - trackpad pinch via native gesture events zooms without duplicate wheel zoom
// - Linux native pinch (normalized fractions from GTK) zooms at pointer and is
//   inert while the viewer is closed
// - limits + fit behaviour, scoped to the expanded viewer.
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  try {
    await page.setContent('<article id="preview" class="markdown"><div class="mermaid-host"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2400 1000"><rect x="100" y="100" width="700" height="300" fill="none" stroke="currentColor" stroke-width="8"/><rect x="1600" y="100" width="700" height="300" fill="none" stroke="currentColor" stroke-width="8"/><text x="260" y="280" font-size="96">diagram</text></svg></div></article>');
    await page.addStyleTag({ path: path.resolve('ui/styles.css') });
    await page.addStyleTag({ path: path.resolve('ui/diagram-viewer.css') });
    await page.addScriptTag({ path: path.resolve('ui/diagram-viewer.js') });

    const expand = page.getByRole('button', { name: 'Expand diagram' });
    await expand.waitFor({ timeout: 3000 });
    await expand.evaluate(button => button.click());
    const dialog = page.getByRole('dialog', { name: 'Expanded diagram' });
    await dialog.waitFor();
    const viewport = dialog.getByRole('region', { name: 'Diagram. Use arrow keys to scroll.' });
    const zoom = dialog.locator('.diagram-viewer-zoom');
    await viewport.waitFor();

    const pct = async () => parseInt(await zoom.textContent(), 10);

    // Ensure a scrollable scale for position tests.
    await dialog.getByRole('button', { name: 'Actual size' }).click();
    assert.equal(await pct(), 100, 'actual size is 100%');
    const scrollable = await viewport.evaluate(el => ({ w: el.scrollWidth, c: el.clientWidth, h: el.scrollHeight, ch: el.clientHeight }));
    assert.ok(scrollable.w > scrollable.c, `100% must scroll horizontally: ${JSON.stringify(scrollable)}`);

    // 1. Buttons preserve viewport-center position at nonzero scroll.
    await viewport.evaluate(el => { el.scrollLeft = 300; el.scrollTop = 120; });
    const before = await viewport.evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop }));
    assert.ok(before.left > 0 && before.top > 0, 'precondition: nonzero scroll');
    const anchorBefore = await page.evaluate(() => {
      const vp = document.querySelector('.diagram-viewer-viewport');
      const drawing = document.querySelector('.diagram-viewer-canvas > *');
      const vr = vp.getBoundingClientRect();
      const dr = drawing.getBoundingClientRect();
      const cx = vr.left + vp.clientWidth / 2, cy = vr.top + vp.clientHeight / 2;
      return { cx, cy, offX: cx - dr.left, offY: cy - dr.top, scaleText: document.querySelector('.diagram-viewer-zoom').textContent };
    });
    await dialog.getByRole('button', { name: 'Zoom in' }).click();
    const afterPct = await pct();
    assert.ok(afterPct > 100, 'zoom in increases scale');
    const after = await viewport.evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop }));
    assert.ok(after.left > 0, `button zoom must not reset scroll to origin (got ${JSON.stringify(after)} from ${JSON.stringify(before)})`);
    const anchorAfter = await page.evaluate(() => {
      const vp = document.querySelector('.diagram-viewer-viewport');
      const drawing = document.querySelector('.diagram-viewer-canvas > *');
      const vr = vp.getBoundingClientRect();
      const dr = drawing.getBoundingClientRect();
      const cx = vr.left + vp.clientWidth / 2, cy = vr.top + vp.clientHeight / 2;
      return { offX: cx - dr.left, offY: cy - dr.top };
    });
    const k = afterPct / 100;
    assert.ok(Math.abs(anchorAfter.offX - anchorBefore.offX * k) < 3, `viewport-center content stays put (x: ${anchorBefore.offX} -> ${anchorAfter.offX}, k=${k})`);
    assert.ok(Math.abs(anchorAfter.offY - anchorBefore.offY * k) < 3, `viewport-center content stays put (y: ${anchorBefore.offY} -> ${anchorAfter.offY}, k=${k})`);

    // 2. Ctrl+wheel zooms at the pointer and is cancellable; ordinary wheel does not zoom.
    const scaleBeforeWheel = await pct();
    const wheelResult = await viewport.evaluate(el => {
      const r = el.getBoundingClientRect();
      const x = r.left + 120, y = r.top + 100;
      const drawing = document.querySelector('.diagram-viewer-canvas > *');
      const dr = drawing.getBoundingClientRect();
      const offX = x - dr.left, offY = y - dr.top;
      const ev = new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      const drawing2 = document.querySelector('.diagram-viewer-canvas > *');
      const dr2 = drawing2.getBoundingClientRect();
      return { prevented: ev.defaultPrevented, offX, offY, newOffX: x - dr2.left, newOffY: y - dr2.top, scaleText: document.querySelector('.diagram-viewer-zoom').textContent };
    });
    const scaleAfterWheel = await pct();
    assert.equal(wheelResult.prevented, true, 'ctrl+wheel is handled (prevented)');
    assert.ok(scaleAfterWheel > scaleBeforeWheel, `ctrl+wheel zooms in (was ${scaleBeforeWheel}%, now ${scaleAfterWheel}%)`);
    const kw = scaleAfterWheel / scaleBeforeWheel;
    assert.ok(Math.abs(wheelResult.newOffX - wheelResult.offX * kw) < 4, `pointer content stays put on ctrl+wheel (x ${wheelResult.offX} -> ${wheelResult.newOffX}, k=${kw})`);

    const scaleBeforePlain = await pct();
    const plainResult = await viewport.evaluate(el => {
      const r = el.getBoundingClientRect();
      const ev = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, scaleText: document.querySelector('.diagram-viewer-zoom').textContent };
    });
    assert.equal(await pct(), scaleBeforePlain, 'ordinary wheel must not change zoom');
    assert.equal(plainResult.prevented, false, 'ordinary wheel is not intercepted so scrolling still works');

    // 3. Native gesture (trackpad pinch) path zooms; wheel is suppressed while a gesture is active (no duplicate).
    const scaleBeforeGesture = await pct();
    const gestureChanged = await viewport.evaluate(el => {
      const mk = (type, props) => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(ev, props);
        return ev;
      };
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      el.dispatchEvent(mk('gesturestart', { scale: 1, clientX: x, clientY: y }));
      const startScale = document.querySelector('.diagram-viewer-zoom').textContent;
      // A companion ctrl+wheel fired by the webview during the gesture must not double-zoom.
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      const afterWheel = document.querySelector('.diagram-viewer-zoom').textContent;
      el.dispatchEvent(mk('gesturechange', { scale: 1.4, clientX: x, clientY: y }));
      const afterGesture = document.querySelector('.diagram-viewer-zoom').textContent;
      el.dispatchEvent(mk('gestureend', { scale: 1.4, clientX: x, clientY: y }));
      return { startScale, afterWheel, afterGesture };
    });
    const scaleAfterGesture = await pct();
    assert.equal(gestureChanged.afterWheel, gestureChanged.startScale, `wheel during gesture must not double-zoom (was ${gestureChanged.startScale}, got ${gestureChanged.afterWheel})`);
    assert.ok(scaleAfterGesture > scaleBeforeGesture, `gesture pinch zooms (was ${scaleBeforeGesture}%, now ${scaleAfterGesture}%)`);

    // 3b. Linux native route. GTK pinch is forwarded as normalized fractions
    // because WebKitGTK does not deliver DOM gesture or ctrl+wheel events.
    const scaleBeforeNative = await pct();
    const nativeChanged = await page.evaluate(() => {
      const fire = detail => window.dispatchEvent(new CustomEvent('folio:diagram-pinch', { detail }));
      const vp = document.querySelector('.diagram-viewer-viewport');
      const r = vp.getBoundingClientRect();
      const xFraction = (r.left + r.width * 0.3) / window.innerWidth;
      const yFraction = (r.top + r.height * 0.4) / window.innerHeight;
      const anchorX = xFraction * window.innerWidth, anchorY = yFraction * window.innerHeight;
      const drawing = document.querySelector('.diagram-viewer-canvas > *');
      const before = drawing.getBoundingClientRect();
      fire({ phase: 'start', scale: 1, xFraction, yFraction });
      const started = document.querySelector('.diagram-viewer-zoom').textContent;
      fire({ phase: 'change', scale: 1.2, xFraction, yFraction });
      const changed = document.querySelector('.diagram-viewer-zoom').textContent;
      vp.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, ctrlKey: true, clientX: anchorX, clientY: anchorY, bubbles: true, cancelable: true }));
      const afterWheel = document.querySelector('.diagram-viewer-zoom').textContent;
      fire({ phase: 'end', scale: 1.2, xFraction, yFraction });
      const after = drawing.getBoundingClientRect();
      return { started, changed, afterWheel, offX: anchorX - before.left, offY: anchorY - before.top, newOffX: anchorX - after.left, newOffY: anchorY - after.top };
    });
    const scaleAfterNative = await pct();
    assert.equal(nativeChanged.started, `${scaleBeforeNative}%`, 'native start does not zoom by itself');
    assert.ok(scaleAfterNative > scaleBeforeNative, `native pinch zooms (was ${scaleBeforeNative}%, now ${scaleAfterNative}%)`);
    assert.equal(nativeChanged.afterWheel, nativeChanged.changed, 'wheel during native pinch must not double-zoom');
    const kn = scaleAfterNative / scaleBeforeNative;
    assert.ok(Math.abs(nativeChanged.newOffX - nativeChanged.offX * kn) < 4, `native pinch keeps the pointer content (x ${nativeChanged.offX} -> ${nativeChanged.newOffX}, k=${kn})`);

    // 4. Wheel outside the expanded viewer does not affect its zoom (scoped).
    const scaleBeforeOutside = await pct();
    await page.evaluate(() => {
      document.body.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    assert.equal(await pct(), scaleBeforeOutside, 'ctrl+wheel outside the viewer is scoped out');

    // 5. Limits and fit behaviour.
    const zoomIn = dialog.getByRole('button', { name: 'Zoom in' });
    for (let i = 0; i < 12; i++) {
      if (await zoomIn.isDisabled()) break;
      await zoomIn.click();
    }
    assert.equal(await pct(), 400, 'zoom clamps at 400%');
    assert.equal(await zoomIn.isDisabled(), true, 'zoom-in disables at max');
    const zoomOut = dialog.getByRole('button', { name: 'Zoom out' });
    for (let i = 0; i < 30; i++) {
      if (await zoomOut.isDisabled()) break;
      await zoomOut.click();
    }
    assert.equal(await pct(), 5, 'zoom clamps at 5%');
    assert.equal(await dialog.getByRole('button', { name: 'Zoom out' }).isDisabled(), true, 'zoom-out disables at min');
    await dialog.getByRole('button', { name: 'Fit diagram' }).click();
    assert.ok(await viewport.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1), 'Fit keeps the diagram within the viewport');

    // 6. Native pinch outside the expanded viewer is inert: the page itself
    // must not zoom, and the closed viewer keeps no gesture state.
    await dialog.getByRole('button', { name: 'Close diagram' }).click();
    assert.equal(await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('folio:diagram-pinch', { detail: { phase: 'change', scale: 2, xFraction: .5, yFraction: .5 } }));
      return document.getElementById('diagram-viewer').open;
    }), false, 'native pinch while closed does not reopen or zoom the viewer');

    assert.deepEqual(await page.evaluate(() => window.__folioTestErrors || []), []);
    console.log('PASS: diagram viewer zoom preserves position, ctrl+wheel, gesture pinch, bounds, fit, scope.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
