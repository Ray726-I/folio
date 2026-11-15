'use strict';
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const path = require('node:path');
const { Transform } = require('prosemirror-transform');
const outfile = path.resolve('target/editor-source-ledger-burst.cjs');
esbuild.buildSync({ stdin: { contents: "export {tryTextEdits,trySourceCardEdit} from './ui/editor/source-edits.js'; export {parseSource,schema} from './ui/editor/model.js'; export {mapSource,mapRich} from './ui/editor/source-ledger.js';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
const { tryTextEdits, trySourceCardEdit, parseSource, schema, mapSource, mapRich } = require(outfile);
const source = '# Burst\n\nOpening paragraph with enough words.\n\n' + ('| A | B |\n| --- | --- |\n| one | two |\n\nA **marked** paragraph.\n\n').repeat(400);
let model = parseSource(source);
const initial = model;
const counters = { runs: 0, owners: 0, gaps: 0 };
for (const name of Object.keys(counters)) {
  const records = model.ledger[name];
  model.ledger[name] = new Proxy(records, { get(target, key, receiver) {
    if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) counters[name]++;
    return Reflect.get(target, key, receiver);
  } });
}
let sourcePosition = source.indexOf('Opening') + 4;
for (let i = 0; i < 30; i++) {
  const pm = mapSource(model.ledger, sourcePosition).pm;
  const tr = new Transform(model.doc).insert(pm, schema.text('x'));
  for (const key of Object.keys(counters)) counters[key] = 0;
  const next = tryTextEdits(model, [tr], tr.doc);
  assert.ok(next, 'ordinary typing uses a verified local model');
  for (const key of Object.keys(counters)) if (i > 0 || key !== 'runs') assert.ok(counters[key] < 150, `typing burst reads only local ${key}, observed ${counters[key]}`);
  model = next;
  sourcePosition++;
}
assert.equal(initial.source, source, 'the initial immutable snapshot stays exact');
assert.equal(initial.doc.textContent.includes('xxxx'), false, 'the initial rich document stays untouched');
function assertEquivalent(actual) {
  const fresh = parseSource(actual.source, actual.sourceEdit);
  assert.ok(actual.doc.eq(fresh.doc));
  for (const name of ['runs','gaps','unmapped','metadata']) assert.deepEqual(actual.ledger[name], fresh.ledger[name], `${name} remains equivalent to canonical parsing`);
  assert.equal(actual.ledger.ownerById.size, fresh.ledger.ownerById.size);
  assert.deepEqual([...actual.ledger.ownerById.keys()], [...fresh.ledger.ownerById.keys()]);
  for (const [id, owner] of actual.ledger.ownerById) assert.equal(actual.ledger.ownerById.get(id), owner);
  actual.ledger.ownerById.forEach((owner, id, map) => { assert.equal(map, actual.ledger.ownerById); assert.ok(map.has(id)); assert.equal(map.get(id), owner); });
  for (let i = 0; i < fresh.ledger.owners.length; i++) {
    const owner = actual.ledger.owners[i], expected = fresh.ledger.owners[i];
    for (const field of ['pmFrom','pmTo','sourceFrom','sourceTo','contentFrom','contentTo','pmContentFrom','pmContentTo']) assert.equal(owner[field], expected[field], `${i}:${field}`);
    assert.equal(owner.node, actual.doc.nodeAt(owner.pmFrom));
    assert.equal(actual.ledger.ownerById.get(owner.id), owner);
  }
}
assertEquivalent(model);
const snapshot = model;
// Moving to another run settles one burst; subsequent typing must again stay
// local, while all earlier snapshots retain their exact mappings.
sourcePosition = model.source.lastIndexOf('paragraph.') + 4;
for (let i = 0; i < 20; i++) {
  const pm = mapSource(model.ledger, sourcePosition).pm;
  const tr = new Transform(model.doc).insert(pm, schema.text('z'));
  model = tryTextEdits(model, [tr], tr.doc); assert.ok(model); sourcePosition++;
}
assertEquivalent(model); assertEquivalent(snapshot);
for (const term of ['Burst','one','marked']) {
  const offset = model.source.indexOf(term), mapped = mapSource(model.ledger, offset);
  assert.equal(mapRich(model.ledger, mapped.pm, {bias:'right'}).source, offset);
}
// Boundary-sensitive suffixes: encoded characters, marks and rendered atoms
// retain their own coordinate maps after many edits in neighbouring runs.
for (const text of [
  'Prefix words &amp; entity tail words.\n',
  'Prefix words **marked words** tail words.\n',
  'Prefix words <kbd>Key</kbd> tail words.\n',
  'Prefix words $x+y$ tail words.\n',
]) {
  let current = parseSource(text), first;
  for (const needle of ['Prefix', 'tail']) {
    let offset = current.source.indexOf(needle) + 2;
    for (let i = 0; i < 12; i++) {
      const pos = mapSource(current.ledger, offset).pm;
      const tr = new Transform(current.doc).insert(pos, schema.text('z'));
      current = tryTextEdits(current, [tr], tr.doc); assert.ok(current); offset++;
      if (!first) first = current;
    }
  }
  assertEquivalent(current); assertEquivalent(first);
}
const cardSource = 'Before.\n\n```text\nalpha beta gamma\ndelta epsilon\n```\n\nAfter.\n';
let card = parseSource(cardSource, { from: cardSource.indexOf('```'), to: cardSource.indexOf('\n\nAfter') + 1 });
let at = card.source.indexOf('beta') + 2;
for (let i = 0; i < 20; i++) { card = trySourceCardEdit(card, { from: at, to: at, insert: 'q' }); assert.ok(card); at++; }
assertEquivalent(card);
console.log('PASS: large-document typing rebases only local ledger records and retains exact immutable snapshots across runs.');
