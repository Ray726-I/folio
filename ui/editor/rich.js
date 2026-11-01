import { Fragment } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection, Selection, AllSelection } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark, setBlockType, wrapIn, chainCommands, exitCode } from 'prosemirror-commands';
import { splitListItem, sinkListItem, liftListItem, wrapInList } from 'prosemirror-schema-list';
import { fixTables, goToNextCell, addRowAfter, addRowBefore, addColumnAfter, addColumnBefore, deleteRow, deleteColumn, deleteTable, TableView, TableMap, findCell, CellSelection, selectedRect, moveTableRow, moveTableColumn, isInTable, cellAround, nextCell } from 'prosemirror-tables';
import { tableOperation } from './table-operations.js';
import { inputRules, wrappingInputRule, textblockTypeInputRule, InputRule } from 'prosemirror-inputrules';
import MarkdownIt from 'markdown-it';
import { decodeHTML, decodeHTMLAttribute } from 'entities';
import { schema, parseSource, updateSource, sourceToRich, richToSource, sourceMapping, richMapping, INLINE_HTML_SPAN_TAGS } from './model.js';
import { buildLedger, applySourcePatches } from './source-ledger.js';
import { tryTextEdits } from './source-edits.js';

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'OS', 'Super', 'Hyper']);

// Extension projections are sanitized HTML, not the document. To toggle a task
// inside one we map the rendered checkbox back to the single marker character
// in the exact raw source slice. This tokenizer deliberately does NOT use the
// rich model's extension fallback (that is what put the task list in a raw
// block in the first place); it only lists the source's own list items so
// fences, escaped markers and prose cannot contribute phantom positions.
const rawTaskTokenizer = new MarkdownIt({ html: true, linkify: false, typographer: false });
const RAW_TASK_LINE = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/;
const RAW_TASK_MARKER = /^[ xX]$/;

// A wheel gesture belongs to wherever it started. Track that for the whole
// gesture so a pointer that drifts over the formula source mid-scroll does not
// suddenly hand the page over to the textarea (and vice versa).
const WHEEL_GESTURE_GAP = 200;
let wheelGestureTarget = null, wheelGestureScroller = null, wheelGestureTime = -Infinity;
if (typeof document !== 'undefined') document.addEventListener('wheel', event => {
  const now = performance.now();
  if (now - wheelGestureTime > WHEEL_GESTURE_GAP) {
    wheelGestureTarget = event.target;
    wheelGestureScroller = scrollableAncestor(event.target);
  }
  wheelGestureTime = now;
}, { capture: true, passive: true });

