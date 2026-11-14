'use strict';
// Focused regression for attaching a committed parse to the rich document.
//
// A source-first commit replaces the editor document with the candidate's
// content Fragment. ProseMirror preserves that Fragment's identity whenever no
// transaction repair changed it, so the parsed segments and ledger owners are
// already anchored to the committed document. Re-walking every descendant and
// re-checking every owner on each commit is pure bookkeeping; it must be
// skipped in exactly that identity case and stay byte-for-byte equivalent
// (mappings, segment ownership, round trip) to the previous implementation
// otherwise.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

fs.mkdirSync('target', { recursive: true });
const outfile = path.resolve('target/editor-model-rebase.cjs');
esbuild.buildSync({
  stdin: {
    contents: `export { attachModel, parseSource, updateSource, schema, editorStats, resetEditorStats } from './ui/editor/model.js';
export { buildLedger, mapSource, mapRich } from './ui/editor/source-ledger.js';
export { EditorState } from 'prosemirror-state';`,
    resolveDir: process.cwd(),
    sourcefile: 'tests/editor-model-rebase-entry.js'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'silent'
});

const {
  attachModel, parseSource, updateSource, schema, editorStats, resetEditorStats,
  buildLedger, mapSource, mapRich, EditorState
} = require(outfile);

// The implementation that lived in ui/editor/rich.js before the identity fast
// path. Kept here verbatim as the semantic oracle for every fallback case.
function legacyAttachModel(parsed, doc) {
  const segments = parsed.segments.length === doc.childCount
    ? parsed.segments.map((segment, index) => ({ ...segment, node: doc.child(index) }))
    : [];
  let ledger = parsed.ledger;
  if (ledger) {
    ledger.doc = doc;
    const nodes = new Map();
    doc.descendants((node, position) => { nodes.set(position, node); });
    for (const owner of ledger.owners) {
      const node = nodes.get(owner.pmFrom);
      if (!node || !node.eq(owner.node)) { ledger = null; break; }
      owner.node = node;
    }
  }
  if (!ledger) {
    try { ledger = buildLedger(parsed.source, doc, { segments }); } catch { ledger = null; }
  }
  return { ...parsed, doc, segments, ledger };
}

// The editor's whole-document source commit: `tr.replaceWith(0, size, parsed.doc.content)`.
function committedDoc(parsed, previousDoc = parsed.doc) {
  const state = EditorState.create({ schema, doc: previousDoc });
  return state.applyTransaction(state.tr.replaceWith(0, state.doc.content.size, parsed.doc.content)).state.doc;
}

function described(model) {
  return {
    source: model.source,
    doc: model.doc,
    segments: model.segments.map(segment => ({ from: segment.from, to: segment.to, raw: segment.raw, node: segment.node })),
    ledger: model.ledger ? {
      doc: model.ledger.doc,
      owners: model.ledger.owners.map(owner => ({
        id: owner.id, type: owner.type, pmFrom: owner.pmFrom, pmTo: owner.pmTo,
        sourceFrom: owner.sourceFrom, sourceTo: owner.sourceTo,
        confidence: owner.confidence, supported: owner.supported, node: owner.node
      })),
      runCount: model.ledger.runs.length,
      gapCount: model.ledger.gaps.length,
      errorCount: model.ledger.errors.length,
      metadata: model.ledger.metadata
    } : null
  };
}

// Every mapping entry point is part of the bookkeeping contract: two models
// that describe the same source/document pair must resolve positions the same
// way, including gaps, unowned syntax and owner attribution.
function mappingOf(model) {
  const readings = [];
  if (!model.ledger) return readings;
  for (let offset = 0; offset <= model.source.length; offset++) {
    for (const bias of ['left', 'right']) {
      const source = mapSource(model.ledger, offset, { bias });
      readings.push(['source', offset, bias, source.pm, source.exact, source.confidence, source.owner?.id ?? null, source.left, source.right]);
    }
  }
  for (let position = 0; position <= model.doc.content.size; position++) {
    const rich = mapRich(model.ledger, position, { bias: 'right' });
    readings.push(['rich', position, rich.source, rich.exact, rich.confidence, rich.owner?.id ?? null, rich.left, rich.right]);
  }
  return readings;
}

function assertSameMapping(actual, expected, label) {
  assert.deepEqual(mappingOf(actual), mappingOf(expected), `${label}: mapping diverged`);
}

function assertOwnerNodesBound(model, label) {
  for (const [index, segment] of model.segments.entries()) {
    assert.equal(segment.node, model.doc.child(index), `${label}: segment ${index} must reference the committed node`);
  }
  for (const owner of model.ledger?.owners ?? []) {
    let found = false;
    model.doc.descendants((node, position) => { if (position === owner.pmFrom) found = node === owner.node; });
    assert.equal(found, true, `${label}: owner ${owner.type}@${owner.pmFrom} must reference the committed node`);
  }
}

const ATLAS = [
  '---',
  'title: Atlas of the Northern Reach',
  '---',
  '',
  '# Atlas of the Northern Reach',
  '',
  'The atlas gathers **survey notes**, *route sketches*, `grid references` and [field photographs](https://example.com/atlas).',
  '',
  '## Coastal survey',
  '',
  'Paragraph one records the tide tables, the buoy positions and the harbour depth soundings taken at dawn.',
  'The second paragraph continues the traverse across the shingle bank and ends at the old lighthouse.',
  '',
  '- landing stage, north quay',
  '- [ ] boat shed inventory',
  '- [x] beacon inspection',
  '',
  '| Station | Easting | Northing |',
  '|:--------|:-------:|---------:|',
  '| A1      | 431205  | 552410   |',
  '| B4      | 431990  | 552880   |',
  '',
  '> A quotation from the surveyor: the wind held fair until the second bell.',
  '',
  '```js',
  'const station = { easting: 431205, northing: 552410 };',
  '```',
  '',
  '## Inland traverse',
  '',
  'The inland traverse crosses the moor, following the dyke and the **old drovers road** to the cairn.',
  'Math on the plate: $\\theta = 12.5^{\\circ}$ and a display block:',
  '',
  '$$',
  '\\Delta h = h_2 - h_1',
  '$$',
  '',
  '![Plate 4](plate-4.png)',
  '',
  '1. first leg to the cairn',
  '2. second leg along the burn',
  '',
  '<!-- surveyor: margin note -->',
  '',
  '## Appendix tables',
  '',
  '| Leg | Bearing | Distance |',
  '|-----|---------|----------|',
  '| 1   | 042     | 1.2 km   |',
  '| 2   | 118     | 0.8 km   |',
  ''
].join('\n');
const atlasSource = ATLAS + ATLAS.replace('Atlas of the Northern Reach', 'Atlas appendix').replace(/^## /gm, '### ') + ATLAS;

for (const source of [ATLAS, atlasSource]) {
  // --- Identity fast path -------------------------------------------------
  // Case 1: the transaction keeps the root node itself.
  {
    const parsed = parseSource(source);
    const doc = committedDoc(parsed);
    assert.equal(doc, parsed.doc, 'whole-document replacement keeps the parsed root when nothing repairs it');
    const legacy = legacyAttachModel(parsed, doc);
    resetEditorStats();
    const model = attachModel(parsed, doc);
    const stats = editorStats();
    assert.equal(stats.rebaseFast, 1, 'identity commit takes the fast path');
    assert.equal(stats.rebaseWalk, 0, 'identity commit must not walk the document');
    assert.equal(model.segments, parsed.segments, 'identity commit reuses the parsed segments');
    assert.equal(model.ledger, parsed.ledger, 'identity commit reuses the parsed ledger');
    assert.equal(model.ledger.doc, doc, 'identity commit points the ledger at the committed document');
    assertOwnerNodesBound(model, 'identity commit');
    assertSameMapping(model, legacy, 'identity commit');
    assert.equal(updateSource(model.doc, model).source, source, 'identity commit round-trips the exact source');
    assert.equal(model.source, source);
  }

  // Case 2: a new root node wrapping the very same content Fragment (what the
  // commit path produces when the view already held a different root).
  {
    const parsed = parseSource(source);
    const doc = schema.nodes.doc.create(null, parsed.doc.content);
    assert.notEqual(doc, parsed.doc);
    assert.equal(doc.content, parsed.doc.content, 'root rewrap keeps the content Fragment');
    const legacy = legacyAttachModel(parseSource(source), doc);
    resetEditorStats();
    const model = attachModel(parsed, doc);
    const stats = editorStats();
    assert.equal(stats.rebaseFast, 1, 'fragment-identity commit takes the fast path');
    assert.equal(stats.rebaseWalk, 0, 'fragment-identity commit must not walk the document');
    assert.equal(model.doc, doc);
    assertOwnerNodesBound(model, 'fragment-identity commit');
    assertSameMapping(model, legacy, 'fragment-identity commit');
    assert.equal(updateSource(model.doc, model).source, source, 'fragment-identity commit round-trips the exact source');
  }

  // --- Repair / divergence fallbacks --------------------------------------
  // Case 3: an appendTransaction repair changed one block. The previous
  // behavior (full walk, then a fresh ledger because the old one no longer
  // matches) is the contract; only the identity case may skip it.
  {
    const parsed = parseSource(source);
    const broken = parsed.doc.copy(parsed.doc.content.replaceChild(1,
      schema.nodes.heading.create({ level: 1 }, schema.text('Atlas of the Southern Reach'))));
    assert.notEqual(broken.content, parsed.doc.content);
    const expected = legacyAttachModel(parseSource(source), broken);
    resetEditorStats();
    const model = attachModel(parsed, broken);
    const stats = editorStats();
    assert.equal(stats.rebaseFast, 0, 'a repaired block must not take the identity fast path');
    assert.equal(stats.rebaseWalk, 1, 'a repaired block walks the committed document');
    assert.equal(model.doc, broken);
    assertOwnerNodesBound(model, 'repaired block');
    assert.deepEqual(described(model).segments.map(segment => [segment.from, segment.to, segment.node]), described(expected).segments.map(segment => [segment.from, segment.to, segment.node]));
    assert.deepEqual(described(model).ledger.owners.map(owner => [owner.id, owner.type, owner.pmFrom, owner.pmTo, owner.sourceFrom, owner.sourceTo, owner.confidence]),
      described(expected).ledger.owners.map(owner => [owner.id, owner.type, owner.pmFrom, owner.pmTo, owner.sourceFrom, owner.sourceTo, owner.confidence]), 'repaired block: owner bookkeeping is unchanged');
    assertSameMapping(model, expected, 'repaired block');
    assert.equal(updateSource(model.doc, model).source, updateSource(expected.doc, expected).source, 'repaired block: serialization matches the previous behavior');
  }

  // Case 4: the committed document no longer has one child per source segment
  // (for example a repair inserted an empty paragraph). Segments must be
  // dropped and the ledger rebuilt, exactly as before.
  {
    const parsed = parseSource(source);
    const extended = schema.nodes.doc.create(null, parsed.doc.content.addToEnd(schema.nodes.paragraph.create()));
    const expected = legacyAttachModel(parseSource(source), extended);
    resetEditorStats();
    const model = attachModel(parsed, extended);
    const stats = editorStats();
    assert.equal(stats.rebaseFast, 0);
    assert.equal(stats.rebaseWalk, 1);
    assert.equal(model.segments.length, 0, 'block-count divergence drops the segments');
    assert.deepEqual(described(model).ledger.owners.map(owner => [owner.id, owner.type, owner.pmFrom, owner.pmTo, owner.sourceFrom, owner.sourceTo, owner.confidence]),
      described(expected).ledger.owners.map(owner => [owner.id, owner.type, owner.pmFrom, owner.pmTo, owner.sourceFrom, owner.sourceTo, owner.confidence]), 'block-count divergence: owner bookkeeping is unchanged');
    assertSameMapping(model, expected, 'block-count divergence');
  }

  // Case 5: reusing the same parse for a second commit (the shell keeps the
  // previous model as its whole-replacement undo snapshot) must stay coherent.
  {
    const parsed = parseSource(source);
    const first = attachModel(parsed, committedDoc(parsed));
    const second = attachModel(parsed, schema.nodes.doc.create(null, parsed.doc.content));
    assert.equal(first.source, source);
    assert.equal(second.source, source);
    assert.equal(editorStats().rebaseFast, 2, 'repeated commits both use the fast path');
    assertOwnerNodesBound(first, 'undo snapshot');
    assertOwnerNodesBound(second, 'second commit');
    assertSameMapping(first, legacyAttachModel(parseSource(source), first.doc), 'undo snapshot');
  }
}

// The commit path must still be correct when the ledger was never built
// (buildLedger threw): the fallback rebuild is the existing behavior.
{
  const parsed = parseSource('# Heading\n\nBody text.\n');
  const bare = { ...parsed, ledger: null };
  const doc = committedDoc(parsed);
  resetEditorStats();
  const model = attachModel(bare, doc);
  assert.equal(editorStats().rebaseFast, 0, 'a missing ledger is not an identity hit');
  assert.ok(model.ledger, 'a missing ledger is rebuilt');
  assert.equal(model.ledger.doc, doc);
  assert.equal(model.source, parsed.source);
}

console.log('PASS: committed-model rebasing reuses parsed segments/ledger when the content Fragment is identical and stays equivalent to the previous walk for repaired or divergent documents.');
