'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const outfile = path.resolve('target/editor-source-card-incremental.cjs');
esbuild.buildSync({ stdin: { contents: `import * as edits from './ui/editor/source-edits.js'; export const trySourceCardEdit = edits['trySourceCardEdit']; export { parseSource, resetEditorStats, editorStats } from './ui/editor/model.js'; export { mapSource, mapRich } from './ui/editor/source-ledger.js';`, resolveDir: process.cwd(), sourcefile: 'source-card-test.js' }, bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
const { trySourceCardEdit, parseSource, resetEditorStats, editorStats, mapSource, mapRich } = require(outfile);
assert.equal(typeof trySourceCardEdit, 'function', 'source-card edits need an incremental path');
function projection(model, edit) {
  const delta = edit.insert.length - (edit.to - edit.from), range = model.sourceEdit;
  return { from: edit.from < range.from ? Math.min(edit.from, range.from + delta) : range.from,
    to: edit.to <= range.to ? range.to + delta : Math.max(edit.from + edit.insert.length, range.to) };
}
function snapshot(model) {
  return JSON.stringify({ ...model, doc: model.doc.toJSON(), segments: model.segments.map(s => ({ ...s, node: s.node.toJSON() })), ledger: { ...model.ledger, doc: model.ledger.doc.toJSON(), owners: model.ledger.owners.map(o => ({ ...o, node: o.node.toJSON() })), ownerById: undefined } });
}
function compare(actual, expected, exhaustive = true) {
  assert.deepEqual(JSON.parse(snapshot(actual)), JSON.parse(snapshot(expected)), 'incremental model, segments and entire ledger match the canonical projected parse');
  for (const bias of ['left', 'right']) {
    const sources = exhaustive ? Array.from({ length: actual.source.length + 1 }, (_, i) => i) : [0, actual.sourceEdit.from, actual.sourceEdit.to, actual.source.length];
    for (const i of sources) {
      const a = mapSource(actual.ledger, i, { bias }), b = mapSource(expected.ledger, i, { bias });
      assert.deepEqual({ ...a, owner: a.owner?.id }, { ...b, owner: b.owner?.id });
    }
    const positions = exhaustive ? Array.from({ length: actual.doc.content.size + 1 }, (_, i) => i) : [0, actual.doc.content.size];
    for (const i of positions) {
      const a = mapRich(actual.ledger, i, { bias }), b = mapRich(expected.ledger, i, { bias });
      assert.deepEqual({ ...a, owner: a.owner?.id }, { ...b, owner: b.owner?.id });
    }
  }
}
function check(model, edit, requireFast = false, exhaustive = true) {
  const before = snapshot(model);
  resetEditorStats();
  const next = trySourceCardEdit(model, edit);
  const stats = editorStats();
  if (requireFast) assert.ok(next, 'stable source-card edit takes the incremental path');
  const source = model.source.slice(0, edit.from) + edit.insert + model.source.slice(edit.to);
  const expected = parseSource(source, projection(model, edit));
  if (next) {
    compare(next, expected, exhaustive);
    for (let i = 0; i < model.segments.length; i++) if (model.segments[i].from !== model.sourceEdit.from) assert.equal(next.doc.child(i), model.doc.child(i), 'unedited blocks retain immutable node identity');
  }
  assert.equal(snapshot(model), before, 'previous model remains valid for undo');
  return { next: next || expected, fast: !!next, stats };
}
// A keystroke in a 124KB document must parse only the card and its neighbors.
{
  const source = 'Intro.\n\n' + 'Paragraph ordinary words.\n\n'.repeat(2400) + '# Card\n\n' + 'After paragraph.\n\n'.repeat(3400);
  const from = source.indexOf('# Card');
  const model = parseSource(source, { from, to: from + 6 });
  const { stats } = check(model, { from: from + 6, to: from + 6, insert: '!' }, true, false);
  assert.ok(stats.sourceParseBytes < 200, `source-card edit parsed ${stats.sourceParseBytes} bytes of ${source.length}`);
}
// Stable punctuation and line boundaries remain incremental, including edits
// that change the number of Markdown blocks represented by the same card.
{
  const source = 'Before.\n\n# Card\n\nAfter.\n';
  const from = source.indexOf('# Card');
  const model = parseSource(source, { from, to: from + 6 });
  for (const insert of ['**', '\n', '\n\n', '\n# Pasted\n\nbody']) check(model, { from: from + 4, to: from + 4, insert }, true);
  assert.equal(trySourceCardEdit(model, { from: 0, to: 0, insert: 'outside' }), null);
}
const fixtures = [
  ['Before.\n\n# Card\n\nAfter.\n\nTail.\n', '# Card', '# Card'],
  ['Before.\n\n```js\nlet card = 1;\n```\n\nAfter.\n\nTail.\n', '```js', '```\n\nAfter'],
  ['Before.\n\n<div>\ncard\n</div>\n\nAfter.\n\nTail.\n', '<div>', '</div>'],
  ['Before.\n\n# Card\n\nSecond block.\n\nAfter.\n', '# Card', 'Second block.'],
  ['# Card\n\nAfter.\n', '# Card', '# Card'],
  ['Before.\n\n# Card\n', '# Card', '# Card'],
  ['Before.\r\n\r\n# Card\r\n\r\nAfter.\r\n', '# Card', '# Card'],
  ['- a **bold** item\n- second\n\n# Card\n\n| h | b |\n| --- | --- |\n| x | y |\n\nTail.\n', '# Card', '# Card'],
  ['Press <kbd>key</kbd>.\n\n# Card\n\nA **bold** and &amp; escaped \\* sign.\n\nTail.\n', '# Card', '# Card'],
  ['> quoted\n> continuation\n\n# Card\n\n$$\nx+y\n$$\n\nTail.\n', '# Card', '# Card'],
];
let fast = 0, fallback = 0;
for (const [source, start, end] of fixtures) {
  const from = source.indexOf(start), to = source.indexOf(end, from) + end.length;
  const base = parseSource(source, { from, to });
  const card = base.segments.find(s => s.from === base.sourceEdit.from);
  const contentEnd = card.from + card.node.textContent.length;
  for (const insert of ['x', '**', '\n', '\n\n', '```', '<!--', '-->', '[ref]: https://example.com\n', '\n# Pasted\n\nbody', '---\n']) {
    for (const at of [card.from, Math.min(card.from + 4, contentEnd), contentEnd]) {
      const result = check(base, { from: at, to: at, insert });
      if (result.fast) fast++; else fallback++;
    }
  }
  // Deleting fence/HTML boundaries and the card's final source newline may escape the card.
  for (const [from, to] of [[card.from, Math.min(card.from + 3, card.to)], [Math.max(card.from, contentEnd - 3), contentEnd], [contentEnd, card.to]]) {
    const result = check(base, { from, to, insert: '' });
    if (result.fast) fast++; else fallback++;
  }
  let current = base, seed = 923;
  for (let i = 0; i < 90; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const segment = current.segments.find(s => s.node.attrs.kind === 'source-edit');
    if (!segment) break;
    const length = segment.node.textContent.length;
    const at = segment.from + seed % (length + 1);
    const insert = ['a', ' ', '\n', '*', '`', '[', ']', '<', '>', ':', '\\', '\n\n'][seed % 12];
    const to = Math.min(at + (seed % 5 === 0 ? 1 : 0), segment.from + length);
    const result = check(current, { from: at, to, insert });
    current = result.next;
    if (result.fast) fast++; else fallback++;
  }
}
for (const source of ['[x][ref]\n\n# Card\n\n[ref]: /old\n', '---\n\nBefore.\n\n# Card\n\nAfter.\n']) {
  const at = source.indexOf('# Card');
  const model = parseSource(source, { from: at, to: at + 6 });
  assert.equal(check(model, { from: at + 6, to: at + 6, insert: '\n---' }).fast, false, 'global definitions/frontmatter retain full canonical parsing');
}
// Display-math rules look forward across arbitrary block boundaries. A card
// edit can close a distant opener or open a block ending beyond this window.
for (const [open, close] of [['$$', '$$'], ['\\[', '\\]']]) {
  for (const [source, insert] of [
    [`${open}\n\nBefore.\n\nGap.\n\n# Card\n\nAfter.\n`, `\n${close}`],
    [`Before.\n\n# Card\n\nAfter.\n\nGap.\n\n${close}\n`, `${open}\n\n`],
  ]) {
    const at = source.indexOf('# Card');
    const model = parseSource(source, { from: at, to: at + 6 });
    const position = insert.startsWith('\n') ? at + 6 : at;
    assert.equal(check(model, { from: position, to: position, insert }).fast, false,
      'display math delimiters can change blocks outside the validation window');
  }
  const source = `${open}\n\nBefore.\n\nGap.\n\n# Card\n${close}x\n\nAfter.\n`;
  const from = source.indexOf('# Card'), at = source.indexOf(`${close}x`) + close.length;
  const model = parseSource(source, { from, to: at + 1 });
  assert.equal(check(model, { from: at, to: at + 1, insert: '' }).fast, false,
    'deleting ordinary text can expose a display math closer');
  const split = close[0] + '\n' + close.slice(1);
  const joinedSource = `${open}\n\nBefore.\n\nGap.\n\n# Card\n${split}\n\nAfter.\n`;
  const cardFrom = joinedSource.indexOf('# Card'), joinAt = joinedSource.indexOf(split, cardFrom) + 1;
  const joinedModel = parseSource(joinedSource, { from: cardFrom, to: joinAt + 2 });
  assert.equal(check(joinedModel, { from: joinAt, to: joinAt + 1, insert: '' }).fast, false,
    'joining lines can create a display math delimiter without inserting syntax');
}
{
  const source = 'Before.\n\n$$\nx + y\n$$\n\nAfter.\n';
  const from = source.indexOf('$$'), at = source.indexOf('x + y') + 1;
  const model = parseSource(source, { from, to: from + 2 });
  check(model, { from: at, to: at, insert: 'z\nbody' }, true);
}
// Opening frontmatter on the first line can consume a distant closing line.
{
  const source = '# Card\n\nAfter.\n\nGap.\n\n---\n';
  const model = parseSource(source, { from: 0, to: 6 });
  assert.equal(check(model, { from: 0, to: 6, insert: '---' }).fast, false,
    'a new first-line frontmatter opener requires the whole document');
  const existing = '---\ntitle: Example\n---\n\nAfter.\n\nGap.\n\n---\n';
  const projected = parseSource(existing, { from: 0, to: 3 });
  const closer = existing.indexOf('---', 3);
  assert.equal(check(projected, { from: closer, to: closer + 1, insert: '' }).fast, false,
    'removing a frontmatter closer can activate a later delimiter');
}
assert.ok(fast > 100 && fallback > 0, 'focused and random edits exercise incremental validation and canonical fallback');
console.log(`PASS: source-card incremental parse budget, exact models/ledgers/mappings and undo snapshots (${fast} fast, ${fallback} fallback edits).`);
