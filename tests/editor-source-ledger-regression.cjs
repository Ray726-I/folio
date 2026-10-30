'use strict';
// Regression checks for the exact source ledger bridge in ui/editor/model.js.
// These are the concrete corruption/selection cases from the empirical gate;
// the full suite and bundle checks remain the parent's responsibility.
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const { Transform } = require('prosemirror-transform');
const { EditorState, TextSelection } = require('prosemirror-state');
const { splitBlock, joinBackward } = require('prosemirror-commands');

const outfile = path.resolve('target/editor-source-ledger-regression.cjs');
esbuild.buildSync({
  stdin: {
    contents: `export * from './ui/editor/model.js'; export { applySourcePatches, buildLedger } from './ui/editor/source-ledger.js';`,
    resolveDir: process.cwd(),
    sourcefile: 'tests/editor-source-ledger-regression-entry.js'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'silent'
});

const { parseSource, updateSource, sourceToRich, richToSource, sourceMapping, richMapping, applySourcePatches, buildLedger, schema } = require(outfile);

function assertLayout(model) {
  assert.equal(model.gaps.length, model.segments.length + 1, 'one gap per source boundary');
  let rebuilt = model.gaps[0];
  let offset = model.gaps[0].length;
  for (let index = 0; index < model.segments.length; index++) {
    const segment = model.segments[index];
    assert.equal(segment.from, offset, `segment ${index} starts at its source offset`);
    rebuilt += segment.raw;
    offset += segment.raw.length;
    assert.equal(segment.to, offset, `segment ${index} ends at its source offset`);
    rebuilt += model.gaps[index + 1];
    offset += model.gaps[index + 1].length;
  }
  assert.equal(rebuilt, model.source, 'gaps and segment raws reconstruct the canonical source');
}

function paragraph(text) { return schema.nodes.paragraph.create(null, schema.text(text)); }
function typeAtSource(source, offset, insert = 'X') {
  const model = parseSource(source);
  const richPos = sourceToRich(model, offset);
  const tr = new Transform(model.doc);
  tr.replaceWith(richPos, richPos, schema.text(insert));
  return { model, richPos, source: updateSource(tr.doc, model).source };
}
function replaceTop(source, index, text) {
  const model = parseSource(source);
  const children = model.doc.content.content.slice();
  children[index] = paragraph(text);
  return { model, source: updateSource(schema.nodes.doc.create(null, children), model).source };
}

// 1. A one-character edit in the last paragraph must retain trailing reference
//    definitions, which are gaps rather than part of the block's raw slice.
{
  const input = 'First [one][a].\n\nSecond [two][b].\n\n[a]: https://a.example\n[b]: https://b.example\n';
  const model = parseSource(input);
  const second = model.doc.child(1);
  const at = model.doc.child(0).nodeSize + 1 + second.content.size;
  const tr = new Transform(model.doc);
  tr.replaceWith(at, at, schema.text('!'));
  const actual = updateSource(tr.doc, model).source;
  assert.ok(actual.startsWith('First [one][a].\n\n'), 'first block preserved');
  assert.ok(actual.includes('\n\n[a]: https://a.example\n[b]: https://b.example\n'), 'trailing reference definitions preserved');
  assert.equal(actual.slice(actual.indexOf('\n\n[a]:')), '\n\n[a]: https://a.example\n[b]: https://b.example\n');
}

// 2. First source character of a paragraph maps inside that paragraph, not to
//    the end of the previous heading.
{
  const input = '# Title\n\nA paragraph.\n';
  const offset = input.indexOf('A paragraph.');
  assert.equal(offset, 9);
  const result = typeAtSource(input, offset);
  assert.equal(result.richPos, 8);
  assert.equal(result.source, '# Title\n\nXA paragraph.\n');
}

// 3. First source character after a table maps to the following paragraph, not
//    into the table's last cell.
{
  const input = 'Intro\n\n| A | B |\n| --- | --- |\n| one | two |\n\nafter paragraph\n';
  const offset = input.indexOf('after paragraph');
  const result = typeAtSource(input, offset);
  assert.equal(result.source, 'Intro\n\n| A | B |\n| --- | --- |\n| one | two |\n\nXafter paragraph\n');
}

// 4. A rich caret at the start of bold text maps after the opening marker, so
//    source-side typing remains inside the strong span.
{
  const input = 'one **two** three\n';
  const model = parseSource(input);
  assert.equal(richToSource(model, 5), 6);
  const mapping = richMapping(model, 5);
  assert.equal(mapping.source, 6);
  assert.equal(mapping.exact, true);
  assert.equal(sourceToRich(model, 6), 5);
}

// 5. Source-start toggle round trip is stable and exact.
{
  const input = '# Title\n\nA paragraph.\n';
  const model = parseSource(input);
  const sourcePos = richToSource(model, 8);
  assert.equal(sourcePos, 9);
  assert.equal(sourceToRich(model, sourcePos), 8);
  assert.equal(sourceMapping(model, sourcePos).exact, true);
}

// 6. No equality fallback: changing the first block to text that equals a later
//    block must not move that later block's attached reference definitions.
{
  const input = 'different\n\nsame\n\n[r1]: https://one.example\n\nsame\n\n[r2]: https://two.example\n';
  const result = replaceTop(input, 0, 'same');
  assert.equal(result.source, 'same\n\nsame\n\n[r1]: https://one.example\n\nsame\n\n[r2]: https://two.example\n');
}

// 7. No-op updates preserve the canonical source byte-for-byte, including
//    adjacent blocks with no blank separator and trailing gaps.
{
  const cases = [
    '## H\n### I\n',
    '# Title\n\nA paragraph.\n',
    '\n\n# H\n\nText\n\n[ref]: https://example.com\n',
    'First [one][a].\n\nSecond [two][b].\n\n[a]: https://a.example\n[b]: https://b.example\n',
    'no trailing newline'
  ];
  for (const input of cases) {
    const model = parseSource(input);
    assertLayout(model);
    assert.equal(updateSource(model.doc, model).source, input, `no-op changed ${JSON.stringify(input)}`);
  }
}

// 7b. Replacing a block whose token range absorbed a blank separator preserves
//     that separator instead of normalizing adjacent blocks together.
{
  const input = '- a\n- b\n\ntext\n';
  const result = replaceTop(input, 0, 'changed');
  assert.equal(result.source, 'changed\n\ntext\n');
}


// 7c. Splitting a paragraph must introduce a real blank separator; joining it
//     back must restore the exact original source without relocating the final
//     comment gap or trailing block.
{
  const input = '# Heading\n\nBefore **bold** café 😀.\n\nAfter.\n\n[route](https://example.com/original)\n\n<!-- exact  spaces -->\n';
  const model = parseSource(input);
  const firstParagraphStart = 1 + model.doc.child(0).nodeSize;
  let state = EditorState.create({ doc: model.doc, selection: TextSelection.create(model.doc, firstParagraphStart + 1) });
  const splitCommand = splitBlock(state, tr => { state = state.apply(tr); });
  assert.equal(splitCommand, true);
  const split = updateSource(state.doc, model);
  assertLayout(split);
  assert.equal(split.segments.length, state.doc.childCount);
  assert.ok(split.source.includes('B\n\nefore **bold**'), 'split paragraphs use a blank separator');
  assert.ok(split.source.endsWith('\n<!-- exact  spaces -->\n'), 'trailing comment stays at the end');
  assert.ok(parseSource(split.source).doc.eq(state.doc), 'split source reparses to the desired rich doc');

  const secondParagraphStart = 1 + state.doc.child(0).nodeSize + state.doc.child(1).nodeSize;
  let joinState = EditorState.create({ doc: state.doc, selection: TextSelection.create(state.doc, secondParagraphStart) });
  const joinCommand = joinBackward(joinState, tr => { joinState = joinState.apply(tr); });
  assert.equal(joinCommand, true);
  const joined = updateSource(joinState.doc, split);
  assertLayout(joined);
  assert.equal(joined.source, input, 'join restores the exact original source');
  assert.ok(parseSource(joined.source).doc.eq(joinState.doc), 'joined source reparses to the desired rich doc');
}

// 7d. Deleting first/middle/last blocks keeps every reference-definition gap
//     in its original relative order and returns a valid new gap layout.
{
  const input = 'First\n\nSecond\n\n[a]: https://a.example\n\nThird\n\n[b]: https://b.example\n';
  const model = parseSource(input);
  const expected = [
    'Second\n\n[a]: https://a.example\n\nThird\n\n[b]: https://b.example\n',
    'First\n\n[a]: https://a.example\n\nThird\n\n[b]: https://b.example\n',
    'First\n\nSecond\n\n[a]: https://a.example\n\n[b]: https://b.example\n'
  ];
  for (const remove of [0, 1, 2]) {
    const children = model.doc.content.content.filter((_, index) => index !== remove);
    const doc = schema.nodes.doc.create(null, children);
    const next = updateSource(doc, model);
    assertLayout(next);
    assert.equal(next.source, expected[remove], `delete block ${remove}`);
    assert.ok(next.source.indexOf('[a]:') < next.source.indexOf('[b]:'), 'reference definitions keep their order');
    assert.ok(parseSource(next.source).doc.eq(doc), `delete block ${remove} reparses to the desired rich doc`);
  }
}

// 7e. Inserting a genuinely new block gets a blank separator but leaves
//     trailing reference definitions after the inserted block.
{
  const input = 'First\n\n[ref]: https://example.com\n';
  const model = parseSource(input);
  const doc = schema.nodes.doc.create(null, [...model.doc.content.content, paragraph('New')]);
  const next = updateSource(doc, model);
  assertLayout(next);
  assert.equal(next.source, 'First\n\nNew\n\n[ref]: https://example.com\n');
  assert.ok(parseSource(next.source).doc.eq(doc));

  const prependedDoc = schema.nodes.doc.create(null, [paragraph('New'), ...model.doc.content.content]);
  const prepended = updateSource(prependedDoc, model);
  assertLayout(prepended);
  assert.equal(prepended.source, 'New\n\nFirst\n\n[ref]: https://example.com\n');
  assert.ok(parseSource(prepended.source).doc.eq(prependedDoc));
}

// 8. The model exposes exact mapping metadata and keeps its ledger current.
{
  const input = '# H\n\nIntro text\n';
  const model = parseSource(input);
  assert.ok(model.ledger, 'parseSource exposes a ledger');
  const mapped = sourceMapping(model, input.indexOf('Intro'));
  assert.equal(mapped.exact, true);
  assert.equal(mapped.pm, sourceToRich(model, input.indexOf('Intro')));
  const changed = model.doc.child(1).type.create(null, schema.text('Intro changed'));
  const next = updateSource(schema.nodes.doc.create(null, [model.doc.child(0), changed]), model);
  assert.equal(next.source, '# H\n\nIntro changed\n');
  assert.equal(sourceToRich(next, next.source.indexOf('changed')), next.doc.child(0).nodeSize + 1 + 'Intro '.length);
}

// 9. Source patches through the ledger stay verified and preserve surrounding
//    reference definitions exactly.
{
  const input = 'Text\n\n[ref]: https://example.com\n';
  const model = parseSource(input);
  const from = input.indexOf('Text');
  const result = applySourcePatches(model.ledger, [{ from, to: from + 4, insert: 'Changed', expected: 'Text' }]);
  assert.equal(result.source, 'Changed\n\n[ref]: https://example.com\n');
  assert.throws(() => applySourcePatches(model.ledger, [{ from, to: from + 4, insert: 'X', expected: 'Text!' }]), /expected/);
}


// 10. Literal raw blocks map one-to-one, while genuinely mismatched raw text
//     still reports unmapped metadata instead of a fuzzy translation.
{
  const input = 'text[^1]\n\n[^1]: note\n';
  const model = parseSource(input);
  const mapping = sourceMapping(model, 1);
  assert.equal(mapping.exact, true);
  assert.equal(mapping.confidence, 'exact');
  assert.ok(mapping.owner && mapping.owner.type === 'raw_block');
  assert.equal(sourceToRich(model, 1), 2);
  assert.equal(richToSource(model, 2), 1);

  const rawNode = model.doc.firstChild;
  const changed = rawNode.type.create(rawNode.attrs, schema.text('different'));
  const mismatched = buildLedger(input, schema.nodes.doc.create(null, [changed]));
  const raw = mismatched.owners.find(owner => owner.type === 'raw_block');
  assert.equal(raw.confidence, 'unmapped');
  assert.equal(mismatched.metadata.complete, false);
}

console.log('PASS: model bridge regression: exact split/join/delete/insert source layout, literal raw mapping, paragraph/table/bold mapping, reference gaps, no equality stealing and explicit unmapped mismatch metadata.');
