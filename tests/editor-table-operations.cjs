const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { Schema } = require('prosemirror-model');
const { EditorState, TextSelection } = require('prosemirror-state');
const { CellSelection, TableMap, tableNodes } = require('prosemirror-tables');

// Build only the new module and leave ProseMirror external so the test's
// schema/state/selection classes are the exact same instances the commands use.
// Keep the bundle inside the repository so Node can resolve the external
// ProseMirror packages from node_modules.
const scratchRoot = path.resolve('target');
fs.mkdirSync(scratchRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(scratchRoot, 'folio-table-operations-'));
const outfile = path.join(directory, 'table-operations.cjs');
esbuild.buildSync({
  entryPoints: [path.resolve('ui/editor/table-operations.js')],
  bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
  external: ['prosemirror-model', 'prosemirror-state', 'prosemirror-tables']
});
process.on('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
const { tableOperation, TABLE_OPERATION_NAMES } = require(outfile);

const schema = new Schema({
  nodes: {
    ...tableNodes({
      tableGroup: 'block',
      cellContent: 'block+',
      cellAttributes: { align: { default: null } }
    }),
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' }
  },
  marks: {
    strong: { parseDOM: [{ tag: 'strong' }], toDOM: () => ['strong', 0] }
  }
});

function makeTable(values, { headerRow = true } = {}) {
  const rows = values.map((cells, rowIndex) => schema.nodes.table_row.create(null, cells.map(value => {
    const spec = typeof value === 'string' ? { text: value } : value;
    const marks = spec.strong ? [schema.marks.strong.create()] : [];
    const content = spec.text ? [schema.text(spec.text, marks)] : [];
    const type = schema.nodes[headerRow && rowIndex === 0 ? 'table_header' : 'table_cell'];
    return type.create({ align: spec.align ?? null }, schema.nodes.paragraph.create(null, content));
  })));
  return schema.nodes.table.create(null, rows);
}

function cellPosition(doc, row, column) {
  const table = doc.firstChild;
  const map = TableMap.get(table);
  return 1 + map.positionAt(row, column, table);
}

function stateAt(table, row = 1, column = 0) {
  const doc = schema.nodes.doc.create(null, [table]);
  return EditorState.create({ doc, selection: CellSelection.create(doc, cellPosition(doc, row, column)) });
}

function selectRect(state, top, bottom, left, right) {
  const doc = state.doc;
  const anchor = cellPosition(doc, top, left);
  const head = cellPosition(doc, bottom, right);
  return state.apply(state.tr.setSelection(CellSelection.create(doc, anchor, head)));
}

function run(name, state) {
  const command = tableOperation(name);
  let dispatched = null;
  const applied = command(state, tr => { dispatched = tr; });
  return { applied, dispatched, state: applied && dispatched ? state.apply(dispatched) : state };
}

function grid(table) {
  const rows = [];
  table.forEach(row => {
    const cells = [];
    row.forEach(cell => cells.push(cell.textContent));
    rows.push(cells);
  });
  return rows;
}

function cellsOf(table, rowIndex) {
  const cells = [];
  table.child(rowIndex).forEach(cell => cells.push(cell));
  return cells;
}

function hasStrong(cell) {
  const text = cell.firstChild?.firstChild;
  return Boolean(text && text.marks.some(mark => mark.type.name === 'strong'));
}

// API surface.
assert.deepEqual([...TABLE_OPERATION_NAMES], [
  'move-row-up', 'move-row-down', 'move-column-left', 'move-column-right',
  'duplicate-row', 'duplicate-column', 'sort-ascending', 'sort-descending',
  'align-left', 'align-center', 'align-right'
]);
for (const name of TABLE_OPERATION_NAMES) assert.equal(typeof tableOperation(name), 'function', name);
assert.throws(() => tableOperation('move-row-sideways'), /Unknown table operation/);
assert.throws(() => tableOperation(), /Unknown table operation/);

// Row contents can move across the first position; header roles stay at the top.
{
  const table = makeTable([['H', 'Header'], ['A', '1'], ['B', '2'], ['C', '3']]);
  const state = stateAt(table, 2, 0);
  const result = run('move-row-up', state);
  assert.equal(result.applied, true, 'row moves up');
  assert.deepEqual(grid(result.state.doc.firstChild), [['H', 'Header'], ['B', '2'], ['A', '1'], ['C', '3']]);
  assert.equal(result.state.doc.firstChild.firstChild.firstChild.type.spec.tableRole, 'header_cell');

  const down = run('move-row-down', stateAt(table, 1, 0));
  assert.equal(down.applied, true, 'row moves down');
  assert.deepEqual(grid(down.state.doc.firstChild), [['H', 'Header'], ['B', '2'], ['A', '1'], ['C', '3']]);

  const promoted = run('move-row-up', stateAt(table, 1, 0));
  assert.equal(promoted.applied, true, 'data can enter the first slot');
  assert.deepEqual(grid(promoted.state.doc.firstChild), [['A', '1'], ['H', 'Header'], ['B', '2'], ['C', '3']]);
  promoted.state.doc.firstChild.forEach((row, offset, index) => row.forEach(cell => {
    assert.equal(cell.type.spec.tableRole, index === 0 ? 'header_cell' : 'cell');
  }));
  assert.equal(run('move-row-down', stateAt(table, 3, 0)).applied, false, 'last row cannot move down');
  assert.equal(run('move-row-up', stateAt(table, 0, 0)).applied, false, 'header row cannot move');
  assert.equal(run('move-row-down', stateAt(table, 0, 0)).applied, true, 'first row can move down');
}

// A wider row selection moves as one block.
{
  const table = makeTable([['H', 'Header'], ['A', '1'], ['B', '2'], ['C', '3'], ['D', '4']]);
  const state = selectRect(stateAt(table, 1, 0), 1, 2, 0, 1);
  const result = run('move-row-down', state);
  assert.equal(result.applied, true);
  assert.deepEqual(grid(result.state.doc.firstChild), [
    ['H', 'Header'], ['C', '3'], ['A', '1'], ['B', '2'], ['D', '4']
  ]);
}

// Move columns and preserve header cells plus body marks.
{
  const table = makeTable([
    ['H1', 'H2', 'H3'],
    ['A1', { text: 'A2', strong: true }, 'A3'],
    ['B1', 'B2', 'B3']
  ]);
  const left = run('move-column-left', stateAt(table, 1, 2));
  assert.equal(left.applied, true);
  assert.deepEqual(grid(left.state.doc.firstChild), [['H1', 'H3', 'H2'], ['A1', 'A3', 'A2'], ['B1', 'B3', 'B2']]);
  assert.equal(left.state.doc.firstChild.firstChild.child(2).type.spec.tableRole, 'header_cell');
  assert.equal(hasStrong(cellsOf(left.state.doc.firstChild, 1)[2]), true, 'moved cell keeps its marks');

  const right = run('move-column-right', stateAt(table, 1, 0));
  assert.equal(right.applied, true);
  assert.deepEqual(grid(right.state.doc.firstChild), [['H2', 'H1', 'H3'], ['A2', 'A1', 'A3'], ['B2', 'B1', 'B3']]);
  assert.equal(run('move-column-left', stateAt(table, 1, 0)).applied, false);
  assert.equal(run('move-column-right', stateAt(table, 1, 2)).applied, false);
}

// A wider column selection moves as one block.
{
  const table = makeTable([['H1', 'H2', 'H3', 'H4'], ['A1', 'A2', 'A3', 'A4']]);
  const state = selectRect(stateAt(table, 1, 1), 0, 1, 1, 2);
  const result = run('move-column-right', state);
  assert.equal(result.applied, true);
  assert.deepEqual(grid(result.state.doc.firstChild), [['H1', 'H4', 'H2', 'H3'], ['A1', 'A4', 'A2', 'A3']]);
}

// Duplicate rows after the selected block; header rows cannot be duplicated as data.
{
  const table = makeTable([['H', 'Header'], ['A', '1'], ['B', { text: '2', strong: true }], ['C', '3']]);
  const result = run('duplicate-row', stateAt(table, 2, 0));
  assert.equal(result.applied, true);
  const rows = grid(result.state.doc.firstChild);
  assert.deepEqual(rows, [['H', 'Header'], ['A', '1'], ['B', '2'], ['B', '2'], ['C', '3']]);
  assert.equal(result.state.doc.firstChild.firstChild.type.spec.tableRole, 'row');
  assert.equal(result.state.doc.firstChild.firstChild.firstChild.type.spec.tableRole, 'header_cell');
  assert.equal(hasStrong(cellsOf(result.state.doc.firstChild, 3)[1]), true, 'duplicated row keeps marks');
  assert.equal(run('duplicate-row', stateAt(table, 0, 0)).applied, false, 'header row is not duplicated into data');
}

// Duplicate columns after the selected block.
{
  const table = makeTable([
    ['H1', 'H2', 'H3'],
    ['A1', { text: 'A2', strong: true }, 'A3']
  ]);
  const result = run('duplicate-column', stateAt(table, 1, 1));
  assert.equal(result.applied, true);
  assert.deepEqual(grid(result.state.doc.firstChild), [['H1', 'H2', 'H2', 'H3'], ['A1', 'A2', 'A2', 'A3']]);
  assert.equal(hasStrong(cellsOf(result.state.doc.firstChild, 1)[2]), true, 'duplicated column keeps marks');
}

// Sort rows by the selected column, numeric-aware, stable, header fixed.
{
  const table = makeTable([['H', 'Score'], ['B', '2'], ['A', '10'], ['C', '1'], ['D', '2'], ['E', '2']]);
  const ascending = run('sort-ascending', stateAt(table, 1, 1));
  assert.equal(ascending.applied, true);
  assert.deepEqual(grid(ascending.state.doc.firstChild), [
    ['H', 'Score'], ['C', '1'], ['B', '2'], ['D', '2'], ['E', '2'], ['A', '10']
  ]);
  assert.equal(ascending.state.doc.firstChild.firstChild.firstChild.type.spec.tableRole, 'header_cell', 'header row is untouched');
  assert.equal(ascending.state.doc.firstChild.firstChild.firstChild.textContent, 'H');

  const descending = run('sort-descending', stateAt(table, 1, 1));
  assert.equal(descending.applied, true);
  assert.deepEqual(grid(descending.state.doc.firstChild), [
    ['H', 'Score'], ['A', '10'], ['B', '2'], ['D', '2'], ['E', '2'], ['C', '1']
  ]);

  const alreadySorted = run('sort-ascending', ascending.state);
  assert.equal(alreadySorted.applied, false, 'sort is a no-op when order is unchanged');

  const fromHeader = run('sort-ascending', stateAt(table, 0, 1));
  assert.equal(fromHeader.applied, true, 'sorting from the header still sorts only data rows');
  assert.deepEqual(grid(fromHeader.state.doc.firstChild), [
    ['H', 'Score'], ['C', '1'], ['B', '2'], ['D', '2'], ['E', '2'], ['A', '10']
  ]);
}

// A table without header cells is all data: the first row sorts and moves too.
{
  const table = makeTable([['C', '3'], ['A', '1'], ['B', '2']], { headerRow: false });
  const sorted = run('sort-ascending', stateAt(table, 0, 1));
  assert.equal(sorted.applied, true);
  assert.deepEqual(grid(sorted.state.doc.firstChild), [['A', '1'], ['B', '2'], ['C', '3']]);
  const moved = run('move-row-down', stateAt(table, 0, 0));
  assert.equal(moved.applied, true, 'headerless first row can move down');
  assert.deepEqual(grid(moved.state.doc.firstChild), [['A', '1'], ['C', '3'], ['B', '2']]);
}

// A collapsed text selection inside a cell is enough context for every command.
{
  const table = makeTable([['H', 'Score'], ['A', '1'], ['B', '2']]);
  const doc = schema.nodes.doc.create(null, [table]);
  const caret = EditorState.create({ doc, selection: TextSelection.create(doc, cellPosition(doc, 1, 1) + 2) });
  const aligned = run('align-center', caret);
  assert.equal(aligned.applied, true, 'caret in a cell can align its column');
  assert.equal(cellsOf(aligned.state.doc.firstChild, 0)[1].attrs.align, 'center');
  const duplicated = run('duplicate-row', aligned.state);
  assert.equal(duplicated.applied, true, 'caret in a cell can duplicate its row');
  assert.deepEqual(grid(duplicated.state.doc.firstChild), [['H', 'Score'], ['A', '1'], ['A', '1'], ['B', '2']]);
}

// Alignment applies to the whole selected column, including the header, because
// Markdown's delimiter row is derived from the first row.
{
  const table = makeTable([['H', 'Score'], ['A', '1'], ['B', '2']]);
  let state = stateAt(table, 1, 1);
  let result = run('align-center', state);
  assert.equal(result.applied, true);
  for (let row = 0; row < 3; row++) {
    const cells = cellsOf(result.state.doc.firstChild, row);
    assert.equal(cells[0].attrs.align, null, 'unselected column is unchanged');
    assert.equal(cells[1].attrs.align, 'center', `row ${row} is centered`);
  }
  state = result.state;
  result = run('align-right', state);
  assert.equal(result.applied, true);
  assert.equal(cellsOf(result.state.doc.firstChild, 0)[1].attrs.align, 'right');
  result = run('align-left', result.state);
  assert.equal(result.applied, true);
  assert.equal(cellsOf(result.state.doc.firstChild, 0)[1].attrs.align, 'left');
  assert.equal(run('align-left', result.state).applied, false, 're-applying the same alignment is a no-op');
}

// Unsafe tables fail closed: non-rectangular rows, merged cells and no table.
{
  const uneven = makeTable([['H1', 'H2'], ['A1', 'A2', 'A3'], ['B1', 'B2', 'B3']]);
  for (const name of ['move-row-up', 'move-column-left', 'duplicate-row', 'duplicate-column', 'sort-ascending', 'align-center']) {
    assert.equal(run(name, stateAt(uneven, 1, 0)).applied, false, `${name} rejects a non-rectangular table`);
  }

  const spanning = schema.nodes.table.create(null, [
    schema.nodes.table_row.create(null, [
      schema.nodes.table_header.create({ colspan: 2 }, schema.nodes.paragraph.create(null, schema.text('H')))
    ]),
    schema.nodes.table_row.create(null, [
      schema.nodes.table_cell.create(null, schema.nodes.paragraph.create(null, schema.text('A'))),
      schema.nodes.table_cell.create(null, schema.nodes.paragraph.create(null, schema.text('B')))
    ])
  ]);
  assert.equal(run('sort-ascending', stateAt(spanning, 1, 0)).applied, false, 'colspan table is rejected');

  const proseDoc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, schema.text('Plain prose'))]);
  const prose = EditorState.create({ doc: proseDoc, selection: TextSelection.create(proseDoc, 2) });
  for (const name of TABLE_OPERATION_NAMES) {
    assert.equal(run(name, prose).applied, false, `${name} is a no-op outside a table`);
  }
}

// Commands answer applicability without dispatch and never mutate the state.
{
  const table = makeTable([['H', 'Header'], ['A', '1'], ['B', '2']]);
  const state = stateAt(table, 1, 0);
  const before = state.doc;
  const command = tableOperation('move-row-down');
  assert.equal(command(state), true, 'dry run reports applicability');
  assert.equal(state.doc, before, 'dry run does not mutate the editor state');
  assert.equal(tableOperation('move-row-up')(stateAt(table, 0, 0)), false, 'dry run reports impossible moves');
}

// Sorting refuses a body with fewer than two rows.
{
  const table = makeTable([['H', 'Header'], ['A', '1']]);
  assert.equal(run('sort-ascending', stateAt(table, 1, 0)).applied, false);
}

console.log('PASS: table operations move/duplicate/sort/align safely, preserve headers and marks, and fail closed on unsafe tables.');
