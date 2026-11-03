#!/usr/bin/env node
'use strict';
// Browser publication latency; double-rAF is a frame approximation, never presentation time.
const { openEditor } = require('../tests/editor-browser.cjs');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const scenarios = ['interior', 'boundary', 'punctuation', 'backspace', 'marked', 'unicode', 'composition'];
function fixture(bytes) {
  const lead = '# Benchmark\n\nPlain interior words and run boundary. **Marked interior words** tail.\n\n';
  const paragraph = 'A paragraph with **bold**, *italic*, `code` and a [link](https://example.com).\n\n';
  return lead + paragraph.repeat(Math.ceil((bytes - lead.length) / paragraph.length)).slice(0, bytes - lead.length);
}
function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)] ?? null, p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? null, worst: sorted.at(-1) ?? null, count: sorted.length };
}
function args(argv) {
  const result = { sizes: [10, 50, 100], chars: 12, warmup: 3, scenarios };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'sizes') result.sizes = argv[++i].split(',').map(Number);
    else if (key === 'scenarios') result.scenarios = argv[++i].split(',');
    else if (['chars', 'warmup'].includes(key)) result[key] = Number(argv[++i]);
  }
  return result;
}
async function run() {
  const options = args(process.argv.slice(2));
  const report = { timestamp: new Date().toISOString(), environment: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model, cpus: os.cpus().length, node: process.version, bundleSHA256: crypto.createHash('sha256').update(fs.readFileSync('ui/vendor/editor/editor.js')).digest('hex'), build: 'checked-in production editor bundle, browser shell with mocked Tauri bridge', viewport: '1180x900', refresh: 'headless virtual display; rAF intervals reported, physical refresh unknown' }, options, limitations: ['Canonical publication includes a minimal setter hook; no layout/geometry instrumentation in this pass.', 'keyDownToSource applies only to keyboard events; Unicode insertText starts at beforeinput.', 'Double-rAF from beforeinput is a frame approximation, not input-to-paint or presentation.', 'EventTiming durations (where supported) are browser event-to-next-render estimates rounded by the browser and thresholded at 16ms; include warmup events and are not native presentation timestamps.', 'Composition is synthetic compositionstart/end around browser insertText; no OS IME, candidate UI, or native WebKit measured.'], results: [] };
  for (const kb of options.sizes) {
    const session = await openEditor(fixture(kb * 1024));
    const { page } = session;
    try {
      report.environment.browser = session.browser.version();
      await page.locator('#preview .ProseMirror').waitFor({ state: 'visible' });
      await page.evaluate(() => {
        window.__bench = { samples: [], pending: null, events: [], eventTimingSupported: PerformanceObserver.supportedEntryTypes.includes('event') };
        if (__bench.eventTimingSupported) {
          __bench.observer = new PerformanceObserver(list => __bench.events.push(...list.getEntries().filter(entry => ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionend'].includes(entry.name)).map(entry => entry.duration)));
          __bench.observer.observe({ type: 'event', durationThreshold: 16, buffered: false });
        }
        document.addEventListener('keydown', () => { if (__bench.pending) __bench.pending.key = performance.now(); }, true);
        document.addEventListener('beforeinput', () => { if (__bench.pending) __bench.pending.input = performance.now(); }, true);
        const descriptor = Object.getOwnPropertyDescriptor(current, 'content');
        let value = current.content;
        Object.defineProperty(current, 'content', { configurable: true, get() { return value; }, set(next) {
          value = next;
          const sample = __bench.pending;
          if (!sample || sample.published) return;
          sample.published = performance.now();
          sample.keyDownToSource = sample.key ? sample.published - sample.key : null;
          sample.inputToSource = sample.input ? sample.published - sample.input : null;
          requestAnimationFrame(() => requestAnimationFrame(() => { sample.inputToDoubleRAF = sample.input ? performance.now() - sample.input : null; __bench.samples.push(sample); }));
        }});
        __bench.restore = () => Object.defineProperty(current, 'content', { ...descriptor, value });
      });
      for (const scenario of options.scenarios) {
        if (!scenarios.includes(scenario)) throw Error(`Unknown scenario: ${scenario}`);
        await page.evaluate(scenario => {
          const p = document.querySelector('#preview .ProseMirror p');
          const node = scenario === 'marked' ? p.querySelector('strong').firstChild : p.firstChild;
          const offset = scenario === 'boundary' ? node.length : Math.min(scenario === 'backspace' ? 35 : 8, node.length);
          const range = document.createRange(); range.setStart(node, offset); range.collapse(true);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); p.closest('[contenteditable]').focus();
        }, scenario);
        await page.waitForTimeout(100);
        await page.evaluate(() => { __bench.events = []; });
        const samples = [];
        for (let i = 0; i < options.warmup + options.chars; i++) {
          const count = await page.evaluate(() => { __bench.pending = {}; return __bench.samples.length; });
          if (scenario === 'backspace') await page.keyboard.press('Backspace');
          else if (scenario === 'unicode') await page.keyboard.insertText('é');
          else if (scenario === 'composition') {
            await page.evaluate(() => getSelection().anchorNode.parentElement.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })));
            await page.keyboard.insertText('漢');
            await page.evaluate(() => getSelection().anchorNode.parentElement.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '漢' })));
          } else await page.keyboard.type(scenario === 'punctuation' ? (i % 2 ? '.' : ' ') : 'x');
          await page.waitForFunction(count => __bench.samples.length > count, count, { timeout: 10000 });
          const sample = await page.evaluate(() => { __bench.pending = null; return __bench.samples.at(-1); });
          if (i >= options.warmup) samples.push(sample);
        }
        await page.waitForTimeout(100);
        const eventTiming = await page.evaluate(() => ({ supported: __bench.eventTimingSupported, durations: __bench.events }));
        const result = { eventTiming: { supported: eventTiming.supported, durationThreshold: 16, includesWarmup: true, duration: stats(eventTiming.durations) }, kb, bytes: kb * 1024, scenario, warmup: options.warmup, samples: options.chars, keyDownToSource: stats(samples.map(x => x.keyDownToSource).filter(x => x !== null)), inputToSource: stats(samples.map(x => x.inputToSource).filter(x => x !== null)), inputToDoubleRAF: stats(samples.map(x => x.inputToDoubleRAF).filter(x => x !== null)) };
        report.results.push(result);
        console.error(`${kb} KB ${scenario}: source p95 ${result.inputToSource.p95?.toFixed(1)} ms; frame approximation p95 ${result.inputToDoubleRAF.p95?.toFixed(1)} ms`);
      }
      if (session.errors.length) throw Error(session.errors.join('\n'));
    } finally { await session.close(); }
  }
  console.log(JSON.stringify(report, null, 2));
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { fixture, stats };
