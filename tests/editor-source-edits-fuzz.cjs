const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { pathToFileURL } = require('node:url');

// Differential fuzz over the source-preserving edit path. For random documents
// and random text edits it checks the invariant the whole editor depends on:
// if `tryTextEdits` accepts an edit, re-parsing the source it produced must
// yield exactly the document the edit produced. A `null` return is a legitimate
// fallback, not a failure — the caller then uses the serializer path.
//
// This is what independently validates the ledger's patch computation (and the
// quadratic-scan work on it) against inputs nobody hand-wrote.
//
// Deterministic: a seeded PRNG, so a failure reproduces exactly.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-edits-fuzz-'));
const outfile = path.join(scratch, 'modules.mjs');

function build() {
  esbuild.buildSync({
    stdin: {
      contents: [
        "export { parseSource } from './ui/editor/model.js';",
        "export { tryTextEdits } from './ui/editor/source-edits.js';",
        "export { EditorState, TextSelection } from 'prosemirror-state';",
      ].join('\n'),
      resolveDir: process.cwd(),
      loader: 'js',
    },
    bundle: true, format: 'esm', platform: 'node', target: 'es2022',
    outfile, logLevel: 'silent',
  });
}

function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const DOCS = [
  '# Title\n\nA paragraph with **bold**, *italic* and `code`.\n',
  'Repeated text repeated text repeated text.\n\nRepeated text repeated text.\n',
  '- one\n- two\n  - nested\n- three\n',
  '| a | b |\n|---|---|\n| 1 | 2 |\n',
  'A [link](https://example.com/x) and <kbd>inline</kbd> HTML.\n',
  'Escapes: \\*not emphasis\\*, entities: &amp; &lt; and `x`.\n',
  'Unicode: café 日本語 😀 and a long sentence that wraps somewhere in the middle of the reader column.\n',
  '> quote text\n> second line\n\nAfter the quote.\n',
  '```js\nconst answer = 42;\n```\n\nAfter code.\n',
  '# One\n\n## Two\n\n### Three\n\nText.\n',
];

const CHARS = ['a', 'Z', ' ', '.', 'x', 'é', '1'];

(async () => {
  build();
  const modules = await import(pathToFileURL(outfile).href);
  const { parseSource, EditorState } = modules;

  // Interior punctuation can turn a paragraph into a Markdown list. An
  // accepted edit must never disagree with a fresh parse.
  {
    const model = parseSource('1 item\n');
    const step = EditorState.create({ doc: model.doc }).tr.insertText('.', 2).steps[0];
    const doc = step.apply(model.doc).doc;
    const next = modules.tryTextEdits(model, [step], doc);
    assert.ok(!next || parseSource(next.source).doc.eq(doc), 'interior punctuation must not change Markdown structure');
  }
  {
    const model = parseSource('abc\n\n&fjlig; end\n');
    const step = EditorState.create({ doc: model.doc }).tr.insertText('XYZ', 2).steps[0];
    const next = modules.tryTextEdits(model, [step], step.apply(model.doc).doc);
    if (next) {
      const fresh = parseSource(next.source);
      assert.deepEqual(next.ledger.runs.map(run => run.charMap), fresh.ledger.runs.map(run => run.charMap), 'later character maps must shift with source');
    }
  }

  let accepted = 0, rejected = 0;
  const random = prng(0x5EED);
  for (let iteration = 0; iteration < 400; iteration++) {
    const source = DOCS[Math.floor(random() * DOCS.length)];
    const model = parseSource(source);
    // Random text position inside a paragraph-like text run.
    const positions = [];
    model.doc.descendants((node, position) => {
      if (node.isText) for (let offset = 0; offset <= node.text.length; offset++) positions.push(position + offset);
    });
    if (!positions.length) { rejected++; continue; }
    const anchor = positions[Math.floor(random() * positions.length)];
    const insert = CHARS[Math.floor(random() * CHARS.length)];
    const deleting = random() < 0.35;
    const to = deleting ? Math.min(anchor + 1, model.doc.content.size) : anchor;
    let step;
    try {
      step = deleting
        ? EditorState.create({ doc: model.doc, schema: model.doc.type.schema }).tr.delete(anchor, to).steps[0]
        : EditorState.create({ doc: model.doc, schema: model.doc.type.schema }).tr.insertText(insert, anchor).steps[0];
    } catch { rejected++; continue; }
    const applied = step.apply(model.doc);
    if (applied.failed) { rejected++; continue; }
    const next = modules.tryTextEdits(model, [step], applied.doc);
    if (!next) { rejected++; continue; }
    accepted++;
    // The invariant: the produced source re-parses to the produced document.
    const reparsed = parseSource(next.source);
    assert.ok(reparsed.doc.eq(next.doc),
      `iteration ${iteration}: accepted edit produced source that re-parses differently\nsource: ${JSON.stringify(next.source)}`);
    // And the derived mapping must agree with a fresh parse of that source.
    // This is what an incremental path would get wrong: source correct, ledger
    // silently stale. Compare positions, not object identity.
    const shape = model => ({
      runs: model.ledger.runs.map(run => [run.kind, run.pmFrom, run.pmTo, run.sourceFrom, run.sourceTo, run.linear ? 1 : 0, run.charMap]),
      owners: model.ledger.owners.map(owner => [owner.type, owner.pmFrom, owner.pmTo, owner.sourceFrom, owner.sourceTo, owner.confidence]),
      segments: model.segments.map(segment => [segment.from, segment.to]),
    });
    assert.deepEqual(shape(next), shape(reparsed),
      `iteration ${iteration}: the returned ledger diverges from a fresh parse of the same source`);
    assert.equal(next.source.length >= 0, true);
  }
  assert.ok(accepted > 50, `the fuzz must accept a meaningful number of edits, got ${accepted} (rejected ${rejected})`);
  console.log(`PASS: ${accepted} random text edits kept source and document in agreement (${rejected} fell back).`);
  fs.rmSync(scratch, { recursive: true, force: true });
})().catch(error => {
  console.error(error);
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
});
