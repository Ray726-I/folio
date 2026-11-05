import {
  CellSelection,
  TableMap,
  isInTable,
  moveTableColumn,
  selectedRect
} from 'prosemirror-tables';

// Structural table commands shared by every presentation. These are pure
// ProseMirror commands: they never read the document lock, because the caller
// owns that policy (see createRichEditor's table controls). A locked editor
// must simply not invoke the command.
//
// The commands intentionally accept only rectangular tables where every cell
// spans exactly one row and one column. On a merged/non-rectangular table the
// operation returns false instead of guessing how cells should move. The first
// row is treated as a header row only when every cell in it has the
// `header_cell` table role. Sorting and duplication preserve that header;
// reordering allows any row to move and keeps header cells in the first slot.

export const TABLE_OPERATION_NAMES = Object.freeze([
  'move-row-up',
  'move-row-down',
  'move-column-left',
  'move-column-right',
  'duplicate-row',
  'duplicate-column',
  'sort-ascending',
  'sort-descending',
  'align-left',
  'align-center',
  'align-right'
]);

const NAMES = new Set(TABLE_OPERATION_NAMES);

// Numeric-aware collation keeps "2" before "10" in a score column while still
// handling ordinary text. Ties keep their original document order below.
const collator = typeof Intl !== 'undefined' && typeof Intl.Collator === 'function'
  ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  : null;

function compareText(left, right) {
  if (collator) return collator.compare(left, right);
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCellRole(role) {
  return role === 'cell' || role === 'header_cell';
}

function rowIsHeader(row) {
  if (!row || row.type.spec.tableRole !== 'row' || row.childCount === 0) return false;
  let header = true;
  row.forEach(cell => { if (cell.type.spec.tableRole !== 'header_cell') header = false; });
  return header;
}

function headerRowCount(table) {
  return rowIsHeader(table.firstChild) ? 1 : 0;
}

// A table is safe to rewrite only when its TableMap and node tree agree that
// every row has exactly `map.width` single-column cells. This also rejects
// missing cells, extra cells, rowspans and colspans.
function rectangularTable(table, map) {
  if (!table || table.type.spec.tableRole !== 'table') return false;
  if (!map || map.width < 1 || map.height < 1) return false;
  if (map.height !== table.childCount) return false;
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex++) {
    const row = table.child(rowIndex);
    if (row.type.spec.tableRole !== 'row' || row.childCount !== map.width) return false;
    for (let cellIndex = 0; cellIndex < row.childCount; cellIndex++) {
      const cell = row.child(cellIndex);
      if (!isCellRole(cell.type.spec.tableRole)) return false;
      if ((cell.attrs.colspan ?? 1) !== 1 || (cell.attrs.rowspan ?? 1) !== 1) return false;
    }
  }
  return true;
}

function tableRows(table) {
  const rows = [];
  table.forEach(row => rows.push(row));
  return rows;
}

function tableContext(state) {
  if (!state || !state.selection || !state.doc) return null;
  try {
    if (!isInTable(state)) return null;
    const selected = selectedRect(state);
    const table = selected.table;
    const map = selected.map;
    if (!rectangularTable(table, map)) return null;
    // selectedRect follows TableMap and uses exclusive right/bottom edges.
    // The rest of this module uses inclusive cell indexes.
    const rect = {
      top: selected.top,
      bottom: selected.bottom - 1,
      left: selected.left,
      right: selected.right - 1
    };
    if (rect.left < 0 || rect.top < 0 || rect.right >= map.width || rect.bottom >= map.height) return null;
    if (rect.right < rect.left || rect.bottom < rect.top) return null;
    return {
      rect,
      table,
      map,
      rows: tableRows(table),
      tablePos: selected.tableStart - 1,
      headerRows: headerRowCount(table)
    };
  } catch {
    return null;
  }
}

function selectCells(tr, tablePos, table, top, bottom, left, right) {
  try {
    const map = TableMap.get(table);
    if (map.width < 1 || map.height < 1) return;
    const anchorRow = Math.max(0, Math.min(top, map.height - 1));
    const headRow = Math.max(0, Math.min(bottom, map.height - 1));
    const anchorCol = Math.max(0, Math.min(left, map.width - 1));
    const headCol = Math.max(0, Math.min(right, map.width - 1));
    const anchor = tablePos + 1 + map.positionAt(anchorRow, anchorCol, table);
    const head = tablePos + 1 + map.positionAt(headRow, headCol, table);
    tr.setSelection(CellSelection.create(tr.doc, anchor, head));
  } catch {
    // A selection is a convenience; a valid document edit must not be lost
    // because a collapsed/edge selection could not be reconstructed.
  }
}

