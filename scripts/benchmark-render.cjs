#!/usr/bin/env node
// Release-build benchmark for the Markdown parser lane.
//
// Build the fixture first:
//   cargo build --release --example editor-fixture
// Then:
//   node scripts/benchmark-render.cjs
//
// This reports ratios rather than enforcing tight wall-clock thresholds. The
// nested-blockquote cases are also correctness checks: the structural budget
// must reject them cheaply with a blockquote_depth diagnostic instead of
// letting Comrak parse pathological nesting.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixture = path.resolve(
  'target/release/examples',
  `editor-fixture${process.platform === 'win32' ? '.exe' : ''}`,
);

if (!fs.existsSync(fixture)) {
  console.error(`Missing ${fixture}`);
  console.error('Build it with: cargo build --release --example editor-fixture');
  process.exit(2);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-benchmark-'));
let input = path.join(scratch, 'input.md');

function render(source) {
  fs.writeFileSync(input, source);
  const started = process.hrtime.bigint();
  const stdout = execFileSync(fixture, [input], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  return { ...JSON.parse(stdout), elapsed };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(source, runs = 3) {
  const samples = [];
  let result;
  for (let index = 0; index < runs; index += 1) {
    // Keep the first sample too; the fixture process is fresh each time, so
    // there is no in-process warmup to discard.
    result = render(source);
    samples.push(result.elapsed);
  }
  return { ...result, elapsed: median(samples), samples };
}

function paragraphSource(count) {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(
      `Paragraph ${index + 1} has **bold**, a [link](https://example.com), and café text.`,
    );
  }
  return `${lines.join('\n\n')}\n`;
}

function nestedBlockquoteSource(depth) {
  return `${'> '.repeat(depth)}nested\n`;
}

const cpu = os.cpus()[0]?.model || 'unknown CPU';
console.log(`Folio parser benchmark`);
console.log(
  `machine: ${os.platform()} ${os.arch()} | ${cpu} | ${os.cpus().length} logical CPUs | node ${process.version}`,
);
console.log(`fixture: ${fixture}`);
console.log('');

const paragraphCounts = [500, 1000, 2000, 4000, 8000, 16000];
let previous = null;
console.log('short paragraphs:');
for (const count of paragraphCounts) {
  const result = measure(paragraphSource(count));
  const ratio = previous ? result.elapsed / previous : 1;
  const ratioLabel = previous ? ratio.toFixed(2) : '-';
  console.log(
    `  ${String(count).padStart(6)} paragraphs: ${result.elapsed.toFixed(1).padStart(9)} ms  ratio ${ratioLabel}`,
  );
  if (previous && ratio >= 3.5) {
    console.log(
      `    warning: doubling the input increased time by ${ratio.toFixed(2)}x (the old baseline was about 4x)`,
    );
  }
  previous = result.elapsed;
}
console.log('');

console.log('nested blockquotes (must fail the structural budget cheaply):');
let nestedFailures = 0;
for (const depth of [10000, 20000, 40000]) {
  const result = measure(nestedBlockquoteSource(depth), 2);
  const rejected = result.html.includes('data-preview-limit="blockquote_depth"');
  if (!rejected) nestedFailures += 1;
  console.log(
    `  depth ${String(depth).padStart(6)}: ${result.elapsed.toFixed(1).padStart(9)} ms  ${rejected ? 'rejected' : 'UNEXPECTED RENDER'}`,
  );
}
console.log('');

fs.rmSync(scratch, { recursive: true, force: true });
if (nestedFailures) {
  console.error(`${nestedFailures} nested-blockquote case(s) were not rejected by the budget.`);
  process.exit(1);
}
console.log('PASS: paragraph scaling recorded; nested blockquotes rejected by the structural budget.');
