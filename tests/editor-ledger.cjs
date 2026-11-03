'use strict';
// Focused unit checks for the source ledger.  This deliberately builds its own
// small esbuild bundle instead of running the full editor suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

fs.mkdirSync('target', { recursive: true });
const outfile = path.resolve('target/editor-ledger.cjs');
esbuild.buildSync({
  stdin: {
    contents: `export * from './ui/editor/source-ledger.js'; export { parseSource, schema } from './ui/editor/model.js';`,
    resolveDir: process.cwd(),
    sourcefile: 'tests/editor-ledger-entry.js'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'silent'
});

const { buildLedger, mapSource, mapRich, applySourcePatches, parseSource, schema } = require(outfile);

function ledgerFor(source) {
  const model = parseSource(source);
  return { model, ledger: buildLedger(source, model.doc) };
}

function exactSource(ledger, offset, label) {
  const mapped = mapSource(ledger, offset);
  assert.equal(mapped.exact, true, `${label}: source ${offset} should map exactly`);
  assert.equal(mapped.confidence, 'exact', `${label}: source ${offset} confidence`);
  return mapped;
}

function exactRich(ledger, position, label, options = {}) {
  const mapped = mapRich(ledger, position, options);
  assert.equal(mapped.exact, true, `${label}: rich ${position} should map exactly`);
  assert.equal(mapped.confidence, 'exact', `${label}: rich ${position} confidence`);
  return mapped;
}

function roundTripSource(ledger, offset, label) {
  const mapped = exactSource(ledger, offset, label);
  const back = exactRich(ledger, mapped.pm, label, { bias: 'right' });
  assert.equal(back.source, offset, `${label}: ${offset} -> ${mapped.pm} -> ${back.source}`);
}

function findRun(ledger, text, occurrence = 0) {
  return ledger.runs.filter(run => run.text === text)[occurrence];
}

// 1. The concrete regression: paragraph start 23 must map inside the paragraph
//    (position 22), not to the previous heading's end/paragraph node start (21).
{
  const source = '# Native editor smoke\n\nIntro paragraph with repeated words and *em* and **strong** and `code`, \\*esc\\*, &amp;.';
  const { model, ledger } = ledgerFor(source);
  const paragraphStart = source.indexOf('Intro');
  assert.equal(paragraphStart, 23);
  const paragraph = model.doc.child(1);
  assert.equal(paragraph.type.name, 'paragraph');
  assert.equal(1 + model.doc.child(0).nodeSize, 22);

  const mapped = mapSource(ledger, paragraphStart);
  assert.equal(mapped.exact, true);
  assert.equal(mapped.pm, 22, 'paragraph start must be the first rich text position');
  assert.notEqual(mapped.pm, 21, 'old flattened diffChars gap');
  assert.equal(mapRich(ledger, 22).source, 23);
  assert.equal(mapRich(ledger, 22).exact, true);
  assert.equal(ledger.metadata.complete, true);
  assert.equal(ledger.metadata.partialOwners, 0);
  assert.equal(ledger.metadata.unmappedOwners, 0);
  assert.equal(ledger.supported, true);
}

// 2. Repeated words map by their own source occurrence, never by text search.
{
  const source = '# H\n\nalpha alpha alpha\n\nalpha alpha\n';
  const { ledger } = ledgerFor(source);
  assert.equal(ledger.metadata.complete, true);
  const offsets = [];
  for (let index = source.indexOf('alpha'); index !== -1; index = source.indexOf('alpha', index + 1)) offsets.push(index);
  assert.equal(offsets.length, 5);
  const positions = offsets.map((offset, index) => exactSource(ledger, offset, `repeated word ${index}`).pm);
  for (let i = 1; i < positions.length; i++) assert.ok(positions[i] > positions[i - 1], `repeated word order ${i}`);
  assert.ok(positions[0] < positions[3], 'second paragraph has distinct rich positions');
  offsets.forEach((offset, index) => assert.equal(exactRich(ledger, positions[index], `repeated word back ${index}`, { bias: 'right' }).source, offset));
}

// 3. Mixed * and _ delimiters become the same marks but keep distinct ranges.
{
  const source = 'a *em* b _em_ c **strong** d __strong__ e\n';
  const { ledger } = ledgerFor(source);
  assert.equal(ledger.metadata.complete, true);
  const first = source.indexOf('em'), second = source.indexOf('em', first + 1);
  const strong = source.indexOf('strong'), strong2 = source.indexOf('strong', strong + 1);
  assert.ok(first >= 0 && second > first && strong > second && strong2 > strong);
  const firstPm = exactSource(ledger, first, 'star em').pm;
  const secondPm = exactSource(ledger, second, 'underscore em').pm;
  const strongPm = exactSource(ledger, strong, 'star strong').pm;
  const strong2Pm = exactSource(ledger, strong2, 'underscore strong').pm;
  assert.ok(firstPm < secondPm && secondPm < strongPm && strongPm < strong2Pm);
  assert.equal(exactRich(ledger, secondPm, 'underscore em back', { bias: 'right' }).source, second);
  assert.deepEqual(ledger.gaps.filter(gap => gap.kind === 'syntax').map(gap => gap.text).sort(), ['*', '*', '**', '**', '_', '_', '__', '__'].sort());
}

// 4. Escapes, named/numeric entities and invalid entities retain exact spelling.
{
  const source = 'a \\*lit\\* &amp; &#65; &nope;\n';
  const { ledger } = ledgerFor(source);
  assert.equal(ledger.metadata.complete, true);
  const lit = source.indexOf('lit');
  roundTripSource(ledger, lit, 'escaped word');
  assert.equal(ledger.runs.find(run => run.text === '*').sourceFrom, 2);
  assert.equal(ledger.runs.find(run => run.text === '*').sourceTo, 4);

  const amp = source.indexOf('&amp;');
  const ampMapped = exactSource(ledger, amp, 'named entity');
  assert.equal(ampMapped.pm, 9);
  assert.equal(exactRich(ledger, 9, 'named entity back', { bias: 'right' }).source, amp);
  assert.equal(mapSource(ledger, amp + 5).pm, 10);

  const numeric = source.indexOf('&#65;');
  assert.equal(exactSource(ledger, numeric, 'numeric entity').pm, 11);
  assert.equal(exactRich(ledger, 11, 'numeric entity back', { bias: 'right' }).source, numeric);

  const invalid = source.indexOf('&nope;');
  const invalidRun = ledger.runs.find(run => run.text === '&nope;');
  assert.ok(invalidRun, 'invalid entity remains visible text');
  assert.equal(invalidRun.sourceFrom, invalid);
  assert.equal(invalidRun.sourceTo, invalid + 6);
  roundTripSource(ledger, invalid, 'invalid entity');
}

// 5. Leading/trailing blank lines are gaps; text still maps exactly.
{
  const source = '\n\n# H\n\ntext\n\n\n';
  const { ledger } = ledgerFor(source);
  assert.equal(ledger.metadata.complete, true);
  assert.equal(ledger.gaps[0].kind, 'whitespace');
  assert.equal(ledger.gaps[0].sourceFrom, 0);
  assert.equal(ledger.gaps[ledger.gaps.length - 1].sourceTo, source.length);
  const text = source.indexOf('text');
  roundTripSource(ledger, text, 'after leading blanks');
  assert.equal(mapSource(ledger, 0).exact, false);
  assert.equal(mapSource(ledger, source.length).exact, false);
}

// 6. Empty GFM cells have an exact zero-width anchor instead of a guessed word.
{
  const source = '| A | B | C |\n|---|---|---|\n| 1 |  | 3 |\n';
  const { ledger } = ledgerFor(source);
  assert.equal(ledger.metadata.complete, true);
  const empties = ledger.runs.filter(run => run.sourceFrom === run.sourceTo);
  assert.equal(empties.length, 1, 'one zero-width run for the empty cell');
  const empty = empties[0];
  assert.equal(empty.text, '');
  const forward = mapSource(ledger, empty.sourceFrom);
  assert.equal(forward.pm, empty.pmFrom);
  assert.equal(forward.exact, true);
  assert.equal(mapRich(ledger, empty.pmFrom).source, empty.sourceFrom);
  for (const needle of ['A', 'B', 'C', '1', '3']) {
    const offset = source.indexOf(needle);
    roundTripSource(ledger, offset, `table ${needle}`);
  }
}

// 7. Equally rendered blocks with different spelling are not matched by equality.
{
  const source = '*same* text\n\n_same_ text\n';
  const { ledger } = ledgerFor(source);
  assert.equal(ledger.metadata.complete, true);
  const first = source.indexOf('same');
  const second = source.indexOf('same', first + 1);
  const firstPm = exactSource(ledger, first, 'star same').pm;
  const secondPm = exactSource(ledger, second, 'underscore same').pm;
  assert.notEqual(firstPm, secondPm);
  assert.equal(exactRich(ledger, firstPm, 'star same back', { bias: 'right' }).source, first);
  assert.equal(exactRich(ledger, secondPm, 'underscore same back', { bias: 'right' }).source, second);
  const paragraphs = ledger.owners.filter(owner => owner.type === 'paragraph');
  assert.equal(paragraphs.length, 2);
  assert.deepEqual(paragraphs.map(owner => [owner.sourceFrom, owner.sourceTo]), [[0, 12], [13, 25]]);
}

// 8. Nested list prefixes, indentation and task markers are syntax gaps.
{
  const source = '- [ ] parent *em*\n  - [x] child `c`\n- [ ] next\n';
  const { model, ledger } = ledgerFor(source);
  assert.equal(ledger.metadata.complete, true);
  for (const needle of ['parent', 'em', 'child', 'c', 'next']) {
    const offset = source.indexOf(needle);
    roundTripSource(ledger, offset, `list ${needle}`);
  }
  const prefixes = ledger.gaps.filter(gap => gap.kind === 'prefix').map(gap => gap.text);
  assert.ok(prefixes.includes('[ ]'));
  assert.ok(prefixes.includes('[x]'));
  assert.ok(prefixes.includes('-'));
  const items = [];
  model.doc.descendants(node => { if (node.type.name === 'list_item') items.push(node.attrs.checked); });
  assert.deepEqual(items, [false, true, false]);
}

// 9. Inline math is an atom with exact source endpoints on both sides.
{
  const source = 'before $x^2$ after\n';
  const { ledger } = ledgerFor(source);
  assert.equal(ledger.metadata.complete, true);
  const owner = ledger.owners.find(candidate => candidate.type === 'math_inline');
  assert.ok(owner);
  assert.equal(owner.confidence, 'exact');
  assert.equal(owner.node.attrs.tex, 'x^2');
  assert.equal(owner.sourceFrom, 7);
  assert.equal(owner.sourceTo, 12);
  assert.equal(mapSource(ledger, 7).pm, 8);
  assert.equal(mapRich(ledger, 8).source, 7);
  assert.equal(mapSource(ledger, 12).pm, 9);
  assert.equal(mapRich(ledger, 9).source, 12);
  const before = source.indexOf('before');
  roundTripSource(ledger, before, 'text before math');
  roundTripSource(ledger, source.indexOf('after'), 'text after math');
}

// 10. Literal raw blocks map one-to-one when their content verifies exactly;
//     mismatched raw content stays explicitly unmapped.
{
  const source = 'text[^1]\n\n[^1]: note\n';
  const { model, ledger } = ledgerFor(source);
  assert.equal(ledger.metadata.complete, true);
  const raw = ledger.owners.find(owner => owner.type === 'raw_block');
  assert.ok(raw);
  assert.equal(raw.confidence, 'exact');
  assert.equal(raw.sourceFrom, 0);
  assert.equal(raw.sourceTo, 9);
  assert.equal(raw.contentFrom, 0);
  assert.equal(raw.contentTo, 8);
  assert.equal(raw.node.textContent, 'text[^1]');
  roundTripSource(ledger, 0, 'literal raw start');
  roundTripSource(ledger, source.indexOf('^1'), 'literal raw interior');
  // A footnote definition is Comrak syntax, not a link reference definition:
  // it must be an owned raw block (and therefore visible in the rich view)
  // rather than an invisible reference gap.
  const definition = ledger.owners.find(owner => owner.type === 'raw_block' && owner.sourceFrom === source.indexOf('[^1]: note'));
  assert.ok(definition, 'footnote definition is mapped as a raw block');
  assert.equal(definition.confidence, 'exact');
  assert.equal(definition.node.textContent, '[^1]: note');
  roundTripSource(ledger, source.indexOf('note'), 'footnote definition interior');

  const changed = model.doc.firstChild.type.create(model.doc.firstChild.attrs, schema.text('different'));
  const mismatched = buildLedger(source, schema.nodes.doc.create(null, [changed]));
  const rawMismatch = mismatched.owners.find(owner => owner.type === 'raw_block');
  assert.equal(rawMismatch.confidence, 'unmapped');
  assert.equal(mismatched.metadata.complete, false);
  const mapped = mapSource(mismatched, 1);
  assert.equal(mapped.exact, false);
  assert.equal(mapped.confidence, 'unmapped');
  assert.ok(mapped.pm === rawMismatch.pmFrom || mapped.pm === rawMismatch.pmTo);
}

// 11. Front matter maps its literal raw text one-to-one; the parser-trimmed
//     trailing LF remains an explicit whitespace gap.
{
  const source = '---\ntitle: x\n---\n\n# H\n';
  const { model, ledger } = ledgerFor(source);
  assert.deepEqual(model.doc.content.content.map(node => node.type.name), ['raw_block', 'heading']);
  const raw = ledger.owners.find(owner => owner.type === 'raw_block');
  assert.equal(raw.confidence, 'exact');
  assert.equal(raw.sourceFrom, 0);
  assert.equal(raw.sourceTo, 17);
  assert.equal(raw.contentFrom, 0);
  assert.equal(raw.contentTo, 16);
  assert.equal(ledger.metadata.complete, true);
  assert.ok(ledger.runs.some(run => run.text === '---\ntitle: x\n---' && run.sourceFrom === 0 && run.sourceTo === 16));
  roundTripSource(ledger, source.indexOf('title'), 'front matter literal');
  roundTripSource(ledger, source.indexOf('H'), 'heading after front matter');
}

// 12. Whitespace/reference gaps are tracked explicitly.
{
  const source = 'text\n\n[ref]: https://example.com "t"\n';
  const { ledger } = ledgerFor(source);
  assert.equal(ledger.metadata.complete, true);
  const reference = ledger.gaps.find(gap => gap.kind === 'reference');
  assert.ok(reference);
  assert.equal(reference.text, '[ref]: https://example.com "t"');
  assert.equal(reference.sourceFrom, 6);
  assert.equal(reference.sourceTo, 36);
  assert.equal(mapSource(ledger, 7).exact, false);
}

// 13. Fenced and indented code blocks map their visible text exactly.
{
  const source = '```js\nlet x = 1\n```\n\n    indented\n';
  const { ledger } = ledgerFor(source);
  assert.equal(ledger.metadata.complete, true);
  roundTripSource(ledger, source.indexOf('let x'), 'fenced code');
  roundTripSource(ledger, source.indexOf('indented'), 'indented code');
  assert.ok(ledger.gaps.some(gap => gap.kind === 'syntax' && gap.text === 'js'));
  assert.ok(ledger.gaps.some(gap => gap.kind === 'syntax' && gap.text === '```'));
}

// 14. Source patches only touch exact, verified intervals.
{
  const source = '# H\n\nIntro text\n';
  const { ledger } = ledgerFor(source);
  const from = source.indexOf('Intro'), to = from + 'Intro'.length;
  const result = applySourcePatches(ledger, [{ from, to, insert: 'Opening', expected: 'Intro' }]);
  assert.equal(result.source, '# H\n\nOpening text\n');
  assert.equal(result.applied, 1);

  const multi = applySourcePatches(ledger, [
    { from, to, insert: 'Opening' },
    { from: source.indexOf('text'), to: source.indexOf('text') + 4, insert: 'prose' }
  ]);
  assert.equal(multi.source, '# H\n\nOpening prose\n');

  assert.throws(() => applySourcePatches(ledger, [{ from, to, insert: 'x', expected: 'Wrong' }]), /expected/);
  assert.throws(() => applySourcePatches(ledger, [{ from, to: to + 2, insert: 'x' }, { from: from + 3, to: to + 2, insert: 'y' }]), /overlap/);
  assert.throws(() => applySourcePatches(ledger, [{ from: -1, to: 2, insert: 'x' }]), /out of bounds/);
  assert.throws(() => applySourcePatches(ledger, [{ from: 0, to: 1, insert: 'x', ownerId: 999 }]), /unknown owner/);
  assert.throws(() => applySourcePatches(ledger, [{ from: 0, to: 3, insert: 'x', ownerId: 1 }]), /outside owner/);
}

// 15. Mapping metadata is not an all-or-nothing claim.
{
  const source = 'a *b* c\n';
  const { ledger } = ledgerFor(source);
  assert.equal(ledger.metadata.complete, true);
  assert.equal(ledger.owners.every(owner => owner.confidence === 'exact'), true);
  assert.equal(ledger.runs.every(run => run.exact === true), true);
  assert.ok(ledger.metadata.coverage > 0 && ledger.metadata.coverage <= 1);
}

// 16. An empty/whitespace-only buffer still has an exact zero-width anchor.
{
  const source = '';
  const { ledger } = ledgerFor(source);
  assert.equal(ledger.metadata.complete, true);
  assert.equal(mapSource(ledger, 0).pm, 1);
  assert.equal(mapRich(ledger, 1).source, 0);
  assert.equal(ledger.owners.length, 1);
  assert.equal(ledger.owners[0].confidence, 'exact');
}

// 17. A partial parse keeps the verified prefix and reports the rest instead
//     of claiming a complete mapping or silently flattening the block.
{
  const source = 'hello\n';
  const model = parseSource(source);
  const paragraph = model.doc.firstChild;
  const doc = schema.nodes.doc.create(null, paragraph.type.create(null, schema.text('hello!')));
  const ledger = buildLedger(source, doc);
  assert.equal(ledger.metadata.complete, false);
  assert.equal(ledger.metadata.partialOwners, 1);
  const owner = ledger.owners.find(candidate => candidate.type === 'paragraph');
  assert.equal(owner.confidence, 'partial');
  assert.ok(owner.reason);
  assert.equal(mapSource(ledger, 0).pm, 1);
  assert.equal(mapRich(ledger, 1).source, 0);
  assert.equal(mapSource(ledger, 4).pm, 5);
}

// 18. Link labels, images and inline HTML are paired structurally, not by
//     searching for their rendered text.
{
  const source = 'A [link *x*](https://e.com "t") and ![alt](i.png) and <b>raw</b>\n';
  const { ledger } = ledgerFor(source);
  assert.equal(ledger.metadata.complete, true);
  const label = source.indexOf('x');
  roundTripSource(ledger, label, 'emphasis inside link label');
  const image = ledger.owners.find(owner => owner.type === 'image');
  assert.ok(image && image.confidence === 'exact');
  const imageStart = source.indexOf('![');
  const imageEnd = source.indexOf(')', imageStart) + 1;
  assert.equal(image.sourceFrom, imageStart);
  assert.equal(image.sourceTo, imageEnd);
  assert.equal(mapSource(ledger, image.sourceFrom).pm, image.pmFrom);
  assert.equal(mapRich(ledger, image.pmFrom).source, image.sourceFrom);
  assert.equal(mapRich(ledger, image.pmTo).source, image.sourceTo);
  const tag = ledger.owners.find(owner => owner.type === 'raw_inline');
  assert.ok(tag && tag.confidence === 'exact');
  // A balanced pair merges into one atom carrying the exact source, so the
  // rich view can render the real element instead of literal tag text.
  assert.equal(tag.node.attrs.source, '<b>raw</b>');
  assert.equal(tag.sourceFrom, source.indexOf('<b>'));
  assert.equal(tag.sourceTo, source.indexOf('</b>') + '</b>'.length);
  roundTripSource(ledger, source.indexOf('<b>'), 'raw inline html');
  // Like math atoms, endpoints map exactly; interior positions resolve to the
  // atom's edges.
  assert.equal(mapSource(ledger, tag.sourceTo).pm, tag.pmTo);
  assert.equal(mapRich(ledger, tag.pmTo).source, tag.sourceTo);
  assert.equal(mapRich(ledger, tag.pmFrom).source, tag.sourceFrom);
}

console.log('PASS: source ledger exact paragraph start, occurrence-aware mapping, escapes/entities, nested tasks, math, tables, links/images, literal raw blocks, partial/unmapped mismatch metadata and verified source patches.');

// Exact rich-position lookup should inspect a local neighborhood even when
// the revision has thousands of unrelated runs.
{
  const model = parseSource('plain words\n\n'.repeat(2000));
  const original = model.ledger.runs;
  let reads = 0;
  model.ledger.runs = new Proxy(original, { get(target, key, receiver) {
    if (/^\d+$/.test(String(key))) reads++;
    return Reflect.get(target, key, receiver);
  } });
  assert.equal(mapRich(model.ledger, 3).source, 2);
  assert.ok(reads < 30, `exact lookup inspected ${reads} runs`);
}