function replaceTable(state, dispatch, context, rows, selection) {
  if (!dispatch) return true;
  const { table, tablePos } = context;
  const tr = state.tr;
  try {
    const next = table.type.create(table.attrs, rows, table.marks);
    tr.replaceWith(tablePos, tablePos + table.nodeSize, next);
    if (selection) {
      selectCells(tr, tablePos, next, selection.top, selection.bottom, selection.left, selection.right);
    }
  } catch {
    return false;
  }
  if (!tr.docChanged) return false;
  dispatch(tr);
  return true;
}

// Row contents can cross the header boundary. Cell roles belong to their
// destination row, so Markdown still has exactly one header at the top.
function normalizeMovedRows(state, context, rows) {
  if (!context.headerRows) return rows;
  return rows.map((row, index) => {
    const type = state.schema.nodes[index === 0 ? 'table_header' : 'table_cell'];
    const cells = [];
    row.forEach(cell => cells.push(type.create(cell.attrs, cell.content, cell.marks)));
    return row.type.create(row.attrs, cells, row.marks);
  });
}

export function moveTableRowTo(from, to) {
  return (state, dispatch) => {
    const context = tableContext(state);
    if (!context || !Number.isInteger(from) || !Number.isInteger(to) ||
        from < 0 || to < 0 || from >= context.rows.length || to >= context.rows.length || from === to) return false;
    const rows = context.rows.slice();
    const [row] = rows.splice(from, 1);
    rows.splice(to, 0, row);
    return replaceTable(state, dispatch, context, normalizeMovedRows(state, context, rows), {
      top: to, bottom: to, left: 0, right: context.map.width - 1
    });
  };
}

function moveRows(state, dispatch, view, direction) {
  const context = tableContext(state);
  if (!context) return false;
  const { rect, rows } = context;
  const top = rect.top, bottom = rect.bottom;
  const length = bottom - top + 1, newTop = top + direction;
  if (newTop < 0 || newTop + length > rows.length) return false;
  const block = rows.slice(top, bottom + 1);
  const rest = rows.slice(0, top).concat(rows.slice(bottom + 1));
  const nextRows = rest.slice(0, newTop).concat(block, rest.slice(newTop));
  return replaceTable(state, dispatch, context, normalizeMovedRows(state, context, nextRows), {
    top: newTop, bottom: newTop + length - 1, left: 0, right: context.map.width - 1
  });
}

// Move a contiguous block of columns one column in `direction`. Columns travel
// whole, so header cells stay in the header row and body cells keep their
// values, marks and alignment.
function moveColumns(state, dispatch, view, direction) {
  const context = tableContext(state);
  if (!context) return false;
  const { rect, rows, map } = context;
  const left = rect.left, right = rect.right;
  if (left < 0 || right >= map.width) return false;
  if (direction < 0) {
    if (left === 0) return false;
  } else if (right >= map.width - 1) {
    return false;
  }
  const length = right - left + 1;
  const newLeft = left + direction;
  if (newLeft < 0 || newLeft + length > map.width) return false;
  if (length === 1) {
    return moveTableColumn({ from: left, to: newLeft, select: true })(state, dispatch, view);
  }
  const nextRows = rows.map(row => {
    const cells = [];
    row.forEach(cell => cells.push(cell));
    const block = cells.slice(left, right + 1);
    const rest = cells.slice(0, left).concat(cells.slice(right + 1));
    return row.type.create(row.attrs, rest.slice(0, newLeft).concat(block, rest.slice(newLeft)), row.marks);
  });
  return replaceTable(state, dispatch, context, nextRows, {
    top: 0,
    bottom: map.height - 1,
    left: newLeft,
    right: newLeft + length - 1
  });
}

function duplicateRows(state, dispatch, context) {
  const { rect, rows, headerRows, map } = context;
  if (rect.top < headerRows || rect.bottom >= rows.length) return false;
  const block = rows.slice(rect.top, rect.bottom + 1).map(row => row.copy(row.content));
  const nextRows = rows.slice(0, rect.bottom + 1).concat(block, rows.slice(rect.bottom + 1));
  return replaceTable(state, dispatch, context, nextRows, {
    top: rect.bottom + 1,
    bottom: rect.bottom + block.length,
    left: 0,
    right: map.width - 1
  });
}

