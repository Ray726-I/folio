const assert = require('node:assert/strict');
const path = require('node:path');
const { EditorState, TextSelection } = require('prosemirror-state');
const { splitListItem } = require('prosemirror-schema-list');
require('esbuild').buildSync({ entryPoints: ['ui/editor/model.js'], bundle: true, packages: 'external', platform: 'node', format: 'cjs', outfile: 'target/editor-task-boundaries.cjs', logLevel: 'silent' });
const model = require(path.resolve('target/editor-task-boundaries.cjs'));
for (const position of [3, 4]) {
  const before = model.parseSource('- [ ] t\n');
  const state = EditorState.create({ doc: before.doc, selection: TextSelection.create(before.doc, position) });
  let change;
  assert.equal(splitListItem(model.schema.nodes.list_item)(state, transaction => { change = transaction; }), true);
  const after = model.updateSource(change.doc, before);
  assert.equal(model.parseSource(after.source).doc.eq(change.doc), true,
    `Enter at task position ${position} must keep an empty task, not turn its marker into literal text`);
}
console.log('PASS: Enter at either edge of a task preserves empty task items on reparse.');
