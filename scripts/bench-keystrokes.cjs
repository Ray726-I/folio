#!/usr/bin/env node
'use strict';
// End-to-end keystroke latency, measured in a real browser against the built
// editor: open a document of a given size and type into it, timing how long
// each keypress takes to be reflected in the canonical Markdown.
//
// This is deliberately separate from the correctness suites. Run with:
//   node scripts/bench-keystrokes.cjs [--sizes 10,50,100] [--chars 20]

const { openEditor } = require('../tests/editor-browser.cjs');

function documentOf(bytes) {
  const paragraph = 'A paragraph with **bold**, *italic*, `code` and a [link](https://example.com).\n\n';
  let source = '# Benchmark\n\n';
  while (Buffer.byteLength(source) < bytes) source += paragraph;
  return source.slice(0, bytes);
}

function parseArgs(argv) {
  const args = { sizes: [10, 50, 100], chars: 20 };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--sizes') args.sizes = String(argv[index + 1]).split(',').map(Number).filter(Boolean);
    if (argv[index] === '--chars') args.chars = Number(argv[index + 1]) || 20;
  }
  return args;
}

(async () => {
  const { sizes, chars } = parseArgs(process.argv.slice(2));
  console.log(`Keystroke latency (browser, ${chars} characters per document)\n`);
  console.log('| Document | median ms/key | max ms/key |');
  console.log('|---:|---:|---:|');
  for (const kb of sizes) {
    const source = documentOf(kb * 1024);
    const session = await openEditor(source);
    const { page } = session;
    try {
      await page.locator('#preview .ProseMirror').waitFor({ state: 'visible' });
      await page.locator('#preview .ProseMirror p').first().click();
      await page.keyboard.press('End');
      // Measure inside the page: from the key event to the moment the shell
      // writes the canonical Markdown. Doing this from Node would add the
      // polling interval (a frame or more) to every sample.
      await page.evaluate(() => {
        window.__lat = [];
        window.__keyAt = 0;
        document.addEventListener('keydown', () => { window.__keyAt = performance.now(); }, true);
        const descriptor = Object.getOwnPropertyDescriptor(current, 'content');
        Object.defineProperty(current, 'content', {
          configurable: true,
          get() { return descriptor.value; },
          set(value) {
            descriptor.value = value;
            if (window.__keyAt) { window.__lat.push(performance.now() - window.__keyAt); window.__keyAt = 0; }
          },
        });
      });
      for (let index = 0; index < chars; index++) await page.keyboard.type('x');
      await page.waitForFunction(count => window.__lat.length >= count, chars, { timeout: 30000 });
      const samples = await page.evaluate(() => window.__lat.slice());
      samples.sort((a, b) => a - b);
      const median = samples[Math.floor(samples.length / 2)];
      const max = samples[samples.length - 1];
      console.log(`| ${kb} KB | ${median.toFixed(1)} | ${max.toFixed(1)} |`);
    } finally {
      await session.close();
    }
  }
})().catch(error => { console.error('benchmark failed:', error); process.exit(1); });