function duplicateColumns(state, dispatch, context) {
  const { rect, rows, map } = context;
  if (rect.left < 0 || rect.right >= map.width) return false;
  const blockLength = rect.right - rect.left + 1;
  const nextRows = rows.map(row => {
    const cells = [];
    row.forEach(cell => cells.push(cell));
    const block = cells.slice(rect.left, rect.right + 1).map(cell => cell.copy(cell.content));
    const rest = cells.slice(0, rect.right + 1).concat(block, cells.slice(rect.right + 1));
    return row.type.create(row.attrs, rest, row.marks);
  });
  return replaceTable(state, dispatch, context, nextRows, {
    top: 0,
    bottom: map.height - 1,
    left: rect.right + 1,
    right: rect.right + blockLength
  });
}

function sortRows(state, dispatch, context, descending) {
  const { rect, rows, headerRows, map } = context;
  const data = rows.slice(headerRows);
  if (data.length < 2) return false;
  const column = rect.left;
  if (column < 0 || column >= map.width) return false;
  const sorted = data.map((row, index) => ({
    row,
    index,
    key: row.child(column).textContent.trim()
  }));
  sorted.sort((left, right) => {
    const order = compareText(left.key, right.key);
    if (order !== 0) return descending ? -order : order;
    return left.index - right.index;
  });
  if (sorted.every((entry, index) => entry.index === index)) return false;

  const nextRows = rows.slice(0, headerRows).concat(sorted.map(entry => entry.row));
  const selectedIndex = Math.max(0, rect.top - headerRows);
  const moved = sorted.findIndex(entry => entry.index === selectedIndex);
  const selection = rect.top < headerRows
    ? { top: rect.top, bottom: Math.min(rect.bottom, headerRows - 1), left: rect.left, right: rect.right }
    : { top: headerRows + Math.max(0, moved), bottom: headerRows + Math.max(0, moved), left: rect.left, right: rect.right };
  return replaceTable(state, dispatch, context, nextRows, selection);
}

// Markdown stores table alignment on the delimiter row, which this schema
// derives from the header cells. Set the attribute on every cell of the
// selected column range, including the header, so the result survives the
// Markdown round trip.
function alignColumns(state, dispatch, context, align) {
  const { rect, table, map, tablePos } = context;
  if (rect.left < 0 || rect.right >= map.width) return false;
  const changes = [];
  for (let rowIndex = 0; rowIndex < map.height; rowIndex++) {
    for (let column = rect.left; column <= rect.right; column++) {
      const cellPos = map.map[rowIndex * map.width + column];
      const cell = table.nodeAt(cellPos);
      if (!cell || !isCellRole(cell.type.spec.tableRole)) continue;
      if (cell.attrs.align === align) continue;
      changes.push([tablePos + 1 + cellPos, cell]);
    }
  }
  if (changes.length === 0) return false;
  if (!dispatch) return true;
  const tr = state.tr;
  for (const [pos, cell] of changes) {
    tr.setNodeMarkup(pos, null, { ...cell.attrs, align });
  }
  if (!tr.docChanged) return false;
  dispatch(tr);
  return true;
}

const OPERATIONS = {
  'move-row-up': (state, dispatch, view) => moveRows(state, dispatch, view, -1),
  'move-row-down': (state, dispatch, view) => moveRows(state, dispatch, view, 1),
  'move-column-left': (state, dispatch, view) => moveColumns(state, dispatch, view, -1),
  'move-column-right': (state, dispatch, view) => moveColumns(state, dispatch, view, 1),
  'duplicate-row': (state, dispatch) => {
    const context = tableContext(state);
    return context ? duplicateRows(state, dispatch, context) : false;
  },
  'duplicate-column': (state, dispatch) => {
    const context = tableContext(state);
    return context ? duplicateColumns(state, dispatch, context) : false;
  },
  'sort-ascending': (state, dispatch) => {
    const context = tableContext(state);
    return context ? sortRows(state, dispatch, context, false) : false;
  },
  'sort-descending': (state, dispatch) => {
    const context = tableContext(state);
    return context ? sortRows(state, dispatch, context, true) : false;
  },
  'align-left': (state, dispatch) => {
    const context = tableContext(state);
    return context ? alignColumns(state, dispatch, context, 'left') : false;
  },
  'align-center': (state, dispatch) => {
    const context = tableContext(state);
    return context ? alignColumns(state, dispatch, context, 'center') : false;
  },
  'align-right': (state, dispatch) => {
    const context = tableContext(state);
    return context ? alignColumns(state, dispatch, context, 'right') : false;
  }
};

export function tableOperation(name) {
  if (typeof name !== 'string' || !NAMES.has(name)) {
    throw new RangeError(`Unknown table operation: ${String(name)}`);
  }
  return OPERATIONS[name];
}
