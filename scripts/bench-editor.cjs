#!/usr/bin/env node
'use strict';
// Editor performance benchmark. Deliberately separate from the correctness
// suites: it measures parse, serialize and source-update cost at several
// document sizes and prints a table. Run with `node scripts/bench-editor.cjs`.
//
// The per-keystroke number users feel is the source-update path
// (`updateSource`) plus, for structural edits, a full `parseSource`. Both are
// measured here without a DOM, so they are a lower bound on the WebView cost.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

const SIZES = [
  ['3 KB', 3 * 1024],
  ['10 KB', 10 * 1024],
  ['50 KB', 50 * 1024],
  ['100 KB', 100 * 1024],
  ['500 KB', 500 * 1024],
  ['1 MB', 1024 * 1024],
];

function documentOf(bytes) {
  const block = [
    '## Section',
    '',
    'A paragraph with **bold**, *italic*, `code`, a [link](https://example.com) and an image ![alt](image.png).',
    '',
    '- list item one',
    '- list item two',
    '',
    '> A quote with a [reference][ref] inside.',
    '',
    '| Left | Center | Right |',
    '|:-----|:------:|------:|',
    '| a    | b      | c     |',
    '',
    '```js',
    'const answer = 42; // note',
    '```',
    '',
  ].join('\n');
  let source = '# Benchmark\n\n';
  while (Buffer.byteLength(source) < bytes) source += block;
  return source.slice(0, bytes);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function time(fn, runs = 7) {
  const samples = [];
  for (let index = 0; index < runs; index++) {
    const started = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return median(samples);
}

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-bench-'));
  const outfile = path.join(scratch, 'model.mjs');
  esbuild.buildSync({
    entryPoints: [path.resolve('ui/editor/model.js')],
    bundle: true, format: 'esm', platform: 'node', target: 'es2022',
    outfile, logLevel: 'silent',
  });
  const model = await import(pathToFileURL(outfile).href);

  console.log('Folio editor benchmark (node, no DOM — lower bound)\n');
  console.log('| Document | parseSource | updateSource (identity) | serialize |');
  console.log('|---:|---:|---:|---:|');
  for (const [label, bytes] of SIZES) {
    const source = documentOf(bytes);
    const parsed = model.parseSource(source);
    const parse = time(() => model.parseSource(source), 5);
    const update = time(() => model.updateSource(parsed.doc, parsed), 7);
    const serialize = time(() => model.serializer.serialize(parsed.doc), 7);
    console.log(`| ${label} | ${parse.toFixed(1)} ms | ${update.toFixed(1)} ms | ${serialize.toFixed(1)} ms |`);
  }
  fs.rmSync(scratch, { recursive: true, force: true });
})().catch(error => { console.error('benchmark failed:', error); process.exit(1); });
