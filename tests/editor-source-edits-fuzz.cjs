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
        "export { mapSource, mapRich } from './ui/editor/source-ledger.js';",
        "export { tryTextEdits, trySourceEdit } from './ui/editor/source-edits.js';",
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
  '1 item\n\nwww.example.co end\n',
  'First [reference][a].\n\nPlain text.\n\n[a]: https://example.com\n',
  'Plain words\r\n\r\nNext paragraph.\r\n',
  'Before **bold** and _em_ text.\n\nEscaped \\*star\\* &fjlig; end.\n',
  'Plain **bold** text.\n\nIncomplete [link](https://example.co',
  'Incomplete [link](https://example.co\n\nPlain **bold** text.\n',
];

const CHARS = ['a', 'Z', ' ', '.', 'x', 'é', '1', '*', '_', '[', ']', '&', '`', ':', '/', '😀', '字', '\t'];

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
  for (let iteration = 0; iteration < 4000; iteration++) {
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
      gaps: model.ledger.gaps,
      metadata: model.ledger.metadata,
    });
    assert.deepEqual(shape(next), shape(reparsed),
      `iteration ${iteration}: the returned ledger diverges from a fresh parse of the same source`);
    const mappingShape = mapping => [mapping.source, mapping.pm, mapping.exact, mapping.confidence, mapping.owner?.id];
    for (const bias of ['left', 'right']) {
      for (let at = 0; at <= next.source.length; at++) assert.deepEqual(
        mappingShape(modules.mapSource(next.ledger, at, {bias})),
        mappingShape(modules.mapSource(reparsed.ledger, at, {bias})), `iteration ${iteration}: source mapping ${at}`);
      for (let at = 0; at <= next.doc.content.size; at++) assert.deepEqual(
        mappingShape(modules.mapRich(next.ledger, at, {bias})),
        mappingShape(modules.mapRich(reparsed.ledger, at, {bias})), `iteration ${iteration}: rich mapping ${at}`);
    }
  }
  let sourceAccepted = 0;
  for (let iteration = 0; iteration < 2000; iteration++) {
    const source = DOCS[Math.floor(random() * DOCS.length)];
    const model = parseSource(source);
    const from = Math.floor(random() * (source.length + 1));
    const to = random() < 0.35 ? Math.min(from + 1, source.length) : from;
    const insert = to > from ? '' : CHARS[Math.floor(random() * CHARS.length)];
    const next = modules.trySourceEdit(model, {from, to, insert});
    if (!next) continue;
    sourceAccepted++;
    assert.equal(next.source, source.slice(0, from) + insert + source.slice(to));
    const fresh = parseSource(next.source);
    assert.ok(next.doc.eq(fresh.doc), `source-first iteration ${iteration}: document`);
    assert.deepEqual(next.ledger.runs, fresh.ledger.runs, `source-first iteration ${iteration}: runs`);
    assert.deepEqual(next.ledger.gaps, fresh.ledger.gaps, `source-first iteration ${iteration}: gaps`);
    assert.deepEqual(next.ledger.metadata, fresh.ledger.metadata, `source-first iteration ${iteration}: metadata`);
    for (const bias of ['left', 'right']) {
      const shape = mapping => [mapping.source, mapping.pm, mapping.exact, mapping.confidence, mapping.owner?.id];
      for (let at = 0; at <= next.source.length; at++) assert.deepEqual(
        shape(modules.mapSource(next.ledger, at, {bias})), shape(modules.mapSource(fresh.ledger, at, {bias})),
        `source-first iteration ${iteration}: source ${at}`);
      for (let at = 0; at <= next.doc.content.size; at++) assert.deepEqual(
        shape(modules.mapRich(next.ledger, at, {bias})), shape(modules.mapRich(fresh.ledger, at, {bias})),
        `source-first iteration ${iteration}: rich ${at}`);
    }
  }
  assert.ok(sourceAccepted > 100, `source-first fuzz accepted ${sourceAccepted} cases`);
  console.log(`PASS: ${sourceAccepted} source-first edits exactly match fresh source/document/mappings.`);
  assert.ok(accepted > 50, `the fuzz must accept a meaningful number of edits, got ${accepted} (rejected ${rejected})`);
  console.log(`PASS: ${accepted} random text edits kept source and document in agreement (${rejected} fell back).`);
  fs.rmSync(scratch, { recursive: true, force: true });
})().catch(error => {
  console.error(error);
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
});
