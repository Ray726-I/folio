#!/usr/bin/env node
'use strict';
// Real Playwright pointer/wheel input. Timing and intrusive geometry/trace diagnostics run separately.
const { openEditor } = require('../tests/editor-browser.cjs');
const { fixture, stats } = require('./bench-keystrokes.cjs');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fixtures = {
  prose: fixture(100 * 1024),
  headings300: Array.from({ length: 300 }, (_, i) => `${i % 3 ? '##' : '#'} Section ${i}\n\nParagraph ${i}.\n\n`).join(''),
  headings1000: Array.from({ length: 1000 }, (_, i) => `${i % 3 ? '##' : '#'} Section ${i}\n\nParagraph ${i}.\n\n`).join(''),
  tables150: tables(150), tables500: tables(500),
  media: '# Media\n\n' + ('Prose between blocks.\n\n```js\n' + 'const longLine = 12345; '.repeat(100) + '\n```\n\n$$\nx^2+y^2=z^2\n$$\n\n![offline](https://example.com/fixture.png)\n\n').repeat(10),
};
function tables(count) { return '# Tables\n\n' + 'Prose between tables.\n\n| A | B |\n|---|---|\n| one | two |\n\n'.repeat(count); }
async function frame(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve))); }
async function reset(page) {
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.evaluate(() => {
    document.body.style.setProperty('--dock-sidebar-width', '280px');
    for (const node of document.querySelectorAll('#reader-scroll, #outline, #outline-body, textarea, .code-surface')) { node.scrollTop = 0; node.scrollLeft = 0; }
  });
  await page.waitForTimeout(200);
}
async function workload(page) {
  const bounds = await page.locator('#reader-scroll').boundingBox();
  // Cell area, prose and both gutters. Each move is real browser input, paced by rAF.
  for (let i = 0; i < 36; i++) {
    await page.mouse.move(bounds.x + bounds.width * ([.01, .18, .5, .82, .99][i % 5]), Math.min(890, bounds.y + Math.min(bounds.height - 10, 60 + i % 8 * 50)));
    if (i % 3 === 0) await page.mouse.wheel(0, i < 24 ? 100 : -100);
    await frame(page);
  }
  const outline = await page.locator('#outline').boundingBox();
  if (outline) { await page.mouse.move(outline.x + outline.width / 2, outline.y + 150); await page.mouse.wheel(0, 400); await frame(page); }
  const divider = await page.locator('#outline-divider').boundingBox();
  if (divider) {
    await page.mouse.move(divider.x + divider.width / 2, divider.y + 100); await page.mouse.down();
    for (let i = 0; i < 16; i++) { await page.mouse.move(divider.x + i * 5, divider.y + 100); await frame(page); }
    await page.mouse.up();
  }
  const nested = page.locator('#preview .code-surface').first();
  if (await nested.count()) { await nested.scrollIntoViewIfNeeded({ timeout: 3000 }); const box = await nested.boundingBox(); if (box) { await page.mouse.move(box.x + 30, box.y + 20); await page.mouse.wheel(300, 0); await frame(page); } }
  for (const width of [1100, 1000, 900, 1000, 1180]) { await page.setViewportSize({ width, height: 900 }); await frame(page); }
}
async function lifecycle(page, cdp, count) {
  const samples = [];
  for (let cycle = 0; cycle <= count; cycle++) {
    let replaceWallMs = null;
    if (cycle) {
      const start = performance.now();
      await page.evaluate(cycle => requestOpenLocation(`/tmp/bench-replace-${cycle}.md`), cycle);
      await page.waitForFunction(() => !busy && Boolean(editor));
      await page.waitForTimeout(550);
      replaceWallMs = performance.now() - start;
    }
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const dom = await cdp.send('Memory.getDOMCounters');
    const overlays = await page.evaluate(() => ({ tableHandles: document.querySelectorAll('.folio-table-handles').length, tableMenus: document.querySelectorAll('.folio-table-menu').length, slashMenus: document.querySelectorAll('.folio-slash-menu').length }));
    samples.push({ cycle, replaceWallMs, jsHeapUsedBytes: heap.usedSize, ...dom, overlays });
  }
  return { replacements: count, settleMs: 550, note: 'Forced-GC Chromium JS heap and CDP DOM counters only; repeated document replacement, not native resident memory or a proof of no leaks. Replacement wall time includes harness roundtrips and settling.', samples };
}
async function run() {
  if (process.argv.includes('--write-fixtures')) {
    const directory = process.argv[process.argv.indexOf('--write-fixtures') + 1];
    fs.mkdirSync(directory, { recursive: true });
    for (const [name, source] of Object.entries(fixtures)) fs.writeFileSync(path.join(directory, `${name}.md`), source);
    console.log(`Wrote ${Object.keys(fixtures).length} deterministic Markdown fixtures to ${directory}`); return;
  }
  const lifecycleOnly = process.argv.includes('--lifecycle-only');
  const names = process.argv.includes('--fixtures') ? process.argv[process.argv.indexOf('--fixtures') + 1].split(',') : lifecycleOnly ? ['prose', 'tables150'] : Object.keys(fixtures);
  const repeats = process.argv.includes('--repeat') ? Number(process.argv[process.argv.indexOf('--repeat') + 1]) : 1;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw Error('--repeat must be 1..10');
  const report = { timestamp: new Date().toISOString(), mode: lifecycleOnly ? 'lifecycle-only' : 'interactions', environment: { uiRoot: path.resolve('ui'), bundleSHA256: crypto.createHash('sha256').update(fs.readFileSync('ui/vendor/editor/editor.js')).digest('hex'), cpu: os.cpus()[0]?.model, platform: os.platform(), release: os.release(), build: 'production editor bundle, mocked Tauri bridge', viewport: '1180x900', physicalRefresh: 'unknown; headless virtual display' }, warmupWorkloads: 1, timedWorkloads: repeats, limitations: ['Frame intervals measure the headless browser rAF clock, not native presentation or input latency.', 'Diagnostic trace function durations include nested calls and must not be summed as CPU utilization.', 'Geometry instrumentation and tracing occur only in a separate diagnostic pass.', 'For --repeat >1, reset/settle time between workloads is included in the measured frame segment.', 'No native WebKit, GPU/compositor trace, real window resize, or OS IME measured.', 'Bounded forced-GC replacement diagnostics run after tracing for prose (10 replacements) and tables150 (5); no browser-close retention claim.'], results: [] };
  for (const name of names) {
    if (!fixtures[name]) throw Error(`Unknown fixture ${name}`);
    const result = { fixture: name, bytes: Buffer.byteLength(fixtures[name]) };
    if (lifecycleOnly) {
      const session = await openEditor(fixtures[name]);
      try {
        report.environment.browser = session.browser.version();
        await session.page.waitForTimeout(600);
        const cdp = await session.page.context().newCDPSession(session.page);
        result.lifecycle = await lifecycle(session.page, cdp, name === 'prose' ? 10 : 5);
        if (session.errors.length) throw Error(session.errors.join('\n'));
      } finally { await session.close(); }
      report.results.push(result); console.error(`${name}: lifecycle complete`); continue;
    }
    for (const diagnostic of [false, true]) {
      const session = await openEditor(fixtures[name]); const { page } = session;
      try {
        report.environment.browser = session.browser.version();
        await page.waitForTimeout(600);
        if (name.startsWith('headings')) { const buttons = page.locator('#outline button[aria-label^="Collapse"]'); if (await buttons.count()) await buttons.first().click(); }
        await reset(page); await workload(page);
        await reset(page);
        let cdp, events = [];
        if (diagnostic) {
          cdp = await page.context().newCDPSession(page);
          cdp.on('Tracing.dataCollected', event => events.push(...event.value));
          await cdp.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' });
          await page.evaluate(() => { window.__rectReads = 0; const original = Element.prototype.getBoundingClientRect; Element.prototype.getBoundingClientRect = function(...args) { ++__rectReads; return original.apply(this, args); }; window.__restoreRects = () => { Element.prototype.getBoundingClientRect = original; }; });
        } else {
          await page.evaluate(() => {
            window.__frames = []; window.__longTasks = []; window.__running = true; let last;
            const loop = now => { if (!__running) return; if (last) __frames.push(now - last); last = now; requestAnimationFrame(loop); }; requestAnimationFrame(loop);
            window.__observer = new PerformanceObserver(list => __longTasks.push(...list.getEntries().map(e => e.duration))); __observer.observe({ type: 'longtask', buffered: false });
          });
        }
        for (let repeat = 0; repeat < repeats; repeat++) {
          if (repeat) await reset(page);
          await workload(page);
        }
        await frame(page);
        if (diagnostic) {
          const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve)); await cdp.send('Tracing.end'); await complete;
          const durations = names => events.filter(event => names.includes(event.name) && event.ph === 'X' && event.dur).map(event => event.dur / 1000);
          result.diagnostic = { geometryReads: await page.evaluate(() => __rectReads), functionCallDuration: stats(durations(['FunctionCall'])), eventDispatchDuration: stats(durations(['EventDispatch'])), layoutDuration: stats(durations(['Layout'])), styleRecalculationDuration: stats(durations(['UpdateLayoutTree', 'RecalculateStyles'])), animationFrameCallbackDuration: stats(durations(['FireAnimationFrame'])) };
          await page.evaluate(() => __restoreRects());
          if (name.startsWith('headings')) {
            const samples = await page.evaluate(async () => {
              const samples = [];
              for (let i = 0; i < 40; i++) {
                const start = performance.now(); refreshEditorOutline(); const duration = performance.now() - start;
                if (i >= 10) samples.push(duration);
                await new Promise(resolve => requestAnimationFrame(resolve));
              }
              return samples;
            });
            result.outlineRefresh = { warmup: 10, samples: 30, unchangedDocument: true, duration: stats(samples), note: 'Synchronous refresh only; unchanged document, no geometry wrapper or trace active; frame wait outside duration.' };
          }
          if (name === 'prose' || name === 'tables150') result.lifecycle = await lifecycle(page, cdp, name === 'prose' ? 10 : 5);
        } else result.timed = await page.evaluate(() => { __running = false; __observer.disconnect(); return { frameIntervals: __frames, longTasks: __longTasks }; });
        if (session.errors.length) throw Error(session.errors.join('\n'));
      } finally { await session.close(); }
    }
    result.timed = { frameIntervals: stats(result.timed.frameIntervals), longTasks: stats(result.timed.longTasks), intervalsOver20ms: result.timed.frameIntervals.filter(ms => ms > 20).length };
    report.results.push(result); console.error(`${name}: frame p95 ${result.timed.frameIntervals.p95.toFixed(1)} ms; diagnostic rectangles ${result.diagnostic.geometryReads}`);
  }
  console.log(JSON.stringify(report, null, 2));
}
run().catch(error => { console.error(error); process.exitCode = 1; });