// Engines treat a textarea as a scroll container even when it has no range, so
// a wheel over it is swallowed instead of reaching the reader. Find the reader
// the way the engine would and move it ourselves in that case.
function scrollableAncestor(element) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}
function scrollElementBy(node, top, left) {
  const nextTop = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, node.scrollTop + top));
  const nextLeft = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, node.scrollLeft + left));
  try { node.scrollTo({ top: nextTop, left: nextLeft, behavior: 'instant' }); }
  catch { node.scrollTop = nextTop; node.scrollLeft = nextLeft; }
}

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
  let revision = 0, bookmark = null, tabSelection = null, commitOutcome = null;
  const refreshers = new Set();

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
      for (const owner of ledger.owners) {
        const node = doc.nodeAt(owner.pmFrom);
        if (!node || !node.eq(owner.node)) { ledger = null; break; }
        owner.node = node;
      }
    }
    if (!ledger) {
      try { ledger = buildLedger(parsed.source, doc, { segments }); } catch { ledger = null; }
    }
    return { doc, source: parsed.source, prefix: parsed.prefix, segments, gaps: parsed.gaps, ledger };
  }

  function commitCandidate(candidate, nextSelection, typing) {
    const size = view.state.doc.content.size;
    const pmAnchor = sourceToRich(candidate, nextSelection.anchor);
    const pmHead = sourceToRich(candidate, nextSelection.head);
    let tr;
    try {
      tr = view.state.tr.replaceWith(0, size, candidate.doc.content);
      tr = tr.setSelection(TextSelection.between(tr.doc.resolve(pmAnchor), tr.doc.resolve(pmHead)));
      tr.setMeta('folio-source-commit', { model: candidate, selection: nextSelection, typing });
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
    try { parsed = parseSource(patched.source); }
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
    const committed = commitCandidate(parsed, { anchor, head }, origin === 'typing' || origin === 'paste');
    return { handled: true, committed };
  }

  const sourceSelection = state => {
    if (bookmarkRange(state)) return { anchor: bookmark.anchor, head: bookmark.head };
    return { anchor: richToSource(model, state.selection.anchor), head: richToSource(model, state.selection.head) };
  };
  const check = action => { if (!options.isLocked()) action(); };
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
  function revealAtomSource(pmPos, attrText, image = false) {
    if (options.isLocked()) return;
    const mapped = richMapping(model, pmPos, { bias: 'right' });
    const owner = mapped?.owner;
    const needle = String(attrText ?? '');
    let chosen = null;
    if (owner && Number.isInteger(owner.sourceFrom) && Number.isInteger(owner.sourceTo) && owner.sourceFrom < owner.sourceTo) {
      if (image) {
        const source = model.source;
        let depth = 0, close = -1;
        if (source.slice(owner.sourceFrom, owner.sourceFrom + 2) === '![') {
          for (let i = owner.sourceFrom + 2; i < owner.sourceTo; i++) {
            if (source[i] === '\\') { i++; continue; }
            if (source[i] === '[') depth++;
            else if (source[i] === ']') { if (depth) depth--; else { close = i; break; } }
          }
        }
        chosen = close < 0 ? null : inlineDestination(close, owner.sourceTo);
        if (!chosen) { options.message?.('This image destination cannot be edited safely.'); return; }
      } else {
      const inner = needle ? model.source.indexOf(needle, owner.sourceFrom) : -1;
      chosen = inner >= owner.sourceFrom && inner + needle.length <= owner.sourceTo
        ? { from: inner, to: inner + needle.length, current: needle }
        : { from: owner.sourceFrom, to: owner.sourceTo, current: model.source.slice(owner.sourceFrom, owner.sourceTo) };
      }
    } else if (Number.isInteger(mapped?.source)) {
      chosen = { from: mapped.source, to: mapped.source, current: '' };
    }
    if (!chosen) return;
    void editDestination({ title: 'Edit source', ...chosen, fallbackFrom: chosen.from, fallbackTo: chosen.to });
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
          checkbox.addEventListener('change', () => check(() => editor.dispatch(editor.state.tr.setNodeMarkup(getPos(), null, { ...node.attrs, checked: checkbox.checked }).setMeta('folio-action', true))));
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
    const formula = document.createElement('span'); formula.className = 'math-formula'; formula.title = 'Click to edit formula';
    formula.setAttribute('role', 'button'); formula.setAttribute('aria-label', 'Edit formula'); formula.tabIndex = 0;
    const panel = document.createElement('span'); panel.className = 'math-local-editor'; panel.hidden = true;
    const input = document.createElement('textarea'); input.setAttribute('aria-label', 'Formula source'); input.rows = node.isInline ? 2 : 4;
    const cancel = button('Cancel', () => { panel.hidden = true; formula.focus(); });
    const apply = button('Apply', () => {
      if (options.isLocked()) return;
      let pos; try { pos = getPos(); } catch { return; }
      let segment = null;
      editor.state.doc.forEach((child, offset, index) => { if (pos >= offset && pos < offset + child.nodeSize) segment = model.segments[index]; });
      if (!segment) { options.message('Could not safely locate this formula in the source.'); return; }
      const source = model.source.slice(segment.from, segment.to), tex = node.attrs.tex;
      const open = node.attrs.delimiter === '\\(' ? '\\(' : node.attrs.delimiter === '\\[' ? '\\[' : node.isInline ? '$' : '$$';
      const close = open === '\\(' ? '\\)' : open === '\\[' ? '\\]' : open;
      const start = source.indexOf(open), end = source.lastIndexOf(close);
      const exactInline = open + tex + close;
      const inlineStart = node.isInline ? source.indexOf(exactInline) : -1;
      const inner = node.isInline ? (inlineStart < 0 ? -1 : inlineStart + open.length) : source.indexOf(tex, Math.max(0, start + open.length));
      if (start < 0 || end < start || inner < 0 || inner + tex.length > end ||
          (node.isInline ? source.indexOf(exactInline, inlineStart + 1) >= 0 : source.indexOf(tex, inner + 1) >= 0)) {
        options.message('Could not safely locate this formula in the source.'); return;
      }
      const from = segment.from + inner, to = from + tex.length;
      const result = replaceLogicalSelection(input.value, 'command', { from, to, all: false, collapsed: false });
      if (result.committed) { panel.hidden = true; editor.focus(); }
    });
    // Wheel gestures over the formula source belong to that textarea only while
    // it can actually move. At either edge, or when the gesture began
    // elsewhere, the delta continues on the page's own scroller instead.
    input.addEventListener('wheel', event => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (input.disabled) return;
      // Wheel deltas arrive in pixels, lines or pages depending on the device.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? input.clientHeight : 1;
      const deltaX = (event.shiftKey ? event.deltaY : event.deltaX) * unit, deltaY = event.shiftKey ? 0 : event.deltaY * unit;
      if (wheelGestureTarget && wheelGestureTarget !== input && !input.contains(wheelGestureTarget)) {
        // The gesture is not ours. Continue it on whatever it started on so the
        // page does not jump back to the formula just because the pointer
        // drifted across it.
        if (!wheelGestureScroller) return;
        event.preventDefault(); event.stopPropagation();
        scrollElementBy(wheelGestureScroller, deltaY, deltaX);
        return;
      }
      const maximumTop = Math.max(0, input.scrollHeight - input.clientHeight), maximumLeft = Math.max(0, input.scrollWidth - input.clientWidth);
      const canScrollX = deltaX !== 0 && maximumLeft > 0 && (deltaX < 0 ? input.scrollLeft > 0 : input.scrollLeft < maximumLeft - 0.5);
      const canScrollY = deltaY !== 0 && maximumTop > 0 && (deltaY < 0 ? input.scrollTop > 0 : input.scrollTop < maximumTop - 0.5);
      if (!canScrollX && !canScrollY) {
        const reader = scrollableAncestor(input);
        if (!reader) return;
        event.preventDefault(); event.stopPropagation();
        scrollElementBy(reader, deltaY, deltaX);
        return;
      }
      event.preventDefault(); event.stopPropagation();
      if (canScrollY) input.scrollTop = Math.max(0, Math.min(maximumTop, input.scrollTop + deltaY));
      if (canScrollX) input.scrollLeft = Math.max(0, Math.min(maximumLeft, input.scrollLeft + deltaX));
    }, { passive: false });
    panel.append(input, apply, cancel);
    const openEditor = () => {
      if (options.isLocked()) return;
      if (!panel.hidden) return;
      input.value = node.attrs.tex; panel.hidden = false; input.focus();
    };
    formula.addEventListener('click', event => {
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault(); event.stopPropagation(); openEditor();
    });
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
    formula.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openEditor(); } });
    dom.append(formula, panel); let generation = 0;
    const render = async () => {
      const tex = panel.hidden ? node.attrs.tex : input.value;
      const current = ++generation; formula.textContent = tex; formula.classList.remove('math-error');
      try { const katex = await options.loadKatex(); if (current !== generation) return; katex.render(tex, formula, { displayMode: !node.isInline, throwOnError: true, trust: false, strict: 'warn' }); }
      catch { if (current === generation) { formula.textContent = tex; formula.classList.add('math-error'); formula.title = 'Formula could not be rendered. Its source is preserved.'; } }
      formula.setAttribute('aria-disabled', String(options.isLocked()));
    };
    input.addEventListener('input', render);
    cancel.addEventListener('click', render);
    render(); const refresh = () => { formula.setAttribute('aria-disabled', String(options.isLocked())); input.disabled = options.isLocked(); apply.disabled = options.isLocked(); }; refreshers.add(refresh);
    return { dom, update(next) { if (next.type !== node.type) return false; if (next.sameMarkup(node) && next.textContent === node.textContent) { node = next; return true; } node = next; render(); return true; }, stopEvent: event => {
      // The local editor's own controls keep their events; pointer events on
      // the formula itself must reach the editor so a single click selects the
      // atom (and a double-click can then open the source editor).
      if (event.target?.closest?.('.math-local-editor')) return true;
      return !['mousedown', 'mouseup', 'click', 'dblclick'].includes(event.type);
    }, ignoreMutation: () => true, destroy() { generation++; refreshers.delete(refresh); } };
  }
  function imageView(node, editorView, getPos) {
    const dom = document.createElement('span'); dom.className = 'image-widget'; dom.contentEditable = 'false'; let generation = 0;
    const lease = options.reserveImage();
    const edit = button('Edit image', () => {
      if (options.isLocked()) return;
      let pos = null;
      try { pos = getPos(); } catch { pos = null; }
      if (pos != null) revealAtomSource(pos, node.attrs.src, true);
      else revealCurrentSelection();
    });
    edit.setAttribute('aria-label', 'Edit image'); edit.title = 'Edit image source';
    const render = async (consent = false) => {
      const current = ++generation; dom.replaceChildren();
      lease.assign('');
      const caption = document.createElement('span'); caption.className = 'image-caption'; caption.textContent = node.attrs.alt || 'Image'; dom.append(caption);
      edit.disabled = options.isLocked();
      dom.append(edit);
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
    const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'Diagram source'; details.append(summary, pre);
    // Opening or focusing the source is an explicit editing intent. A later
    // successful render may close source that it opened automatically for an
    // error, but it must never close the editor out from under the user.
    let sourceTouched = false, sourceAutoOpened = false;
    summary.addEventListener('click', () => { sourceTouched = true; });
    details.addEventListener('focusin', () => { sourceTouched = true; });
    details.addEventListener('toggle', () => { if (!details.open) sourceAutoOpened = false; });
    let generation = 0, source = null, theme = null, abortController = null, renderTimer = 0;
    let highlightGeneration = 0, highlightTimer = 0, highlightedSource = null, highlightedLanguage = null;
    dom.addEventListener('focusin', () => dom.classList.add('code-editing'));
    dom.addEventListener('focusout', () => requestAnimationFrame(() => { if (!dom.contains(document.activeElement)) dom.classList.remove('code-editing'); }));
    const clearHighlight = () => {
      highlightGeneration++; clearTimeout(highlightTimer);
      highlightCode.replaceChildren(); dom.classList.remove('code-highlighted');
      highlightedSource = null; highlightedLanguage = null;
    };
    const scheduleHighlight = language => {
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
      const language = node.attrs.params.trim().split(/\s/)[0]; dom.dataset.language = language;
      if (language === 'math') {
        clearHighlight(); clearTimeout(renderTimer); renderTimer = 0; abortController?.abort(); source = null; theme = null;
        dom.classList.remove('mermaid-host'); delete dom.dataset.mermaidSource; delete dom.dataset.diagramState;
        summary.textContent = 'Math source';
        if (pre.parentNode !== details) details.append(summary, pre);
        if (!drawing.isConnected || !details.isConnected) dom.replaceChildren(drawing, details);
        const current = ++generation, tex = node.textContent;
        drawing.className = 'math-block math-formula'; drawing.textContent = tex;
        try {
          const katex = await options.loadKatex();
          if (current !== generation || !dom.isConnected) return;
          katex.render(tex, drawing, { displayMode: true, throwOnError: true, trust: false, strict: 'warn' });
        } catch {
          if (current !== generation) return;
          drawing.textContent = 'Formula could not be rendered. Its source is preserved.';
          drawing.classList.add('math-error'); details.open = true;
        }
        return;
      }
      if (language !== 'mermaid') {
        generation++; clearTimeout(renderTimer); renderTimer = 0; abortController?.abort(); source = null; theme = null;
        dom.classList.remove('mermaid-host'); delete dom.dataset.mermaidSource; delete dom.dataset.diagramState;
        code.className = /^[a-z0-9_+#.-]+$/i.test(language) ? `language-${language}` : '';
        if (pre.parentNode !== dom || highlight.nextSibling !== pre) dom.replaceChildren(highlight, pre);
        scheduleHighlight(language);
        return;
      }
      clearHighlight();
      summary.textContent = 'Diagram source';
      dom.classList.add('mermaid-host'); dom.dataset.mermaidSource = node.textContent;
      if (pre.parentNode !== details) details.append(summary, pre);
      if (!drawing.isConnected || !details.isConnected) dom.replaceChildren(drawing, details);
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
            // Only an error-opened source auto-collapses, and only when the
            // user has not opened or focused it since. A user-opened source
            // stays open for the whole editing session.
            if (sourceAutoOpened && !sourceTouched && !details.contains(document.activeElement)) details.open = false;
            sourceAutoOpened = false;
          } else {
            drawing.textContent = outcome?.error?.code === 'unsupported_external_images' ? 'This diagram needs external images, which are blocked while rendering offline.' : 'Mermaid diagram could not be rendered.';
            drawing.className = 'mermaid-error'; code.className = 'mermaid-source';
            dom.dataset.diagramState = 'error';
            if (!details.open) { sourceAutoOpened = true; details.open = true; }
          }
        } catch {
          if (current !== generation || !dom.isConnected) return;
          drawing.textContent = 'Mermaid diagram could not be rendered.';
          drawing.className = 'mermaid-error'; code.className = 'mermaid-source';
          dom.dataset.diagramState = 'error';
          if (!details.open) { sourceAutoOpened = true; details.open = true; }
        }
      }, hadDiagram ? 120 : 0);
    };
    render(); refreshers.add(render);
    return { dom, contentDOM: code, update(next) { if (next.type !== node.type) return false; if (next.sameMarkup(node) && next.textContent === node.textContent) { node = next; return true; } node = next; render(); return true; }, ignoreMutation: mutation => mutation.type === 'attributes' || !pre.contains(mutation.target), destroy() { generation++; clearTimeout(renderTimer); clearTimeout(highlightTimer); highlightGeneration++; abortController?.abort(); refreshers.delete(render); } };
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
      const rendered = view?.dom.querySelectorAll('.extension-preview, .html-inline');
      if (!rendered || !rendered.length) return false;
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        for (const node of rendered) if (range.intersectsNode(node)) return true;
      }
    } catch {}
    return false;
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
    if (!selectionGuarded) return;
    // A standing reading range keeps its guard; anything else hands selection
    // back to the editor so typing and caret movement stay predictable.
    if (renderedRangeActive()) return;
    setSelectionGuarded(false);
    try { view?.domObserver.flush(); } catch {}
  }
  function resyncGuardedSelection() {
    if (!selectionGuarded) return;
    setSelectionGuarded(false);
    try { view?.domObserver.flush(); } catch {}
  }
  function selectionIncludesRenderedAtom() {
    try {
      const selection = view?.state?.selection;
      if (!selection || selection.empty) return false;
      let found = false;
      view.state.doc.nodesBetween(selection.from, selection.to, node => {
        if (node.type.name === 'raw_block' || node.type.name === 'raw_inline') { found = true; return false; }
      });
      return found;
    } catch { return false; }
  }
  // Clipboard text for a reading range that covers rendered projections. Clone
  // the DOM range instead of using the ProseMirror serializer (which would emit
  // literal Markdown for raw atoms) and strip editor-only actions/backing
  // layers so a selection never copies both rendered text and its source.
  // Attaching the clone offscreen keeps innerText's block line breaks.
  function cleanedRangeText(range) {
    if (!range || range.collapsed) return null;
    const fragment = range.cloneContents();
    if (!fragment || !fragment.childNodes.length) return null;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:720px;pointer-events:none;';
    host.append(fragment);
    host.querySelectorAll('.extension-actions, button, input, [aria-hidden="true"]').forEach(node => node.remove());
    document.body.append(host);
    try {
      const text = host.innerText ?? host.textContent ?? '';
      return text || null;
    } finally { host.remove(); }
  }
  function renderedDomText(node, pos) {
    let dom = null;
    try { dom = view.nodeDOM(pos); } catch {}
    if (!dom || typeof dom.cloneNode !== 'function') return node.textContent;
    const clone = dom.cloneNode(true);
    clone.querySelectorAll('.extension-actions, button, input, [aria-hidden="true"]').forEach(child => child.remove());
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:720px;pointer-events:none;';
    host.append(clone);
    document.body.append(host);
    try { return host.innerText ?? host.textContent ?? node.textContent; }
    finally { host.remove(); }
  }
  // Keyboard selections can cover an atom without the browser's native range
  // covering its rendered DOM. Mirror textBetween but substitute the rendered
  // projection for stored source, so copy never emits literal Markdown.
  function renderedSelectionText(from, to) {
    let text = '', first = true;
    try {
      view.state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name === 'raw_block') {
          const nodeText = renderedDomText(node, pos);
          if (first) first = false; else text += '\n\n';
          text += nodeText;
          return false;
        }
        const nodeText = node.isText ? node.text.slice(Math.max(from, pos) - pos, to - pos)
          : !node.isLeaf ? ''
          : node.type.name === 'hard_break' ? '\n'
          : node.type.name === 'raw_inline' ? renderedDomText(node, pos)
          : node.type.spec.leafText ? node.type.spec.leafText(node) : '';
        if (node.isBlock && (node.isLeaf && nodeText || node.isTextblock)) {
          if (first) first = false; else text += '\n\n';
        }
        text += nodeText;
      }, 0);
    } catch { return null; }
    return text || null;
  }
  function copyRenderedSelection(event) {
    const data = event.clipboardData;
    if (!data) return false;
    // A live mouse/pointer range is authoritative for partial readings,
    // including selections that start or end inside a projection. Keyboard
    // selections over an atom need the state-aware text builder instead.
    let text = null;
    if (renderedRangeActive()) {
      try { text = cleanedRangeText(window.getSelection().getRangeAt(0)); } catch {}
    }
    if (text === null && selectionIncludesRenderedAtom()) {
      const selection = view.state.selection;
      text = renderedSelectionText(selection.from, selection.to);
    }
    if (text === null) return false;
    event.preventDefault();
    try { data.setData('text/plain', text); } catch { return false; }
    return true;
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
  function folioHighlightRanges(range) {
    const result = [];
    const root = range.commonAncestorContainer;
    const scope = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
    if (!scope || !view.dom.contains(scope)) return result;
    // Fast path: nothing inside needs native-only painting.
    if (typeof scope.querySelector !== 'function' || !scope.querySelector('.code-surface code')) {
      result.push(range.cloneRange());
      return result;
    }
    // Slow path: split around token-highlighted code, whose glyphs must stay
    // transparent over the token layer. Per MDN the `how` argument names the
    // SOURCE point first (END_TO_START compares this.start to source.end),
    // so the receiver/argument order below is deliberate and covered by
    // reading-custom-highlight.
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
      // Token-highlighted code keeps its native painting (wash background
      // with transparent text over the token layer); everything else is
      // mirrored per fragment.
      if (text.parentElement && text.parentElement.closest('.code-surface code')) continue;
      const part = intersects(text);
      if (part) result.push(part);
    }
    return result;
  }
  function applyFolioRanges(ranges) {
    if (!customHighlightSupported || !view) return;
    if (!ranges.length) {
      if (folioPaintActive) {
        folioPaintActive = false;
        try { window.CSS.highlights.delete(folioHighlightName); } catch {}
        view.dom.classList.remove('folio-paint');
      }
      return;
    }
    try {
      window.CSS.highlights.set(folioHighlightName, new Highlight(...ranges));
      if (!folioPaintActive) {
        folioPaintActive = true;
        view.dom.classList.add('folio-paint');
      }
    } catch {
      // Registry hiccup (detached nodes?): fall back to native painting.
      folioPaintActive = false;
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
    if (!customHighlightSupported || !view) return;
    const selection = window.getSelection();
    let ranges = [];
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed
      && view.dom.contains(selection.anchorNode) && view.dom.contains(selection.focusNode)
      && !view.dom.classList.contains('ProseMirror-hideselection')) {
      try { ranges = folioHighlightRanges(selection.getRangeAt(0)); }
      catch { ranges = []; }
    }
    // A standing find highlight survives selectionchange events that belong
    // to the find field (the native document selection is empty there).
    if (!ranges.length && paintSearchHighlight()) return;
    applyFolioRanges(ranges);
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
    const guardMutation = event => { event.preventDefault(); };
    dom.addEventListener('beforeinput', guardMutation);
    dom.addEventListener('drop', guardMutation);
    dom.addEventListener('dragstart', guardMutation);
    // Author links behave like Markdown links: plain click reveals the exact
    // source in the source presentation for editing, Ctrl/Cmd-click opens.
    // Other inline elements have no click action; the atom selects normally.
    dom.addEventListener('click', event => {
      const anchor = event.target.closest('a');
      if (!anchor || event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || options.isLocked()) return;
      let pos = null;
      try { pos = getPos(); } catch { pos = null; }
      if (pos == null) return;
      event.preventDefault();
      event.stopPropagation();
      revealAtomSource(pos, anchor.getAttribute('href') || '');
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
    const actions = document.createElement('div'); actions.className = 'extension-actions';
    const editLabel = /^---\n/.test(node.textContent) ? 'Edit front matter' : 'Edit source';
    // In-place source editing: this block's literal Markdown opens in a
    // textarea inside the block and commits through the exact source splice,
    // so editing never requires switching the whole document to a text engine.
    const panel = document.createElement('div'); panel.className = 'extension-source-editor'; panel.hidden = true;
    const sourceInput = document.createElement('textarea');
    sourceInput.setAttribute('aria-label', `${editLabel} for this block`);
    sourceInput.spellcheck = false;
    sourceInput.rows = Math.min(24, Math.max(3, node.textContent.split('\n').length));
    const commitSource = () => {
      if (options.isLocked()) return;
      const frame = sourceFrame();
      if (!frame) { options.message('Could not safely locate this block in the source.'); return; }
      if (sourceInput.value === model.source.slice(frame.from, frame.to)) { panel.hidden = true; edit.focus(); return; }
      const outcome = replaceLogicalSelection(sourceInput.value, 'command', { from: frame.from, to: frame.to, all: false, collapsed: false });
      if (outcome.committed) { panel.hidden = true; editor.focus(); }
    };
    // Only reachable when the ledger cannot prove an exact byte range for this
    // block. Kept until the source presentation is removed.
    const revealFallback = () => {
      let pos = null;
      try { pos = getPos(); } catch { pos = null; }
      if (pos != null) {
        const owner = model.ledger?.owners?.find(entry => entry.pmFrom === pos && entry.type === 'raw_block');
        if (owner && Number.isInteger(owner.sourceFrom) && Number.isInteger(owner.sourceTo)) {
          options.revealSource?.(owner.sourceFrom, owner.sourceTo);
          return;
        }
        try {
          const mapped = richMapping(model, pos + 1, { bias: 'right' });
          const fallback = mapped?.owner;
          if (fallback && Number.isInteger(fallback.sourceFrom) && Number.isInteger(fallback.sourceTo)) {
            options.revealSource?.(fallback.sourceFrom, fallback.sourceTo);
            return;
          }
        } catch {}
      }
      revealCurrentSelection();
    };
    const edit = button(editLabel, () => {
      if (options.isLocked()) return;
      const frame = sourceFrame();
      if (!frame) { revealFallback(); return; }
      sourceInput.value = model.source.slice(frame.from, frame.to);
      panel.hidden = false;
      sourceInput.focus();
      sourceInput.select();
    });
    edit.classList.add('extension-edit');
    edit.setAttribute('aria-label', `${editLabel} for this block`);
    edit.title = 'Edit this block’s Markdown in place';
    sourceInput.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); panel.hidden = true; edit.focus(); return; }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commitSource(); }
    });
    const applySource = button('Apply', commitSource);
    const cancelSource = button('Cancel', () => { panel.hidden = true; edit.focus(); });
    panel.append(sourceInput, applySource, cancelSource);
    actions.append(edit);
    dom.append(projection, actions, panel);
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
      invalidateTasks();
      try {
        const html = await options.renderExtension(source);
        if (generation === current && source === node.textContent && dom.isConnected) {
          projection.innerHTML = html; mountedSource = source; syncTaskControls();
          void mountAuthorImages(source, projection, () => generation !== current || !dom.isConnected);
        }
      }
      catch { if (current === generation) projection.textContent = 'Rendered view unavailable. Use Edit source to inspect the exact Markdown.'; }
    };
    let lastRemote = options.remoteImages();
    const refresh = () => {
      const remote = options.remoteImages();
      if (remote !== lastRemote) {
        lastRemote = remote; generation++; invalidateTasks();
        if (!remote) projection.querySelectorAll('img').forEach(img => { img.removeAttribute('srcset'); img.removeAttribute('src'); });
      }
      edit.disabled = options.isLocked(); applySource.disabled = options.isLocked(); sourceInput.disabled = options.isLocked();
      if (options.isLocked()) panel.hidden = true;
      syncEditability(); syncTaskControls(); Promise.resolve().then(render);
    };
    refreshers.add(refresh); refresh();
    const removeListeners = () => { refreshers.delete(refresh); };
    // Atom view: the literal source is not mounted in the reading DOM, so no
    // duplicate selectable text exists here. Source edits go through the
    // in-place panel above; task checkboxes are the one bounded exception,
    // because their whole state is one marker character in the exact raw slice.
    return { dom, update(next) { if (next.type !== node.type) return false; const same = next.sameMarkup(node) && next.textContent === node.textContent; if (!same) { generation++; invalidateTasks(); } node = next; if (!same) Promise.resolve().then(render); return true; }, ignoreMutation: () => true, stopEvent: event => event.target.closest?.('.extension-source-editor, button, input[type="checkbox"]') != null, destroy() { generation++; removeListeners(); } };
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
      return replaceLogicalSelection('', 'delete', range).handled;
    };
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
    ].map(([pattern, mark]) => new InputRule(pattern, (state, match, start, end) => state.tr.insertText(match[1], start, end).addMark(start, start + match[1].length, schema.marks[mark].create()).removeStoredMark(schema.marks[mark]))),
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
        // Inline heading source: when the caret (or selection anchor) sits
        // inside a heading, reveal its exact Markdown line (marker AND text,
        // e.g. `### Slide …`) as an editable input before the heading text —
        // no popup, no toolbar. The input is a decoration widget outside the
        // document: it never joins heading text, copy output or the
        // ProseMirror selection, so the marker cannot leak into the canonical
        // text. While open, the rendered heading text is hidden by CSS so the
        // line reads exactly once, as pure Markdown. Committing replaces the
        // verified line bytes through the source-first path (reparse + undo
        // preserved, keystrokes commit live with caret kept); Escape or blur
        // cancels without touching the file. Non-ATX sources fail closed
        // with a message.
        let activeHeading = -1;
        try {
          const $from = state.selection.$from;
          for (let depth = $from.depth; depth > 0; depth--) {
            if ($from.node(depth).type === schema.nodes.heading) { activeHeading = $from.before(depth); break; }
          }
        } catch {}
        state.doc.descendants((node, pos) => {
          if (node.type !== schema.nodes.heading || pos !== activeHeading) return;
          const line = headingLineRange(pos);
          if (!line) return;
          if (node.content.size > 0) {
            widgets.push(Decoration.inline(pos + 1, pos + 1 + node.content.size, { class: 'folio-heading-source-dim' }));
          }
          widgets.push(Decoration.widget(pos + 1, () => {
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'folio-heading-source';
            input.setAttribute('aria-label', `Heading source, level ${node.attrs.level}`);
            input.title = 'Edit heading Markdown (Enter to apply, Escape to cancel)';
            input.spellcheck = false;
            input.autocomplete = 'off';
            const original = line.text;
            input.value = original;
            input.size = Math.max(1, Math.min(72, original.length));
            let done = false;
            let composing = false;
            const revert = () => { input.value = original; input.size = Math.max(1, Math.min(72, original.length)); };
            const commit = () => {
              if (options.isLocked()) { revert(); return; }
              done = commitHeadingLine(pos, input.value, original);
              if (!done) revert();
            };
            const refresh = () => { input.disabled = options.isLocked(); };
            input.folioRefresh = refresh; refreshers.add(refresh); refresh();
            const updateSourceWhileTyping = () => {
              input.size = Math.max(1, Math.min(72, input.value.length));
              if (composing || options.isLocked() || !/^( {0,3})(#{1,6})[ \t]+/.test(input.value)) return;
              const value = input.value, start = input.selectionStart, end = input.selectionEnd;
              if (value === original) return;
              if (!commitHeadingLine(pos, value, original, { typing: true, start, end })) return;
              // Trailing source whitespace has no rich position and can map
              // to the next block. Keep the projection anchored to this
              // heading while its source input remains active.
              const heading = view.state.doc.nodeAt(pos);
              if (heading?.type === schema.nodes.heading && view.state.selection.$from.parent !== heading) {
                const caret = Math.min(pos + heading.nodeSize - 1, pos + 1 + heading.content.size);
                view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, caret)));
              }
              const dom = view.nodeDOM(pos);
              const next = dom instanceof HTMLElement ? dom.querySelector('.folio-heading-source') : null;
              if (next instanceof HTMLInputElement) {
                next.focus(); next.setSelectionRange(Math.min(start, next.value.length), Math.min(end, next.value.length));
              }
            };
            input.addEventListener('compositionstart', () => { composing = true; });
            input.addEventListener('compositionend', () => { composing = false; updateSourceWhileTyping(); });
            input.addEventListener('input', updateSourceWhileTyping);
            input.addEventListener('keydown', event => {
              event.stopPropagation();
              // Undo/redo from inside the input goes through the shell history
              // (the rebuilt input owns no native undo stack after a live
              // commit). The caret is restored onto the rebuilt input so
              // repeated undo keeps typing context instead of dropping focus.
              const mod = event.ctrlKey || event.metaKey;
              if (mod && !event.altKey && (event.key === 'z' || event.key === 'Z' || event.key === 'y' || event.key === 'Y') && !composing) {
                event.preventDefault();
                if (options.isLocked()) return;
                const caret = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
                try { options.undo(event.key.toLowerCase() === 'y' || event.shiftKey); } catch {}
                try {
                  const dom = view.nodeDOM(pos);
                  const next = dom instanceof HTMLElement ? dom.querySelector('.folio-heading-source') : null;
                  if (next instanceof HTMLInputElement) {
                    next.focus();
                    const at = Math.max(0, Math.min(next.value.length, caret));
                    next.setSelectionRange(at, at);
                  }
                } catch {}
                return;
              }
              if (event.key === 'Enter') { event.preventDefault(); commit(); }
              else if (event.key === 'Escape') { event.preventDefault(); done = true; revert(); try { view.focus(); } catch {} }
            });
            input.addEventListener('blur', () => { if (!done) revert(); });
            return input;
          }, { side: -1, stopEvent: () => true, destroy: node => refreshers.delete(node.folioRefresh) }));
        });
        widgets.push(Decoration.widget(state.doc.content.size, () => {
          const input = document.createElement('textarea');
          input.className = 'editor-trailing-input'; input.rows = 1;
          input.setAttribute('aria-label', 'Write a new paragraph at the end of the document');
          input.placeholder = 'Type / for blocks…';
          const refresh = () => { input.disabled = options.isLocked(); };
          input.folioRefresh = refresh; refreshers.add(refresh); refresh();
          let composing = false;
          const commit = () => {
            if (composing || !input.value || options.isLocked()) return;
            if (input.value === '/') { input.value = ''; openSlashMenu(input, true); return; }
            const text = input.value;
            const source = model.source, newline = source.includes('\r\n') ? '\r\n' : '\n';
            const separator = !source || /(?:\r?\n){2}$/.test(source) ? '' : /\n$/.test(source) ? newline : newline + newline;
            const end = source.length;
            const result = replaceLogicalSelection(separator + text, 'typing', { from: end, to: end, all: false, collapsed: true });
            if (result.committed) { input.value = ''; view.focus(); }
          };
          input.addEventListener('compositionstart', () => { composing = true; });
          input.addEventListener('compositionend', () => { composing = false; commit(); });
          input.addEventListener('input', commit);
          return input;
        }, { side: 1, stopEvent: () => true, destroy: node => refreshers.delete(node.folioRefresh) }));
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
      inputRules({ rules }),
      keymap({
        'Mod-b': toggleMark(schema.marks.strong), 'Mod-i': toggleMark(schema.marks.em), 'Mod-`': toggleMark(schema.marks.code),
        'Mod-a': selectAllLogical, 'F2': () => focusHeadingMarker(),
        Backspace: deleteLogical(true), Delete: deleteLogical(false),
        'Shift-Enter': insertSoftBreak,
        Enter: chainCommands(enterLogical, tableEnter, completeDivider, splitListItem(schema.nodes.list_item), baseKeymap.Enter),
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
    return { table: isInTable(state), heading };
  }
  let activePopup = null;
  // Pending plain-press on a heading for click-to-edit: a plain left press
  // (no modifiers) records its point so the later click can tell a tap from
  // a drag. Anything else (modifiers, lock, the source input itself) leaves
  // this null and the click path below does nothing.
  let headingPress = null;
  function closePopup(restore = false) {
    if (!activePopup) return;
    const { menu, trigger } = activePopup; activePopup = null;
    trigger?.setAttribute('aria-expanded', 'false'); menu.remove();
    if (restore) trigger?.focus();
  }
  function positionPopup(menu, rect) {
    document.body.append(menu);
    const width = menu.offsetWidth, height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8))}px`;
  }
  // Exact first source line of the heading at `pos`, verified against the
  // ledger owner. The range covers the line bytes only (never the line
  // break), and the text must be single-line ATX; anything else (setext,
  // unprovable or unsafe ranges, CR bytes) returns null so the inline editor
  // never appears and the source presentation stays the only path.
  function headingLineRange(pos) {
    try {
      const owner = model.ledger?.owners?.find(item => item.type === 'heading' && item.pmFrom === pos && item.confidence === 'exact' && item.supported !== false);
      if (!owner || !Number.isInteger(owner.sourceFrom) || !Number.isInteger(owner.sourceTo)) return null;
      if (owner.sourceFrom < 0 || owner.sourceTo > model.source.length || owner.sourceFrom >= owner.sourceTo) return null;
      let end = model.source.indexOf('\n', owner.sourceFrom);
      if (end < 0 || end > owner.sourceTo) end = owner.sourceTo;
      const text = model.source.slice(owner.sourceFrom, end);
      if (!text || /[\r]/.test(text)) return null;
      if (!/^( {0,3})(#{1,6})([ \t]+|$)/.test(text)) return null;
      return { from: owner.sourceFrom, to: end, text };
    } catch { return null; }
  }
  // Write an inline heading-line edit through the exact source splice. The
  // verified line range is replaced wholesale and reparsed, so levels, text
  // and spacing all round-trip with shell undo; every other byte is
  // preserved. A hashes-only value (`###`) is a level change: only the marker
  // bytes are replaced and the rest of the line is kept. Empty values,
  // multi-line values and non-heading values are rejected; stale seeds (the
  // line changed under the open editor) fail closed.
  function commitHeadingLine(pos, value, original, typing = null) {
    if (options.isLocked()) return false;
    if (!value || !value.trim()) {
      if (!typing) options.message('Heading text cannot be empty. Press Escape to cancel.');
      return false;
    }
    if (/[\r\n]/.test(value)) {
      if (!typing) options.message('A heading is a single line. Press Escape to cancel.');
      return false;
    }
    const range = headingLineRange(pos);
    if (!range) { if (!typing) options.message('This heading cannot be edited safely in place.'); return false; }
    if (model.source.slice(range.from, range.to) !== original) {
      if (!typing) options.message('This heading changed while editing. Your edit was not applied.');
      return false;
    }
    let from = range.from, to = range.to, insert = value;
    const hashesOnly = /^(#{1,6})$/.exec(value);
    if (hashesOnly) {
      const marker = /^( {0,3})(#{1,6})([ \t]+|$)/.exec(original);
      if (!marker) return false;
      from = range.from + marker[1].length;
      to = from + marker[2].length;
      insert = hashesOnly[1];
    } else if (!/^( {0,3})(#{1,6})([ \t]+|$)/.test(value)) {
      if (!typing) options.message('Headings need 1 to 6 # characters followed by a space.');
      return false;
    }
    const result = replaceLogicalSelection(insert, typing ? 'typing' : 'command', { from, to, all: false, collapsed: false }, typing ? { anchor: typing.start, head: typing.end } : null);
    if (result.committed && !typing) view.focus();
    return result.committed;
  }
  // Keyboard path to the inline source: with the caret in a heading, F2
  // focuses its source input for direct editing (Enter commits, Esc cancels).
  function focusHeadingMarker() {
    if (options.isLocked() || !view) return false;
    try {
      const $from = view.state.selection.$from;
      let pos = -1;
      for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type === schema.nodes.heading) { pos = $from.before(depth); break; }
      }
      if (pos < 0) return false;
      const dom = view.nodeDOM(pos);
      const input = dom instanceof HTMLElement ? dom.querySelector('.folio-heading-source') : null;
      if (!(input instanceof HTMLInputElement)) return false;
      input.focus();
      input.select();
      return true;
    } catch { return false; }
  }
  // Click-to-edit handoff: after a plain click lands the caret in a heading,
  // move DOM focus into its inline source input at the offset matching the
  // click point, so typing edits the visible Markdown at once. Only plain
  // primary taps qualify (recorded by mousedown, minimal travel, collapsed
  // selection, unlocked, trusted event); modifier/drag/multi-click gestures
  // and the input itself are left to their native behavior, and programmatic
  // selection changes never reach this path because there is no click.
  function focusHeadingInputAtPoint(clientX, clientY) {
    if (!view || options.isLocked()) return false;
    try {
      const selection = view.state.selection;
      if (!(selection instanceof TextSelection) || !selection.empty) return false;
      const $from = selection.$from;
      let pos = -1;
      for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type === schema.nodes.heading) { pos = $from.before(depth); break; }
      }
      if (pos < 0) return false;
      const line = headingLineRange(pos);
      if (!line) return false;
      const dom = view.nodeDOM(pos);
      const input = dom instanceof HTMLElement ? dom.querySelector('.folio-heading-source') : null;
      if (!(input instanceof HTMLInputElement)) return false;
      if (document.activeElement === input) return true;
      let offset = line.text.length;
      try {
        const hit = view.posAtCoords({ left: clientX, top: clientY });
        if (hit && Number.isInteger(hit.pos)) {
          const source = richToSource(model, Math.max(0, Math.min(view.state.doc.content.size, hit.pos)));
          if (Number.isInteger(source)) offset = Math.max(0, Math.min(line.text.length, source - line.from));
        }
      } catch {}
      input.focus();
      try { input.setSelectionRange(offset, offset); } catch {}
      return true;
    } catch { return false; }
  }
  function openSlashMenu(trigger, tail, coordinates = null) {
    if (options.isLocked()) return;
    closePopup();
    const menu = document.createElement('div'); menu.className = 'folio-slash-menu';
    menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', 'Insert block');
    const search = document.createElement('input'); search.type = 'search';
    search.setAttribute('aria-label', 'Search blocks'); search.placeholder = 'Search blocks…';
    menu.append(search);
    const list = document.createElement('div'); menu.append(list);
    const choices = [
      ['Paragraph', 'paragraph', ''], ...Array.from({ length: 6 }, (_, i) => [`Heading ${i + 1}`, `heading${i + 1}`, `${'#'.repeat(i + 1)} Heading`]),
      ['Bullet list', 'bullet', '- Item'], ['Numbered list', 'numbered', '1. Item'],
      ['Quote', 'quote', '> Quote'], ['Table', 'table', '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |'],
      ['Horizontal line', 'rule', '---']
    ];
    const choose = ([, command, literal]) => {
      closePopup();
      if (tail) {
        if (!literal) { trigger.focus(); return; }
        const source = model.source, newline = source.includes('\r\n') ? '\r\n' : '\n';
        const separator = !source || /(?:\r?\n){2}$/.test(source) ? '' : /\n$/.test(source) ? newline : newline + newline;
        const end = source.length;
        const result = replaceLogicalSelection(separator + literal.replace(/\n/g, newline), 'command', { from: end, to: end, all: false, collapsed: true });
        if (result.committed) view.focus();
        return;
      }
      view.focus();
      const commands = {
        paragraph: setBlockType(schema.nodes.paragraph), bullet: wrapInList(schema.nodes.bullet_list),
        numbered: wrapInList(schema.nodes.ordered_list), quote: wrapIn(schema.nodes.blockquote),
      };
      if (/^heading[1-6]$/.test(command)) commands[command] = setBlockType(schema.nodes.heading, { level: Number(command.slice(-1)) });
      if (command === 'rule') view.dispatch(view.state.tr.replaceSelectionWith(schema.nodes.horizontal_rule.create()));
      else if (command === 'table') {
        const cell = header => schema.nodes[header ? 'table_header' : 'table_cell'].createAndFill();
        const table = schema.nodes.table.create(null, [schema.nodes.table_row.create(null, [cell(true), cell(true)]), schema.nodes.table_row.create(null, [cell(false), cell(false)])]);
        view.dispatch(view.state.tr.replaceSelectionWith(table));
      } else commands[command]?.(view.state, view.dispatch, view);
    };
    function render() {
      list.replaceChildren();
      const query = search.value.trim().toLowerCase();
      for (const choice of choices.filter(item => item[0].toLowerCase().includes(query))) {
        const item = document.createElement('button'); item.type = 'button'; item.textContent = choice[0];
        item.addEventListener('click', () => choose(choice)); list.append(item);
      }
    }
    search.addEventListener('input', render);
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closePopup(true); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); (document.activeElement.nextElementSibling || list.firstElementChild)?.focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); (document.activeElement.previousElementSibling || search)?.focus(); }
      else if (event.key === 'Enter' && event.target === search) { event.preventDefault(); list.firstElementChild?.click(); }
    });
    render(); activePopup = { menu, trigger };
    const rect = coordinates ? { left: coordinates.left, bottom: coordinates.bottom } : trigger.getBoundingClientRect();
    positionPopup(menu, rect); search.focus();
  }
  view = new EditorView(parent, {
    // Keep the view focusable during temporary transition protection; the
    // transaction filter below enforces the effective lock for document edits.
    state: stateFor(model.doc), editable: () => !options.isUserLocked(),
    attributes: { 'aria-label': 'Formatted Markdown editor', spellcheck: 'true' },
    nodeViews: { list_item: listItem, image: imageView, math_inline: mathView, math_block: mathView, code_block: codeView, raw_block: rawView, raw_inline: rawInlineView, table: node => new TableView(node, 80) },
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
        model = attachModel(commit.model, result.state.doc);
        view.updateState(result.state);
        options.onContext?.(currentContext(result.state));
        try { syncTableChrome(); } catch {}
        setBookmark(commit.selection.anchor, commit.selection.head, result.state);
        commitOutcome = true;
        options.onChange(model.source, sourceSelection(result.state), beforeSelection, commit.typing);
        return;
      }
      const nextModel = changed ? tryTextEdits(model, result.transactions, result.state.doc) || updateSource(result.state.doc, model) : model;
      if (changed && nextModel.source !== model.source) { revision++; bookmark = null; }
      model = nextModel;
      view.updateState(result.state);
      options.onContext?.(currentContext(result.state));
      try { syncTableChrome(); } catch {}
      if (tabMeta) tabSelection = { from: result.state.selection.from, to: result.state.selection.to, anchor: result.state.selection.anchor, head: result.state.selection.head };
      if (changed) {
        const typing = !tr.getMeta('folio-action') && tr.steps.every(step => { const json = step.toJSON(); return json.stepType === 'replace' && (!json.slice || json.slice.content?.every(node => node.type === 'text')); });
        options.onChange(model.source, sourceSelection(result.state), beforeSelection, typing);
      }
    },
    handleKeyDown(editor, event) {
      if (event.isComposing) return false;
      // A projection-only trailing input must not steal the browser's end of
      // document navigation from a final editable code block.
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'End') {
        const $from = editor.state.selection.$from;
        if ($from.parent.type === schema.nodes.code_block && $from.after() === editor.state.doc.content.size) {
          editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, $from.end())));
          return true;
        }
      }
      if (NAVIGATION_KEYS.has(event.key)) { releaseBookmark(); tabSelection = null; }
      if (event.key === 'Enter' || event.key === 'Tab') captureDOMSelection();
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) { options.undo(key === 'y' || event.shiftKey); return true; }
      return false;
    },
    handleTextInput(editor, from, to, text) {
      if (editor.composing) return false;
      if (text === '/' && from === to && editor.state.selection.$from.parent.type === schema.nodes.paragraph &&
          editor.state.selection.$from.parent.content.size === 0 && !options.isLocked()) {
        openSlashMenu(editor.dom, false, editor.coordsAtPos(from));
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
      if (!data || data.types?.includes('text/html')) return false;
      const text = data.getData('text/plain');
      if (!text) return false;
      const range = logicalRange(editor.state);
      if (!range || range.collapsed) return false;
      return replaceLogicalSelection(text, 'paste', range).handled;
    },
    handleDOMEvents: {
      mousedown(editor, event) {
        // Every left-button gesture starts guarded: while the pointer is down
        // the native range is left alone so reading selections can cross
        // rendered projections, and the guard settles on pointer-up. A plain
        // new caret still syncs on release via the pointer-up flush below.
        if (event.button === 0) { setSelectionGuarded(true); releaseBookmark(); tabSelection = null; }
        // A press inside a table hands anchoring back to the selection: the
        // click lands the caret, the selection-anchored controls appear, and
        // later pointer movement re-evaluates the hover zone from there.
        if (event.target instanceof Element && event.target.closest
            && event.target.closest('.tableWrapper') && editor.dom.contains(event.target)) {
          hoverAnchor = null;
          hoverPending = null;
        }
        // Record a plain-press candidate for heading click-to-edit. Any
        // modifier, a locked document, or a press starting in the source
        // input itself clears it so those gestures keep native behavior.
        // A press landing on rendered heading text while its source input
        // holds focus first yields: blur the input (pending keystrokes are
        // discarded, exactly like Escape without the refocus) so the native
        // gesture — caret move, shift-extend, drag, word select — proceeds
        // on the document instead of fighting the island.
        headingPress = null;
        if (event.target instanceof Element && !event.target.closest('.folio-heading-source')) {
          try {
            const heading = event.target.closest ? event.target.closest('h1,h2,h3,h4,h5,h6') : null;
            const open = heading && editor.dom.contains(heading) ? heading.querySelector('.folio-heading-source') : null;
            if (open && document.activeElement === open) open.blur();
          } catch {}
        }
        if (event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
            && !options.isLocked() && event.target instanceof Element && event.isTrusted !== false) {
          const heading = event.target.closest ? event.target.closest('h1,h2,h3,h4,h5,h6') : null;
          if (heading && editor.dom.contains(heading) && !event.target.closest('.folio-heading-source')) {
            headingPress = { x: event.clientX, y: event.clientY };
          }
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
        // A reading range touching a projection copies the rendered text under
        // the highlight. The editor's serializer would emit literal source
        // for the atom, so the native range is served here instead.
        return copyRenderedSelection(event);
      },
      cut(editor, event) {
        // Cutting a reading range must never mutate the document: serve the
        // rendered text as a copy and keep the Markdown intact.
        if (copyRenderedSelection(event)) return true;
        const range = logicalRange(editor.state);
        if (!range || range.collapsed || !event.clipboardData) return false;
        const text = model.source.slice(range.from, range.to);
        try { event.clipboardData.setData('text/plain', text); }
        catch {
          event.preventDefault();
          options.message('The clipboard could not be written. Your document is preserved.');
          return true;
        }
        const outcome = replaceLogicalSelection('', 'cut', range);
        if (!outcome.committed) {
          // Rejection is a handled path: stop the browser's default cut so it
          // cannot mutate the DOM after the source splice was refused.
          if (outcome.handled) event.preventDefault();
          return outcome.handled;
        }
        event.preventDefault();
        return true;
      },
      click(editor, event) {
      // Heading click-to-edit runs before link handling: a plain tap on
      // heading text hands focus to the inline source input at the tapped
      // offset. Modifier taps, drags (pointer travelled), non-collapsed
      // selections and taps already inside the input fall through untouched.
      if (headingPress && event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
          && event.isTrusted !== false && !options.isLocked()
          && Math.hypot(event.clientX - headingPress.x, event.clientY - headingPress.y) < 6) {
        headingPress = null;
        if (!(event.target instanceof Element && event.target.closest('.folio-heading-source'))) {
          focusHeadingInputAtPoint(event.clientX, event.clientY);
        }
      } else headingPress = null;
      const anchor = event.target.closest('a'); if (!anchor) return false;
      event.preventDefault(); const href = anchor.getAttribute('href') || '';
      if (event.ctrlKey || event.metaKey || options.isLocked()) options.openLink(href);
      else {
        const pos = editor.posAtDOM(anchor, 0), $pos = editor.state.doc.resolve(pos), ranges = [];
        $pos.parent.forEach((child, offset) => { if (schema.marks.link.isInSet(child.marks)?.attrs.href === href) ranges.push({ from: $pos.start() + offset, to: $pos.start() + offset + child.nodeSize }); });
        const index = ranges.findIndex(range => range.from <= pos && range.to >= pos);
        if (index < 0) return true;
        let from = ranges[index].from, to = ranges[index].to;
        for (let i = index - 1; i >= 0 && ranges[i].to === from; i--) from = ranges[i].from;
        for (let i = index + 1; i < ranges.length && ranges[i].from === to; i++) to = ranges[i].to;
        revealLinkSource(from, to, href);
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
  // the header row fixed. There is deliberately no local fallback: running a
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
  // Same safeguards as the table-operations module, enforced for pointer
  // drags (which move directly via moveTableRow/moveTableColumn): the table
  // must be rectangular (no merged/rowspan/colspan cells) and neither the
  // dragged row nor its destination may be the header row. Columns travel
  // whole, so they need only the rectangularity check.
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
      let headerRows = 0;
      const first = table.firstChild;
      if (first && first.childCount > 0) {
        let allHeader = true;
        first.forEach(cell => { if (cell.type.spec.tableRole !== 'header_cell') allHeader = false; });
        if (allHeader) headerRows = 1;
      }
      return { headerRows };
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
    if (!target || !view.dom.contains(target)) { scheduleHoverClear(); return; }
    const wrapper = target.closest ? target.closest('.tableWrapper') : null;
    if (!wrapper || !view.dom.contains(wrapper)) { scheduleHoverClear(); return; }
    cancelHoverClear();
    const rect = wrapper.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = clientX, y = clientY;
    let zone = 'cell';
    if (y <= rect.top + HOVER_EDGE) zone = 'top';
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
    try { syncTableChrome(); } catch {}
  }
  view.dom.addEventListener('pointerover', onTablePointerOver);
  view.dom.addEventListener('pointermove', onTablePointerOver);
  view.dom.addEventListener('pointerleave', scheduleHoverClear);
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
    try { event.currentTarget?.setPointerCapture?.(event.pointerId); } catch {}
    handleDrag = { kind, from: index, slot: index, live: false, edges: rowColEdges(info), info };
  }
  function moveTargetFor(drag) {
    const count = drag.kind === 'row' ? drag.edges.rows.length : drag.edges.cols.length;
    const slot = Math.max(0, Math.min(count, drag.slot));
    if (slot === drag.from || slot === drag.from + 1) return -1;
    return slot > drag.from ? slot - 1 : slot;
  }
  // Drag destinations pass through the same safeguards as the operations
  // module: rectangular tables only, and row drags may neither start from
  // nor land on the header row. Anything else hides the indicator and drops
  // as a no-op (the document is never touched).
  function guardedDropTarget(drag) {
    const target = moveTargetFor(drag);
    if (target < 0) return -1;
    const info = (drag.info && drag.info.wrapper && drag.info.wrapper.isConnected) ? drag.info : tableInfo();
    if (!info) return -1;
    const guard = rectangularTableGuard(info);
    if (!guard) return -1;
    if (drag.kind === 'row' && (drag.from < guard.headerRows || target < guard.headerRows)) return -1;
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
    const drag = handleDrag;
    drag.live = true;
    const coord = drag.kind === 'row' ? event.clientY : event.clientX;
    const boundaries = drag.kind === 'row' ? drag.edges.rows : drag.edges.cols;
    const edge = drag.kind === 'row' ? drag.edges.top : drag.edges.left;
    drag.slot = slotFromCoord(boundaries, edge, coord);
    const target = guardedDropTarget(drag);
    const info = (drag.info && drag.info.wrapper && drag.info.wrapper.isConnected) ? drag.info : tableInfo();
    if (target < 0 || !info || !info.wrapper) { dropLine.hidden = true; paintDropHandle(-1); return; }
    const wrapRect = info.wrapper.getBoundingClientRect();
    if (drag.kind === 'row') {
      const stops = [drag.edges.top].concat(drag.edges.rows);
      const y = stops[Math.max(0, Math.min(stops.length - 1, drag.slot))];
      dropLine.style.left = `${Math.round(wrapRect.left)}px`;
      dropLine.style.width = `${Math.round(Math.max(0, wrapRect.width))}px`;
      dropLine.style.top = `${Math.round(y - 1)}px`;
      dropLine.style.height = '2px';
      dropLine.style.bottom = '';
    } else {
      const stops = [drag.edges.left].concat(drag.edges.cols);
      const x = stops[Math.max(0, Math.min(stops.length - 1, drag.slot))];
      dropLine.style.top = `${Math.round(wrapRect.top)}px`;
      dropLine.style.height = `${Math.round(Math.max(0, wrapRect.height))}px`;
      dropLine.style.left = `${Math.round(x - 1)}px`;
      dropLine.style.width = '2px';
      dropLine.style.bottom = '';
    }
    dropLine.hidden = false;
    paintDropHandle(target);
  }
  function endHandleDrag(commit) {
    const drag = handleDrag;
    handleDrag = null;
    dropLine.hidden = true;
    paintDropHandle(-1);
    if (!drag || !commit || !drag.live) return;
    const target = guardedDropTarget(drag);
    if (target < 0 || !view || options.isLocked()) return;
    hoverAnchor = null;
    try {
      suppressHandleClick = { el: document.querySelector(`[data-handle-${drag.kind}="${drag.from}"]`), t: performance.now() };
    } catch { suppressHandleClick = null; }
    const info = (drag.info && drag.info.wrapper && drag.info.wrapper.isConnected) ? drag.info : tableInfo();
    if (info) {
      if (drag.kind === 'row') selectTableCell(drag.from, info.col, info);
      else selectTableCell(info.row, drag.from, info);
    }
    const moved = drag.kind === 'row'
      ? runTableCommand(moveTableRow({ from: drag.from, to: target }))
      : runTableCommand(moveTableColumn({ from: drag.from, to: target }));
    if (moved) refocusHandle(drag.kind, target);
  }
  function onHandlePointerUp(event) {
    if (!handleDrag) return;
    event.preventDefault();
    endHandleDrag(true);
  }
  function onHandlePointerCancel() {
    endHandleDrag(false);
  }
  document.addEventListener('pointermove', onHandlePointerMove);
  document.addEventListener('pointerup', onHandlePointerUp);
  document.addEventListener('pointercancel', onHandlePointerCancel);
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
    if (activePopup && activePopup.menu.classList.contains('folio-table-menu')) closePopup();
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
  function openTableMenu(trigger, anchor) {
    if (!view) return;
    closePopup();
    if (!actionInfo()) return;
    const locked = options.isLocked();
    const menu = document.createElement('div');
    menu.className = 'folio-table-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Table menu');
    let openSub = null;
    const topButtons = [];
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
    if (first) first.focus();
  }
  function openTableMenuFor(kind, index, trigger, coords) {
    const info = actionInfo();
    if (!info) return;
    if (!options.isLocked()) {
      if (kind === 'row') selectTableCell(index, info.col, info);
      else selectTableCell(info.row, index, info);
    }
    let anchor = null;
    if (coords && Number.isFinite(coords.left) && Number.isFinite(coords.bottom)) anchor = coords;
    else if (trigger) {
      try {
        const rect = trigger.getBoundingClientRect();
        anchor = { left: rect.left, bottom: rect.bottom };
      } catch {}
    }
    openTableMenu(trigger || null, anchor);
  }
  view.dom.addEventListener('contextmenu', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !view.dom.contains(target)) return;
    const cellEl = target.closest ? target.closest('td, th') : null;
    if (!cellEl || !view.dom.contains(cellEl)) return;
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
    openTableMenu(null, anchor);
  });
  // Visibility follows one anchor: the hovered table/zone when the pointer
  // is over a table or its chrome, otherwise the selected table (keyboard /
  // touch path). Exactly one kind of control shows at a time: the hovered
  // edge's control, or — for a caret without hover — the caret row/column
  // handles plus both append buttons. Repositioning only moves overlays;
  // hovering never dispatches, so the source is never touched by pointing.
  function syncTableChrome() {
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
    const wrapRect = anchor.wrapper.getBoundingClientRect();
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
    handlesLayer.replaceChildren();
    if (showRowHandle) {
      const r = Math.max(0, Math.min(anchor.height - 1, anchor.row));
      const btn = makeHandle('row', r);
      btn.disabled = locked;
      const dom = cellDomAt(anchor, r, 0);
      const b = dom ? dom.getBoundingClientRect() : null;
      const y = b ? b.top + b.height / 2 : wrapRect.top + wrapRect.height * ((r + 0.5) / anchor.height);
      btn.style.left = `${Math.round(Math.max(8, wrapRect.left - 30))}px`;
      btn.style.top = `${Math.round(y - 12)}px`;
      handlesLayer.append(btn);
    }
    if (showColHandle) {
      const c = Math.max(0, Math.min(anchor.width - 1, anchor.col));
      const btn = makeHandle('col', c);
      btn.disabled = locked;
      const dom = cellDomAt(anchor, 0, c);
      const b = dom ? dom.getBoundingClientRect() : null;
      const x = b ? b.left + b.width / 2 : wrapRect.left + wrapRect.width * ((c + 0.5) / anchor.width);
      btn.style.left = `${Math.round(x - 12)}px`;
      btn.style.top = `${Math.round(Math.max(8, wrapRect.top - 30))}px`;
      handlesLayer.append(btn);
    }
  }
  const syncTableChromeOnScroll = () => { try { syncTableChrome(); } catch {} };
  window.addEventListener('scroll', syncTableChromeOnScroll, true);
  window.addEventListener('resize', syncTableChromeOnScroll);
  const refreshTableChrome = () => { try { syncTableChrome(); } catch {} };
  refreshers.add(refreshTableChrome);
  try { syncTableChrome(); } catch {}
  // A drag ending outside the editor (or cancelled) still settles the guard.
  window.addEventListener('pointerup', releaseSelectionGuard);
  window.addEventListener('pointercancel', releaseSelectionGuard);
  window.addEventListener('blur', releaseSelectionGuard);
  // Mirror the live DOM range into the folio-selection custom highlight (see
  // above). Document-level so ranges leaving the reader clear the mirror.
  document.addEventListener('selectionchange', syncFolioHighlight);
  const dismissPopup = event => {
    if (activePopup && !activePopup.menu.contains(event.target) && !activePopup.trigger?.contains(event.target)) closePopup();
  };
  document.addEventListener('pointerdown', dismissPopup, true);
  return {
    view,
    captureSelection() {
      captureDOMSelection();
    },
    selection: () => sourceSelection(view.state),
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
        model = parseSource(content);
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
      if (name === 'table') {
        const cell = header => schema.nodes[header ? 'table_header' : 'table_cell'].createAndFill();
        const table = schema.nodes.table.create(null, [schema.nodes.table_row.create(null, [cell(true), cell(true)]), schema.nodes.table_row.create(null, [cell(false), cell(false)])]);
        view.dispatch(view.state.tr.replaceSelectionWith(table).scrollIntoView());
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
      try { view.dom.removeEventListener('pointerover', onTablePointerOver); } catch {}
      try { view.dom.removeEventListener('pointerleave', scheduleHoverClear); } catch {}
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
