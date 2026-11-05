import { Fragment } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection, NodeSelection, Selection, AllSelection } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark, setBlockType, wrapIn, chainCommands, exitCode } from 'prosemirror-commands';
import { splitListItem, sinkListItem, liftListItem, wrapInList } from 'prosemirror-schema-list';
import { fixTables, goToNextCell, addRowAfter, addRowBefore, addColumnAfter, addColumnBefore, deleteRow, deleteColumn, deleteTable, TableView, TableMap, findCell, CellSelection, selectedRect, moveTableColumn, isInTable, cellAround, nextCell } from 'prosemirror-tables';
import { tableOperation, moveTableRowTo } from './table-operations.js';
import { inputRules, wrappingInputRule, textblockTypeInputRule, InputRule } from 'prosemirror-inputrules';
import MarkdownIt from 'markdown-it';
import { decodeHTML, decodeHTMLAttribute } from 'entities';
import { schema, parseSource, updateSource, sourceToRich, richToSource, sourceMapping, richMapping, INLINE_HTML_SPAN_TAGS } from './model.js';
import { buildLedger, applySourcePatches } from './source-ledger.js';
import { tryTextEdits, trySourceEdit } from './source-edits.js';
import { createHeadingMetadata } from './headings.js';
import { parser as markdownParser, GFM } from '@lezer/markdown';

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'OS', 'Super', 'Hyper']);

// Slash-menu catalogue. Each leaf carries the exact Markdown a block needs and
// the source offsets to select after insertion, so the picker never has to
// guess at schema commands and the inserted bytes stay predictable.
const SLASH_ICON_SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const SLASH_ICON_BODY = {
  paragraph: '<path d="M13 4v16M17 4v16M13 4H9.5a4.5 4.5 0 0 0 0 9H13"/>',
  heading: '<path d="M6 5v14M18 5v14M6 12h12"/>',
  list: '<path d="M9 7h11M9 12h11M9 17h11"/><circle cx="4.5" cy="7" r="1.1"/><circle cx="4.5" cy="12" r="1.1"/><circle cx="4.5" cy="17" r="1.1"/>',
  bullet: '<path d="M9 7h11M9 12h11M9 17h11"/><circle cx="4.5" cy="7" r="1.1"/><circle cx="4.5" cy="12" r="1.1"/><circle cx="4.5" cy="17" r="1.1"/>',
  task: '<rect x="3.2" y="5.2" width="6.4" height="6.4" rx="1.6"/><path d="m4.7 8.4 1.2 1.2 2.3-2.6M12.5 8h8.5M3.2 16h4.5M12.5 16h8.5"/>',
  quote: '<path d="M5 6v12M9 8h10M9 12h7M9 16h10"/>',
  code: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4"/>',
  table: '<rect x="3.5" y="5" width="17" height="14" rx="1.7"/><path d="M3.5 10h17M10 10v9M15 10v9"/>',
  divider: '<path d="M4 12h16"/><path d="M7.5 7.5h9M7.5 16.5h9" opacity=".38"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m4.8 17.2 4.5-4.5 3.3 3.3 2.3-2.3 4.3 4.3"/>',
  math: '<path d="M17.5 5.5h-9l4.6 6.5-4.6 6.5h9"/>',
  mermaid: '<circle cx="6.2" cy="6.8" r="2.5"/><circle cx="17.8" cy="17.2" r="2.5"/><path d="m8.4 8.2 7.2 7.2"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'
};
const SLASH_MERMAID_BODY = 'graph TD\n  A[Start] --> B[End]';
const SLASH_BLOCKS = [
  { id: 'paragraph', label: 'Paragraph', icon: 'paragraph', keywords: 'text body plain normal', snippet: '' },
  { id: 'heading', label: 'Heading', icon: 'heading', title: 'Heading', keywords: 'title head', children: Array.from({ length: 6 }, (_, index) => ({
    id: `heading${index + 1}`, label: `Heading ${index + 1}`, badge: `H${index + 1}`, keywords: `h${index + 1} title head`,
    meta: '#'.repeat(index + 1), snippet: `${'#'.repeat(index + 1)} `
  })) },
  { id: 'list', label: 'List', icon: 'list', title: 'List', keywords: 'bullets items', children: [
    { id: 'bullet', label: 'Bullet list', icon: 'bullet', keywords: 'unordered ul dash', meta: '-', snippet: '- ' },
    { id: 'numbered', label: 'Numbered list', badge: '1.', keywords: 'ordered ol numbered digits', snippet: '1. ' },
    { id: 'task', label: 'Task list', icon: 'task', keywords: 'todo checklist checkbox tasks', meta: '[ ]', snippet: '- [ ] ' }
  ] },
  { id: 'quote', label: 'Quote', icon: 'quote', keywords: 'blockquote citation', meta: '>', snippet: '> ' },
  { id: 'code', label: 'Code block', icon: 'code', keywords: 'fence snippet code', snippet: '```\n\n```', select: [4, 4] },
  { id: 'table', label: 'Table', icon: 'table', keywords: 'grid rows columns cells', meta: '2×2', snippet: '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |', select: [2, 10] },
  { id: 'more', label: 'More', icon: 'more', title: 'More blocks', children: [
    { id: 'divider', label: 'Divider', icon: 'divider', keywords: 'horizontal rule line hr separator', meta: '---', snippet: '---' },
    { id: 'image', label: 'Image', icon: 'image', keywords: 'picture photo media', meta: '![]()', snippet: '![alt](image.png)', select: [2, 5] },
    { id: 'math', label: 'Math block', icon: 'math', keywords: 'formula latex equation tex katex', meta: '$$', snippet: '$$\nx\n$$', select: [3, 4] },
    { id: 'mermaid', label: 'Mermaid diagram', icon: 'mermaid', keywords: 'chart graph flow diagram mermaid', meta: 'mermaid', snippet: `\`\`\`mermaid\n${SLASH_MERMAID_BODY}\n\`\`\`` }
  ] }
];
const SLASH_LEAVES = SLASH_BLOCKS.flatMap(item => item.children
  ? item.children.map(child => ({ ...child, keywords: `${child.keywords || ''} ${item.label} ${item.keywords || ''}` }))
  : [{ ...item }]);

// Extension projections are sanitized HTML, not the document. To toggle a task
// inside one we map the rendered checkbox back to the single marker character
// in the exact raw source slice. This tokenizer deliberately does NOT use the
// rich model's extension fallback (that is what put the task list in a raw
// block in the first place); it only lists the source's own list items so
// fences, escaped markers and prose cannot contribute phantom positions.
const rawTaskTokenizer = new MarkdownIt({ html: true, linkify: false, typographer: false });
const RAW_TASK_LINE = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/;
const RAW_TASK_MARKER = /^[ xX]$/;

// Return the source offset of each GFM task marker in `source`, in document
// order. A null result means the source could not be inspected safely; callers
// must then leave every checkbox disabled rather than guessing a position.
export function rawTaskMarkers(source) {
  if (typeof source !== 'string' || !source) return [];
  let tokens;
  try { tokens = rawTaskTokenizer.parse(source, {}); } catch { return null; }
  const starts = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') starts.push(index + 1);
  const markers = [];
  for (const token of tokens) {
    if (token.type !== 'list_item_open' || !Array.isArray(token.map)) continue;
    const start = starts[token.map[0]];
    if (!Number.isInteger(start) || start < 0 || start > source.length) return null;
    let end = source.indexOf('\n', start);
    if (end < 0) end = source.length;
    const line = source.slice(start, end).replace(/\r$/, '');
    const match = RAW_TASK_LINE.exec(line);
    if (!match) continue;
    const bracket = match[0].lastIndexOf('[');
    if (bracket < 0) return null;
    const offset = start + bracket + 1;
    if (!RAW_TASK_MARKER.test(source.slice(offset, offset + 1))) return null;
    markers.push({ offset, checked: match[1] !== ' ' });
  }
  return markers;
}

// Explicit source-grapheme policy for collapsed Delete/Backspace. A bookmark
// may be non-collapsed in source even when its projected ProseMirror selection
// collapsed at a non-injective syntax boundary; in that case the caller uses
// the logical interval instead of this helper.
function graphemeUnit(text, position, backward) {
  if (backward) {
    if (position <= 0) return null;
    let start = position - 1;
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.slice(0, position));
      for (const part of segments) start = part.index;
    } else {
      const previous = Array.from(text.slice(0, position)).pop();
      start = position - previous.length;
    }
    return { from: start, to: position };
  }
  if (position >= text.length) return null;
  let end = position + 1;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.slice(position))[Symbol.iterator]().next().value;
    if (first) end = position + first.segment.length;
  } else {
    end = position + Array.from(text.slice(position))[0].length;
  }
  return { from: position, to: end };
}

function button(label, action) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'button small'; button.textContent = label;
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(); }); return button;
}
// Raw author HTML must never be handed to DOMParser: an inert document can
// still start image/iframe/style resource loads in some webviews. This small
// scanner only reads tag structure from the string and never constructs a
// browsing context. It deliberately keeps raw-text element bodies opaque and
// drops comments/declarations, so hidden markup cannot masquerade as images.
const HTML_RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
const HTML_VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
function scanHtmlTokens(source) {
  const text = String(source || ''), lower = text.toLowerCase(), tokens = [];
  const isSpace = character => character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f';
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('<', index);
    if (open < 0) { tokens.push({ type: 'text', value: text.slice(index) }); break; }
    if (open > index) tokens.push({ type: 'text', value: text.slice(index, open) });
    index = open;
    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4);
      index = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', index)) {
      const end = text.indexOf(']]>', index + 9);
      index = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<!', index) || text.startsWith('<?', index)) {
      const end = text.indexOf('>', index + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text[index + 1] === '/') {
      let cursor = index + 2;
      while (cursor < text.length && isSpace(text[cursor])) cursor++;
      const start = cursor;
      while (cursor < text.length && /[A-Za-z0-9:_-]/.test(text[cursor])) cursor++;
      const name = lower.slice(start, cursor);
      const end = text.indexOf('>', cursor);
      index = end < 0 ? text.length : end + 1;
      if (name) tokens.push({ type: 'end', name });
      continue;
    }
    if (!/[A-Za-z]/.test(text[index + 1] || '')) { index++; continue; }
    let cursor = index + 1;
    const nameStart = cursor;
    while (cursor < text.length && /[A-Za-z0-9:_-]/.test(text[cursor])) cursor++;
    const name = lower.slice(nameStart, cursor);
    const attrs = new Map();
    let selfClosing = false;
    while (cursor < text.length) {
      while (cursor < text.length && isSpace(text[cursor])) cursor++;
      if (cursor >= text.length) break;
      if (text[cursor] === '>') { cursor++; break; }
      if (text[cursor] === '/') { selfClosing = true; cursor++; continue; }
      const attributeStart = cursor;
      while (cursor < text.length && !isSpace(text[cursor]) && !/[=>/]/.test(text[cursor])) cursor++;
      if (cursor === attributeStart) { cursor++; continue; }
      const attribute = lower.slice(attributeStart, cursor);
      while (cursor < text.length && isSpace(text[cursor])) cursor++;
      let value = '';
      if (text[cursor] === '=') {
        cursor++;
        while (cursor < text.length && isSpace(text[cursor])) cursor++;
        const quote = text[cursor];
        if (quote === '"' || quote === "'") {
          cursor++;
          const valueStart = cursor;
          while (cursor < text.length && text[cursor] !== quote) cursor++;
          value = text.slice(valueStart, cursor);
          if (cursor < text.length) cursor++;
        } else {
          const valueStart = cursor;
          while (cursor < text.length && !isSpace(text[cursor]) && text[cursor] !== '>') cursor++;
          value = text.slice(valueStart, cursor);
        }
      } else if (cursor < text.length && text[cursor] !== '>') {
        // HTML boolean attribute. Leave the cursor on the next delimiter.
      }
      if (!attrs.has(attribute)) attrs.set(attribute, decodeHTMLAttribute(value));
    }
    const tag = { type: 'start', name, attrs, selfClosing: selfClosing || HTML_VOID_TAGS.has(name) };
    tokens.push(tag);
    index = cursor;
    if (HTML_RAW_TEXT_TAGS.has(name) && !tag.selfClosing) {
      if (name === 'plaintext') {
        if (index < text.length) tokens.push({ type: 'text', value: text.slice(index) });
        index = text.length;
        break;
      }
      const close = lower.indexOf(`</${name}`, index);
      if (close < 0) {
        if (index < text.length) tokens.push({ type: 'text', value: text.slice(index) });
        index = text.length;
        break;
      }
      if (close > index) tokens.push({ type: 'text', value: text.slice(index, close) });
      index = close;
    }
  }
  return tokens;
}
const IMAGE_IDENTITY_ATTRIBUTES = ['alt', 'title', 'width', 'height', 'class'];
function imageFingerprint(attrs) {
  const value = name => attrs instanceof Map ? (attrs.get(name) ?? '') : (attrs.getAttribute?.(name) ?? '');
  return IMAGE_IDENTITY_ATTRIBUTES.map(name => `${name}=${value(name)}`).join('\u0000');
}
function selectionAt(doc, anchor, head = anchor) {
  const a = Math.max(0, Math.min(anchor, doc.content.size)), h = Math.max(0, Math.min(head, doc.content.size));
  return TextSelection.between(doc.resolve(a), doc.resolve(h));
}

