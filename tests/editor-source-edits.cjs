'use strict';
// Focused checks for the source-preserving plain-text fast path.
// Build a small standalone CJS bundle; the full editor suite and shared bundle
// checks remain the parent's responsibility.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { Transform } = require('prosemirror-transform');

fs.mkdirSync('target', { recursive: true });
const outfile = path.resolve('target/editor-source-edits.cjs');
esbuild.buildSync({
  stdin: {
    contents: `export { tryTextEdits } from './ui/editor/source-edits.js'; export { parseSource, schema } from './ui/editor/model.js'; export { mapSource, mapRich } from './ui/editor/source-ledger.js';`,
    resolveDir: process.cwd(),
    sourcefile: 'tests/editor-source-edits-entry.js'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'silent'
});

const { tryTextEdits, parseSource, schema, mapSource, mapRich } = require(outfile);

function textPosition(doc, needle, occurrence = 0) {
  let seen = 0, found = null;
  doc.descendants((node, position) => {
    if (found || !node.isText) return undefined;
    let index = node.text.indexOf(needle);
    while (index !== -1) {
      if (seen === occurrence) {
        found = {
          from: position + index,
          to: position + index + needle.length,
          marks: node.marks
        };
        return false;
      }
      seen++;
      index = node.text.indexOf(needle, index + needle.length);
    }
    return undefined;
  });
  if (!found) throw new Error(`Text ${JSON.stringify(needle)} occurrence ${occurrence} not found`);
  return found;
}

function transaction(doc, edits) {
  const tr = new Transform(doc);
  for (const edit of edits) {
    if (edit.remove) tr.delete(edit.from, edit.to);
    else tr.replaceWith(edit.from, edit.to, schema.text(edit.text, edit.marks || []));
  }
  return tr;
}

function replace(doc, needle, text, occurrence = 0) {
  const target = textPosition(doc, needle, occurrence);
  return { ...target, text };
}

function assertModelShape(model, intended, probes = []) {
  assert.equal(model.doc, intended, 'model uses the intended document identity');
  assert.equal(model.segments.length, intended.childCount);
  for (let index = 0; index < model.segments.length; index++) {
    assert.equal(model.segments[index].node, intended.child(index), `segment ${index} points at the intended child`);
  }

  const ledger = model.ledger;
  const fresh = parseSource(model.source).ledger;
  assert.ok(ledger, 'returned model retains a verified ledger');
  assert.equal(ledger.source, model.source, 'ledger describes the returned source');
  assert.equal(ledger.doc, intended, 'ledger describes the intended document');
  assert.deepEqual(ledger.metadata, fresh.metadata, 'ledger metadata matches a fresh parse');
  assert.deepEqual(ledger.runs, fresh.runs, 'ledger runs match a fresh parse');
  assert.deepEqual(ledger.gaps, fresh.gaps, 'ledger gaps match a fresh parse');
  assert.deepEqual(ledger.unmapped, fresh.unmapped, 'ledger unmapped ranges match a fresh parse');
  assert.deepEqual(ledger.errors, fresh.errors, 'ledger errors match a fresh parse');
  assert.equal(ledger.owners.length, fresh.owners.length, 'ledger owner count matches a fresh parse');
  for (let index = 0; index < ledger.owners.length; index++) {
    const actual = ledger.owners[index], expected = fresh.owners[index];
    assert.equal(actual.id, expected.id);
    assert.equal(actual.type, expected.type);
    assert.equal(actual.pmFrom, expected.pmFrom);
    assert.equal(actual.pmTo, expected.pmTo);
    assert.equal(actual.sourceFrom, expected.sourceFrom);
    assert.equal(actual.sourceTo, expected.sourceTo);
    assert.equal(actual.confidence, expected.confidence);
    assert.equal(actual.supported, expected.supported);
    assert.ok(actual.node.eq(expected.node), `owner ${index} still describes the same node content`);
    assert.equal(actual.node, intended.nodeAt(actual.pmFrom), `owner ${index} points at the intended document node`);
  }

  for (const probe of probes) {
    const offset = model.source.indexOf(probe);
    assert.ok(offset >= 0, `probe ${JSON.stringify(probe)} exists`);
    const mapped = mapSource(ledger, offset, { bias: 'right' });
    assert.equal(mapped.exact, true, `probe ${probe}: source maps exactly`);
    assert.equal(mapped.confidence, 'exact', `probe ${probe}: source confidence`);
    assert.equal(mapRich(ledger, mapped.pm, { bias: 'right' }).source, offset, `probe ${probe}: round trip`);
  }
}

// 1. Plain text edits keep the existing __bold__ and *em* delimiter spelling.
{
  const input = 'A __bold__ and *em* end\n';
  const model = parseSource(input);
  const previousLedger = model.ledger, previousOwnerNode = model.ledger.owners[0].node;

  const bold = replace(model.doc, 'bold', 'bolder');
  const boldTr = transaction(model.doc, [bold]);
  const boldModel = tryTextEdits(model, [boldTr], boldTr.doc);
  assert.ok(boldModel, 'bold text replacement should be supported');
  assert.equal(boldModel.source, 'A __bolder__ and *em* end\n');
  assertModelShape(boldModel, boldTr.doc, ['bolder']);
  assert.equal(model.ledger, previousLedger, 'previous ledger object is not replaced');
  assert.equal(model.ledger.doc, model.doc, 'previous ledger still describes the previous document');
  assert.equal(model.ledger.owners[0].node, previousOwnerNode, 'previous ledger owner identity is untouched');
  assert.notEqual(boldModel.ledger, previousLedger, 'returned ledger is a fresh verified ledger');

  const em = replace(model.doc, 'em', 'EM');
  const emTr = transaction(model.doc, [em]);
  const emModel = tryTextEdits(model, [emTr], emTr.doc);
  assert.ok(emModel, 'emphasis text replacement should be supported');
  assert.equal(emModel.source, 'A __bold__ and *EM* end\n');
  assertModelShape(emModel, emTr.doc, ['EM']);
}

// 1b. Deletion ends before a closing marker (left affinity), while a plain
//     insertion at the marked end lands after it (right affinity).
{
  const input = 'one **two** three\n';
  const model = parseSource(input);
  const two = textPosition(model.doc, 'two');
  const deleteTr = transaction(model.doc, [{ remove: true, from: two.from, to: two.from + 2 }]);
  const deleted = tryTextEdits(model, [deleteTr], deleteTr.doc);
  assert.ok(deleted, 'deletion inside a marked run should be supported');
  assert.equal(deleted.source, 'one **o** three\n');
  assertModelShape(deleted, deleteTr.doc, ['three']);

  const insertTr = transaction(model.doc, [{ from: two.to, to: two.to, text: '!' }]);
  const inserted = tryTextEdits(model, [insertTr], insertTr.doc);
  assert.ok(inserted, 'plain insertion at a marked end should be supported');
  assert.equal(inserted.source, 'one **two**! three\n');
  assertModelShape(inserted, insertTr.doc, ['!']);
}

// 2. Trailing reference definitions are gaps and stay byte-for-byte unchanged.
{
  const input = 'First [one][a].\n\nSecond [two][b].\n\n[a]: https://a.example\n[b]: https://b.example\n';
  const model = parseSource(input);
  const edit = replace(model.doc, 'Second', 'Changed');
  const tr = transaction(model.doc, [edit]);
  const updated = tryTextEdits(model, [tr], tr.doc);
  assert.ok(updated, 'paragraph text replacement should be supported');
  assert.equal(updated.source,
    'First [one][a].\n\nChanged [two][b].\n\n[a]: https://a.example\n[b]: https://b.example\n');
  assert.ok(updated.source.endsWith('\n\n[a]: https://a.example\n[b]: https://b.example\n'));
  assertModelShape(updated, tr.doc, ['Changed']);
}

// 3. Escapes and named/numeric entities outside the edit are copied verbatim.
{
  const input = 'Escape \\*lit\\* and &amp; and &#65; and &nope; end\n';
  const model = parseSource(input);
  const edit = replace(model.doc, 'end', 'END');
  const tr = transaction(model.doc, [edit]);
  const updated = tryTextEdits(model, [tr], tr.doc);
  assert.ok(updated, 'plain replacement near escapes should be supported');
  assert.equal(updated.source, 'Escape \\*lit\\* and &amp; and &#65; and &nope; END\n');
  assertModelShape(updated, tr.doc, ['END']);
}

// 4. Repeated text maps through the actual step position, not a text search.
{
  const input = 'alpha alpha alpha\n\nalpha alpha\n';
  const model = parseSource(input);
  const tr = transaction(model.doc, [
    replace(model.doc, 'alpha', 'bravo', 1),
    replace(model.doc, 'alpha', 'omega', 4)
  ]);
  const updated = tryTextEdits(model, [tr], tr.doc);
  assert.ok(updated, 'repeated words should be supported by exact position');
  assert.equal(updated.source, 'alpha bravo alpha\n\nalpha omega\n');
  assertModelShape(updated, tr.doc, ['bravo', 'omega']);
}

// 5. A mapped nested-list paragraph keeps its indentation and sibling markers.
{
  const input = '- parent *em*\n  - child\n- next\n';
  const model = parseSource(input);
  const edit = replace(model.doc, 'child', 'kid');
  const tr = transaction(model.doc, [edit]);
  const updated = tryTextEdits(model, [tr], tr.doc);
  assert.ok(updated, 'nested list text replacement should be supported when mapped');
  assert.equal(updated.source, '- parent *em*\n  - kid\n- next\n');
  assertModelShape(updated, tr.doc, ['kid']);
}

// 6. An edit whose text would be reinterpreted as Markdown is rejected without
//    touching the previous model or source.
{
  const input = 'A plain text end\n';
  const model = parseSource(input);
  const beforeSource = model.source, beforeDoc = model.doc, beforeLedger = model.ledger;
  const edit = replace(model.doc, 'plain', '*x*');
  const tr = transaction(model.doc, [edit]);
  const updated = tryTextEdits(model, [tr], tr.doc);
  assert.equal(updated, null, 'partial markup must not silently change semantics');
  assert.equal(model.source, beforeSource);
  assert.equal(model.doc, beforeDoc);
  assert.equal(model.ledger, beforeLedger);
}

// 7. Unsupported raw content and null inputs are refused instead of guessed.
{
  const input = 'text[^1]\n\n[^1]: note\n';
  const model = parseSource(input);
  const edit = replace(model.doc, 'text', 'TEXT');
  const tr = transaction(model.doc, [edit]);
  assert.equal(tryTextEdits(model, [tr], tr.doc), null, 'raw block text edit must return null');
  assert.equal(tryTextEdits(null, [], model.doc), null, 'null model must return null');
  assert.equal(tryTextEdits(model, [tr], null), null, 'null intended document must return null');

  const plainInput = 'A plain end\n';
  const plainModel = parseSource(plainInput);
  const target = textPosition(plainModel.doc, 'plain');
  const markTr = new Transform(plainModel.doc);
  markTr.addMark(target.from, target.to, schema.marks.strong.create());
  assert.equal(tryTextEdits(plainModel, [markTr], markTr.doc), null, 'mark commands must return null');
  assert.equal(plainModel.source, plainInput);
}

// 8. Multiple steps and multiple transactions are applied in sequence.
{
  const input = 'one **two** three\n\nfour\n';
  const model = parseSource(input);
  const tr = transaction(model.doc, [
    replace(model.doc, 'one', 'ONE'),
    replace(model.doc, 'two', 'TWO')
  ]);
  const updated = tryTextEdits(model, [tr], tr.doc);
  assert.ok(updated, 'multiple steps in one transaction should be supported');
  assert.equal(updated.source, 'ONE **TWO** three\n\nfour\n');
  assertModelShape(updated, tr.doc, ['TWO']);

  const input2 = 'alpha beta\n';
  const model2 = parseSource(input2);
  const first = transaction(model2.doc, [replace(model2.doc, 'alpha', 'ALPHA')]);
  const second = transaction(first.doc, [replace(first.doc, 'beta', 'BETA')]);
  const updated2 = tryTextEdits(model2, [first, second], second.doc);
  assert.ok(updated2, 'multiple transactions should be supported');
  assert.equal(updated2.source, 'ALPHA BETA\n');
  assertModelShape(updated2, second.doc, ['ALPHA', 'BETA']);

  const input3 = 'alpha beta\n';
  const model3 = parseSource(input3);
  const shifted = new Transform(model3.doc);
  shifted.insert(1, schema.text('X'));
  const beta = textPosition(shifted.doc, 'beta');
  shifted.replaceWith(beta.from, beta.to, schema.text('BETA'));
  const updated3 = tryTextEdits(model3, [shifted], shifted.doc);
  assert.ok(updated3, 'steps whose positions shift after an insertion should be supported');
  assert.equal(updated3.source, 'Xalpha BETA\n');
  assertModelShape(updated3, shifted.doc, ['BETA']);
}

console.log('PASS: source text edits preserve delimiter spelling, references, escapes/entities, repeated occurrences, nested lists, reject semantic markup drift/raw input and handle multi-step transactions.');