export function createRichEditor(parent, options) {
  let model = parseSource(options.content), view;
  let fullReplacementUndoModel = null;
  let revision = 0, bookmark = null, tabSelection = null, commitOutcome = null, pendingTail = false;
  let linkClickTimer = 0, inlineClickTimer = 0;
  const headingMetadata = createHeadingMetadata();
  headingMetadata.read(model);
  const refreshers = new Set();
  const codeHighlights = new WeakMap();
  const codeHighlightObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
      for (const entry of entries) codeHighlights.get(entry.target)?.(entry.isIntersecting);
    }, { rootMargin: '200px' })
    : null;
  // The observer narrows gutter discovery to mounted, visible tables. A point
  // probe below covers the first frame before observer delivery after layout.
  const nearbyTables = new Set();
  const tableObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) nearbyTables.add(entry.target);
      else nearbyTables.delete(entry.target);
    }
  }, { root: parent.closest('.reader-scroll'), rootMargin: '60px' }) : null;
  function tableView(node) {
    const table = new TableView(node, 80);
    tableObserver?.observe(table.dom);
    table.destroy = () => { tableObserver?.unobserve(table.dom); nearbyTables.delete(table.dom); };
    return table;
  }

  // A logical bookmark keeps the exact source endpoints selected in the source
  // presentation, the source revision they belong to, and the actual
  // ProseMirror selection after projection normalization. Source and rich
  // positions are not bijective, so re-deriving endpoints from the DOM would
  // silently lose delimiters/entity spellings.
  function bookmarkRange(state = view?.state) {
    if (!bookmark || bookmark.revision !== revision || bookmark.source !== model.source) return null;
    if (!state) return { from: Math.min(bookmark.anchor, bookmark.head), to: Math.max(bookmark.anchor, bookmark.head), all: bookmark.all };
    if (bookmark.all) return state.selection instanceof AllSelection ? { from: 0, to: model.source.length, all: true } : null;
    const selection = state.selection;
    if (!(selection instanceof TextSelection) || selection.anchor !== bookmark.pmAnchor || selection.head !== bookmark.pmHead) return null;
    return { from: Math.min(bookmark.anchor, bookmark.head), to: Math.max(bookmark.anchor, bookmark.head), all: false };
  }
  function setBookmark(anchor, head, state, all = false) {
    bookmark = { revision, source: model.source, anchor, head, pmAnchor: state.selection.anchor, pmHead: state.selection.head, all };
  }
  function releaseBookmark() { bookmark = null; }

  // Verified ordinary rich selection endpoints. Cross-owner ranges (cells,
  // prose blocks, atoms) are accepted only when both endpoints round-trip
  // exactly; ambiguous endpoints stay with the native ProseMirror path.
  function verifiedSourceRange(from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return null;
    const start = richMapping(model, from, { bias: 'right' });
    const end = richMapping(model, to, { bias: 'left' });
    if (!start.exact || start.confidence !== 'exact' || !start.owner || start.owner.confidence !== 'exact' || start.owner.supported === false) return null;
    if (!end.exact || end.confidence !== 'exact' || !end.owner || end.owner.confidence !== 'exact' || end.owner.supported === false) return null;
    if (start.source > end.source) return null;
    const backStart = sourceMapping(model, start.source, { bias: 'right' });
    const backEnd = sourceMapping(model, end.source, { bias: 'left' });
    if (!backStart.exact || backStart.confidence !== 'exact' || backStart.pm !== from) return null;
    if (!backEnd.exact || backEnd.confidence !== 'exact' || backEnd.pm !== to) return null;
    return { from: start.source, to: end.source, startOwner: start.owner.id, endOwner: end.owner.id };
  }
  function logicalRange(state = view?.state) {
    const bookmarked = bookmarkRange(state);
    if (bookmarked) return { ...bookmarked, collapsed: bookmarked.from === bookmarked.to };
    if (state.selection instanceof AllSelection) return { from: 0, to: model.source.length, all: true, collapsed: false };
    if (state.selection instanceof TextSelection && !state.selection.empty) {
      const verified = verifiedSourceRange(state.selection.from, state.selection.to);
      if (verified) return { ...verified, all: false, collapsed: false };
    }
    return null;
  }

  function isTabCellSelection(selection) {
    return Boolean(tabSelection) && selection.from === tabSelection.from && selection.to === tabSelection.to &&
      selection.anchor === tabSelection.anchor && selection.head === tabSelection.head;
  }

  // A source splice is only safe inside a cell. Replacing a range that spans
  // two cells (or leaves the table) deletes delimiters and changes the column
  // count, so those gestures are refused rather than corrupting the table.
  function crossesTableCells(state = view?.state) {
    if (!state) return false;
    const selection = state.selection;
    if (selection.empty || selection instanceof AllSelection) return false;
    if (selection instanceof CellSelection) return true;
    if (selection instanceof NodeSelection && selection.node.type === schema.nodes.table) return false;
    if (!(selection instanceof TextSelection)) return false;
    if (!isInTable(state)) {
      // A prose -> prose selection may still enclose a whole table. Replacing
      // that source interval would delete the table columns.
      let enclosure = false;
      state.doc.nodesBetween(selection.from, selection.to, node => { if (node.type === schema.nodes.table) enclosure = true; });
      return enclosure;
    }
    const start = cellAround(selection.$from), end = cellAround(selection.$to);
    if (!start || !end) return true;
    return start.pos !== end.pos;
  }

  // Attach a canonical parse to the actual document produced by the committed
  // transaction. Segment node identity is rebased so later non-text edits can
  // still use unchanged-node anchoring.
  function attachModel(parsed, doc) {
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

  function commitCandidate(candidate, nextSelection, typing, sourceEdit) {
    const size = view.state.doc.content.size;
    const pmAnchor = sourceToRich(candidate, nextSelection.anchor);
    const pmHead = sourceToRich(candidate, nextSelection.head);
    let tr;
    try {
      tr = view.state.tr.replaceWith(0, size, candidate.doc.content);
      tr = tr.setSelection(TextSelection.between(tr.doc.resolve(pmAnchor), tr.doc.resolve(pmHead)));
      tr.setMeta('folio-source-commit', { model: candidate, selection: nextSelection, typing, sourceEdit });
    } catch {
      options.message('This edit could not be applied as an exact source change. The previous document is preserved.');
      return false;
    }
    // dispatchTransaction applies appendTransaction and verifies the result
    // before adopting the canonical model. A divergent repair fails closed
    // there and reports the explicit outcome through commitOutcome.
    commitOutcome = null;
    try { view.dispatch(tr); }
    catch {
      options.message('This edit could not be applied as an exact source change. The previous document is preserved.');
      return false;
    }
    return commitOutcome === true;
  }

  // One source-first replacement path used by typed input, Delete/Backspace,
  // Enter over a selection, paste and cut. It checks Lock/size before parsing
  // or committing, splices only the exact source interval, reparses the
  // candidate, and commits the canonical parse through the existing view.
  function replaceLogicalSelection(insert, origin = 'typing', explicitRange = null, nextSelection = null) {
    if (options.isLocked()) return { handled: true, committed: false };
    const range = explicitRange || logicalRange(view.state);
    if (!range || range.all && explicitRange && explicitRange.all === false) return { handled: false, committed: false };
    const from = range.from, to = range.to;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > model.source.length || from > to) {
      options.message('This edit could not be applied as an exact source change. The previous document is preserved.');
      return { handled: true, committed: false };
    }
    const sourceLength = model.source.length - (to - from) + insert.length;
    if (sourceLength > MAX_SOURCE_BYTES || (sourceLength > MAX_SOURCE_BYTES / 4 && new TextEncoder().encode(model.source.slice(0, from) + insert + model.source.slice(to)).length > MAX_SOURCE_BYTES)) {
      options.message('This edit would exceed the 20 MiB document limit. The previous document is preserved.');
      return { handled: true, committed: false };
    }
    let patched;
    try {
      patched = applySourcePatches(model.source, [{ from, to, insert, expected: model.source.slice(from, to) }]);
    } catch {
      options.message('This edit could not be applied as an exact source change. The previous document is preserved.');
      return { handled: true, committed: false };
    }
    let parsed;
    try {
      let sourceEdit = model.sourceEdit;
      if (sourceEdit) {
        const delta = insert.length - (to - from);
        sourceEdit = { from: from < sourceEdit.from ? Math.min(from, sourceEdit.from + delta) : sourceEdit.from,
          to: to <= sourceEdit.to ? sourceEdit.to + delta : Math.max(from + insert.length, sourceEdit.to) };
      }
      parsed = sourceEdit ? parseSource(patched.source, sourceEdit) : trySourceEdit(model, { from, to, insert }) || parseSource(patched.source);
    }
    catch {
      options.message('This edit could not be applied as an exact source change. The previous document is preserved.');
      return { handled: true, committed: false };
    }
    // Command insertions may want the caret inside the syntax they just added
    // (for example the URL of a new link). Offsets are relative to `insert` so
    // the caller never has to reason about the surrounding source bytes.
    const relativeAnchor = nextSelection ? nextSelection.anchor : insert.length;
    const relativeHead = nextSelection ? nextSelection.head : insert.length;
    const anchor = Math.max(0, Math.min(patched.source.length, from + relativeAnchor));
    const head = Math.max(0, Math.min(patched.source.length, from + relativeHead));
    const committed = commitCandidate(parsed, { anchor, head }, origin === 'typing' || origin === 'paste', { from, to, insert });
    return { handled: true, committed };
  }

  const sourceSelection = state => {
    if (bookmarkRange(state)) return { anchor: bookmark.anchor, head: bookmark.head };
    return { anchor: richToSource(model, state.selection.anchor), head: richToSource(model, state.selection.head) };
  };
  // In-buffer source access for links, math and images. The Markdown buffer
  // stays the truth; these helpers only select the exact syntax range in the
  // shared source projection for direct typing. No modal, no separate edit
  // session. Lock and undo are preserved by the shell entry.
  // Open a destination for editing in place. The exact Markdown range is
  // replaced through the source-preserving commit; there is no mode switch.
  async function editDestination({ title, current, from, to, fallbackFrom, fallbackTo }) {
    if (options.isLocked()) return;
    if (!options.editValue) { options.revealSource?.(fallbackFrom, fallbackTo); return; }
    const next = await options.editValue({ title, value: current });
    if (next === null || next === undefined || next === current) return;
    const outcome = replaceLogicalSelection(next, 'command', { from, to, all: false, collapsed: false });
    if (!outcome.committed) options.message?.('That change could not be applied to the Markdown source.');
  }
  // Locate an inline Markdown destination by syntax, not by searching for its
  // decoded value (which may occur in the label or contain escaped characters).
  function inlineDestination(open, limit) {
    const source = model.source;
    if (source.slice(open, open + 2) !== '](') return null;
    let start = open + 2;
    while (start < limit && /[ \t\n]/.test(source[start])) start++;
    const angle = source[start] === '<';
    if (angle) start++;
    let depth = 0;
    for (let i = start; i < limit; i++) {
      const ch = source[i];
      if (ch === '\\') { i++; continue; }
      if (angle && ch === '>') return { from: start, to: i, current: source.slice(start, i) };
      if (!angle && ch === '(') { depth++; continue; }
      if (!angle && ch === ')' && depth > 0) { depth--; continue; }
      if (!angle && (ch === ')' || /\s/.test(ch))) return { from: start, to: i, current: source.slice(start, i) };
    }
    return null;
  }
  function destinationRange(from, to) {
    let verified = verifiedSourceRange(from, to);
    if (!verified) {
      const start = richMapping(model, from, { bias: 'right' });
      const end = richMapping(model, to, { bias: 'left' });
      if (!start.exact || !end.exact || !start.owner || start.owner.id !== end.owner?.id ||
          start.source > end.source || model.source.slice(start.source, end.source) !== model.doc.textBetween(from, to)) return null;
      verified = { from: start.source, to: end.source };
    }
    const close = model.source.indexOf('](', Math.max(verified.from, verified.to - 1));
    if (close < 0 || close > verified.to + 1) return null;
    return inlineDestination(close, model.source.length);
  }
  function revealLinkSource(from, to, href) {
    if (options.isLocked()) return;
    const range = destinationRange(from, to);
    if (!range) { options.message?.('This link destination cannot be edited safely.'); return; }
    void editDestination({ title: 'Edit link destination', ...range, fallbackFrom: range.from, fallbackTo: range.to });
  }
  function revealCurrentSelection() {
    if (options.isLocked() || !options.revealSource) return;
    try {
      const selection = sourceSelection(view.state);
      options.revealSource(selection.anchor, selection.head);
    } catch {}
  }
  // Formatting commands that author Markdown syntax (Link, Image, Math) write
  // through the same exact-source path as typing, so the bytes stay predictable
  // and the shell's undo history remains authoritative. The returned range is
  // verified against the ledger; an ambiguous projection falls back to the
  // existing "reveal source" affordance rather than guessing an offset.
  function commandSourceRange() {
    const bookmarked = bookmarkRange(view.state);
    if (bookmarked) return bookmarked.all
      ? { from: 0, to: model.source.length }
      : { from: bookmarked.from, to: bookmarked.to };
    const selection = view.state.selection;
    if (!(selection instanceof TextSelection)) return null;
    if (!selection.empty) {
      const verified = verifiedSourceRange(selection.from, selection.to);
      return verified ? { from: verified.from, to: verified.to } : null;
    }
    const mapped = richMapping(model, selection.head, { bias: 'right' });
    if (!mapped || !mapped.exact || mapped.confidence !== 'exact' || !mapped.owner) return null;
    if (mapped.owner.confidence !== 'exact' || mapped.owner.supported === false) return null;
    if (!Number.isInteger(mapped.source)) return null;
    return { from: mapped.source, to: mapped.source };
  }
  function looksLikeDestination(text) {
    if (!text || /\s/.test(text) || !safeDestination(text)) return false;
    return /^(?:[a-z][a-z\d+.-]*:\S+|\/\/\S+|\/{1,2}\S*|\.{1,2}\/\S+|[\w.-]+\/[\w./-]*)$/i.test(text);
  }
  function insertCommandSyntax(name) {
    const range = commandSourceRange();
    if (!range) return false;
    const selected = model.source.slice(range.from, range.to);
    let insert, anchor, head;
    if (name === 'link') {
      if (selected && looksLikeDestination(selected)) {
        insert = `[${selected}](${selected})`;
        const start = insert.lastIndexOf(`(${selected})`) + 1;
        anchor = start; head = start + selected.length;
      } else if (selected) {
        insert = `[${selected}](https://example.com)`;
        const start = insert.indexOf('https://example.com');
        anchor = start; head = start + 'https://example.com'.length;
      } else {
        insert = '[text](https://example.com)';
        anchor = 1; head = 1 + 'text'.length;
      }
    } else if (name === 'image') {
      if (selected && looksLikeDestination(selected)) {
        insert = `![image](${selected})`;
        anchor = 2; head = 2 + 'image'.length;
      } else if (selected) {
        insert = `![${selected}](image.png)`;
        const start = insert.lastIndexOf('image.png');
        anchor = start; head = start + 'image.png'.length;
      } else {
        insert = '![alt](image.png)';
        anchor = 2; head = 2 + 'alt'.length;
      }
    } else if (name === 'math') {
      if (selected) {
        insert = `$${selected}$`;
        anchor = 1; head = 1 + selected.length;
      } else {
        insert = '$x$';
        anchor = 1; head = 2;
      }
    } else return false;
    const outcome = replaceLogicalSelection(insert, 'command', { from: range.from, to: range.to, all: false, collapsed: range.from === range.to }, { anchor, head });
    return outcome.committed;
  }
  // The checkbox lives in a list_item node view, but only one source byte is
  // allowed to change. Locate the verified `[ ]`/`[x]` marker through the
  // ledger so toggling never serializes the whole list (which used to drop
  // blank lines and turn a loose list tight).
  function listItemTaskMarker(pos) {
    let ledger = model.ledger;
    if (!ledger) {
      try { ledger = model.ledger = buildLedger(model.source, model.doc, { segments: model.segments }); }
      catch { return null; }
    }
    const owner = ledger?.owners?.find(entry => entry.pmFrom === pos && entry.type === 'list_item' && entry.confidence === 'exact');
    if (!owner) return null;
    const raw = model.source.slice(owner.sourceFrom, owner.sourceTo);
    const match = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+)\[([ xX])\]/.exec(raw);
    if (!match) return null;
    const from = owner.sourceFrom + match[1].length + 1;
    return { from, to: from + 1, checked: match[2] !== ' ' };
  }
  function listItem(node, editor, getPos) {
    const dom = document.createElement('li'), contentDOM = document.createElement('div'); contentDOM.className = 'list-content';
    let checkbox;
    function update(next) {
      if (next.type !== node.type) return false;
      node = next; dom.classList.toggle('task-item', node.attrs.checked !== null);
      if (node.attrs.checked !== null) {
        if (!checkbox) {
          checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.contentEditable = 'false'; checkbox.setAttribute('aria-label', 'Toggle task'); dom.prepend(checkbox);
          checkbox.addEventListener('mousedown', event => event.preventDefault());
          checkbox.addEventListener('change', () => {
            if (options.isLocked()) { checkbox.checked = node.attrs.checked; return; }
            const wanted = Boolean(checkbox.checked);
            if (wanted === Boolean(node.attrs.checked)) return;
            const marker = listItemTaskMarker(getPos());
            if (!marker) { checkbox.checked = Boolean(node.attrs.checked); return; }
            const outcome = replaceLogicalSelection(wanted ? 'x' : ' ', 'task', { from: marker.from, to: marker.to, all: false, collapsed: false });
            if (!outcome.committed) checkbox.checked = Boolean(node.attrs.checked);
          });
        }
        checkbox.checked = node.attrs.checked; checkbox.disabled = options.isLocked();
      } else if (checkbox) { checkbox.remove(); checkbox = null; }
      return true;
    }
    dom.append(contentDOM); update(node);
    const refresh = () => { if (checkbox) checkbox.disabled = options.isLocked(); }; refreshers.add(refresh);
    return { dom, contentDOM, update, stopEvent: event => event.target === checkbox, ignoreMutation: mutation => mutation.type === 'attributes' && mutation.target === checkbox, destroy() { refreshers.delete(refresh); } };
  }
  function mathView(node, editor, getPos) {
    const dom = document.createElement(node.isInline ? 'span' : 'div'); dom.className = node.isInline ? 'math-inline' : 'math-block'; dom.contentEditable = 'false';
    const formula = document.createElement('span'); formula.className = 'math-formula'; formula.title = 'Right-click to edit Markdown';
    formula.setAttribute('role', 'button'); formula.setAttribute('aria-label', 'Edit formula'); formula.tabIndex = 0;
    // Shift-click on a formula extends the selection *through* it. Letting the
    // editor resolve the click on its own lands the head on the atom boundary,
    // which excludes the formula the pointer is actually over.
    formula.addEventListener('mousedown', event => {
      if (event.button !== 0 || !event.shiftKey) return;
      let pos; try { pos = getPos(); } catch { return; }
      if (pos == null) return;
      event.preventDefault(); event.stopPropagation();
      const { state } = editor;
      const from = Math.min(state.selection.from, pos), to = Math.max(state.selection.to, pos + node.nodeSize);
      editor.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
    });
    dom.append(formula); let generation = 0;
    const render = async () => {
      const tex = node.attrs.tex;
      const current = ++generation; formula.textContent = tex; formula.classList.remove('math-error');
      try { const katex = await options.loadKatex(); if (current !== generation) return; katex.render(tex, formula, { displayMode: !node.isInline, throwOnError: true, trust: false, strict: 'warn' }); }
      catch { if (current === generation) { formula.textContent = tex; formula.classList.add('math-error'); formula.title = 'Formula could not be rendered. Its source is preserved.'; } }
      formula.setAttribute('aria-disabled', String(options.isLocked()));
    };
    const refresh = () => formula.setAttribute('aria-disabled', String(options.isLocked()));
    render(); refreshers.add(refresh);
    return { dom, update(next) { if (next.type !== node.type) return false; if (next.sameMarkup(node) && next.textContent === node.textContent) { node = next; return true; } node = next; render(); return true; }, stopEvent: event => {
      if (event.type === 'keydown') {
        // The formula is focusable so keyboard users can open it with Enter.
        // That must not make document-wide selection and deletion only work
        // after clicking elsewhere: Ctrl/Cmd+A reaches the editor always, and
        // Delete/Backspace reach it once a selection exists.
        const key = event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && !event.altKey && key === 'a') return false;
        if ((event.key === 'Backspace' || event.key === 'Delete') && !editor.state.selection.empty) return false;
      }
      return !['mousedown', 'mouseup', 'click', 'dblclick'].includes(event.type);
    }, ignoreMutation: () => true, destroy() { generation++; refreshers.delete(refresh); } };
  }
  function imageView(node, editorView, getPos) {
    const dom = document.createElement('span'); dom.className = 'image-widget'; dom.contentEditable = 'false'; let generation = 0;
    dom.addEventListener('click', event => {
      if (event.button !== 0 || options.isLocked() || event.target.closest('button,textarea')) return;
      let pos;
      try { pos = getPos(); } catch { return; }
      const selection = Selection.near(editorView.state.doc.resolve(pos + node.nodeSize), -1);
      if (!selection) return;
      editorView.dispatch(editorView.state.tr.setSelection(selection).scrollIntoView());
      editorView.focus();
    });
    const lease = options.reserveImage();
    const render = async (consent = false) => {
      const current = ++generation; dom.replaceChildren();
      lease.assign('');
      const caption = document.createElement('span'); caption.className = 'image-caption'; caption.textContent = node.attrs.alt || 'Image'; dom.append(caption);
      if (!lease.allowed) { caption.textContent = 'Image limit reached. Source is preserved.'; return; }
      try {
        const image = await options.resolveImage(node.attrs.src, consent);
        if (current !== generation) return;
        if (image.blocked) {
          const reason = document.createElement('span'); reason.textContent = `Remote image blocked · ${image.domain}. Loading may reveal your IP address.`;
          dom.append(reason, button('Load image', () => render(true)));
        } else if (image.src && lease.assign(image.src)) {
          const img = document.createElement('img'); img.alt = node.attrs.alt || ''; img.title = node.attrs.title || ''; img.referrerPolicy = 'no-referrer';
          img.addEventListener('error', () => { caption.textContent = 'Image could not be loaded. Its source is preserved.'; }); img.src = image.src; dom.prepend(img);
        } else caption.textContent = image.error || 'Image unavailable or image memory limit reached. Its source is preserved.';
      } catch { if (current === generation) caption.textContent = 'Image unavailable. Its source is preserved.'; }
    };
    render(); const refresh = () => render(); refreshers.add(refresh);
    return { dom, update(next) { if (next.type !== node.type) return false; if (next.eq(node)) return true; node = next; render(); return true; }, stopEvent: () => true, ignoreMutation: () => true, destroy() { generation++; lease.release(); refreshers.delete(refresh); } };
  }
  function codeView(node, editor, getPos) {
    const dom = document.createElement('div'); dom.className = 'code-container';
    const fenceInfo = document.createElement('input');
    fenceInfo.className = 'code-fence-info'; fenceInfo.type = 'text';
    fenceInfo.setAttribute('aria-label', 'Code fence info');
    fenceInfo.title = 'Edit code fence info (Enter to apply, Escape to cancel)'; fenceInfo.placeholder = 'Language';
    fenceInfo.spellcheck = false; fenceInfo.contentEditable = 'false';
    function fenceRange() {
      let pos;
      try { pos = getPos(); } catch { return null; }
      if (!Number.isInteger(pos)) return null;
      let ledger = model.ledger;
      if (!ledger) {
        try { ledger = model.ledger = buildLedger(model.source, model.doc, { segments: model.segments }); } catch { return null; }
      }
      const owner = ledger?.owners?.find(entry => entry.pmFrom === pos && entry.type === 'code_block');
      if (!owner || owner.confidence !== 'exact' || owner.supported === false) return null;
      const lineEnd = model.source.indexOf('\n', owner.sourceFrom);
      const end = lineEnd < 0 ? owner.sourceTo : Math.min(lineEnd, owner.sourceTo);
      const line = model.source.slice(owner.sourceFrom, end).replace(/\r$/, '');
      const match = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
      if (!match) return null;
      const from = owner.sourceFrom + match[1].length + match[2].length;
      return { from, to: owner.sourceFrom + line.length, value: match[3], fence: match[2] };
    }
    function syncFenceInfo() {
      const range = fenceRange();
      fenceInfo.hidden = !range; fenceInfo.disabled = options.isLocked();
      if (range && document.activeElement !== fenceInfo) fenceInfo.value = range.value;
    }
    function commitFenceInfo() {
      const range = fenceRange();
      if (!range || options.isLocked()) return;
      const value = fenceInfo.value;
      if (range.fence[0] === '`' && value.includes('`')) { options.message('Backticks are not allowed in a backtick fence info string.'); fenceInfo.value = range.value; return; }
      if (value !== range.value) replaceLogicalSelection(value, 'command', { from: range.from, to: range.to, all: false, collapsed: false });
      try { view.focus(); } catch {}
    }
    fenceInfo.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); commitFenceInfo(); }
      else if (event.key === 'Escape') { event.preventDefault(); const range = fenceRange(); if (range) fenceInfo.value = range.value; try { view.focus(); } catch {} }
    });
    fenceInfo.addEventListener('blur', () => { const range = fenceRange(); if (range) fenceInfo.value = range.value; });
    const drawing = document.createElement('div');
    // The native renderer already owns a safe, sanitized syntax highlighter.
    // Keep its tokens in a non-editable backing layer and leave the real
    // editable text above it. When the code block is focused the backing layer
    // is covered by the normal editable surface, so selection and IME behave
    // exactly as before; the tokens never enter the ProseMirror document.
    const highlight = document.createElement('pre'); highlight.className = 'code-highlight'; highlight.setAttribute('aria-hidden', 'true');
    const highlightCode = document.createElement('code'); highlight.append(highlightCode);
    const pre = document.createElement('pre'); pre.className = 'code-surface';
    // The highlighted projection sits behind the editable scroller. Keep its
    // horizontal offset in sync so hidden source glyphs and visible tokens
    // continue to represent the same part of a long line.
    pre.addEventListener('scroll', () => { highlight.scrollLeft = pre.scrollLeft; }, { passive: true });
    const code = document.createElement('code'); pre.append(code);
    let generation = 0, source = null, theme = null, abortController = null, renderTimer = 0;
    let highlightGeneration = 0, highlightTimer = 0, highlightedSource = null, highlightedLanguage = null;
    let nearViewport = !codeHighlightObserver;
    dom.addEventListener('focusin', () => dom.classList.add('code-editing'));
    dom.addEventListener('focusout', () => requestAnimationFrame(() => { if (!dom.contains(document.activeElement)) dom.classList.remove('code-editing'); }));
    const clearHighlight = () => {
      highlightGeneration++; clearTimeout(highlightTimer);
      highlightCode.replaceChildren(); dom.classList.remove('code-highlighted');
      highlightedSource = null; highlightedLanguage = null;
    };
    const scheduleHighlight = language => {
      if (!nearViewport) {
        if (highlightedSource !== null && (highlightedSource !== node.textContent || highlightedLanguage !== language)) clearHighlight();
        return;
      }
      const sourceText = node.textContent;
      if (sourceText === highlightedSource && language === highlightedLanguage) return;
      highlightedSource = sourceText; highlightedLanguage = language;
      const current = ++highlightGeneration; clearTimeout(highlightTimer);
      // Keep the real text visible until fresh tokens for this exact source
      // arrive; never show a stale highlight over changed code.
      dom.classList.remove('code-highlighted');
      if (!options.highlightCode || !sourceText || sourceText.length > 200000) { highlightCode.replaceChildren(); return; }
      highlightTimer = setTimeout(async () => {
        try {
          const html = await options.highlightCode(sourceText, language);
          if (current !== highlightGeneration || !dom.isConnected) return;
          const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
          const source = parsed.querySelector('pre code') || parsed.body;
          const copy = document.createDocumentFragment();
          // Copy text and token spans only; never inject arbitrary markup.
          const copyTokens = (from, to) => {
            for (const child of from.childNodes) {
              if (child.nodeType === Node.TEXT_NODE) to.append(document.createTextNode(child.nodeValue));
              else if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'SPAN') {
                const span = document.createElement('span');
                for (const name of child.classList) if (/^[a-z0-9_-]+$/i.test(name)) span.classList.add(name);
                copyTokens(child, span); to.append(span);
              } else copyTokens(child, to);
            }
          };
          if (source) copyTokens(source, copy);
          highlightCode.replaceChildren(copy);
          highlight.scrollLeft = pre.scrollLeft;
          dom.classList.toggle('code-highlighted', highlightCode.textContent === sourceText && highlightCode.childNodes.length > 0);
        } catch { if (current === highlightGeneration) { highlightCode.replaceChildren(); dom.classList.remove('code-highlighted'); } }
      }, 60);
    };
    const render = async () => {
      syncFenceInfo();
      const language = node.attrs.params.trim().split(/\s/)[0]; dom.dataset.language = language;
      if (language === 'math') {
        clearHighlight(); clearTimeout(renderTimer); renderTimer = 0; abortController?.abort(); source = null; theme = null;
        dom.classList.remove('mermaid-host'); delete dom.dataset.mermaidSource; delete dom.dataset.diagramState;
        pre.hidden = true;
        if (pre.parentNode !== dom || drawing.parentNode !== dom) dom.replaceChildren(fenceInfo, drawing, pre);
        const current = ++generation, tex = node.textContent;
        drawing.className = 'math-block math-formula'; drawing.textContent = tex;
        try {
          const katex = await options.loadKatex();
          if (current !== generation || !dom.isConnected) return;
          katex.render(tex, drawing, { displayMode: true, throwOnError: true, trust: false, strict: 'warn' });
        } catch {
          if (current !== generation) return;
          drawing.textContent = 'Formula could not be rendered. Its source is preserved.';
          drawing.classList.add('math-error');
        }
        return;
      }
      if (language !== 'mermaid') {
        generation++; clearTimeout(renderTimer); renderTimer = 0; abortController?.abort(); source = null; theme = null;
        dom.classList.remove('mermaid-host'); delete dom.dataset.mermaidSource; delete dom.dataset.diagramState;
        code.className = /^[a-z0-9_+#.-]+$/i.test(language) ? `language-${language}` : '';
        pre.hidden = false;
        if (pre.parentNode !== dom || highlight.nextSibling !== pre) dom.replaceChildren(fenceInfo, highlight, pre);
        scheduleHighlight(language);
        return;
      }
      clearHighlight();
      dom.classList.add('mermaid-host'); dom.dataset.mermaidSource = node.textContent;
      pre.hidden = true;
      if (pre.parentNode !== dom || drawing.parentNode !== dom) dom.replaceChildren(fenceInfo, drawing, pre);
      const text = node.textContent, nextTheme = options.themeRevision();
      if (source === text && theme === nextTheme) return;
      // A keystroke changes the exact source, so any render still in flight is
      // stale. Invalidate it immediately, but debounce the next render and keep
      // the previous SVG visible: the diagram should update after typing
      // settles, not flash through a placeholder on every character.
      generation++; clearTimeout(renderTimer); abortController?.abort(); abortController = null;
      source = text; theme = nextTheme; dom.dataset.themeRevision = String(theme);
      dom.dataset.diagramState = 'rendering';
      const current = generation, hadDiagram = Boolean(drawing.querySelector('svg'));
      drawing.classList.remove('mermaid-error');
      code.className = '';
      if (!hadDiagram) drawing.textContent = 'Rendering diagram…';
      renderTimer = setTimeout(async () => {
        renderTimer = 0;
        if (current !== generation || !dom.isConnected) return;
        abortController = new AbortController();
        try {
          const outcome = await options.renderDiagram(text, abortController.signal);
          if (current !== generation || !dom.isConnected) return;
          if (outcome?.ok && outcome.sanitized && outcome.svg) {
            drawing.className = ''; drawing.innerHTML = outcome.svg; code.className = '';
            dom.dataset.diagramState = 'rendered';
          } else {
            drawing.textContent = outcome?.error?.code === 'unsupported_external_images' ? 'This diagram needs external images, which are blocked while rendering offline.' : 'Mermaid diagram could not be rendered.';
            drawing.className = 'mermaid-error'; code.className = 'mermaid-source';
            dom.dataset.diagramState = 'error';
          }
        } catch {
          if (current !== generation || !dom.isConnected) return;
          drawing.textContent = 'Mermaid diagram could not be rendered.';
          drawing.className = 'mermaid-error'; code.className = 'mermaid-source';
          dom.dataset.diagramState = 'error';
        }
      }, hadDiagram ? 120 : 0);
    };
    if (codeHighlightObserver) {
      codeHighlights.set(dom, visible => {
        nearViewport = visible;
        if (visible && !pre.hidden) scheduleHighlight(dom.dataset.language || '');
      });
      codeHighlightObserver.observe(dom);
    }
    render(); refreshers.add(render);
    return { dom, contentDOM: code, update(next) { if (next.type !== node.type) return false; if (next.sameMarkup(node) && next.textContent === node.textContent) { node = next; return true; } node = next; render(); return true; }, stopEvent: event => event.target === fenceInfo || event.target.classList?.contains('code-markdown-source'), ignoreMutation: mutation => mutation.type === 'attributes' || !pre.contains(mutation.target), destroy() { generation++; clearTimeout(renderTimer); clearTimeout(highlightTimer); highlightGeneration++; abortController?.abort(); codeHighlightObserver?.unobserve(dom); codeHighlights.delete(dom); refreshers.delete(render); } };
  }
  // Reading selections may start, cross and end inside a rendered projection
  // or inline element. ProseMirror maps any DOM position inside an atom to
  // the atom boundary and rewrites the DOM range, which truncates cross-block
  // drags to the editable side. While a drag is active the editor's selection
  // observer is paused so the native range is left alone; it is re-synced on
  // release (or on the next edit/pointer gesture if a reading range is still
  // standing). The guarded range always covers rendered text, never the
  // literal source.
  let selectionGuarded = false;
  function renderedRangeActive() {
    try {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
      const rendered = view?.dom.querySelectorAll('.extension-preview, .html-inline, .mermaid-host, .math-block, .math-inline, .image-widget');
      if (!rendered || !rendered.length) return false;
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        for (const node of rendered) if (range.intersectsNode(node)) return true;
      }
    } catch {}
    return false;
  }
  // ProseMirror escalates rapid presses by elapsed time and pointer distance,
  // not by the browser's own click count. Mirror that rule so a rendered block
  // opts out of the triple-click default in exactly the presses ProseMirror
  // would escalate, while an ordinary third click still reaches it.
  function tripleClickPress(editor, event) {
    if (event.detail >= 3) return true;
    const last = editor.input?.lastClick;
    if (!last || last.button !== event.button || last.type !== 'doubleClick') return false;
    if (Date.now() - last.time >= 500) return false;
    const dx = last.x - event.clientX, dy = last.y - event.clientY;
    return dx * dx + dy * dy < 100;
  }
  // The paragraph unit of a rendered projection: the nearest block element
  // around the pressed text. Returns null outside a projection so every other
  // triple click keeps ProseMirror's own paragraph selection.
  function renderedParagraphAt(target) {
    if (!(target instanceof Element)) return null;
    const projection = target.closest('.extension-preview');
    if (!projection) return null;
    for (let node = target; node && node !== projection; node = node.parentElement) {
      if (node.matches?.('p,li,dt,dd,h1,h2,h3,h4,h5,h6,pre,blockquote,figcaption,td,th')) return node;
    }
    return null;
  }
  function setSelectionGuarded(on) {
    if (Boolean(on) === selectionGuarded) return;
    selectionGuarded = Boolean(on);
    try {
      if (!view) return;
      // Pausing disconnects both mutation and selection observation; the
      // projection blocks input (see rawView), so no document change can slip
      // through while the observer is paused.
      if (selectionGuarded) view.domObserver.stop();
      else view.domObserver.start();
    } catch {}
  }
  function releaseSelectionGuard() {
    if (!selectionGuarded) {
      // Reconcile on a plain pointer-up/blur too. WebKitGTK does not always
      // deliver a selectionchange when a range is cleared by clicking chrome,
      // and a stale mirror would keep painting an old block.
      try { syncFolioHighlight(); } catch {}
      return;
    }
    // A standing reading range keeps its guard; anything else hands selection
    // back to the editor so typing and caret movement stay predictable.
    if (renderedRangeActive()) {
      // The native projection range cannot be represented in editor state.
      // Cancel ProseMirror's deferred mouseup write of that truncated range.
      const mouseDown = view.input.mouseDown;
      if (mouseDown) mouseDown.delayedSelectionSync = false;
      return;
    }
    setSelectionGuarded(false);
    try { view?.domObserver.flush(); } catch {}
    try { syncFolioHighlight(); } catch {}
  }
  function resyncGuardedSelection() {
    if (!selectionGuarded) return;
    // Stopping the DOM observer is what lets a native drag cross a rendered
    // atom without ProseMirror truncating it to that atom's boundary. But a
    // stopped observer also means editor state never learned the new range.
    // Before an edit or caret command runs, map the live range through the
    // same source-aware endpoint logic used for copy, then adopt that exact
    // source interval as the bookmark and the editor selection. A plain
    // observer flush is not enough: it has no moved-selection records to read.
    let range = null;
    try {
      const dom = window.getSelection();
      if (dom && dom.rangeCount === 1 && !dom.isCollapsed) range = markdownClipboardRange();
    } catch {}
    setSelectionGuarded(false);
    if (range && range.from < range.to) {
      try {
        const limit = view.state.doc.content.size;
        const anchor = Math.max(0, Math.min(limit, sourceToRich(model, range.from)));
        const head = Math.max(0, Math.min(limit, sourceToRich(model, range.to)));
        const next = TextSelection.between(view.state.doc.resolve(anchor), view.state.doc.resolve(head));
        if (!view.state.selection.eq(next)) view.dispatch(view.state.tr.setSelection(next));
        setBookmark(range.from, range.to, view.state);
        return;
      } catch {}
    }
    try { view?.domObserver.flush(); } catch {}
  }
  // A native drag over the visible glyphs of `**bold**` or `[label](url)` can
  // map its end to the closing syntax and return an unbalanced fragment. For
  // visual selections, copy the visible text (or a balanced fragment) rather
  // than half a delimiter pair. Explicit source selections use the bookmark
  // path above and remain byte-exact.
  function balancedClipboardRange(from, to) {
    const runs = model.ledger?.runs;
    if (!runs || from >= to) return { from, to };
    const containing = runs.filter(run => (run.kind === 'text' || run.kind === 'atom') &&
      run.sourceFrom <= from && run.sourceTo >= from);
    if (!containing.length) return { from, to };
    const run = containing.sort((a, b) => b.sourceFrom - a.sourceFrom)[0];
    const marked = Boolean(run.marksKey);
    const tail = model.source.slice(run.sourceTo, to);
    if (to > run.sourceTo && (/^[*_~`]+$/.test(tail) || /^\]\([^)\n]*\)$/.test(tail))) to = run.sourceTo;
    if (marked && from > run.sourceFrom && to > run.sourceTo) from = run.sourceFrom;
    return { from, to };
  }
  // Deleting the visible text of a marked run should take its delimiters with
  // it, otherwise a cut leaves an empty `****`/`~~~~`/`` pair behind.
  function cutExpandedRange(range) {
    const runs = model.ledger?.runs;
    if (!runs || range.from >= range.to) return range;
    const run = runs.find(item => item.kind === 'text' && item.sourceFrom === range.from && item.sourceTo === range.to);
    if (!run) return range;
    const delim = view.state.doc.rangeHasMark(run.pmFrom, run.pmTo, schema.marks.strong) ? '**'
      : view.state.doc.rangeHasMark(run.pmFrom, run.pmTo, schema.marks.em) ? '*'
      : view.state.doc.rangeHasMark(run.pmFrom, run.pmTo, schema.marks.strike) ? '~~'
      : view.state.doc.rangeHasMark(run.pmFrom, run.pmTo, schema.marks.code) ? '`' : null;
    if (!delim) return range;
    const from = range.from - delim.length, to = range.to + delim.length;
    if (from < 0 || model.source.slice(from, range.from) !== delim || model.source.slice(range.to, to) !== delim) return range;
    return { ...range, from, to };
  }
  function markdownClipboardRange() {
    const logical = bookmarkRange(view.state);
    if (logical && logical.from < logical.to) return logical;
    const domSelection = window.getSelection();
    if (domSelection && domSelection.rangeCount && !domSelection.isCollapsed && view.dom.contains(domSelection.anchorNode) && view.dom.contains(domSelection.focusNode)) {
      const range = domSelection.getRangeAt(0);
      const endpoint = (container, offset, end) => {
        let pos = view.posAtDOM(container, offset, end ? -1 : 1);
        let mapped = richToSource(model, pos);
        let pmFrom = 0;
        for (const segment of model.segments) {
          const dom = view.nodeDOM(pmFrom);
          if (dom && (dom === container || dom.contains(container))) {
            // Rendered atoms have no text-to-source bijection. Include their
            // complete source rather than copying labels or omitting fences.
            const projected = segment.node.type.name === 'raw_block' && segment.node.attrs.kind !== 'source-edit'
              || dom.matches?.('.mermaid-host,.math-block,.image-widget');
            if (projected) return end ? segment.to : segment.from;
            const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT);
            const texts = []; let text;
            while ((text = walker.nextNode())) {
              if (!text.parentElement.closest('button,input,textarea,.code-highlight,.katex-mathml,[hidden]')) texts.push(text);
            }
            if (!end && container === texts[0] && offset === 0) mapped = segment.from;
            const last = texts.at(-1);
            if (end && container === last && offset === last?.length) mapped = segment.to;
            break;
          }
          pmFrom += segment.node.nodeSize;
        }
        return mapped;
      };
      try {
        const from = endpoint(range.startContainer, range.startOffset, false);
        const to = endpoint(range.endContainer, range.endOffset, true);
        if (Number.isInteger(from) && Number.isInteger(to) && from < to) return balancedClipboardRange(from, to);
      } catch {}
    }
    if (view.state.selection instanceof AllSelection) return { from: 0, to: model.source.length };
    if (!view.state.selection.empty) {
      const selection = sourceSelection(view.state);
      return { from: Math.min(selection.anchor, selection.head), to: Math.max(selection.anchor, selection.head) };
    }
    return null;
  }
  function copyMarkdownSelection(event) {
    if (!event.clipboardData) return false;
    const range = markdownClipboardRange();
    if (!range) return false;
    try {
      event.clipboardData.setData('text/plain', model.source.slice(range.from, range.to));
      // Do not attach rendered HTML: paste destinations should receive the
      // same Markdown payload as plain-text clipboard consumers.
      event.preventDefault();
      return true;
    } catch {
      event.preventDefault();
      options.message('The clipboard could not be written. Your document is preserved.');
      return true;
    }
  }
  // Text-shaped reading paint via the CSS Custom Highlights API. The real DOM
  // range stays authoritative (selection, copy and editing all behave
  // natively); a mirrored Highlight repaints it per text fragment so engines
  // that fill whole blocks for multi-block selections show the same calm
  // per-line wash as everywhere else. Unsupported engines never engage, which
  // keeps ordinary native painting as the fallback.
  const folioHighlightName = 'folio-selection';
  const customHighlightSupported = (() => {
    try {
      return typeof Highlight === 'function'
        && !!(window.CSS && window.CSS.highlights)
        && CSS.supports('selector(::highlight(folio-selection))');
    } catch { return false; }
  })();
  let folioPaintActive = false;
  // A text node may contain several explicit lines (every fenced code block
  // does). Some engines fill the whole bounding box of a highlight range, so a
  // range spanning those newlines paints a solid rectangle over the block
  // instead of a per-line wash. Split a same-node fragment at line breaks so
  // every registered range stays on one line.
  function lineFragments(range) {
    if (range.startContainer !== range.endContainer || range.startContainer.nodeType !== Node.TEXT_NODE) return [range];
    const node = range.startContainer, value = node.nodeValue || '';
    const parts = [];
    let lineStart = range.startOffset;
    for (let index = lineStart; index < range.endOffset; index++) {
      if (value.charCodeAt(index) !== 10) continue;
      if (index > lineStart) {
        const part = document.createRange();
        part.setStart(node, lineStart); part.setEnd(node, index);
        parts.push(part);
      }
      lineStart = index + 1;
    }
    if (range.endOffset > lineStart) {
      const part = document.createRange();
      part.setStart(node, lineStart); part.setEnd(node, range.endOffset);
      parts.push(part);
    }
    return parts;
  }
  function folioHighlightRanges(range) {
    const result = [];
    const root = range.commonAncestorContainer;
    const scope = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
    if (!scope || !view.dom.contains(scope)) return result;
    // One range per real text node avoids the block-sized rectangles some
    // engines paint for a range crossing element boundaries. Syntax overlays
    // are duplicate, non-selectable glyphs and must never enter the mirror.
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const probe = document.createRange();
    let text;
    const intersects = node => {
      probe.selectNodeContents(node);
      if (probe.compareBoundaryPoints(Range.START_TO_END, range) <= 0) return null;
      if (probe.compareBoundaryPoints(Range.END_TO_START, range) >= 0) return null;
      const out = document.createRange();
      if (range.compareBoundaryPoints(Range.START_TO_START, probe) <= 0) out.setStart(node, 0);
      else if (range.startContainer === node) out.setStart(node, range.startOffset);
      else out.setStart(node, 0);
      if (range.compareBoundaryPoints(Range.END_TO_END, probe) >= 0) out.setEnd(node, node.nodeValue.length);
      else if (range.endContainer === node) out.setEnd(node, range.endOffset);
      else out.setEnd(node, node.nodeValue.length);
      return out.collapsed ? null : out;
    };
    while ((text = walker.nextNode())) {
      if (text.parentElement?.closest('.code-highlight,button,input,textarea,.katex-mathml')) continue;
      // KaTeX's visible glyph tree is aria-hidden because MathML supplies
      // accessibility. It is still the tree that selection must paint.
      if (text.parentElement?.closest('[aria-hidden="true"]') && !text.parentElement.closest('.katex-html')) continue;
      const part = intersects(text);
      if (!part) continue;
      // A range made only of a line break paints a full-width bar in WebKit,
      // and whitespace alone has nothing to wash. Keep text-bearing fragments
      // only; line splitting has already removed every interior newline.
      for (const line of lineFragments(part)) {
        const value = line.toString().replace(/[\u200B-\u200D\uFEFF]/g, '');
        if (value.trim() && !/[\r\n]/.test(value)) result.push(line);
      }
    }
    return result;
  }
  function applyFolioRanges(ranges, hasSelection = false) {
    if (!customHighlightSupported || !view) return;
    view.dom.querySelectorAll('.code-selection-painted').forEach(node => node.classList.remove('code-selection-painted'));
    for (const range of ranges) {
      const code = range.startContainer.parentElement?.closest('.code-surface');
      code?.closest('.code-container')?.classList.add('code-selection-painted');
    }
    if (!ranges.length) {
      // A selection made only of line breaks or spaces has no text to wash.
      // Keep suppression on anyway: falling back to native paint here is what
      // turned that selection into a full-width engine rectangle.
      if (hasSelection) {
        try { window.CSS.highlights.delete(folioHighlightName); } catch {}
        folioPaintActive = true;
        view.dom.classList.add('folio-paint');
        return;
      }
      if (folioPaintActive) {
        folioPaintActive = false;
        try { window.CSS.highlights.delete(folioHighlightName); } catch {}
        view.dom.classList.remove('folio-paint');
      }
      return;
    }
    try {
      window.CSS.highlights.set(folioHighlightName, new Highlight(...ranges));
      folioPaintActive = true;
      view.dom.classList.add('folio-paint');
    } catch {
      // Registry hiccup (detached nodes?): fall back to native painting.
      folioPaintActive = false;
      view.dom.querySelectorAll('.code-selection-painted').forEach(node => node.classList.remove('code-selection-painted'));
      try { window.CSS.highlights.delete(folioHighlightName); } catch {}
      view.dom.classList.remove('folio-paint');
    }
  }
  // Find jumps select the match in editor state, but focus stays in the find
  // field. ProseMirror only paints its native selection while the editor has
  // focus, so mirror the match through the same custom-highlight registry the
  // reading selection uses. Keyboard focus and the scroll position stay
  // untouched while the hit remains visibly marked.
  let searchHighlight = null;
  function searchDomRange(from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) return null;
    let start, end;
    try {
      start = sourceMapping(model, from, { bias: 'right' }).pm;
      end = sourceMapping(model, to, { bias: 'left' }).pm;
    } catch { return null; }
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null;
    try {
      const a = view.domAtPos(start), b = view.domAtPos(end);
      const range = document.createRange();
      range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset);
      return range.collapsed ? null : range;
    } catch { return null; }
  }
  function paintSearchHighlight() {
    if (!searchHighlight) return false;
    try {
      const range = searchDomRange(searchHighlight.from, searchHighlight.to);
      if (!range) return false;
      applyFolioRanges(folioHighlightRanges(range));
      return true;
    } catch { return false; }
  }
  function syncFolioHighlight() {
    if (!view) return;
    options.onContext?.(currentContext(view.state));
    const native = window.getSelection();
    const nativeRange = native && native.rangeCount && !native.isCollapsed ? native.getRangeAt(0) : null;
    view.dom.querySelectorAll('.mermaid-host, .math-block, .math-inline, .image-widget').forEach(node => {
      node.classList.toggle('folio-rendered-selected', Boolean(nativeRange && nativeRange.intersectsNode(node)));
    });
    const { from, to } = view.state.selection;
    // Mirroring an entire large document creates thousands of DOM ranges.
    // Keep native paint for those selections, including selection restored
    // by undo. Ordinary ranges keep Folio's per-line painting.
    const useNativePaint = nativeRange && to - from > 100000;
    if (!customHighlightSupported || useNativePaint) {
      if (useNativePaint && customHighlightSupported) applyFolioRanges([]);
      view.dom.querySelectorAll('.code-container').forEach(node => {
        const surface = node.querySelector('.code-surface code');
        node.classList.toggle('code-selection-painted', Boolean(nativeRange && surface && nativeRange.intersectsNode(surface)));
      });
      return;
    }
    const selection = window.getSelection();
    const hasSelection = Boolean(selection && selection.rangeCount > 0 && !selection.isCollapsed
      && view.dom.contains(selection.anchorNode) && view.dom.contains(selection.focusNode));
    let ranges = [];
    if (hasSelection) {
      try { ranges = folioHighlightRanges(selection.getRangeAt(0)); }
      catch { ranges = []; }
    }
    // A standing find highlight survives selectionchange events that belong
    // to the find field (the native document selection is empty there).
    if (!ranges.length && paintSearchHighlight()) return;
    applyFolioRanges(ranges, hasSelection);
  }
  function setSearchHighlight(from, to) {
    searchHighlight = Number.isInteger(from) && Number.isInteger(to) && to > from ? { from, to } : null;
    if (!searchHighlight) applyFolioRanges([]);
    else if (!paintSearchHighlight()) applyFolioRanges([]);
  }
  function clearSearchHighlight() {
    searchHighlight = null;
    syncFolioHighlight();
  }
  // Inline author HTML (keyboard keys, variables, sample output...) renders as
  // real sanitized elements instead of literal code text. The atom keeps the
  // exact source for round-tripping and reveals it in the source presentation
  // on demand, exactly like math and image atoms. Only allowlisted tags
  // render; anything else (or a malformed fragment) falls back to the
  // previous code-chip rendering, which is always safe to display.
  const INLINE_HTML_ELEMENTS = new Set(INLINE_HTML_SPAN_TAGS);
  const PROGRESS_BAR_ATTRIBUTES = new Set(['value', 'max']);
  const METER_BAR_ATTRIBUTES = new Set(['value', 'min', 'max', 'low', 'high', 'optimum']);
  function barNumber(value) {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  function renderInlineHtml(source) {
    // Build directly from the token stream, never from a parsed document. Only
    // allowlisted elements get created, so an inner <img>/<iframe>/<style> is
    // rejected before any resource-bearing node can exist.
    const fragment = document.createDocumentFragment();
    const stack = [];
    let root = null;
    for (const token of scanHtmlTokens(source)) {
      if (token.type === 'text') {
        const value = decodeHTML(token.value);
        const parent = stack[stack.length - 1];
        if (parent) parent.append(document.createTextNode(value));
        else {
          // The merged pair must be exactly one element; surrounding prose
          // means the tokenizer and this renderer disagree, so refuse.
          if (value.trim() !== '') return null;
          if (value) fragment.append(document.createTextNode(value));
        }
        continue;
      }
      if (token.type === 'start') {
        if (!INLINE_HTML_ELEMENTS.has(token.name)) return null;
        const element = document.createElement(token.name);
        if (token.name === 'a') {
          const href = token.attrs.get('href');
          // Same destination policy as Markdown links: relative document links
          // keep working, script/data/file targets never do.
          if (href && safeDestination(href)) element.setAttribute('href', href);
        }
        // A progress/meter bar keeps only its own numeric attributes. Every
        // other attribute (handlers, style, class, arbitrary names) is dropped,
        // and a value that is not a finite number is dropped rather than
        // guessed, so the bar can never describe something the source does not.
        const numeric = token.name === 'progress' ? PROGRESS_BAR_ATTRIBUTES : token.name === 'meter' ? METER_BAR_ATTRIBUTES : null;
        if (numeric) {
          for (const [name, value] of token.attrs) {
            if (!numeric.has(name)) continue;
            const number = barNumber(value);
            if (number === null) continue;
            element.setAttribute(name, String(number));
          }
        }
        // Every other attribute is dropped: no handlers, no styles, and no
        // forged editor markers can ride along.
        if (!stack.length) {
          if (root) return null;
          root = element;
          fragment.append(element);
        } else stack[stack.length - 1].append(element);
        if (!token.selfClosing) stack.push(element);
        continue;
      }
      if (!stack.length) return null;
      const open = stack.pop();
      if (open.tagName.toLowerCase() !== token.name) return null;
    }
    if (stack.length || !root) return null;
    return fragment;
  }
  function rawInlineView(node, editor, getPos) {
    const dom = document.createElement('span');
    dom.className = 'html-inline';
    // Join the editable surface like projections do: ProseMirror leaves an
    // explicitly set contenteditable alone, and a non-editable island would
    // punch holes in selection painting. Input is blocked below because the
    // DOM is a sanitized rendering, not the document. Under Lock the whole
    // editor (including this span) is uniformly non-editable, so selections
    // span the same way in both modes.
    const syncEditability = () => {
      try { dom.contentEditable = String(!options.isUserLocked()); } catch {}
    };
    syncEditability();
    const guardMutation = event => { if (!event.target.closest?.('.inline-markdown-source')) event.preventDefault(); };
    dom.addEventListener('beforeinput', guardMutation);
    dom.addEventListener('drop', guardMutation);
    dom.addEventListener('dragstart', guardMutation);
    // Modifier clicks open the link destination.
    dom.addEventListener('click', event => {
      const anchor = event.target.closest('a');
      if (!anchor || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      if (event.ctrlKey || event.metaKey || options.isLocked()) { options.openLink(anchor.getAttribute('href') || ''); return; }
      let pos;
      try { pos = getPos(); } catch { return; }
      const owner = richMapping(model, pos, { bias: 'right' })?.owner;
      if (!owner || owner.confidence !== 'exact' || owner.supported === false || !options.editValue) {
        options.message?.('This inline HTML cannot be edited safely.');
        return;
      }
      const from = owner.sourceFrom, to = owner.sourceTo, original = model.source.slice(from, to);
      if (original !== node.attrs.source) return;
      if (event.detail > 1) { clearTimeout(inlineClickTimer); return; }
      clearTimeout(inlineClickTimer);
      const clickedRevision = revision;
      inlineClickTimer = setTimeout(() => {
        inlineClickTimer = 0;
        void options.editValue({ title: 'Edit inline HTML', value: original }).then(next => {
          if (next === null || next === undefined || next === original) return;
          if (revision !== clickedRevision || model.source.slice(from, to) !== original ||
              !replaceLogicalSelection(next, 'command', { from, to, all: false, collapsed: false }).committed) {
            options.message?.('This inline HTML could not be updated safely.');
          }
        });
      }, 240);
    });
    const render = () => {
      dom.replaceChildren();
      const rendered = renderInlineHtml(node.attrs.source);
      let content = null;
      if (rendered) content = rendered;
      else {
        // Fallback preserves the previous literal rendering for tags outside
        // the allowlist and malformed fragments; the source stays exact.
        const code = document.createElement('code');
        code.className = 'source-inline';
        code.textContent = node.attrs.source;
        const fallback = document.createDocumentFragment();
        fallback.append(code);
        content = fallback;
      }
      // Preserve an outer Markdown link mark exactly like the schema
      // serializer does: wrap the rendering in an anchor so the link stays
      // clickable and reveals its URL instead of going silently dead.
      const link = node.marks.find(mark => mark.type.name === 'link');
      if (link) {
        const anchor = document.createElement('a');
        const href = link.attrs.href;
        if (href && safeDestination(href)) anchor.setAttribute('href', href);
        anchor.setAttribute('rel', 'noreferrer');
        anchor.append(content);
        dom.append(anchor);
      } else dom.append(content);
    };
    render();
    const refresh = () => syncEditability();
    refreshers.add(refresh);
    return { dom, update(next) { if (next.type !== node.type) return false; node = next; render(); return true; }, ignoreMutation: () => true, destroy() { refreshers.delete(refresh); } };
  }
  // The native sanitizer replaces a blocked remote author-HTML image source
  // with an opaque local placeholder, so the projection carries no destination
  // that could drive per-image consent. Recover the exact destinations from the
  // raw block itself and pair them positionally with the sanitized images. The
  // URL is never written to the projection before the user asks to load it; a
  // count mismatch means the mapping is not provable, so every image stays
  // inert rather than guessing.
  function remoteImageDestination(value) {
    const normalized = String(value || '')
      .replace(/[\t\n\r]/g, '')
      .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
    const slashed = normalized.replace(/\\/g, '/').toLowerCase();
    return slashed.startsWith('//') || slashed.startsWith('http:') || slashed.startsWith('https:') || normalized.startsWith('\\');
  }
  function authorImageSources(source, projection) {
    const rendered = [...projection.querySelectorAll('img')];
    if (!rendered.length) return [];
    const sourceImages = [];
    for (const token of scanHtmlTokens(source)) {
      if (token.type !== 'start' || token.name !== 'img') continue;
      const destination = token.attrs.get('src') || '';
      sourceImages.push({
        destination,
        remote: remoteImageDestination(destination),
        fingerprint: imageFingerprint(token.attrs)
      });
    }
    if (!sourceImages.length) return [];
    // Pair by surviving identity (alt/title/dimensions/class), never by count.
    // A sanitizer that removes or reorders an image then leaves either side
    // without a unique match; only unique-on-both-sides identities may be
    // trusted, otherwise the control fails closed instead of guessing a URL.
    const sourceCounts = new Map();
    for (const image of sourceImages) sourceCounts.set(image.fingerprint, (sourceCounts.get(image.fingerprint) || 0) + 1);
    const renderedByIdentity = new Map();
    for (const image of rendered) {
      const fingerprint = imageFingerprint(image);
      const matches = renderedByIdentity.get(fingerprint) || [];
      matches.push(image);
      renderedByIdentity.set(fingerprint, matches);
    }
    return sourceImages.flatMap(image => {
      if (!image.remote || sourceCounts.get(image.fingerprint) !== 1) return [];
      const matches = renderedByIdentity.get(image.fingerprint);
      return matches?.length === 1 ? [{ image: matches[0], destination: image.destination }] : [];
    });
  }
  function offerExtensionImageLoad(image, destination, stale) {
    if (stale() || !image.isConnected) return;
    if (image.nextElementSibling?.classList?.contains('extension-image-load')) return;
    const controls = document.createElement('span');
    controls.className = 'extension-image-load';
    const load = button('Load image', async () => {
      load.disabled = true;
      try {
        const result = await options.resolveImage(destination, true);
        if (stale() || !image.isConnected) return;
        if (!result.src) { load.disabled = false; return; }
        image.referrerPolicy = 'no-referrer';
        image.src = result.src;
        controls.remove();
      } catch { load.disabled = false; }
    });
    load.setAttribute('aria-label', 'Load image');
    load.title = 'Load remote image';
    controls.append(load);
    image.after(controls);
  }
  async function mountAuthorImages(source, projection, stale) {
    for (const entry of authorImageSources(source, projection)) {
      // A permitted projection already carries the exact destination. Do not
      // ask the native renderer again; only blocked placeholders need consent.
      if (entry.image.getAttribute('src') === entry.destination) continue;
      try {
        const result = await options.resolveImage(entry.destination, false);
        if (stale() || !entry.image.isConnected) return;
        if (result.src === entry.destination) {
          entry.image.referrerPolicy = 'no-referrer';
          entry.image.src = result.src;
        } else if (result.blocked || (result.src && /^data:image\/svg\+xml;base64,/.test(result.src))) {
          offerExtensionImageLoad(entry.image, entry.destination, stale);
        } else if (result.src) {
          entry.image.referrerPolicy = 'no-referrer';
          entry.image.src = result.src;
        }
      } catch {}
    }
  }
  function rawView(node, editor, getPos) {
    if (node.attrs.kind === 'source-edit') {
      const dom = document.createElement('pre'); dom.className = 'folio-source-edit';
      // The card stands in for the block it replaced, so it inherits that
      // block's vertical margins. Re-applied on every mount/update because
      // ProseMirror may rebuild the node view.
      const applyMargins = () => {
        if (!sourceCardMargins) return;
        dom.style.marginTop = sourceCardMargins.top;
        dom.style.marginBottom = sourceCardMargins.bottom;
      };
      applyMargins();
      const contentDOM = document.createElement('code'); dom.append(contentDOM);
      return { dom, contentDOM, update(next) { if (next.type !== node.type || next.attrs.kind !== 'source-edit') return false; applyMargins(); return true; } };
    }
    const dom = document.createElement('section'); dom.className = 'extension-block';
    // Assert editability up front: ProseMirror marks atom DOM non-editable when
    // the attribute is absent, which would make the projection an atomic
    // island that reading selections cannot cross. The projection stays part
    // of the editable surface so selections can natively span rendered text
    // across block boundaries; input is blocked below because the DOM is a
    // sanitized rendering, not the document. Under Lock the whole editor
    // (including this block) is uniformly non-editable, so selections span
    // the same way; the guard below keeps working in both modes.
    const syncEditability = () => {
      try { dom.contentEditable = String(!options.isUserLocked()); } catch {}
    };
    syncEditability();
    const projection = document.createElement('div'); projection.className = 'extension-preview';
    // The projection is part of the editable surface so reading selections
    // can natively span rendered text across block boundaries. Input is
    // blocked here: the DOM is a sanitized rendering, not the document, and
    // the literal Markdown lives solely in the explicit source presentation.
    const guardMutation = event => { event.preventDefault(); };
    projection.addEventListener('beforeinput', guardMutation);
    projection.addEventListener('drop', guardMutation);
    projection.addEventListener('dragstart', guardMutation);
    // A drag entering from outside the editor never saw a mousedown, so arm
    // the guard here as a backstop; in-editor drags are guarded centrally.
    projection.addEventListener('mousemove', event => { if (event.buttons & 1) setSelectionGuarded(true); });
    projection.tabIndex = options.isLocked() ? -1 : 0;
    projection.title = 'Right-click to edit Markdown';
    projection.addEventListener('keydown', event => {
      if (event.target !== projection || !['Enter', 'F2'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (revealSourceBlock(dom)) { event.preventDefault(); event.stopPropagation(); }
    });
    dom.append(projection);
    let generation = 0;
    let mountedSource = null;
    function invalidateTasks() {
      mountedSource = null;
      projection.querySelectorAll('input[type="checkbox"]').forEach(box => { box.disabled = true; });
    }
    // The raw node's ledger owner is the only accepted anchor. Both the node
    // text and the live model source must agree on the exact byte slice before
    // any checkbox is enabled; a stale projection or a remapped ledger fails
    // closed and leaves the native disabled state in place.
    function sourceFrame() {
      let pos = null;
      try { pos = getPos(); } catch { return null; }
      if (pos == null) return null;
      let ledger = model.ledger;
      if (!ledger) {
        // Structural edits can leave the attached ledger lazy. Rebuild it from
        // the exact source/document pair; never fall back to text search.
        try { ledger = model.ledger = buildLedger(model.source, model.doc, { segments: model.segments }); }
        catch { return null; }
      }
      const owner = ledger?.owners?.find(entry => entry.pmFrom === pos && entry.type === 'raw_block');
      if (!owner || owner.confidence !== 'exact' || owner.supported === false) return null;
      if (!Number.isInteger(owner.sourceFrom) || !Number.isInteger(owner.sourceTo)) return null;
      if (owner.sourceFrom < 0 || owner.sourceTo > model.source.length || owner.sourceFrom > owner.sourceTo) return null;
      // The ledger ends a raw owner at the next block boundary, so it may
      // include the blank separator after the literal node text. Compare the
      // node's own length and keep that as the mapping boundary.
      const to = owner.sourceFrom + node.textContent.length;
      if (to > owner.sourceTo) return null;
      if (model.source.slice(owner.sourceFrom, to) !== node.textContent) return null;
      return { from: owner.sourceFrom, to };
    }
    function taskFrame() {
      const frame = sourceFrame();
      if (!frame) return null;
      // renderExtension selects the projection by the first occurrence of this
      // literal. If an identical raw slice appears earlier, the rendered
      // controls do not provably belong to this node, so disable them.
      if (model.source.indexOf(node.textContent) !== frame.from) return null;
      return frame;
    }
    function taskMarkerAt(index) {
      if (mountedSource !== node.textContent) return null;
      const frame = taskFrame();
      if (!frame) return null;
      const markers = rawTaskMarkers(model.source.slice(frame.from, frame.to));
      if (!markers || !Number.isInteger(index) || index < 0 || index >= markers.length) return null;
      const marker = markers[index];
      const offset = frame.from + marker.offset;
      if (offset <= frame.from || offset + 1 >= frame.to) return null;
      if (model.source[offset - 1] !== '[' || model.source[offset + 1] !== ']') return null;
      if (!RAW_TASK_MARKER.test(model.source[offset])) return null;
      if ((model.source[offset] !== ' ') !== marker.checked) return null;
      return { offset, checked: marker.checked };
    }
    const boundTaskControls = new WeakSet();
    function toggleRawTask(checkbox, index) {
      if (options.isLocked()) { checkbox.checked = !checkbox.checked; return; }
      const marker = taskMarkerAt(index);
      if (!marker) { checkbox.checked = !checkbox.checked; return; }
      const wanted = Boolean(checkbox.checked);
      if (wanted === marker.checked) { checkbox.checked = marker.checked; return; }
      // Only the marker character changes. The source-first commit reparses
      // and refuses the transaction if the result cannot be represented
      // exactly; restore the control instead of leaving a lying checkbox.
      const outcome = replaceLogicalSelection(wanted ? 'x' : ' ', 'task', { from: marker.offset, to: marker.offset + 1, all: false, collapsed: false });
      if (!outcome.committed) checkbox.checked = marker.checked;
    }
    function syncTaskControls() {
      const boxes = [...projection.querySelectorAll('input[type="checkbox"][data-task-index]')];
      if (!boxes.length) return;
      const frame = taskFrame();
      const markers = frame ? rawTaskMarkers(model.source.slice(frame.from, frame.to)) : null;
      // Rendered tasks and source task items must agree one-for-one. Anything
      // else (an extension the local tokenizer and Comrak disagree on, a
      // malformed projection, duplicate fragments) disables every box here.
      const safe = mountedSource === node.textContent && markers && markers.length === boxes.length ? markers : null;
      boxes.forEach((checkbox, index) => {
        checkbox.contentEditable = 'false';
        checkbox.__folioTaskIndex = index;
        checkbox.disabled = options.isLocked() || !safe;
        if (!safe) return;
        checkbox.setAttribute('aria-label', 'Toggle task');
        if (boundTaskControls.has(checkbox)) return;
        boundTaskControls.add(checkbox);
        checkbox.addEventListener('mousedown', event => event.preventDefault());
        checkbox.addEventListener('change', event => {
          event.stopPropagation();
          toggleRawTask(checkbox, checkbox.__folioTaskIndex);
        });
      });
    }
    const render = async () => {
      const current = ++generation;
      const source = node.textContent;
      projection.title = 'Right-click to edit Markdown';
      invalidateTasks();
      try {
        const html = await options.renderExtension(source);
        if (generation === current && source === node.textContent && dom.isConnected) {
          projection.innerHTML = html;
          if (!projection.hasChildNodes()) projection.textContent = /^---\r?\n/.test(source) ? 'Front matter' : 'Markdown block';
          mountedSource = source; syncTaskControls();
          void mountAuthorImages(source, projection, () => generation !== current || !dom.isConnected);
        }
      }
      catch { if (current === generation) projection.textContent = 'Rendered view unavailable. Right-click to edit Markdown.'; }
    };
    let lastRemote = options.remoteImages();
    const refresh = () => {
      const remote = options.remoteImages();
      if (remote !== lastRemote) {
        lastRemote = remote; generation++; invalidateTasks();
        if (!remote) projection.querySelectorAll('img').forEach(img => { img.removeAttribute('srcset'); img.removeAttribute('src'); });
      }
      projection.tabIndex = options.isLocked() ? -1 : 0;
      syncEditability(); syncTaskControls(); Promise.resolve().then(render);
    };
    refreshers.add(refresh); refresh();
    const removeListeners = () => { refreshers.delete(refresh); };
    // The context menu reveals literal Markdown in the shared editor. Task
    // checkboxes commit only their verified source marker.
    return { dom, update(next) { if (next.type !== node.type || next.attrs.kind === 'source-edit') return false; const same = next.sameMarkup(node) && next.textContent === node.textContent; if (!same) { generation++; invalidateTasks(); } node = next; if (!same) Promise.resolve().then(render); return true; }, ignoreMutation: () => true, stopEvent: event => event.target.closest?.('button, input[type="checkbox"]') != null, destroy() { generation++; removeListeners(); } };
  }
  const safeDestination = value => {
    const destination = String(value || '');
    if (!destination || /[\u0000-\u001f\u007f]/.test(destination) || /^(?:javascript|data|vbscript|file):/i.test(destination)) return null;
    return destination;
  };
  function dividerTransaction(state, start, end) {
    const $from = state.doc.resolve(start);
    if ($from.parent.type !== schema.nodes.paragraph || $from.parentOffset !== 0 || $from.parent.content.size !== end - start) return null;
    const before = start - 1;
    const tr = state.tr.replaceWith(before, end, Fragment.fromArray([schema.nodes.horizontal_rule.create(), schema.nodes.paragraph.create()]));
    return tr.setSelection(TextSelection.create(tr.doc, before + 2));
  }
  function completeDivider(state, dispatch) {
    const { $from, empty } = state.selection;
    if (!empty || $from.parent.type !== schema.nodes.paragraph || $from.parentOffset !== $from.parent.content.size) return false;
    if ($from.marks().some(mark => mark.type.spec.code)) return false;
    if (!/^(?:---|___|\*\*\*)$/.test($from.parent.textContent)) return false;
    if (dispatch) dispatch(dividerTransaction(state, $from.start(), $from.pos));
    return true;
  }
  // Bounded table Enter: never delete a Tab-selected cell value, never trap
  // keyboard users, and never split a second paragraph inside a cell.
  // - CellSelection, cross-cell ranges, and full-cell Tab selections collapse
  //   into the focused cell for editing without deleting existing content.
  // - Collapsed Enter at the end of the last cell adds a row and moves into
  //   its first cell (the agreed tentative semantics).
  // - Any other collapsed Enter inserts an editable hard break, which the
  //   Markdown table serializer keeps as `<br>` (not a second `<p>` block).
  function tableEnter(state, dispatch, view) {
    if (!isInTable(state)) return false;
    const selection = state.selection;
    if (selection instanceof CellSelection) {
      if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, selection.head)).scrollIntoView());
      return true;
    }
    if (!(selection instanceof TextSelection)) return false;
    const $from = selection.$from;
    const $cellPos = cellAround($from);
    if (!$cellPos) return false;
    const $cellTo = cellAround(selection.$to);
    if (!$cellTo || $cellTo.pos !== $cellPos.pos) {
      // Only a Tab-generated cell selection collapses into its target. An
      // ordinary cross-cell text selection is left to the source-first
      // selection handler or ProseMirror's normal deletion.
      if (!isTabCellSelection(selection)) return false;
      if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, selection.head)).scrollIntoView());
      return true;
    }
    const locked = options.isLocked();
    if (!selection.empty) {
      const cell = $cellPos.nodeAfter;
      // Tab provenance, not range extent alone, identifies the special
      // full-cell selection created by goToNextCell.
      if (isTabCellSelection(selection) && cell && cell.childCount === 1 && selection.$from.parent === selection.$to.parent
        && selection.$from.parentOffset === 0
        && selection.$to.parentOffset === selection.$to.parent.content.size) {
        if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, selection.head)).scrollIntoView());
        return true;
      }
      if (locked) return true;
      if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
      return true;
    }
    if (locked) return true;
    const cell = $cellPos.nodeAfter;
    if (cell && $from.pos >= $cellPos.pos + cell.nodeSize - 2
      && nextCell($cellPos, 'horiz', 1) == null && nextCell($cellPos, 'vert', 1) == null) {
      if (dispatch) {
        const added = addRowAfter(state, dispatch, view);
        if (added && view) goToNextCell(1)(view.state, view.dispatch, view);
      }
      return true;
    }
    if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
    return true;
  }
  // Keyboard exit for tables so Tab/Enter can never trap focus inside the
  // grid. Mod-Enter continues into the following paragraph (creating one
  // when the table ends the document); Shift-Mod-Enter continues into the
  // preceding paragraph. Pure navigation never mutates content under Lock.
  function exitTableForward(state, dispatch) {
    const $from = state.selection.$from;
    let tableDepth = -1;
    for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.spec.tableRole === 'table') { tableDepth = depth; break; }
    if (tableDepth < 0) return false;
    if (!dispatch) return true;
    const tableEnd = $from.after(tableDepth);
    if (tableEnd >= state.doc.content.size) {
      if (options.isLocked()) return true;
      const tr = state.tr.insert(tableEnd, schema.nodes.paragraph.create());
      dispatch(tr.setSelection(TextSelection.create(tr.doc, tableEnd + 1)).scrollIntoView());
    } else {
      dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(tableEnd), 1)).scrollIntoView());
    }
    return true;
  }
  function exitTableBackward(state, dispatch) {
    const $from = state.selection.$from;
    let tableDepth = -1;
    for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.spec.tableRole === 'table') { tableDepth = depth; break; }
    if (tableDepth < 0) return false;
    if (!dispatch) return true;
    const tableStart = $from.before(tableDepth);
    if (tableStart <= 0) {
      if (options.isLocked()) return true;
      const tr = state.tr.insert(0, schema.nodes.paragraph.create());
      dispatch(tr.setSelection(TextSelection.create(tr.doc, 1)).scrollIntoView());
    } else {
      dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(tableStart), -1)).scrollIntoView());
    }
    return true;
  }
  // Explicit Tab provenance for the full-cell selection created by
  // goToNextCell. Downstream Enter handling must not infer this from range
  // extent: an ordinary user selection can cover the same extent.
  function tabCell(direction) {
    return (state, dispatch, view) => goToNextCell(direction)(state, dispatch
      ? transaction => { transaction.setMeta('folio-tab-cell', true); dispatch(transaction); }
      : undefined, view);
  }
  function indentSelection(editor, backward) {
    if (options.isLocked()) return false;
    const { $from, $to } = editor.state.selection;
    const source = $from.parent.attrs.kind === 'source-edit' || $to.parent.attrs.kind === 'source-edit';
    if (!source) {
      // Tables navigate cells and rendered lists use structural nesting.
      if (isInTable(editor.state)) return false;
      for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type === schema.nodes.list_item) return false;
      if (!$from.parent.inlineContent) return false;
    }
    const selection = sourceSelection(editor.state);
    const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head);
    if (!backward && from === to) {
      // Tab stops every four columns, including existing literal tabs.
      const lineStart = model.source.lastIndexOf('\n', from - 1) + 1;
      let column = 0;
      for (const character of model.source.slice(lineStart, from)) column += character === '\t' ? 4 - column % 4 : 1;
      return replaceLogicalSelection(' '.repeat(4 - column % 4), 'command', { from, to, all: false }).handled;
    }
    const start = model.source.lastIndexOf('\n', from - 1) + 1;
    // A selection ending at the next line's start excludes that line.
    const last = to > from && model.source[to - 1] === '\n' ? to - 1 : to;
    const newline = model.source.indexOf('\n', last);
    const end = newline < 0 ? model.source.length : newline;
    const lines = model.source.slice(start, end).split('\n');
    const patches = []; let offset = start;
    const insert = lines.map(line => {
      const remove = backward ? (line.startsWith('\t') ? 1 : (/^ {1,4}/.exec(line)?.[0].length || 0)) : 0;
      const prefix = backward ? '' : '    ';
      if (remove || prefix) patches.push({ from: offset, to: offset + remove, length: prefix.length });
      offset += line.length + 1;
      return prefix + line.slice(remove);
    }).join('\n');
    if (!patches.length) return true;
    const map = position => position - start + patches.reduce((delta, patch) => {
      if (position < patch.from) return delta;
      return delta + patch.length - Math.min(position - patch.from, patch.to - patch.from);
    }, 0);
    return replaceLogicalSelection(insert, 'command', { from: start, to: end, all: false }, { anchor: map(selection.anchor), head: map(selection.head) }).handled;
  }
  function deleteLogical(backward) {
    return (state, dispatch) => {
      if (bookmarkRange(state) && !bookmark.all && bookmark.anchor === bookmark.head) {
        if (!dispatch) return true;
        if (options.isLocked()) return true;
        const unit = graphemeUnit(model.source, bookmark.anchor, backward);
        if (!unit) return true;
        return replaceLogicalSelection('', 'delete', unit).handled;
      }
      const range = logicalRange(state);
      if (!range || range.collapsed) return false;
      if (!dispatch) return true;
      if (options.isLocked()) return true;
      if (crossesTableCells(state)) {
        options.message?.('Deleting across table cells is not supported. Edit within one cell.');
        return true;
      }
      return replaceLogicalSelection('', 'delete', range).handled;
    };
  }
  // A fence typed as a complete paragraph (` ```js `) becomes a code block on
  // Enter. Without this, the paragraph serializer escaped the backticks and a
  // natural "fence, language, Enter, code" flow produced a literal paragraph.
  function enterFence(state, dispatch) {
    if (!(state.selection instanceof TextSelection) || !state.selection.empty) return false;
    const $from = state.selection.$from;
    if ($from.parent.type !== schema.nodes.paragraph || $from.depth !== 1) return false;
    const match = /^(```+|~~~+)([\w-]*)$/.exec($from.parent.textContent);
    if (!match) return false;
    if (!dispatch) return true;
    if (options.isLocked()) return true;
    const from = $from.before(1), to = $from.after(1);
    const block = schema.nodes.code_block.create({ params: match[2] || '' });
    const paragraph = schema.nodes.paragraph.create();
    let tr;
    try {
      tr = state.tr.replaceWith(from, to, Fragment.fromArray([block, paragraph]));
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(from + 1), 1));
    } catch { return false; }
    dispatch(tr.scrollIntoView());
    return true;
  }
  function enterLogical(state, dispatch) {
    if (isTabCellSelection(state.selection)) return false;
    const range = logicalRange(state);
    if (!range || range.collapsed) return false;
    if (!dispatch) return true;
    if (options.isLocked()) return true;
    return replaceLogicalSelection('\n', 'enter', range).handled;
  }
  // Shift+Enter is a soft line break, not a block split. ProseMirror's base
  // keymap has no binding for it, so without this it silently does nothing.
  // Code blocks keep their native newline behavior; all other textblocks get a
  // schema hard_break, which serializes as backslash-newline (or <br> in cells).
  function insertSoftBreak(state, dispatch) {
    if (!(state.selection instanceof TextSelection)) return false;
    const $from = state.selection.$from;
    if ($from.parent.type.spec.code) return baseKeymap.Enter(state, dispatch);
    if (!dispatch) return true;
    if (options.isLocked()) return true;
    dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
    return true;
  }
  function selectAllLogical(state, dispatch, view) {
    if (!dispatch) return true;
    setSelectionGuarded(false);
    const tr = state.tr.setSelection(new AllSelection(state.doc)).setMeta('folio-projection', true);
    dispatch(tr);
    setBookmark(0, model.source.length, view?.state || state, true);
    return true;
  }
  const rules = [
    new InputRule(/(?<!\\)!\[([^\]\n]*)\]\(([^()\s\n]+)\)$/, (state, match, start, end) => {
      const src = safeDestination(match[2]); if (!src) return null;
      const tr = state.tr.replaceWith(start, end, schema.nodes.image.create({ src, alt: match[1], title: '' }));
      return tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tr.doc.content.size, start + 1)), 1));
    }, { inCodeMark: false }),
    new InputRule(/(?<!\\)(?<!!)\[([^\[\]\n]+)\]\(([^()\s\n]+)\)$/, (state, match, start, end) => {
      const href = safeDestination(match[2]); if (!href) return null;
      return state.tr.insertText(match[1], start, end).addMark(start, start + match[1].length, schema.marks.link.create({ href })).removeStoredMark(schema.marks.link);
    }, { inCodeMark: false }),
    new InputRule(/^(?:---|___|\*\*\*)\s$/, (state, match, start, end) => dividerTransaction(state, start, end), { inCodeMark: false }),
    ...[
      [/\*\*([^*\n]+)\*\*$/, 'strong'], [/__([^_\n]+)__$/, 'strong'],
      // Do not let the second opening star of `**hello` start an em run when
      // only the first closing star has been typed.
      [/(?:(?<=\*\*)|(?<!\*))\*([^*\n]+)\*$/, 'em'],
      [/`([^`\n]+)`$/, 'code'], [/~~([^~\n]+)~~$/, 'strike']
    ].map(([pattern, mark]) => new InputRule(pattern, (state, match, start, end) => {
      // CommonMark does not treat space-flanked delimiters as emphasis. The
      // regex alone turned `2 * 3 * 4` into `2  *3*  4`; require the value to
      // touch its delimiters before converting. Inline code keeps spaces.
      if (mark !== 'code' && (!match[1] || /^\s|\s$/.test(match[1]))) return null;
      return state.tr.insertText(match[1], start, end).addMark(start, start + match[1].length, schema.marks[mark].create()).removeStoredMark(schema.marks[mark]);
    })),
    new InputRule(/\$([^$\n]+)\$$/, (state, match, start, end) => state.tr.replaceWith(start, end, schema.nodes.math_inline.create({ tex: match[1] }))),
    wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
    wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list, match => ({ bullet: match[1], tight: true })),
    wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list, match => ({ order: +match[1], tight: true })),
    textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, match => ({ level: match[1].length })),
    textblockTypeInputRule(/^```([\w-]*)\s$/, schema.nodes.code_block, match => ({ params: match[1] })),
    new InputRule(/^\[([ xX])\]\s$/, (state, match, start, end) => {
      const $from = state.doc.resolve(start);
      for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type === schema.nodes.list_item) return state.tr.delete(start, end).setNodeMarkup($from.before(depth), null, { checked: match[1] !== ' ' });
      return null;
    })
  ];
  function stateFor(doc, selection) {
    return EditorState.create({ doc, selection: selection ? selectionAt(doc, sourceToRich(model, selection.anchor), sourceToRich(model, selection.head)) : undefined, plugins: [
      // A projection-only input gives the document a writable tail without
      // inserting an empty paragraph (and changing the file) on open or focus.
      new Plugin({ props: { decorations(state) {
        const widgets = [];
        // The trailing strip is an invisible click target: the page ends
        // calmly and no UI copy sits in the reading column. The hint below
        // appears only while the caret is on the empty final line.
        widgets.push(Decoration.widget(state.doc.content.size, () => {
          const input = document.createElement('button');
          input.type = 'button'; input.className = 'editor-trailing-input';
          input.tabIndex = -1;
          input.setAttribute('aria-label', 'Write a new paragraph at the end of the document');
          const refresh = () => { input.disabled = options.isLocked(); };
          input.folioRefresh = refresh; refreshers.add(refresh); refresh();
          input.addEventListener('click', () => {
            if (options.isLocked()) return;
            pendingTail = true;
            const paragraph = schema.nodes.paragraph.create();
            const pos = model.doc.content.size;
            const doc = model.doc.copy(model.doc.content.append(schema.nodes.doc.create(null, paragraph).content));
            model = { ...model, doc, ledger: null, segments: [...model.segments, { node: paragraph, from: model.source.length, to: model.source.length, raw: '' }] };
            view.updateState(stateFor(doc));
            view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, pos + 1)));
            view.focus();
          });
          return input;
        }, { side: 1, stopEvent: () => true, destroy: node => refreshers.delete(node.folioRefresh) }));
        const { selection } = state;
        const emptyDocument = state.doc.childCount === 1 && state.doc.firstChild?.type === schema.nodes.paragraph && state.doc.firstChild.content.size === 0;
        if (!options.isLocked() && !emptyDocument && selection.empty && selection.$from.depth === 1
            && selection.$from.parent.type === schema.nodes.paragraph
            && selection.$from.parent.content.size === 0
            && selection.$from.index(0) === state.doc.childCount - 1) {
          widgets.push(Decoration.widget(selection.$from.before(1) + 1, () => {
            const hint = document.createElement('span');
            hint.className = 'folio-empty-hint'; hint.contentEditable = 'false';
            hint.setAttribute('aria-hidden', 'true');
            const key = document.createElement('span'); key.className = 'folio-empty-hint-key'; key.textContent = '/';
            const label = document.createElement('span'); label.textContent = 'Type for blocks…';
            hint.append(key, label);
            return hint;
          }, { side: 1 }));
        }
        return DecorationSet.create(state.doc, widgets);
      } } }),
      // A locked transition must also reject transactions that only set
      // stored marks (for example Ctrl+B at an empty selection). Otherwise the
      // mark survives the rejected open and bolds the user's next typing.
      new Plugin({ filterTransaction: tr => !options.isLocked() || (!tr.docChanged && !tr.storedMarksSet) }),
      new Plugin({
        // Public table repair policy replaces stock tableEditing's drag and
        // normalization behavior while keeping TableView/schema/commands.
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some(transaction => transaction.docChanged)) return null;
          return fixTables(newState, oldState);
        }
      }),
      inputRules({ rules: rules.map(rule => new InputRule(rule.match, (state, match, start, end) => state.selection.$from.parent.attrs.kind === 'source-edit' ? null : rule.handler(state, match, start, end))) }),
      keymap({
        'Mod-b': toggleMark(schema.marks.strong), 'Mod-i': toggleMark(schema.marks.em), 'Mod-`': toggleMark(schema.marks.code),
        'Mod-a': selectAllLogical, 'F2': () => focusHeadingMarker(),
        Backspace: deleteLogical(true), Delete: deleteLogical(false),
        'Shift-Enter': insertSoftBreak,
        Enter: chainCommands(enterFence, enterLogical, tableEnter, completeDivider, splitListItem(schema.nodes.list_item), baseKeymap.Enter),
        Tab: chainCommands(tabCell(1), sinkListItem(schema.nodes.list_item)), 'Shift-Tab': chainCommands(tabCell(-1), liftListItem(schema.nodes.list_item)),
        'Mod-Enter': chainCommands(exitTableForward, exitCode),
        'Shift-Mod-Enter': exitTableBackward
      }), keymap(baseKeymap)
    ] });
  }
  // Force-sync a just-clicked native caret/range into ProseMirror state via
  // the same public posAtDOM behavior as the shell's pre-toggle capture.
  // Keyboard commands (Enter/Tab/Mod-Enter) must see the click target, not a
  // stale selection left over from an async selectionchange read. Pure
  // selection sync: NodeSelection/CellSelection projections are preserved,
  // only a plain inline text range that differs replaces the selection.
  function captureDOMSelection() {
    if (!view) return;
    // A valid source bookmark is the authoritative logical selection. Toggling
    // to the source presentation must not replace it with a DOM position that
    // has already been normalized through the non-injective projection.
    if (bookmarkRange(view.state)) return;
    if (isTabCellSelection(view.state.selection)) return;
    const dom = window.getSelection();
    if (!dom || dom.rangeCount !== 1 || !dom.anchorNode || !dom.focusNode) return;
    if (!view.dom.contains(dom.anchorNode) || !view.dom.contains(dom.focusNode)) return;
    let anchor, head;
    try {
      anchor = view.posAtDOM(dom.anchorNode, dom.anchorOffset, 1);
      head = view.posAtDOM(dom.focusNode, dom.focusOffset, dom.isCollapsed ? 1 : -1);
    } catch { return; }
    const doc = view.state.doc, current = view.state.selection;
    const $anchor = doc.resolve(anchor), $head = doc.resolve(head);
    if (!$anchor.parent.inlineContent || !$head.parent.inlineContent) return;
    // A native caret/range can be the DOM projection of a cell or node
    // selection. Only replace that selection when the DOM range is a plain
    // inline text range that differs from the selection it represents.
    if (!(current instanceof TextSelection) && current.anchor === anchor && current.head === head) return;
    const next = TextSelection.between($anchor, $head);
    if (current.eq(next)) return;
    view.dispatch(view.state.tr.setSelection(next));
  }
  function currentContext(state) {
    const $from = state.selection.$from;
    let heading = null;
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type === schema.nodes.heading) {
        heading = { pos: $from.before(depth), level: $from.node(depth).attrs.level };
        break;
      }
    }
    const activeMarks = state.storedMarks || $from.marks();
    const marks = ['strong', 'em', 'code'].filter(name => activeMarks.some(mark => mark.type === schema.marks[name]));
    if (!marks.length && !state.selection.empty) {
      for (const name of ['strong', 'em', 'code']) if (state.doc.rangeHasMark(state.selection.from, state.selection.to, schema.marks[name])) marks.push(name);
    }
    return { table: isInTable(state), heading, code: $from.parent.type.spec.code === true, marks };
  }
  let activePopup = null;
  function closePopup(restore = false) {
    if (!activePopup) return;
    const { menu, trigger, cleanup } = activePopup; activePopup = null;
    cleanup?.();
    trigger?.setAttribute('aria-expanded', 'false'); menu.remove();
    if (restore) trigger?.focus();
  }
  function positionPopup(menu, rect) {
    document.body.append(menu);
    const width = menu.offsetWidth, height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8))}px`;
  }
  function focusHeadingMarker() {
    const dom = view.domAtPos(view.state.selection.head).node;
    return revealSourceBlock(dom instanceof Element ? dom : dom.parentElement);
  }
  function openSlashMenu(trigger) {
    if (options.isLocked()) return;
    closePopup();
    const initial = sourceSelection(view.state);
    const start = initial.head - 1;
    if (initial.anchor !== initial.head || model.source.slice(start, initial.head) !== '/') return;
    const menu = document.createElement('div'); menu.className = 'folio-slash-menu';
    menu.id = 'folio-block-suggestions';
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', 'Insert block');
    const head = document.createElement('div'); head.className = 'folio-slash-head';
    const title = document.createElement('span'); title.className = 'folio-slash-title'; title.textContent = 'Insert block';
    const key = document.createElement('span'); key.className = 'folio-slash-key'; key.textContent = 'esc';
    head.append(title, key); head.setAttribute('aria-hidden', 'true');
    const list = document.createElement('div'); list.className = 'folio-slash-list';
    const submenu = document.createElement('div'); submenu.className = 'folio-slash-submenu';
    submenu.id = 'folio-block-submenu'; submenu.setAttribute('role', 'listbox'); submenu.hidden = true;
    const subhead = document.createElement('div'); subhead.className = 'folio-slash-subhead';
    const back = document.createElement('button');
    back.type = 'button'; back.className = 'folio-slash-back'; back.hidden = true;
    back.setAttribute('aria-label', 'Back to blocks');
    back.innerHTML = `<svg ${SLASH_ICON_SVG}><path d="m15 6-6 6 6 6"/></svg>`;
    const subtitle = document.createElement('span'); subtitle.className = 'folio-slash-subtitle';
    subtitle.setAttribute('aria-hidden', 'true');
    subhead.append(back, subtitle);
    const sublist = document.createElement('div'); sublist.className = 'folio-slash-sublist';
    submenu.append(subhead, sublist);
    menu.append(head, list, submenu);
    let active = 0, activeSub = 0, openIndex = -1, focusArea = 'root';
    let displayed = SLASH_BLOCKS, filtered = false, lastQuery = '';
    let hoverTimer = 0, closeTimer = 0;
    const mode = { menu, trigger, update: renderRoot, keydown, cleanup };

    function slashContext() {
      const selection = sourceSelection(view.state);
      if (!selection || selection.anchor !== selection.head) return null;
      const position = selection.head;
      if (position < start + 1 || model.source[start] !== '/') return null;
      if (model.source.lastIndexOf('\n', start - 1) + 1 !== start) return null;
      const text = model.source.slice(start, position);
      if (/[\r\n]/.test(text)) return null;
      const { $from } = view.state.selection;
      // The picker inserts top-level block Markdown, so it only belongs on a
      // top-level empty paragraph; a list item or quote line has its own block
      // context where the same snippet would be wrong.
      if ($from.depth !== 1 || $from.parent.type !== schema.nodes.paragraph) return null;
      return { head: position, query: text.slice(1) };
    }
    function matchesQuery(item, query) {
      return `${item.label} ${item.keywords || ''} ${item.meta || ''}`.toLowerCase().includes(query);
    }
    function iconFor(item) {
      const icon = document.createElement('span'); icon.className = 'folio-slash-icon'; icon.setAttribute('aria-hidden', 'true');
      if (item.badge) { icon.classList.add('folio-slash-badge'); icon.textContent = item.badge; }
      else icon.innerHTML = `<svg ${SLASH_ICON_SVG}>${SLASH_ICON_BODY[item.icon] || SLASH_ICON_BODY.more}</svg>`;
      return icon;
    }
    function chevron() {
      const mark = document.createElement('span'); mark.className = 'folio-slash-chevron'; mark.setAttribute('aria-hidden', 'true');
      mark.innerHTML = `<svg ${SLASH_ICON_SVG}><path d="m9 6 6 6-6 6"/></svg>`;
      return mark;
    }
    function choose(item) {
      const context = slashContext();
      if (!context) { closePopup(); return; }
      const snippet = item.snippet || '';
      const next = item.select
        ? { anchor: item.select[0], head: item.select[1] }
        : { anchor: snippet.length, head: snippet.length };
      closePopup();
      const outcome = replaceLogicalSelection(snippet, 'command',
        { from: start, to: context.head, all: false, collapsed: context.head === start + 1 }, next);
      if (!outcome.committed) options.message?.('This block could not be inserted into the Markdown source.');
      try { view.focus(); } catch {}
    }
    function rowFor(item, index, isSub) {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'folio-slash-row';
      row.dataset.slashIndex = String(index);
      row.id = isSub ? `folio-block-sub-option-${index}` : `folio-block-option-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.append(iconFor(item));
      const label = document.createElement('span'); label.className = 'folio-slash-label'; label.textContent = item.label;
      row.append(label);
      if (item.meta) {
        const meta = document.createElement('span'); meta.className = 'folio-slash-meta'; meta.textContent = item.meta;
        meta.setAttribute('aria-hidden', 'true');
        row.append(meta);
      }
      if (item.children) {
        row.setAttribute('aria-haspopup', 'listbox');
        row.setAttribute('aria-expanded', 'false');
        row.append(chevron());
      }
      row.addEventListener('mousedown', event => event.preventDefault());
      if (isSub) {
        row.addEventListener('pointerenter', () => {
          cancelClose(); focusArea = 'sub'; activeSub = index; paint();
        });
        row.addEventListener('click', () => choose(item));
      } else {
        row.addEventListener('pointerenter', () => {
          cancelClose();
          focusArea = 'root'; active = index;
          if (openIndex >= 0 && openIndex !== index) closeSub();
          if (item.children && openIndex !== index) scheduleOpen(index);
          paint();
        });
        row.addEventListener('click', () => {
          if (item.children) {
            if (openIndex === index && focusArea === 'sub') closeSub();
            else openSub(index, true);
            paint();
          } else choose(item);
        });
      }
      return row;
    }
    function activeRow() {
      return focusArea === 'sub' && openIndex >= 0 ? sublist.children[activeSub] : list.children[active];
    }
    function paint() {
      for (const row of list.querySelectorAll(':scope > button')) {
        const index = Number(row.dataset.slashIndex);
        row.setAttribute('aria-selected', String(index === active));
        if (row.hasAttribute('aria-haspopup')) row.setAttribute('aria-expanded', String(!filtered && index === openIndex));
      }
      for (const row of sublist.querySelectorAll(':scope > button')) {
        const index = Number(row.dataset.slashIndex);
        row.setAttribute('aria-selected', String(focusArea === 'sub' && index === activeSub));
      }
      const current = focusArea === 'sub' && openIndex >= 0
        ? `folio-block-sub-option-${activeSub}` : `folio-block-option-${active}`;
      trigger.setAttribute('aria-activedescendant', current);
    }
    function cancelClose() { clearTimeout(closeTimer); closeTimer = 0; }
    function scheduleClose() {
      cancelClose();
      closeTimer = setTimeout(() => {
        closeTimer = 0;
        if (!activePopup) return;
        exitSub();
      }, 160);
    }
    function closeSub() {
      clearTimeout(hoverTimer); hoverTimer = 0;
      if (openIndex >= 0) {
        const row = list.querySelector(`:scope > button[data-slash-index="${openIndex}"]`);
        row?.setAttribute('aria-expanded', 'false');
      }
      openIndex = -1;
      submenu.hidden = true;
      sublist.replaceChildren();
      submenu.classList.remove('open-left');
      submenu.style.top = '';
      menu.classList.remove('compact');
      back.hidden = true;
      focusArea = 'root';
    }
    function exitSub() {
      const parent = openIndex;
      closeSub(); active = Math.max(0, parent); paint();
      if (activePopup) place();
    }
    function positionSubmenu() {
      if (menu.classList.contains('compact')) return;
      const parentRow = list.querySelector(`:scope > button[data-slash-index="${openIndex}"]`);
      if (!parentRow) return;
      submenu.classList.remove('open-left');
      submenu.style.top = '0px';
      const menuRect = menu.getBoundingClientRect(), rowRect = parentRow.getBoundingClientRect();
      const subHeight = submenu.offsetHeight;
      const top = Math.max(6 - menuRect.top,
        Math.min(rowRect.top - menuRect.top - 5, window.innerHeight - 8 - menuRect.top - subHeight));
      submenu.style.top = `${Math.round(top)}px`;
      if (menuRect.left + menuRect.width - 4 + submenu.offsetWidth > window.innerWidth - 8) submenu.classList.add('open-left');
    }
    function renderSub() {
      const parent = displayed[openIndex];
      if (!parent?.children) { closeSub(); return; }
      subtitle.textContent = parent.title || parent.label;
      submenu.setAttribute('aria-label', `${parent.title || parent.label} blocks`);
      sublist.replaceChildren();
      parent.children.forEach((child, index) => sublist.append(rowFor(child, index, true)));
      submenu.hidden = false;
      positionSubmenu();
      const parentRow = list.querySelector(`:scope > button[data-slash-index="${openIndex}"]`);
      parentRow?.setAttribute('aria-expanded', 'true');
    }
    function openSub(index, focus) {
      if (!displayed[index]?.children) return;
      clearTimeout(hoverTimer); hoverTimer = 0;
      cancelClose();
      if (openIndex !== index) activeSub = 0;
      openIndex = index; active = index;
      if (focus) focusArea = 'sub';
      // A flyout needs room to the right of the picker. When it does not fit
      // (narrow windows, the app's 600px minimum), the submenu becomes an
      // in-place drill-down with a back row instead of leaving the viewport.
      const fits = menu.getBoundingClientRect().left + menu.offsetWidth + 236 <= window.innerWidth - 8;
      menu.classList.toggle('compact', !fits);
      back.hidden = fits;
      renderSub();
      if (!fits) place();
      paint();
      if (focus) activeRow()?.scrollIntoView({ block: 'nearest' });
    }
    function scheduleOpen(index) {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        hoverTimer = 0;
        if (!activePopup) return;
        if (!slashContext()) { closePopup(); return; }
        if (active !== index || openIndex === index) return;
        openSub(index, false);
      }, 90);
    }
    function place() {
      // Anchor to the slash itself, not the moving caret: filtering must not
      // drag the picker sideways with every typed character.
      let anchor;
      try { anchor = view.coordsAtPos(sourceToRich(model, start)); } catch { anchor = null; }
      if (!anchor) anchor = view.coordsAtPos(view.state.selection.from);
      const gap = 9, margin = 10;
      const width = menu.offsetWidth, height = menu.offsetHeight;
      const below = anchor.bottom + gap, above = anchor.top - gap - height;
      const useAbove = below + height > window.innerHeight - margin && above >= margin;
      const top = Math.max(margin, Math.min(useAbove ? above : below, window.innerHeight - margin - height));
      const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(top)}px`;
      menu.dataset.side = useAbove ? 'above' : 'below';
    }
    function renderRoot() {
      const context = slashContext();
      if (!context) { closePopup(); return; }
      const query = context.query.trim().toLowerCase();
      filtered = Boolean(query);
      displayed = filtered ? SLASH_LEAVES.filter(item => matchesQuery(item, query)) : SLASH_BLOCKS;
      if (filtered) closeSub();
      else if (openIndex >= 0 && !displayed[openIndex]?.children) closeSub();
      if (filtered && query !== lastQuery) { active = 0; activeSub = 0; }
      lastQuery = query;
      active = displayed.length ? Math.min(Math.max(0, active), displayed.length - 1) : 0;
      list.replaceChildren();
      if (!displayed.length) {
        // Keep the picker alive with an explicit empty state. Closing it here
        // meant a mistyped query silently removed the picker, and backspacing
        // could not bring it back.
        const empty = document.createElement('div');
        empty.className = 'folio-slash-empty';
        empty.setAttribute('role', 'status');
        empty.textContent = 'No blocks match';
        list.append(empty);
        title.textContent = 'Blocks';
        submenu.hidden = true;
        trigger.removeAttribute('aria-activedescendant');
        place();
        return;
      }
      displayed.forEach((item, index) => list.append(rowFor(item, index, false)));
      title.textContent = filtered ? 'Blocks' : 'Insert block';
      if (!filtered && openIndex >= 0) renderSub();
      else { submenu.hidden = true; }
      place();
      paint();
    }
    function onViewportChange(event) {
      if (event?.type === 'scroll' && menu.contains(event.target)) return;
      closePopup();
    }
    function cleanup() {
      clearTimeout(hoverTimer); clearTimeout(closeTimer); hoverTimer = 0; closeTimer = 0;
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('blur', onViewportChange);
      document.removeEventListener('scroll', onViewportChange, true);
      trigger.removeAttribute('aria-controls');
      trigger.removeAttribute('aria-activedescendant');
    }
    function keydown(event) {
      if (event.isComposing) return false;
      if (event.key === 'Escape') {
        if (openIndex >= 0) exitSub();
        else closePopup();
        return true;
      }
      if (event.key === 'Tab' || event.key === 'Home' || event.key === 'End'
          || event.key === 'PageUp' || event.key === 'PageDown') { closePopup(); return false; }
      if ((event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
          && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) {
        // Modified chords belong to editing/navigation, not the picker.
        closePopup(); return false;
      }
      if (event.key === 'ArrowRight') {
        if (focusArea === 'root' && displayed[active]?.children) { openSub(active, true); return true; }
        return false;
      }
      if (event.key === 'ArrowLeft') {
        if (focusArea === 'sub') { exitSub(); return true; }
        return false;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        if (focusArea === 'sub' && openIndex >= 0) {
          const children = displayed[openIndex]?.children || [];
          if (!children.length) return true;
          activeSub = (activeSub + delta + children.length) % children.length;
        } else {
          if (!displayed.length) return true;
          active = (active + delta + displayed.length) % displayed.length;
          if (openIndex >= 0 && openIndex !== active) closeSub();
        }
        paint(); activeRow()?.scrollIntoView({ block: 'nearest' });
        return true;
      }
      if (event.key === 'Enter') {
        if (focusArea === 'sub' && openIndex >= 0) {
          const child = displayed[openIndex]?.children?.[activeSub];
          if (child) choose(child);
          return true;
        }
        const item = displayed[active];
        if (!item) { closePopup(); return false; }
        if (item.children) openSub(active, true);
        else choose(item);
        return true;
      }
      return false;
    }
    back.addEventListener('mousedown', event => event.preventDefault());
    back.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); exitSub(); });
    submenu.addEventListener('pointerenter', cancelClose);
    submenu.addEventListener('pointerleave', scheduleClose);
    menu.addEventListener('pointerleave', scheduleClose);
    list.addEventListener('scroll', () => { if (openIndex >= 0 && !submenu.hidden) positionSubmenu(); }, { passive: true });
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('blur', onViewportChange);
    document.addEventListener('scroll', onViewportChange, true);
    trigger.setAttribute('aria-controls', menu.id);
    trigger.setAttribute('aria-expanded', 'true');
    document.body.append(menu);
    activePopup = mode;
    renderRoot();
  }
  function clearFormulaNodeSelection() {
    const selection = view.state.selection;
    if (!(selection instanceof NodeSelection) || !['math_block', 'math_inline'].includes(selection.node.type.name)) return false;
    const next = Selection.findFrom(view.state.doc.resolve(selection.to), 1, true)
      || Selection.findFrom(view.state.doc.resolve(selection.from), -1, true);
    if (next) view.dispatch(view.state.tr.setSelection(next));
    return true;
  }
  view = new EditorView(parent, {
    // Keep the view focusable during temporary transition protection; the
    // transaction filter below enforces the effective lock for document edits.
    state: stateFor(model.doc), editable: () => !options.isUserLocked(),
    attributes: () => ({ 'aria-label': 'Formatted Markdown editor', spellcheck: 'true', class: folioPaintActive ? 'folio-paint' : '' }),
    nodeViews: { list_item: listItem, image: imageView, math_inline: mathView, math_block: mathView, code_block: codeView, raw_block: rawView, raw_inline: rawInlineView, table: tableView },
    dispatchTransaction(tr) {
      const beforeSelection = sourceSelection(view.state);
      const tabMeta = tr.getMeta('folio-tab-cell');
      const commit = tr.getMeta('folio-source-commit');
      const result = view.state.applyTransaction(tr), changed = !result.state.doc.eq(view.state.doc);
      if (commit) {
        // Fail closed: an appendTransaction repair that changes the canonical
        // parse means the exact source splice cannot be represented. Keep the
        // previous model/view/source/bookmark/history and report the rejection
        // instead of re-serializing canonical source back through the schema.
        if (!result.state.doc.eq(commit.model.doc)) {
          commitOutcome = false;
          options.message('This edit could not be applied as an exact source change. The previous document is preserved.');
          return;
        }
        revision++;
        if (!model.sourceEdit && commit.sourceEdit?.from === 0 && commit.sourceEdit.to === model.source.length) {
          // Keep one parsed snapshot for undo of a whole-document replacement.
          fullReplacementUndoModel = model;
        }
        if (commit.sourceEdit) headingMetadata.splice(model, commit.model, commit.sourceEdit);
        else headingMetadata.reset();
        model = attachModel(commit.model, result.state.doc);
        view.updateState(result.state);
        options.onContext?.(currentContext(result.state));
        try { syncTableChrome(); } catch {}
        setBookmark(commit.selection.anchor, commit.selection.head, result.state);
        commitOutcome = true;
        options.onChange(model.source, sourceSelection(result.state), beforeSelection, commit.typing);
        activePopup?.update?.();
        return;
      }
      let nextModel = changed ? tryTextEdits(model, result.transactions, result.state.doc) || updateSource(result.state.doc, model) : model;
      if (changed && model.sourceEdit) nextModel.sourceEdit = { from: model.sourceEdit.from, to: model.sourceEdit.to + nextModel.source.length - model.source.length };
      if (changed && nextModel.source !== model.source) { revision++; bookmark = null; }
      if (changed) headingMetadata.map(result.transactions);
      model = nextModel;
      view.updateState(result.state);
      options.onContext?.(currentContext(result.state));
      try { syncTableChrome(); } catch {}
      if (tabMeta) tabSelection = { from: result.state.selection.from, to: result.state.selection.to, anchor: result.state.selection.anchor, head: result.state.selection.head };
      if (changed) {
        const typing = !tr.getMeta('folio-action') && tr.steps.every(step => { const json = step.toJSON(); return json.stepType === 'replace' && (!json.slice || json.slice.content?.every(node => node.type === 'text')); });
        options.onChange(model.source, sourceSelection(result.state), beforeSelection, typing);
      }
      activePopup?.update?.();
    },
    handleClickOn(editor, pos, node, nodePos, event, direct) {
      if (!direct || !['math_block', 'math_inline'].includes(node.type.name) || event.button !== 0
          || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
      clearFormulaNodeSelection();
      window.getSelection()?.removeAllRanges();
      syncFolioHighlight();
      return true;
    },
    handleKeyDown(editor, event) {
      if (event.isComposing) return false;
      // A guarded reading range is not in editor state. Adopt it before the
      // keymap runs so Delete/Backspace/typing replace the visible interval.
      // Modifier-only presses and copy/cut shortcuts keep the native range so
      // clipboard behavior is unchanged.
      const pressed = event.key.toLowerCase();
      const clipboardShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && (pressed === 'c' || pressed === 'x');
      if (selectionGuarded && !MODIFIER_KEYS.has(event.key) && !clipboardShortcut) resyncGuardedSelection();
      // A click can update the browser caret before ProseMirror observes its
      // selectionchange. Adopt it before source-edit keyboard commands run.
      if (model.sourceEdit) captureDOMSelection();
      if (event.key === 'Escape' && !model.sourceEdit && !activePopup && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        captureDOMSelection();
        const selection = editor.state.selection;
        if (!selection.empty || selection instanceof NodeSelection) {
          const head = editor.state.doc.resolve(selection.head);
          const caret = Selection.findFrom(head, 1, true) || Selection.findFrom(head, -1, true);
          if (caret) {
            releaseBookmark(); tabSelection = null;
            editor.dispatch(editor.state.tr.setSelection(caret));
            syncFolioHighlight();
            event.preventDefault(); return true;
          }
        }
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && pressed === 'a') {
        return selectAllLogical(editor.state, editor.dispatch, editor);
      }
      if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey && document.activeElement === editor.dom) {
        captureDOMSelection();
        if (indentSelection(editor, event.shiftKey)) { event.preventDefault(); return true; }
      }
      if (model.sourceEdit && (event.ctrlKey || event.metaKey) && event.shiftKey && ['Home', 'End'].includes(event.key)) {
        const edge = event.key === 'Home' ? 0 : editor.state.doc.content.size;
        editor.dispatch(editor.state.tr.setSelection(TextSelection.between(editor.state.selection.$anchor, editor.state.doc.resolve(edge))).scrollIntoView());
        event.preventDefault(); return true;
      }
      if (model.sourceEdit && !options.isLocked() && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const selection = sourceSelection(editor.state);
        let from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head);
        if (event.key === 'Escape') {
          model = parseSource(model.source); bookmark = null;
          editor.updateState(stateFor(model.doc, selection)); editor.focus(); event.preventDefault(); return true;
        }
        if (['Enter', 'Backspace', 'Delete'].includes(event.key)) {
          if (from === to && event.key !== 'Enter') {
            if (event.key === 'Backspace' && from > 0) from -= /[\uDC00-\uDFFF]/.test(model.source[from - 1]) ? 2 : 1;
            if (event.key === 'Delete' && to < model.source.length) to += /[\uD800-\uDBFF]/.test(model.source[to]) ? 2 : 1;
          }
          event.preventDefault();
          return replaceLogicalSelection(event.key === 'Enter' ? '\n' : '', 'typing', { from, to, all: false }).handled;
        }
      }
      if (activePopup?.keydown?.(event)) return true;
      // Navigate in the editable document, excluding the trailing click target.
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key === 'End') {
        releaseBookmark();
        tabSelection = null;
        const end = editor.state.doc.resolve(editor.state.doc.content.size);
        const selection = Selection.findFrom(end, -1, true) || Selection.atEnd(editor.state.doc);
        editor.dispatch(editor.state.tr.setSelection(selection).scrollIntoView());
        return true;
      }
      if (NAVIGATION_KEYS.has(event.key)) { options.checkpoint(); releaseBookmark(); tabSelection = null; }
      if (event.key === 'Enter' || event.key === 'Tab') captureDOMSelection();
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) { options.undo(key === 'y' || event.shiftKey); return true; }
      return false;
    },
    handleTextInput(editor, from, to, text) {
      if (editor.composing) return false;
      if (crossesTableCells(editor.state)) {
        options.message?.('Typing across table cells is not supported. Edit within one cell.');
        return true;
      }
      if (pendingTail && editor.state.selection.$from.parent.content.size === 0 && from === editor.state.doc.content.size - 1) {
        pendingTail = false;
        const prefix = model.source.length ? (model.source.endsWith('\n') ? '\n' : '\n\n') : '';
        const result = replaceLogicalSelection(prefix + text, 'typing', { from: model.source.length, to: model.source.length, all: false });
        if (result.committed && text === '/') openSlashMenu(editor.dom);
        return result.handled;
      }
      if (model.sourceEdit) {
        return replaceLogicalSelection(text, 'typing', { from: richToSource(model, from), to: richToSource(model, to), all: false }).handled;
      }
      if (text === ']' && from === to && !options.isLocked()) {
        const caret = editor.state.doc.resolve(from);
        const paragraph = caret.parent;
        if (caret.depth === 1 && paragraph.type === schema.nodes.paragraph &&
            paragraph.childCount === 1 && paragraph.firstChild.isText &&
            !paragraph.firstChild.marks.length && !editor.state.storedMarks?.length) {
          const before = paragraph.textContent.slice(0, caret.parentOffset);
          const syntax = (before + text).match(/(?:\[\[[^\[\]\n]+\]\]|\[\^[^\[\]\n]+\])$/)?.[0];
          if (syntax) {
            const segment = model.segments[caret.index(0)];
            const raw = segment?.raw.replace(/\r?\n$/, '');
            // The incomplete spelling may contain escaped brackets. Require
            // the entire plain paragraph to agree before splicing its suffix.
            if (segment?.node === paragraph && caret.parentOffset === paragraph.content.size &&
                raw?.replace(/\\([\[\]\^])/g, '$1') === before) {
              const suffix = raw.match(/(?:\\?\[\\?\[[^\[\]\n]+\\?\]|\\?\[\\?\^[^\[\]\n]+)$/)?.[0];
              if (suffix && suffix.replace(/\\([\[\]\^])/g, '$1') === syntax.slice(0, -1)) {
                const end = segment.from + raw.length;
                return replaceLogicalSelection(syntax, 'typing', { from: end - suffix.length, to: end, all: false }).handled;
              }
            }
          }
        }
      }
      if (text === '/' && from === to && editor.state.selection.$from.depth === 1
          && editor.state.selection.$from.parent.type === schema.nodes.paragraph
          && editor.state.selection.$from.parent.content.size === 0 && !options.isLocked()) {
        editor.dispatch(editor.state.tr.insertText(text, from, to));
        openSlashMenu(editor.dom);
        return true;
      }
      // A formatting command (Ctrl+B/Ctrl+I or a toolbar mark) sets stored
      // marks on the ProseMirror state. The logical source splice below would
      // reparse the document and silently discard them, so an explicit mark
      // intent must take the native rich-text path and let the serializer emit
      // the Markdown delimiters.
      if (editor.state.storedMarks !== null) return false;
      const range = bookmarkRange(editor.state);
      if (range) {
        if (bookmark.all) {
          if (!(editor.state.selection instanceof AllSelection)) return false;
          return replaceLogicalSelection(text, 'typing', { from: 0, to: model.source.length, all: true, collapsed: false }).handled;
        }
        const pmFrom = Math.min(bookmark.pmAnchor, bookmark.pmHead), pmTo = Math.max(bookmark.pmAnchor, bookmark.pmHead);
        if (from !== pmFrom || to !== pmTo) return false;
        // A source offset inside an empty paragraph is the blank separator
        // itself, not a text position. Let ProseMirror insert into the visible
        // empty paragraph and serialize the block instead of splicing into the
        // separator (which would join the following paragraph).
        const $from = editor.state.selection.$from;
        if ($from.parent.isTextblock && $from.parent.content.size === 0) return false;
        return replaceLogicalSelection(text, 'typing', range).handled;
      }
      const selection = editor.state.selection;
      if (!(selection instanceof TextSelection) || selection.empty) return false;
      if (from !== selection.from || to !== selection.to) return false;
      const verified = verifiedSourceRange(from, to);
      if (!verified || verified.startOwner === verified.endOwner) return false;
      return replaceLogicalSelection(text, 'typing', { ...verified, all: false, collapsed: false }).handled;
    },
    handlePaste(editor, event) {
      if (editor.composing) return false;
      const data = event.clipboardData;
      if (!data) return false;
      // Markdown is canonical, so the plain-text payload wins even when the
      // clipboard also carries HTML. Round-tripping HTML through the rich
      // schema dropped fenced-code info strings, rewrote list spacing and
      // mangled TeX. HTML remains the fallback only when no text is offered.
      let text = data.getData('text/plain');
      if (!text) return false;
      if (crossesTableCells(editor.state)) {
        event.preventDefault();
        options.message?.('Pasting across table cells is not supported. Paste inside one cell.');
        return true;
      }
      // A cell is GFM inline content: a raw newline would split the row. Use
      // the cell's existing hard-break spelling instead.
      if (isInTable(editor.state) && editor.state.selection instanceof TextSelection) {
        text = text.replace(/\\*\|/g, match => {
          const slashes = match.length - 1;
          return '\\'.repeat(slashes + (slashes % 2 === 0 ? 1 : 0)) + '|';
        }).replace(/\r\n|\r|\n/g, '<br>');
      }
      const logical = logicalRange(editor.state);
      const caret = sourceSelection(editor.state);
      const range = logical || { from: Math.min(caret.anchor, caret.head), to: Math.max(caret.anchor, caret.head), all: false };
      return replaceLogicalSelection(text, 'paste', range).handled;
    },
    handleDOMEvents: {
      mousedown(editor, event) {
        // Every left-button gesture starts guarded: while the pointer is down
        // the native range is left alone so reading selections can cross
        // rendered projections, and the guard settles on pointer-up. A plain
        // new caret still syncs on release via the pointer-up flush below.
        if (event.button === 0) { options.checkpoint(); setSelectionGuarded(true); releaseBookmark(); tabSelection = null; }
        // A rendered block is one atom in the document, so ProseMirror's
        // triple-click default selects the whole block (alert title included,
        // or a footnote, Mermaid diagram or raw HTML island) instead of the
        // paragraph under the pointer. Select the rendered paragraph directly
        // and skip ProseMirror's handler; the guard armed above keeps the
        // range as a reading selection, exactly like a drag inside the
        // projection.
        if (event.button === 0 && !event.ctrlKey && !event.metaKey && tripleClickPress(editor, event)) {
          const paragraph = renderedParagraphAt(event.target);
          if (paragraph) {
            event.preventDefault();
            const range = document.createRange();
            range.selectNodeContents(paragraph);
            const dom = window.getSelection();
            dom.removeAllRanges();
            dom.addRange(range);
            return true;
          }
        }
        // A press inside a table hands anchoring back to the selection: the
        // click lands the caret, the selection-anchored controls appear, and
        // later pointer movement re-evaluates the hover zone from there.
        if (event.target instanceof Element && event.target.closest
            && event.target.closest('.tableWrapper') && editor.dom.contains(event.target)) {
          hoverAnchor = null;
          hoverPending = null;
        }
        return false;
      },
      keydown(editor, event) {
        if (selectionGuarded) {
          // A standing reading range must survive the chord long enough for
          // the native clipboard event to serve its rendered text. Returning
          // true skips ProseMirror's selection normalization without
          // preventDefault, so browser copy/cut still runs and our copy/cut
          // handlers can serve the rendered range. Modifier-only presses must
          // not truncate the range either.
          const key = event.key.toLowerCase();
          const clipboardShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && (key === 'c' || key === 'x');
          if (MODIFIER_KEYS.has(event.key) || clipboardShortcut) return true;
        }
        // Typing or moving from a guarded reading range first adopts it into
        // editor state so the gesture lands predictably; the rewrite covers
        // the mapped block range, never hidden source.
        if (selectionGuarded) resyncGuardedSelection();
        return false;
      },
      beforeinput(editor, event) {
        if (selectionGuarded) resyncGuardedSelection();
        return false;
      },
      copy(editor, event) {
        // Clipboard text is the exact canonical Markdown, including rendered
        // objects between the native range endpoints.
        return copyMarkdownSelection(event);
      },
      cut(editor, event) {
        if (!event.clipboardData) return false;
        const crossed = crossesTableCells(editor.state);
        const range = logicalRange(editor.state) || markdownClipboardRange();
        // A reading/locked range is copy-only. This is no longer used as a
        // blanket escape hatch in Edit mode: crossing a rendered atom used to
        // make Ctrl+X a silent no-op there.
        if (options.isLocked()) {
          if (renderedRangeActive()) return copyMarkdownSelection(event);
          if (!range || range.collapsed) return false;
          try { event.clipboardData.setData('text/plain', model.source.slice(range.from, range.to)); }
          catch {}
          event.preventDefault();
          return true;
        }
        if (crossed) {
          if (range && !range.collapsed) {
            try { event.clipboardData.setData('text/plain', model.source.slice(range.from, range.to)); } catch {}
          }
          event.preventDefault();
          options.message?.('Cutting across table cells is not supported. Copy, then clear the cells individually.');
          return true;
        }
        if (!range || range.collapsed) return false;
        const text = model.source.slice(range.from, range.to);
        try { event.clipboardData.setData('text/plain', text); }
        catch {
          event.preventDefault();
          options.message('The clipboard could not be written. Your document is preserved.');
          return true;
        }
        const outcome = replaceLogicalSelection('', 'cut', cutExpandedRange(range));
        if (!outcome.committed) {
          // Rejection is a handled path: stop the browser's default cut so it
          // cannot mutate the DOM after the source splice was refused.
          event.preventDefault();
          return true;
        }
        event.preventDefault();
        return true;
      },
      click(editor, event) {
      const anchor = event.target.closest('a'); if (!anchor) return false;
      event.preventDefault(); const href = anchor.getAttribute('href') || '';
      const inline = anchor.closest('.html-inline');
      if (inline && !options.isLocked()) {
        // An inline HTML link is an atom; a primary click edits its exact
        // source instead of following it. Reading/locked mode still opens.
        let pos = editor.posAtDOM(inline, 0), node = editor.state.doc.nodeAt(pos);
        if (node?.type.name !== 'raw_inline') {
          const $pos = editor.state.doc.resolve(pos);
          node = $pos.parent.childAfter($pos.parentOffset).node;
        }
        const owner = node?.type.name === 'raw_inline'
          ? model.ledger?.owners?.find(item => item.type === 'raw_inline' && item.pmFrom <= pos && item.pmTo >= pos) : null;
        if (node && owner && options.editValue) {
          void options.editValue({ title: 'Edit inline HTML', value: node.attrs.source }).then(next => {
            if (next === null || next === undefined || next === node.attrs.source) return;
            const outcome = replaceLogicalSelection(next, 'command', { from: owner.sourceFrom, to: owner.sourceTo, all: false, collapsed: false });
            if (!outcome.committed) options.message?.('This inline HTML could not be updated safely.');
          });
          return true;
        }
      }
      if (event.ctrlKey || event.metaKey || options.isLocked()) options.openLink(href);
      else {
        const pos = editor.posAtDOM(anchor, 0), $pos = editor.state.doc.resolve(pos), ranges = [];
        $pos.parent.forEach((child, offset) => { if (schema.marks.link.isInSet(child.marks)?.attrs.href === href) ranges.push({ from: $pos.start() + offset, to: $pos.start() + offset + child.nodeSize }); });
        const index = ranges.findIndex(range => range.from <= pos && range.to >= pos);
        if (index < 0) return true;
        let from = ranges[index].from, to = ranges[index].to;
        for (let i = index - 1; i >= 0 && ranges[i].to === from; i--) from = ranges[i].from;
        for (let i = index + 1; i < ranges.length && ranges[i].from === to; i++) to = ranges[i].to;
        // A primary click opens the destination editor after the selection
        // gesture settles. Ctrl/Cmd click (or a click under Lock) opens it.
        if (event.detail > 1) { clearTimeout(linkClickTimer); return true; }
        clearTimeout(linkClickTimer);
        linkClickTimer = setTimeout(() => { linkClickTimer = 0; revealLinkSource(from, to, href); }, 240);
      }
      return true;
    }, auxclick(editor, event) { const anchor = event.target.closest('a'); if (!anchor || event.button !== 1) return false; event.preventDefault(); options.openLink(anchor.getAttribute('href') || ''); return true; } }
  });
  // Folio-original contextual table system (Obsidian-style, Folio-built): an
  // unobtrusive + control below/right appends a row/column, hover-revealed
  // grips on the top/left arrange rows/columns by dragging, and a cell context
  // menu carries Row/Column insert/move/duplicate/delete, sorting and
  // alignment. All chrome lives in document.body overlays — never inside the
  // ProseMirror document — so hovering, focusing, dragging or copying never
  // adds control text to the clipboard and never dispatches a transaction.
  // Structural edits reuse the stock TableView/PM table commands plus the
  // shared table-operations module, so cell editing, native selection, lock,
  // undo and Markdown integrity stay authoritative. No tableEditing plugin is
  // added; visibility is selection-driven and hover only fades chrome in.
  const TABLE_OP_NAMES = ['move-row-up', 'move-row-down', 'move-column-left', 'move-column-right',
    'duplicate-row', 'duplicate-column', 'sort-ascending', 'sort-descending',
    'align-left', 'align-center', 'align-right'];
  // The shared table-operations module is the only authority for structural
  // rewrites (move/duplicate/sort/align). It refuses merged cells and keeps
  // valid header cell roles when rows cross the first position. There is deliberately no local fallback: running a
  // weaker local rewrite after it returns false (or throws) would bypass the
  // header and unsafe-table safeguards. Unknown names fail closed.
  function resolveTableOp(name) {
    let command = null;
    try { command = tableOperation(name); } catch { command = null; }
    if (typeof command !== 'function') return () => false;
    return (state, dispatch, v) => {
      if (options.isLocked()) return false;
      try {
        return command(state, dispatch, v);
      } catch { return false; }
    };
  }
  // Pointer drags share the structural commands' rectangular-table safeguards.
  function rectangularTableGuard(info) {
    try {
      const { table, map } = info;
      if (!table || table.type.spec.tableRole !== 'table') return null;
      if (!map || map.width < 1 || map.height < 1) return null;
      if (map.height !== table.childCount) return null;
      for (let r = 0; r < table.childCount; r++) {
        const row = table.child(r);
        if (row.type.spec.tableRole !== 'row' || row.childCount !== map.width) return null;
        for (let c = 0; c < row.childCount; c++) {
          const cell = row.child(c);
          const role = cell.type.spec.tableRole;
          if (role !== 'cell' && role !== 'header_cell') return null;
          if ((cell.attrs.colspan ?? 1) !== 1 || (cell.attrs.rowspan ?? 1) !== 1) return null;
        }
      }
      return true;
    } catch { return null; }
  }
  function runTableCommand(command) {
    if (options.isLocked() || !view) return false;
    let ok = false;
    try { ok = command(view.state, view.dispatch, view); } catch { ok = false; }
    try { syncTableChrome(); } catch {}
    return ok;
  }
  function chromeAppendButton(action, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `folio-table-add folio-table-add-${action}`;
    btn.dataset.tableAppend = action;
    btn.textContent = '+';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.addEventListener('mousedown', event => event.preventDefault());
    btn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (action === 'row') appendTableRow();
      else appendTableColumn();
    });
    btn.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); try { view?.focus(); } catch {} }
    });
    return btn;
  }
  const addRowBtn = chromeAppendButton('row', 'Add row');
  const addColBtn = chromeAppendButton('column', 'Add column');
  document.body.append(addRowBtn, addColBtn);
  pinChromeOnHover(addRowBtn);
  pinChromeOnHover(addColBtn);
  const handlesLayer = document.createElement('div');
  handlesLayer.className = 'folio-table-handles';
  handlesLayer.hidden = true;
  document.body.append(handlesLayer);
  const dropLine = document.createElement('div');
  dropLine.className = 'folio-table-drop-line';
  dropLine.hidden = true;
  dropLine.setAttribute('aria-hidden', 'true');
  document.body.append(dropLine);
  // Hover anchor: the table (and row/column/edge zone) under the pointer.
  // Hovering positions chrome but never dispatches — no selection change, no
  // source mutation — so merely pointing at a table is always free. Actions
  // move the caret into the hovered cell first (a pure navigation step).
  let hoverAnchor = null;
  let hoverClearTimer = 0;
  function cancelHoverClear() {
    try { clearTimeout(hoverClearTimer); } catch {}
    hoverClearTimer = 0;
  }
  function scheduleHoverClear() {
    cancelHoverClear();
    hoverClearTimer = setTimeout(() => {
      hoverClearTimer = 0;
      // A focused control pins its chrome: hiding under keyboard focus would
      // drop focus to the body mid-operation.
      if (handlesLayer.contains(document.activeElement)
          || document.activeElement === addRowBtn || document.activeElement === addColBtn) return;
      hoverAnchor = null;
      try { syncTableChrome(); } catch {}
    }, 120);
  }
  // Geometry for the table under a pointer position, resolved without
  // touching the selection. Row/column come from the table map so merged
  // cells still anchor to their covering row/column. Coordinates (not
  // element mapping) are used because custom table DOM does not always
  // resolve through posAtDOM.
  function infoFromPoint(clientX, clientY, wrapper) {
    try {
      if (!wrapper || !wrapper.isConnected) return null;
      const hit = view.posAtCoords({ left: clientX, top: clientY });
      if (!hit) return null;
      const pos = Math.max(0, Math.min(view.state.doc.content.size, hit.pos));
      const $pos = view.state.doc.resolve(pos);
      let depth = -1;
      for (let d = $pos.depth; d > 0; d--) {
        if ($pos.node(d).type.spec.tableRole === 'table') { depth = d; break; }
      }
      if (depth < 0) return null;
      const tablePos = $pos.before(depth);
      const table = view.state.doc.nodeAt(tablePos);
      if (!table) return null;
      let dom = null;
      try { dom = view.nodeDOM(tablePos); } catch {}
      const own = dom instanceof HTMLElement ? (dom.closest?.('.tableWrapper') || dom) : null;
      if (own !== wrapper) return null;
      const map = TableMap.get(table);
      const tableStart = $pos.start(depth);
      // findCell needs an exact cell start; coords can land anywhere inside
      // a cell (or its gap), so settle onto the covering cell first.
      let found = null;
      try { found = findCell($pos); }
      catch {
        try { found = findCell(cellAround($pos)); }
        catch { return null; }
      }
      return {
        table, map, tableStart,
        row: Math.max(0, Math.min(map.height - 1, found.top)),
        col: Math.max(0, Math.min(map.width - 1, found.left)),
        height: map.height, width: map.width, wrapper, zone: 'cell'
      };
    } catch { return null; }
  }
  function sameHover(a, b) {
    if (!a || !b) return false;
    return a.wrapper === b.wrapper && a.row === b.row && a.col === b.col && a.zone === b.zone;
  }
  // Edge zones are 30px strips; controls sit flush on the table edge so the
  // pointer crosses straight from the table onto the control with no gap.
  // Zones are re-evaluated on every pointermove (rAF-throttled): resting the
  // pointer inside one cell must still notice the edge strip, which
  // enter-only tracking would miss.
  const HOVER_EDGE = 30;
  let hoverRaf = 0, hoverPending = null;
  function queueHover(clientX, clientY, target) {
    hoverPending = { clientX, clientY, target };
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const pending = hoverPending;
      hoverPending = null;
      if (pending) updateHoverAnchor(pending.clientX, pending.clientY, pending.target);
    });
  }
  function onTablePointerOver(event) {
    if (handleDrag) return;
    queueHover(event.clientX, event.clientY, event.target instanceof Element ? event.target : null);
  }
  function updateHoverAnchor(clientX, clientY, rawTarget) {
    if (handleDrag) return;
    const target = rawTarget instanceof Element ? rawTarget : null;
    if (target && (handlesLayer.contains(target) || target === addRowBtn || target === addColBtn)) { cancelHoverClear(); return; }
    const reader = view.dom.closest('.reader-scroll');
    if (!target || !reader?.contains(target)) { scheduleHoverClear(); return; }
    let wrapper = target.closest('.tableWrapper');
    const rectangles = new Map();
    const boundsFor = candidate => {
      if (!rectangles.has(candidate)) rectangles.set(candidate, candidate.getBoundingClientRect());
      return rectangles.get(candidate);
    };
    if (!wrapper || !view.dom.contains(wrapper)) {
      // A narrow, non-intercepting gutter makes controls discoverable even
      // when the pointer approaches from outside the table.
      wrapper = null;
      const candidates = new Set(nearbyTables);
      // Hit testing finds the table just beyond a gutter without requiring a
      // document-wide scan, including before the observer's first callback.
      for (const [dx, dy] of [[0, 0], [-HOVER_EDGE, 0], [HOVER_EDGE, 0], [0, -HOVER_EDGE], [0, HOVER_EDGE]]) {
        for (const hit of document.elementsFromPoint(clientX + dx, clientY + dy)) {
          const table = hit.closest('.tableWrapper');
          if (table && view.dom.contains(table)) candidates.add(table);
        }
      }
      for (const candidate of candidates) {
        if (!candidate.isConnected) { nearbyTables.delete(candidate); continue; }
        const bounds = boundsFor(candidate);
        const insideX = clientX >= bounds.left && clientX <= bounds.right;
        const insideY = clientY >= bounds.top && clientY <= bounds.bottom;
        if ((insideY && clientX >= bounds.left - HOVER_EDGE && clientX <= bounds.right + HOVER_EDGE) ||
            (insideX && clientY >= bounds.top - HOVER_EDGE && clientY <= bounds.bottom + HOVER_EDGE)) {
          wrapper = candidate; break;
        }
      }
    }
    if (!wrapper) { scheduleHoverClear(); return; }
    cancelHoverClear();
    const rect = boundsFor(wrapper);
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = clientX, y = clientY;
    let zone = 'cell';
    if (x < rect.left) zone = 'left';
    else if (x > rect.right) zone = 'right';
    else if (y <= rect.top + HOVER_EDGE) zone = 'top';
    else if (y >= rect.bottom - HOVER_EDGE) zone = 'bottom';
    else if (x <= rect.left + HOVER_EDGE) zone = 'left';
    else if (x >= rect.right - HOVER_EDGE) zone = 'right';
    let anchor = infoFromPoint(x, y, wrapper);
    if (anchor) anchor.zone = zone;
    if (!anchor) {
      // Coordinates missed the table (wrapper padding, scrollbar, or a snap
      // outside it): reuse the table under the pointer when provable, else
      // keep the previous state instead of flickering.
      const probe = infoFromPoint(
        Math.max(rect.left + 1, Math.min(rect.right - 1, x)),
        Math.max(rect.top + 1, Math.min(rect.bottom - 1, y)),
        wrapper
      );
      if (probe) anchor = { ...probe, zone };
      else if (hoverAnchor && hoverAnchor.wrapper === wrapper) anchor = { ...hoverAnchor, zone };
      else return;
    }
    if (!anchor || sameHover(hoverAnchor, anchor)) return;
    hoverAnchor = anchor;
    try { syncTableChrome(rectangles); } catch {}
  }
  document.addEventListener('pointermove', onTablePointerOver);
  function pinChromeOnHover(element) {
    element.addEventListener('pointerenter', cancelHoverClear);
    element.addEventListener('pointerleave', scheduleHoverClear);
    element.addEventListener('focusin', cancelHoverClear);
  }
  // Anchor info for the table holding the selection: node/map geometry for
  // commands plus the rendered wrapper for overlay positioning.
  function tableInfo() {
    try {
      if (!isInTable(view.state)) return null;
      const rect = selectedRect(view.state);
      const $from = view.state.selection.$from;
      let depth = -1;
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.spec.tableRole === 'table') { depth = d; break; }
      }
      if (depth < 0) return null;
      let wrapper = null;
      try {
        const dom = view.nodeDOM($from.before(depth));
        if (dom instanceof HTMLElement) wrapper = dom.closest?.('.tableWrapper') || dom;
      } catch {}
      return {
        table: rect.table, map: rect.map, tableStart: rect.tableStart,
        row: rect.top, col: rect.left, height: rect.map.height, width: rect.map.width,
        wrapper
      };
    } catch { return null; }
  }
  // Move the caret into one cell without touching content. Selection-only
  // transactions pass the lock filter and create no history entry, so this
  // stays a pure navigation step even under Lock.
  function selectTableCell(row, col, base) {
    const info = base || tableInfo();
    if (!info || !view) return false;
    try {
      const r = Math.max(0, Math.min(info.height - 1, row));
      const c = Math.max(0, Math.min(info.width - 1, col));
      const pos = info.tableStart + info.map.map[r * info.width + c];
      const selection = Selection.near(view.state.doc.resolve(Math.max(0, pos + 1)));
      if (!view.state.selection.eq(selection)) view.dispatch(view.state.tr.setSelection(selection));
      return true;
    } catch { return false; }
  }
  // The table actions act on: the hovered table when the pointer is over
  // one (no prior cell click needed), otherwise the selected table. Hover
  // never dispatches by itself; the selection move happens only when an
  // action runs, exactly like focusing a cell first.
  function actionInfo() {
    if (hoverAnchor && hoverAnchor.wrapper && hoverAnchor.wrapper.isConnected && hoverAnchor.table) return hoverAnchor;
    return tableInfo();
  }
  function appendTableRow() {
    const info = actionInfo();
    if (!info || !selectTableCell(info.height - 1, info.col, info)) return false;
    return runTableCommand(addRowAfter);
  }
  function appendTableColumn() {
    const info = actionInfo();
    if (!info || !selectTableCell(info.row, info.width - 1, info)) return false;
    return runTableCommand(addColumnAfter);
  }
  function cellDomAt(info, row, col) {
    try {
      const dom = view.nodeDOM(info.tableStart + info.map.map[row * info.width + col]);
      return dom instanceof HTMLElement ? dom : null;
    } catch { return null; }
  }
  function refocusHandle(kind, index) {
    try {
      const next = handlesLayer.querySelector(kind === 'row'
        ? `[data-handle-row="${index}"]`
        : `[data-handle-col="${index}"]`);
      if (next) next.focus();
    } catch {}
  }
  // Suppress only the click the browser synthesizes on the dragged handle
  // itself after a drag (identified by element + recency, so a later click
  // on any handle — including the same one — still opens its menu).
  let suppressHandleClick = null;
  function consumeDragClick(btn) {
    if (suppressHandleClick && suppressHandleClick.el === btn &&
        performance.now() - suppressHandleClick.t < 750) {
      suppressHandleClick = null;
      return true;
    }
    if (suppressHandleClick && suppressHandleClick.el === btn) suppressHandleClick = null;
    return false;
  }
  function makeHandle(kind, index) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `folio-table-handle folio-table-handle-${kind}`;
    if (kind === 'row') btn.dataset.handleRow = String(index);
    else btn.dataset.handleCol = String(index);
    const label = kind === 'row' ? `Row ${index + 1} handle` : `Column ${index + 1} handle`;
    btn.setAttribute('aria-label', label);
    btn.title = kind === 'row'
      ? `Row ${index + 1}: drag to move, arrow keys move, Enter for menu`
      : `Column ${index + 1}: drag to move, arrow keys move, Enter for menu`;
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    const grip = document.createElement('span');
    grip.className = 'folio-table-grip';
    grip.textContent = kind === 'row' ? '↕' : '↔';
    grip.setAttribute('aria-hidden', 'true');
    btn.append(grip);
    btn.addEventListener('mousedown', event => event.preventDefault());
    btn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (consumeDragClick(event.currentTarget)) return;
      if (options.isLocked()) return;
      openTableMenuFor(kind, index, btn);
    });
    btn.addEventListener('keydown', event => handleKeyFor(kind, index, event));
    btn.addEventListener('pointerdown', event => startHandleDrag(kind, index, event));
    pinChromeOnHover(btn);
    btn.addEventListener('contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      openTableMenuFor(kind, index, btn, { left: event.clientX, bottom: event.clientY });
    });
    return btn;
  }
  // Keyboard equivalents for every drag: arrows move the row/column by one
  // through the same table operations, Enter opens the menu, Escape refocuses.
  function handleKeyFor(kind, index, event) {
    const key = event.key;
    if (key === 'Escape') { event.preventDefault(); try { view?.focus(); } catch {} return; }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      if (!options.isLocked()) openTableMenuFor(kind, index, event.target.closest?.('button'));
      return;
    }
    if (options.isLocked()) return;
    const step = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : key === 'ArrowDown' || key === 'ArrowRight' ? 1 : 0;
    if (!step) return;
    if (kind === 'row' && (key === 'ArrowLeft' || key === 'ArrowRight')) return;
    if (kind === 'col' && (key === 'ArrowUp' || key === 'ArrowDown')) return;
    event.preventDefault();
    event.stopPropagation();
    const info = actionInfo();
    if (!info) return;
    if (kind === 'row') {
      if (!selectTableCell(index, info.col, info)) return;
      if (!runTableCommand(resolveTableOp(step < 0 ? 'move-row-up' : 'move-row-down'))) return;
      refocusHandle(kind, Math.max(0, Math.min(info.height - 1, index + step)));
    } else {
      if (!selectTableCell(info.row, index, info)) return;
      if (!runTableCommand(resolveTableOp(step < 0 ? 'move-column-left' : 'move-column-right'))) return;
      refocusHandle(kind, Math.max(0, Math.min(info.width - 1, index + step)));
    }
  }
  let handleDrag = null;
  function createDragPreview(drag) {
    const { info, kind, from } = drag;
    const cells = [];
    for (let r = 0; r < info.height; r++) {
      if (kind === 'row' && r !== from) continue;
      for (let c = 0; c < info.width; c++) {
        if (kind === 'col' && c !== from) continue;
        const cell = cellDomAt(info, r, c);
        if (cell) cells.push(cell);
      }
    }
    if (!cells.length) return;
    const first = cells[0].getBoundingClientRect(), last = cells.at(-1).getBoundingClientRect();
    const rect = { left: first.left, top: first.top, width: last.right - first.left, height: last.bottom - first.top };
    const preview = document.createElement('div');
    preview.className = 'markdown folio-table-drag-preview'; preview.setAttribute('aria-hidden', 'true');
    const table = document.createElement('table');
    let row;
    cells.forEach((cell, index) => {
      if (kind === 'col' || index === 0) { row = document.createElement('tr'); table.append(row); }
      const clone = cell.cloneNode(true), box = cell.getBoundingClientRect();
      clone.style.width = `${box.width}px`; clone.style.minWidth = `${box.width}px`;
      clone.style.height = `${box.height}px`; clone.classList.remove('selectedCell');
      clone.removeAttribute('id'); clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
      row.append(clone);
    });
    preview.append(table);
    const style = getComputedStyle(cells[0]);
    Object.assign(preview.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`,
      height: `${rect.height}px`, fontSize: style.fontSize, fontFamily: style.fontFamily, lineHeight: style.lineHeight });
    const outline = document.createElement('div'); outline.className = 'folio-table-drag-source';
    outline.setAttribute('aria-hidden', 'true');
    Object.assign(outline.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    document.body.append(outline, preview);
    drag.preview = preview; drag.outline = outline; drag.origin = rect;
  }
  function finishDragPreview(drag, destination) {
    drag?.outline?.remove();
    if (!drag?.preview) return;
    const preview = drag.preview;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { preview.remove(); return; }
    const rect = destination || drag.origin;
    const from = getComputedStyle(preview).transform;
    const animation = preview.animate([
      { transform: from, opacity: .95 },
      { transform: `translate(${rect.left - drag.origin.left}px, ${rect.top - drag.origin.top}px)`, opacity: .2 }
    ], { duration: 180, easing: 'ease-out', fill: 'forwards' });
    animation.finished.then(() => preview.remove(), () => preview.remove());
  }
  function rowColEdges(info) {
    const wrapRect = info.wrapper.getBoundingClientRect();
    const rows = [], cols = [];
    for (let r = 0; r < info.height; r++) {
      const dom = cellDomAt(info, r, 0);
      const b = dom ? dom.getBoundingClientRect() : null;
      rows.push(b ? b.bottom : wrapRect.top + wrapRect.height * ((r + 1) / info.height));
    }
    for (let c = 0; c < info.width; c++) {
      const dom = cellDomAt(info, 0, c);
      const b = dom ? dom.getBoundingClientRect() : null;
      cols.push(b ? b.right : wrapRect.left + wrapRect.width * ((c + 1) / info.width));
    }
    return { top: wrapRect.top, left: wrapRect.left, bottom: wrapRect.bottom, right: wrapRect.right, rows, cols };
  }
  function slotFromCoord(boundaries, edge, coord) {
    let slot = 0;
    const stops = [edge].concat(boundaries);
    while (slot < stops.length - 1 && coord >= stops[slot + 1]) slot++;
    return slot;
  }
  function startHandleDrag(kind, index, event) {
    if (options.isLocked() || !view) return;
    if (event.button !== 0) return;
    const info = actionInfo();
    if (!info || !info.wrapper) return;
    if ((kind === 'row' ? info.height : info.width) < 2) return;
    event.preventDefault();
    if (!rectangularTableGuard(info)) return;
    try { event.currentTarget?.setPointerCapture?.(event.pointerId); } catch {}
    handleDrag = { kind, from: index, slot: index, live: false, edges: rowColEdges(info), info,
      startX: event.clientX, startY: event.clientY };
  }
  function moveTargetFor(drag) {
    const count = drag.kind === 'row' ? drag.edges.rows.length : drag.edges.cols.length;
    const slot = Math.max(0, Math.min(count, drag.slot));
    if (slot === drag.from || slot === drag.from + 1) return -1;
    return slot > drag.from ? slot - 1 : slot;
  }
  // Invalid destinations and merged tables drop as a no-op.
  function guardedDropTarget(drag) {
    const target = moveTargetFor(drag);
    if (target < 0) return -1;
    const info = (drag.info && drag.info.wrapper && drag.info.wrapper.isConnected) ? drag.info : tableInfo();
    if (!info) return -1;
    const guard = rectangularTableGuard(info);
    if (!guard) return -1;
    return target;
  }
  function paintDropHandle(target) {
    try {
      for (const btn of handlesLayer.querySelectorAll('.folio-table-handle')) {
        const isRow = btn.hasAttribute('data-handle-row');
        const mine = Number(isRow ? btn.getAttribute('data-handle-row') : btn.getAttribute('data-handle-col'));
        const matches = target >= 0 && handleDrag &&
          ((handleDrag.kind === 'row') === isRow) && mine === target;
        btn.classList.toggle('drop-target', Boolean(matches));
      }
    } catch {}
  }
  function onHandlePointerMove(event) {
    if (!handleDrag) return;
    handleDrag.pending = { clientX: event.clientX, clientY: event.clientY };
    if (handleDrag.frame) return;
    const drag = handleDrag;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = 0;
      if (handleDrag === drag && drag.pending) {
        const point = drag.pending; drag.pending = null;
        paintHandleDrag(point);
      }
    });
  }
  function paintHandleDrag(event) {
    if (!handleDrag) return;
    const drag = handleDrag;
    if (!drag.live && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    if (!drag.live) createDragPreview(drag);
    drag.live = true;
    if (drag.preview) drag.preview.style.transform = `translate(${drag.kind === 'col' ? event.clientX - drag.startX : 0}px, ${drag.kind === 'row' ? event.clientY - drag.startY : 0}px)`;
    const coord = drag.kind === 'row' ? event.clientY : event.clientX;
    const boundaries = drag.kind === 'row' ? drag.edges.rows : drag.edges.cols;
    const edge = drag.kind === 'row' ? drag.edges.top : drag.edges.left;
    drag.slot = slotFromCoord(boundaries, edge, coord);
    const target = moveTargetFor(drag);
    if (target < 0 || !drag.info.wrapper.isConnected) { dropLine.hidden = true; paintDropHandle(-1); return; }
    const wrapRect = drag.edges;
    if (drag.kind === 'row') {
      const stops = [drag.edges.top].concat(drag.edges.rows);
      const y = stops[Math.max(0, Math.min(stops.length - 1, drag.slot))];
      dropLine.style.left = `${Math.round(wrapRect.left)}px`;
      dropLine.style.width = `${Math.round(Math.max(0, wrapRect.right - wrapRect.left))}px`;
      dropLine.style.top = `${Math.round(y - 1)}px`;
      dropLine.style.height = '2px';
      dropLine.style.bottom = '';
    } else {
      const stops = [drag.edges.left].concat(drag.edges.cols);
      const x = stops[Math.max(0, Math.min(stops.length - 1, drag.slot))];
      dropLine.style.top = `${Math.round(wrapRect.top)}px`;
      dropLine.style.height = `${Math.round(Math.max(0, wrapRect.bottom - wrapRect.top))}px`;
      dropLine.style.left = `${Math.round(x - 1)}px`;
      dropLine.style.width = '2px';
      dropLine.style.bottom = '';
    }
    dropLine.hidden = false;
    paintDropHandle(target);
  }
  function endHandleDrag(commit) {
    const drag = handleDrag;
    if (drag?.frame) cancelAnimationFrame(drag.frame);
    if (commit && drag?.pending) paintHandleDrag(drag.pending);
    handleDrag = null;
    dropLine.hidden = true;
    paintDropHandle(-1);
    if (drag?.live) {
      try {
        suppressHandleClick = { el: document.querySelector(`[data-handle-${drag.kind}="${drag.from}"]`), t: performance.now() };
      } catch { suppressHandleClick = null; }
    }
    if (!drag || !commit || !drag.live) { finishDragPreview(drag); return; }
    const target = guardedDropTarget(drag);
    if (target < 0 || !view || options.isLocked()) { finishDragPreview(drag); return; }
    hoverAnchor = null;
    const info = (drag.info && drag.info.wrapper && drag.info.wrapper.isConnected) ? drag.info : tableInfo();
    if (info) {
      if (drag.kind === 'row') selectTableCell(drag.from, info.col, info);
      else selectTableCell(info.row, drag.from, info);
    }
    const moved = drag.kind === 'row'
      ? runTableCommand(moveTableRowTo(drag.from, target))
      : runTableCommand(moveTableColumn({ from: drag.from, to: target }));
    let destination = null;
    if (moved) {
      const next = tableInfo();
      if (next) destination = cellDomAt(next, drag.kind === 'row' ? target : 0, drag.kind === 'col' ? target : 0)?.getBoundingClientRect();
      if (next) selectTableCell(drag.kind === 'row' ? target : next.row, drag.kind === 'col' ? target : next.col, next);
      releaseBookmark(); tabSelection = null;
      window.getSelection()?.removeAllRanges();
      syncFolioHighlight();
      refocusHandle(drag.kind, target);
    }
    finishDragPreview(drag, destination);
  }
  function onHandlePointerUp(event) {
    if (!handleDrag) return;
    event.preventDefault();
    endHandleDrag(true);
  }
  function onHandlePointerCancel() {
    endHandleDrag(false);
  }
  function onHandleDragKey(event) {
    if (handleDrag && event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); endHandleDrag(false);
    }
  }
  document.addEventListener('pointermove', onHandlePointerMove);
  document.addEventListener('pointerup', onHandlePointerUp);
  document.addEventListener('pointercancel', onHandlePointerCancel);
  document.addEventListener('keydown', onHandleDragKey, true);
  // Compact contextual menu: Row and Column fly out as submenus (insertion,
  // move, duplicate, deletion, plus alignment for columns); sort and table
  // deletion stay top-level. Leaf items keep the same
  // `data-table-menu-action` hooks. Full keyboard model: arrows move within
  // the open level, Right/Enter opens a submenu, Left/Escape steps back out,
  // Home/End jump, focus auto-expands submenus, and focus leaving the menu
  // dismisses it. Submenus flip to the left and clamp vertically so they
  // never leave the viewport.
  const TABLE_MENU_TREE = [
    { label: 'Row', submenu: 'row', items: [
      ['insert-row-above', 'Insert row above'], ['insert-row-below', 'Insert row below'],
      ['move-row-up', 'Move row up'], ['move-row-down', 'Move row down'],
      ['duplicate-row', 'Duplicate row'], ['delete-row', 'Delete row']
    ] },
    { label: 'Column', submenu: 'column', items: [
      ['insert-column-left', 'Insert column left'], ['insert-column-right', 'Insert column right'],
      ['move-column-left', 'Move column left'], ['move-column-right', 'Move column right'],
      ['duplicate-column', 'Duplicate column'],
      ['align-left', 'Align left'], ['align-center', 'Align center'], ['align-right', 'Align right'],
      ['delete-column', 'Delete column']
    ] },
    { action: 'sort-ascending', label: 'Sort ascending' },
    { action: 'sort-descending', label: 'Sort descending' },
    { action: 'delete-table', label: 'Delete table', danger: true }
  ];
  function tableMenuCommand(action) {
    switch (action) {
      case 'insert-row-above': return addRowBefore;
      case 'insert-row-below': return addRowAfter;
      case 'insert-column-left': return addColumnBefore;
      case 'insert-column-right': return addColumnAfter;
      case 'delete-row': return deleteRow;
      case 'delete-column': return deleteColumn;
      case 'delete-table': return deleteTable;
      default: return TABLE_OP_NAMES.includes(action) ? resolveTableOp(action) : null;
    }
  }
  function closeTableMenu() {
    if (activePopup && activePopup.menu.classList.contains('folio-table-menu') && !activePopup.menu.classList.contains('folio-document-menu')) closePopup();
  }
  function markdownMenuItem(target) {
    // Rendered projection descendants can be replaced while the menu is
    // open. Keep the owning editor node as the stable source target.
    let offset = 0;
    for (const segment of model.segments) {
      const owner = view.nodeDOM(offset);
      if (owner === target || owner?.contains?.(target)) { target = owner; break; }
      offset += segment.node.nodeSize;
    }
    const item = document.createElement('button');
    item.type = 'button'; item.textContent = 'Edit Markdown';
    item.setAttribute('role', 'menuitem');
    item.disabled = options.isLocked() || !target || !!target.closest('.folio-source-edit');
    item.addEventListener('click', () => {
      closePopup();
      if (target?.isConnected) revealSourceBlock(target);
    });
    return item;
  }
  function openDocumentMenu(target, event) {
    closePopup();
    captureDOMSelection();
    if (target === view.dom) {
      const dom = view.domAtPos(view.state.selection.head).node;
      target = dom instanceof Element ? dom : dom.parentElement;
    }
    const menu = document.createElement('div');
    menu.className = 'folio-table-menu folio-document-menu';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Document menu');
    menu.tabIndex = -1;
    menu.append(markdownMenuItem(target));
    const separator = document.createElement('hr'); separator.setAttribute('role', 'separator');
    menu.append(separator);
    for (const [label, action] of [['Undo', 'undo'], ['Redo', 'redo'], ['Cut', 'cut'], ['Copy', 'copy'], ['Paste', 'paste'], ['Select all', 'select-all']]) {
      const item = document.createElement('button'); item.type = 'button'; item.textContent = label;
      item.setAttribute('role', 'menuitem');
      const historyAction = action === 'undo' || action === 'redo';
      item.disabled = !(historyAction ? options.undo : options.editClipboard) || (options.isLocked() && ['undo', 'redo', 'cut', 'paste'].includes(action));
      item.addEventListener('click', () => {
        closePopup();
        if (historyAction) { options.undo?.(action === 'redo'); view.focus(); return; }
        Promise.resolve(options.editClipboard?.(action)).catch(error => options.message?.(String(error)));
      });
      menu.append(item);
    }
    menu.addEventListener('keydown', event => {
      const items = [...menu.querySelectorAll('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); closePopup(); view.focus(); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); (items[index + 1] || items[0])?.focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); (items[index - 1] || items.at(-1))?.focus(); }
      else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); }
      else if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus(); }
    });
    menu.addEventListener('focusout', event => { if (!menu.contains(event.relatedTarget)) closePopup(); });
    activePopup = { menu, trigger: null };
    const hasPoint = !!(event.clientX || event.clientY);
    const point = hasPoint ? { left: event.clientX, bottom: event.clientY } : view.coordsAtPos(view.state.selection.head);
    positionPopup(menu, point);
    if (hasPoint) menu.focus();
    else menu.querySelector('button:not(:disabled)')?.focus();
  }
  function menuLeafButton(action, label, locked, danger) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.dataset.tableMenuAction = action;
    item.textContent = label;
    item.setAttribute('aria-label', label);
    if (danger) item.dataset.tableMenuDanger = 'true';
    item.disabled = locked;
    item.addEventListener('click', () => {
      closePopup();
      if (options.isLocked()) return;
      const cmd = tableMenuCommand(action);
      if (cmd && runTableCommand(cmd)) { try { view.focus(); } catch {} }
    });
    return item;
  }
  function openTableMenu(trigger, anchor, focusContainer = false) {
    if (!view) return;
    closePopup();
    if (!actionInfo()) return;
    const locked = options.isLocked();
    const menu = document.createElement('div');
    menu.className = 'folio-table-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Table menu');
    menu.tabIndex = -1;
    let openSub = null;
    const topButtons = [];
    const sourceItem = markdownMenuItem(tableInfo()?.wrapper);
    sourceItem.addEventListener('pointerenter', () => closeSubmenu(false));
    sourceItem.addEventListener('focus', () => closeSubmenu(false));
    menu.append(sourceItem);
    topButtons.push(sourceItem);
    function closeSubmenu(restoreFocus) {
      if (!openSub) return;
      const { wrap, btn, sub } = openSub;
      openSub = null;
      sub.hidden = true;
      try { btn.setAttribute('aria-expanded', 'false'); } catch {}
      wrap.classList.remove('sub-open');
      if (restoreFocus) { try { btn.focus(); } catch {} }
    }
    function openSubmenu(wrap, focusFirst) {
      const btn = wrap.querySelector(':scope > button');
      const sub = wrap.querySelector(':scope > .folio-table-submenu');
      if (!btn || !sub || btn.disabled) return;
      if (openSub && openSub.wrap === wrap) {
        if (focusFirst) {
          const first = sub.querySelector('button:not(:disabled)');
          if (first) first.focus();
        }
        return;
      }
      closeSubmenu(false);
      sub.hidden = false;
      // Clamp before measuring the flip: estimate below the parent, then
      // shift up if the real box would leave the viewport.
      const wrapRect = wrap.getBoundingClientRect();
      sub.classList.remove('open-left');
      sub.style.top = '';
      const estimate = Math.min(360, sub.children.length * 38 + 12);
      const top = Math.max(8, Math.min(wrapRect.top - 7, window.innerHeight - 8 - estimate));
      sub.style.top = `${Math.round(top - wrapRect.top)}px`;
      const box = sub.getBoundingClientRect();
      if (box.right > window.innerWidth - 8) sub.classList.add('open-left');
      if (box.bottom > window.innerHeight - 8) {
        const excess = box.bottom - (window.innerHeight - 8);
        sub.style.top = `${Math.round(top - wrapRect.top - excess)}px`;
      }
      openSub = { wrap, btn, sub };
      try { btn.setAttribute('aria-expanded', 'true'); } catch {}
      wrap.classList.add('sub-open');
      if (focusFirst) {
        const first = sub.querySelector('button:not(:disabled)');
        if (first) first.focus();
      }
    }
    menu.addEventListener('pointerleave', () => {
      // Letting the pointer leave the whole menu dismisses any open branch
      // (the menu itself stays until outside-dismissal).
      closeSubmenu(false);
    });
    for (const node of TABLE_MENU_TREE) {
      if (node.submenu) {
        const wrap = document.createElement('div');
        wrap.className = 'folio-table-subwrap';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.tableSubmenu = node.submenu;
        btn.setAttribute('aria-haspopup', 'true');
        btn.setAttribute('aria-expanded', 'false');
        const label = document.createElement('span');
        label.textContent = node.label;
        const arrow = document.createElement('span');
        arrow.className = 'folio-table-arrow';
        arrow.textContent = '›';
        arrow.setAttribute('aria-hidden', 'true');
        btn.append(label, arrow);
        btn.setAttribute('aria-label', `${node.label} submenu`);
        btn.title = `${node.label} submenu`;
        btn.disabled = locked;
        const sub = document.createElement('div');
        sub.className = 'folio-table-submenu';
        sub.setAttribute('role', 'menu');
        sub.setAttribute('aria-label', `${node.label} actions`);
        sub.hidden = true;
        for (const [action, labelText] of node.items) {
          sub.append(menuLeafButton(action, labelText, locked, /^delete-/.test(action)));
        }
        wrap.append(btn, sub);
        btn.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          if (btn.disabled) return;
          if (openSub && openSub.wrap === wrap) closeSubmenu(false);
          else openSubmenu(wrap, true);
        });
        btn.addEventListener('pointerenter', () => { if (!btn.disabled) openSubmenu(wrap, false); });
        wrap.addEventListener('pointerleave', () => closeSubmenu(false));
        sub.addEventListener('pointerenter', () => cancelHoverClear());
        menu.append(wrap);
        topButtons.push(btn);
      } else {
        const item = menuLeafButton(node.action, node.label, locked, node.danger);
        item.addEventListener('pointerenter', () => closeSubmenu(false));
        item.addEventListener('focus', () => closeSubmenu(false));
        menu.append(item);
        topButtons.push(item);
      }
    }
    menu.addEventListener('keydown', event => {
      const inSub = openSub && openSub.sub.contains(document.activeElement);
      const scope = inSub
        ? Array.from(openSub.sub.querySelectorAll('button:not(:disabled)'))
        : topButtons.filter(btn => !btn.disabled);
      const current = scope.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        if (inSub) closeSubmenu(true);
        else closePopup(true);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        (scope[current + 1] || scope[0])?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        (scope[current - 1] || scope[scope.length - 1])?.focus();
      } else if (event.key === 'Home') { event.preventDefault(); scope[0]?.focus(); }
      else if (event.key === 'End') { event.preventDefault(); scope[scope.length - 1]?.focus(); }
      else if (event.key === 'ArrowRight' || (event.key === 'Enter' && !inSub && document.activeElement?.hasAttribute('aria-haspopup'))) {
        const parent = document.activeElement?.closest?.('.folio-table-subwrap');
        if (parent && !inSub) { event.preventDefault(); openSubmenu(parent, true); }
      } else if (event.key === 'ArrowLeft') {
        if (inSub) { event.preventDefault(); closeSubmenu(true); }
      }
    });
    menu.addEventListener('focusout', event => {
      if (!menu.contains(event.relatedTarget)) closeTableMenu();
    });
    activePopup = { menu, trigger: trigger || null };
    try { trigger?.setAttribute?.('aria-expanded', 'true'); } catch {}
    positionPopup(menu, anchor || { left: window.innerWidth / 2, bottom: 88 });
    const first = menu.querySelector(':scope > button:not(:disabled), :scope > .folio-table-subwrap > button:not(:disabled)');
    if (focusContainer) menu.focus();
    else if (first) first.focus();
  }
  function openTableMenuFor(kind, index, trigger, coords) {
    const info = actionInfo();
    if (!info) return;
    let anchor = null;
    if (coords && Number.isFinite(coords.left) && Number.isFinite(coords.bottom)) anchor = coords;
    else if (trigger) {
      try {
        const rect = trigger.getBoundingClientRect();
        anchor = { left: rect.left, bottom: rect.bottom };
      } catch {}
    }
    // Selecting a different cell rebuilds the handle layer. Measure the
    // original button first, then use its replacement for focus restoration.
    if (!options.isLocked()) {
      if (kind === 'row') selectTableCell(index, info.col, info);
      else selectTableCell(info.row, index, info);
    }
    if (trigger && !trigger.isConnected) {
      trigger = handlesLayer.querySelector(kind === 'row' ? `[data-handle-row="${index}"]` : `[data-handle-col="${index}"]`);
    }
    openTableMenu(trigger || null, anchor);
  }
  view.dom.addEventListener('contextmenu', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !view.dom.contains(target) || target.closest('input,textarea,button,select')) return;
    const cellEl = target.closest ? target.closest('td, th') : null;
    if (!cellEl || !view.dom.contains(cellEl)) {
      event.preventDefault(); event.stopPropagation();
      openDocumentMenu(target, event);
      return;
    }
    let cell = null;
    try {
      cell = cellAround(view.state.doc.resolve(view.posAtDOM(cellEl, 0)));
    } catch { cell = null; }
    if (!cell) return;
    event.preventDefault();
    event.stopPropagation();
    if (!options.isLocked()) {
      try {
        const selection = Selection.near(cell);
        if (!view.state.selection.eq(selection)) view.dispatch(view.state.tr.setSelection(selection));
      } catch {}
    }
    const hasPoint = Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && (event.clientX !== 0 || event.clientY !== 0);
    let anchor = null;
    if (hasPoint) anchor = { left: event.clientX, bottom: event.clientY };
    else {
      try {
        const at = view.coordsAtPos(view.state.selection.from);
        if (at) anchor = { left: at.left, bottom: at.bottom };
      } catch {}
    }
    openTableMenu(null, anchor, hasPoint);
  });
  // Visibility follows one anchor: the hovered table/zone when the pointer
  // is over a table or its chrome, otherwise the selected table (keyboard /
  // touch path). Exactly one kind of control shows at a time: the hovered
  // edge's control, or — for a caret without hover — the caret row/column
  // handles plus both append buttons. Repositioning only moves overlays;
  // hovering never dispatches, so the source is never touched by pointing.
  let handleWrapper = null;
  function stableHandle(kind, index, wrapper) {
    const existing = handlesLayer.firstElementChild;
    const key = kind === 'row' ? 'handleRow' : 'handleCol';
    if (handleWrapper === wrapper && existing?.dataset[key] === String(index)) return existing;
    const button = makeHandle(kind, index);
    handlesLayer.replaceChildren(button);
    handleWrapper = wrapper;
    return button;
  }
  function syncTableChrome(rectangles) {
    if (!view) return;
    const locked = options.isLocked();
    let anchor = null;
    if (hoverAnchor && hoverAnchor.wrapper && hoverAnchor.wrapper.isConnected && hoverAnchor.table) {
      anchor = hoverAnchor;
    } else {
      if (hoverAnchor) hoverAnchor = null;
      const info = tableInfo();
      if (info && info.wrapper && info.wrapper.isConnected) anchor = { ...info, zone: 'selection' };
    }
    // A focused control pins its chrome open for keyboard users even when
    // the pointer is elsewhere.
    if (anchor && (handlesLayer.contains(document.activeElement)
        || document.activeElement === addRowBtn || document.activeElement === addColBtn)) {
      const info = tableInfo();
      if (info && info.wrapper && info.wrapper.isConnected) anchor = { ...info, zone: 'selection' };
    }
    addRowBtn.disabled = locked;
    addColBtn.disabled = locked;
    if (!anchor || !anchor.wrapper || !anchor.wrapper.isConnected) {
      addRowBtn.hidden = true;
      addColBtn.hidden = true;
      handlesLayer.hidden = true;
      dropLine.hidden = true;
      closeTableMenu();
      return;
    }
    const wrapRect = rectangles?.get(anchor.wrapper) || anchor.wrapper.getBoundingClientRect();
    if (wrapRect.bottom < 0 || wrapRect.top > window.innerHeight || wrapRect.width <= 0 || wrapRect.height <= 0) {
      addRowBtn.hidden = true;
      addColBtn.hidden = true;
      handlesLayer.hidden = true;
      dropLine.hidden = true;
      closeTableMenu();
      return;
    }
    if (handleDrag && !tableInfo()) { endHandleDrag(false); return; }
    const zone = anchor.zone || 'selection';
    const showRowHandle = zone === 'left' || (zone === 'selection' && document.activeElement?.dataset?.handleRow !== undefined);
    const showColHandle = zone === 'top' || (zone === 'selection' && document.activeElement?.dataset?.handleCol !== undefined);
    const showAddRow = zone === 'bottom' || (zone === 'selection' && document.activeElement === addRowBtn);
    const showAddCol = zone === 'right' || (zone === 'selection' && document.activeElement === addColBtn);
    addRowBtn.hidden = !showAddRow;
    addColBtn.hidden = !showAddCol;
    if (showAddRow) {
      const rowW = addRowBtn.offsetWidth || 28, rowH = addRowBtn.offsetHeight || 28;
      const rowLeft = Math.max(8, Math.min(window.innerWidth - rowW - 8, wrapRect.left + wrapRect.width / 2 - rowW / 2));
      let rowTop = wrapRect.bottom + 6;
      if (rowTop + rowH > window.innerHeight - 8) rowTop = Math.max(8, wrapRect.bottom - rowH - 6);
      addRowBtn.style.left = `${Math.round(rowLeft)}px`;
      addRowBtn.style.top = `${Math.round(rowTop)}px`;
    }
    if (showAddCol) {
      const colW = addColBtn.offsetWidth || 28, colH = addColBtn.offsetHeight || 28;
      let colLeft = wrapRect.right + 6;
      if (colLeft + colW > window.innerWidth - 8) colLeft = Math.max(8, wrapRect.right - colW - 6);
      const colTop = Math.max(8, Math.min(window.innerHeight - colH - 8, wrapRect.top + wrapRect.height / 2 - colH / 2));
      addColBtn.style.left = `${Math.round(colLeft)}px`;
      addColBtn.style.top = `${Math.round(colTop)}px`;
    }
    handlesLayer.hidden = !(showRowHandle || showColHandle);
    if (!showRowHandle && !showColHandle && handlesLayer.childElementCount) handlesLayer.replaceChildren();
    if (showRowHandle) {
      const r = Math.max(0, Math.min(anchor.height - 1, anchor.row));
      const btn = stableHandle('row', r, anchor.wrapper);
      btn.disabled = locked;
      const dom = cellDomAt(anchor, r, 0);
      const b = dom ? dom.getBoundingClientRect() : null;
      const y = b ? b.top + b.height / 2 : wrapRect.top + wrapRect.height * ((r + 0.5) / anchor.height);
      btn.style.left = `${Math.round(Math.max(8, wrapRect.left - 30))}px`;
      btn.style.top = `${Math.round(y - 12)}px`;
    }
    if (showColHandle) {
      const c = Math.max(0, Math.min(anchor.width - 1, anchor.col));
      const btn = stableHandle('col', c, anchor.wrapper);
      btn.disabled = locked;
      const dom = cellDomAt(anchor, 0, c);
      const b = dom ? dom.getBoundingClientRect() : null;
      const x = b ? b.left + b.width / 2 : wrapRect.left + wrapRect.width * ((c + 0.5) / anchor.width);
      btn.style.left = `${Math.round(x - 12)}px`;
      btn.style.top = `${Math.round(Math.max(8, wrapRect.top - 30))}px`;
    }
  }
  let tableChromeFrame = 0;
  const syncTableChromeOnScroll = () => {
    const focused = handlesLayer.contains(document.activeElement) ||
      document.activeElement === addRowBtn || document.activeElement === addColBtn;
    if (tableChromeFrame || (!hoverAnchor && !focused && handlesLayer.hidden && addRowBtn.hidden && addColBtn.hidden && !handleDrag)) return;
    tableChromeFrame = requestAnimationFrame(() => {
      tableChromeFrame = 0;
      try { syncTableChrome(); } catch {}
    });
  };
  window.addEventListener('scroll', syncTableChromeOnScroll, true);
  window.addEventListener('resize', syncTableChromeOnScroll);
  const refreshTableChrome = () => { try { syncTableChrome(); } catch {} };
  function revealSourceBlock(target) {
    if (options.isLocked() || !target || target.closest('.folio-source-edit')) return false;
    let offset = 0, index = -1;
    for (let i = 0; i < model.segments.length; i++) {
      const dom = view.nodeDOM(offset);
      if (dom === target || dom?.contains?.(target)) { index = i; break; }
      offset += model.segments[i].node.nodeSize;
    }
    const segment = model.segments[index];
    if (!segment) return false;
    // The source presentation is shorter than the rendered block it replaces
    // and sits on its own margins, so the swap would shift the block and can
    // scroll the reader out from under the user. Pin the block to the viewport
    // position it already had; a reveal must never move the text being read.
    const scroller = options.scroller || null;
    const anchored = scroller && target instanceof Element ? target.getBoundingClientRect() : null;
    // A rendered projection sits on the block rhythm (no top margin), while
    // the source card is a UA <pre> with its own larger margins. Carry the
    // projection's vertical margins onto the card so the swap is
    // position-neutral instead of nudging the block and the reader.
    const projection = target instanceof Element ? target.closest('.extension-block') : null;
    const projectionStyle = projection ? getComputedStyle(projection) : null;
    sourceCardMargins = projectionStyle ? { top: projectionStyle.marginTop, bottom: projectionStyle.marginBottom } : null;
    const oldCaret = richToSource(model, view.state.selection.head);
    const caret = oldCaret >= segment.from && oldCaret < segment.to ? Math.min(oldCaret, segment.to - (segment.raw.endsWith('\n') ? 1 : 0)) : segment.from;
    const candidate = parseSource(model.source, { from: segment.from, to: segment.to });
    setSelectionGuarded(false);
    model = candidate; bookmark = null;
    view.updateState(stateFor(candidate.doc, { anchor: caret, head: caret }));
    view.focus();
    if (anchored) {
      let start = 0;
      for (let i = 0; i < index && i < model.segments.length; i++) start += model.segments[i].node.nodeSize;
      const revealed = view.nodeDOM(start);
      const rect = revealed instanceof Element ? revealed.getBoundingClientRect() : null;
      const delta = rect ? rect.top - anchored.top : 0;
      if (delta) {
        const behavior = scroller.style.scrollBehavior;
        scroller.style.scrollBehavior = 'auto';
        scroller.scrollTop += delta;
        scroller.style.scrollBehavior = behavior;
      }
    }
    return true;
  }
  // Vertical margins for the in-place source card, taken from the block it
  // replaced (see revealSourceBlock).
  let sourceCardMargins = null;
  let sourcePress = null;
  view.dom.addEventListener('mousedown', event => {
    // Rendered projections must not arm a secondary-button selection: its
    // later mouseup would steal focus from the context menu.
    if (event.button === 2 && event.target instanceof Element && event.target.closest('.math-inline,.math-block,.html-inline,.extension-preview')) {
      event.preventDefault(); event.stopPropagation();
      return;
    }
    sourcePress = event.button === 0 ? { x:event.clientX, y:event.clientY } : null;
  }, true);
  const sourceGesture = event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('.folio-source-edit')) return;
    const selection = window.getSelection();
    if (event.type === 'click' && selection && !selection.isCollapsed) {
      // Atom clicks can leave a node selection (or the previous text range)
      // standing. A stationary primary click still reveals source; a drag
      // must keep its native reading range.
      const plainClick = event.detail === 1 && sourcePress && Math.hypot(event.clientX-sourcePress.x, event.clientY-sourcePress.y) < 6;
      if (!plainClick) return;
    }
    const control = target.closest('button,input,textarea,select');
    if (control) return;
    const sourceTarget = event.type === 'keydown' ? target.closest('.math-formula') : null;
    if (sourceTarget && revealSourceBlock(sourceTarget)) { event.preventDefault(); event.stopImmediatePropagation(); }
    else if (model.sourceEdit && event.type === 'click' && !target.closest('button,input,textarea')) {
      const selection = sourceSelection(view.state);
      model = parseSource(model.source); bookmark = null;
      view.updateState(stateFor(model.doc, selection)); view.focus();
    }
  };
  view.dom.addEventListener('focusout', () => {
    requestAnimationFrame(() => {
      if (view.isDestroyed || !model.sourceEdit || view.dom.contains(document.activeElement)) return;
      const selection = sourceSelection(view.state);
      model = parseSource(model.source); bookmark = null;
      view.updateState(stateFor(model.doc, selection));
    });
  });
  view.dom.addEventListener('click', sourceGesture, true);
  view.dom.addEventListener('dblclick', event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const divider = event.target instanceof Element ? event.target.closest('hr') : null;
    if (divider && view.dom.contains(divider) && revealSourceBlock(divider)) {
      event.preventDefault(); event.stopPropagation();
    }
  }, true);
  view.dom.addEventListener('keydown', event => {
    if (['Enter', ' '].includes(event.key) && event.target.closest?.('.math-formula')) sourceGesture(event);
  }, true);
  refreshers.add(refreshTableChrome);
  options.onContext?.(currentContext(view.state));
  try { syncTableChrome(); } catch {}
  // A drag ending outside the editor (or cancelled) still settles the guard.
  window.addEventListener('pointerup', releaseSelectionGuard);
  window.addEventListener('pointercancel', releaseSelectionGuard);
  window.addEventListener('blur', releaseSelectionGuard);
  // Mirror the live DOM range into the folio-selection custom highlight (see
  // above). Document-level so ranges leaving the reader clear the mirror.
  document.addEventListener('selectionchange', syncFolioHighlight);
  const dismissPopup = event => {
    if (!event.target.closest?.('.math-block,.math-inline') && clearFormulaNodeSelection()) {
      window.getSelection()?.removeAllRanges();
      syncFolioHighlight();
    }
    if (activePopup && !activePopup.menu.contains(event.target) && !activePopup.trigger?.contains(event.target)) closePopup();
  };
  document.addEventListener('pointerdown', dismissPopup, true);
  return {
    view,
    headings: () => headingMetadata.read(model),
    context: () => currentContext(view.state),
    captureSelection() {
      captureDOMSelection();
    },
    selection: () => sourceSelection(view.state),
    selectAll: () => selectAllLogical(view.state, view.dispatch, view),
    sourceAtCoords(coords) {
      const hit = view.posAtCoords(coords);
      return hit ? richToSource(model, hit.pos) : null;
    },
    coordsAtSource(offset) {
      return view.coordsAtPos(sourceToRich(model, offset));
    },
    setDocument(content, selection, meta = {}) {
      if (content !== model.source) {
        revision++; bookmark = null;
        if (!model.sourceEdit && fullReplacementUndoModel?.source === content) {
          model = fullReplacementUndoModel;
          fullReplacementUndoModel = null;
        } else {
          model = parseSource(content, model.sourceEdit ? { from: model.sourceEdit.from, to: model.sourceEdit.to + content.length - model.source.length } : null);
        }
        headingMetadata.reset();
        headingMetadata.read(model);
        const state = stateFor(model.doc, selection);
        view.updateState(state);
        if (meta.logical && selection) setBookmark(selection.anchor, selection.head, state);
      } else if (selection) {
        // A source offset that falls inside inter-block whitespace cannot be
        // represented by the parsed rich document. If the current rich caret
        // is a transient empty paragraph (for example after Enter at the start
        // of a paragraph), keep that paragraph instead of snapping to the next
        // block's first character; otherwise toggling presentations makes the
        // next character join the following paragraph as a soft break.
        const mapped = selection.anchor === selection.head
          ? sourceMapping(model, selection.anchor, { bias: 'right' }) : null;
        const current = view.state.selection;
        const transientEmpty = current instanceof TextSelection && current.empty
          && current.$from.parent.type === schema.nodes.paragraph
          && current.$from.parent.content.size === 0;
        if (mapped && (!mapped.exact || mapped.confidence !== 'exact') && transientEmpty) {
          bookmark = null;
          return;
        }
        // A zero-write presentation of the same logical selection must not
        // invalidate its bookmark (toggle/media/focus round trip).
        const unchanged = !meta.logical && bookmarkRange(view.state) &&
          bookmark.anchor === selection.anchor && bookmark.head === selection.head;
        if (unchanged) return;
        bookmark = null;
        const next = selectionAt(model.doc, sourceToRich(model, selection.anchor), sourceToRich(model, selection.head));
        view.dispatch(view.state.tr.setSelection(next).setMeta('folio-projection', true));
        if (meta.logical) setBookmark(selection.anchor, selection.head, view.state);
      }
      try { syncTableChrome(); } catch {}
    },
    setLocked() { view.setProps({ editable: () => !options.isUserLocked() }); for (const refresh of refreshers) refresh(); },
    setTransitionLocked() { for (const refresh of refreshers) refresh(); },
    refreshMedia() { for (const refresh of refreshers) refresh(); },
    setSearchHighlight,
    clearSearchHighlight,
    focus: () => view.focus(),
    command(name) {
      if (options.isLocked()) return;
      const commands = {
        bold: toggleMark(schema.marks.strong), italic: toggleMark(schema.marks.em), code: toggleMark(schema.marks.code), strike: toggleMark(schema.marks.strike),
        paragraph: setBlockType(schema.nodes.paragraph), heading: setBlockType(schema.nodes.heading, { level: 2 }),
        bullet: wrapInList(schema.nodes.bullet_list), numbered: wrapInList(schema.nodes.ordered_list), quote: wrapIn(schema.nodes.blockquote),
        row: addRowAfter, column: addColumnAfter, 'delete-row': deleteRow, 'delete-column': deleteColumn, 'delete-table': deleteTable,
        'insert-row-above': addRowBefore, 'insert-row-below': addRowAfter,
        'insert-column-left': addColumnBefore, 'insert-column-right': addColumnAfter
      };
      for (const op of TABLE_OP_NAMES) commands[op] = resolveTableOp(op);
      // Block-level commands write Markdown block syntax. Inside a table cell
      // that syntax cannot render (a cell is GFM inline content), and inside a
      // code block `setBlockType` would replace the fence with prose. Reject
      // both rather than silently corrupting the source.
      const blockCommands = new Set(['paragraph', 'heading', 'bullet', 'numbered', 'quote', 'table']);
      let inTable = isInTable(view.state);
      const { $from, from, to } = view.state.selection;
      let inCode = $from.parent.type.spec.code === true;
      if (blockCommands.has(name) && from < to) {
        view.state.doc.nodesBetween(from, to, node => {
          if (node.type.spec.tableRole === 'table') inTable = true;
          if (node.type.spec.code) inCode = true;
          return !inTable && !inCode;
        });
      }
      if (blockCommands.has(name) && (inTable || inCode)) {
        options.message?.(inTable
          ? 'Block formatting is not available inside a table cell.'
          : 'Block formatting is not available inside a code block.');
        return;
      }
      if (name === 'table') {
        const cell = header => schema.nodes[header ? 'table_header' : 'table_cell'].createAndFill();
        const table = schema.nodes.table.create(null, [schema.nodes.table_row.create(null, [cell(true), cell(true)]), schema.nodes.table_row.create(null, [cell(false), cell(false)])]);
        let tr = view.state.tr.replaceSelectionWith(table);
        // Drop the caret into the first cell so Insert > Table is immediately
        // usable. Find the inserted node by identity; mapping the old caret
        // across a block insertion is ambiguous when the paragraph is split.
        let tableFrom = -1;
        tr.doc.descendants((node, position) => { if (node === table) tableFrom = position; });
        try {
          if (tableFrom >= 0) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tableFrom + 3, tr.doc.content.size)), 1));
        } catch {}
        view.dispatch(tr.scrollIntoView());
      } else if (name === 'math' || name === 'link' || name === 'image') {
        // Author real Markdown syntax at the exact source selection. This is
        // what makes the toolbar buttons usable rather than only exposing an
        // empty source range: the selected text becomes the label/TeX/src when
        // it fits, and a placeholder stays selected for direct typing.
        if (!insertCommandSyntax(name)) revealCurrentSelection();
        view.focus();
        return;
      } else commands[name]?.(view.state, view.dispatch, view);
      view.focus();
    },
    destroy() {
      endHandleDrag(false);
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      if (tableChromeFrame) cancelAnimationFrame(tableChromeFrame);
      hoverPending = null;
      tableObserver?.disconnect();
      codeHighlightObserver?.disconnect();
      nearbyTables.clear();
      closePopup();
      try { addRowBtn.remove(); } catch {}
      try { addColBtn.remove(); } catch {}
      try { handlesLayer.remove(); } catch {}
      try { dropLine.remove(); } catch {}
      refreshers.delete(refreshTableChrome);
      window.removeEventListener('scroll', syncTableChromeOnScroll, true);
      window.removeEventListener('resize', syncTableChromeOnScroll);
      document.removeEventListener('pointermove', onHandlePointerMove);
      document.removeEventListener('pointerup', onHandlePointerUp);
      document.removeEventListener('pointercancel', onHandlePointerCancel);
      document.removeEventListener('keydown', onHandleDragKey, true);
      try { document.removeEventListener('pointermove', onTablePointerOver); } catch {}
      cancelHoverClear();
      hoverAnchor = null;
      document.removeEventListener('pointerdown', dismissPopup, true);
      document.removeEventListener('selectionchange', syncFolioHighlight);
      try { window.CSS.highlights.delete('folio-selection'); } catch {}
      window.removeEventListener('pointerup', releaseSelectionGuard);
      window.removeEventListener('pointercancel', releaseSelectionGuard);
      window.removeEventListener('blur', releaseSelectionGuard);
      view.destroy();
    }
  };
}
