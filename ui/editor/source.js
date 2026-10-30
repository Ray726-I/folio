import { EditorState, StateField, StateEffect, Annotation, Compartment } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, drawSelection } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import MarkdownIt from 'markdown-it';

const external = Annotation.define(), refresh = StateEffect.define();
const MAX_REVEAL_LENGTH = 2 * 1024 * 1024, SCROLL_MARGIN = 24;
const tableRenderer = new MarkdownIt({ html: false });
tableRenderer.renderer.rules.image = (tokens, i) => tableRenderer.utils.escapeHtml(tokens[i].content || 'Image');

function escapedAt(line, index) {
  let slashes = 0;
  while (index - slashes - 1 >= 0 && line[index - slashes - 1] === '\\') slashes++;
  return slashes % 2 === 1;
}

// Map a rendered table cell back to the first non-padding character of its
// Markdown cell, supporting both leading-pipe and pipe-less table rows.
function tableCellOffset(text, from, rowIndex, column) {
  const lines = text.split('\n'), sourceRow = rowIndex ? rowIndex + 1 : 0;
  let offset = from;
  for (let i = 0; i < sourceRow && i < lines.length; i++) offset += lines[i].length + 1;
  const line = lines[sourceRow] || '', pipes = [];
  for (let i = 0; i < line.length; i++) if (line[i] === '|' && !escapedAt(line, i)) pipes.push(i);
  let start = 0;
  if (/^\s*\|/.test(line)) start = pipes[column] === undefined ? 0 : pipes[column] + 1;
  else if (column > 0) start = pipes[column - 1] === undefined ? 0 : pipes[column - 1] + 1;
  while (start < line.length && (line[start] === ' ' || line[start] === '\t')) start++;
  return offset + Math.min(start, line.length);
}

function scrollInstant(scroller, top) {
  const behavior = scroller.style.scrollBehavior;
  scroller.style.scrollBehavior = 'auto';
  scroller.scrollTop = top;
  scroller.style.scrollBehavior = behavior;
}

function selectionExtent(view) {
  const head = view.state.selection.main.head;
  try {
    const rect = view.coordsAtPos(head);
    if (rect) return { top: rect.top, bottom: rect.bottom };
    const block = view.lineBlockAt(head);
    return { top: view.documentTop + block.top, bottom: view.documentTop + block.bottom };
  } catch { return null; }
}

function revealBounds(scroller, bounds, margin = SCROLL_MARGIN) {
  const rect = scroller.getBoundingClientRect();
  const min = rect.top + margin, max = rect.bottom - margin;
  let delta = 0;
  if (bounds.top < min) delta = bounds.top - min;
  else if (bounds.bottom > max) delta = bounds.bottom - max;
  // Bypass the shell's smooth scrolling, which otherwise lets the caret trail
  // thousands of pixels behind the viewport during long jumps.
  if (delta) scrollInstant(scroller, scroller.scrollTop + delta);
}

class TablePreview extends WidgetType {
  constructor(text, from, selectCell) { super(); this.text = text; this.from = from; this.selectCell = selectCell; }
  eq(other) { return this.text === other.text && this.from === other.from; }
  toDOM() {
    const wrapper = document.createElement('div'); wrapper.className = 'table-scroll source-table-preview';
    // Markdown-it has HTML disabled and images replaced with escaped alt text.
    wrapper.innerHTML = tableRenderer.render(this.text);
    wrapper.setAttribute('aria-label', 'Markdown table. Activate to edit its source.');
    wrapper.addEventListener('mousedown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const cell = event.target.closest('td,th'), row = cell?.parentElement;
      const rowIndex = row ? [...wrapper.querySelectorAll('tr')].indexOf(row) : 0;
      const column = cell ? [...row.children].indexOf(cell) : 0;
      // Revealing the source replaces the compact widget with taller Markdown
      // lines. Hand the clicked row's screen position to the shared reveal so
      // the selection update and row anchoring land in the same frame.
      this.selectCell(tableCellOffset(this.text, this.from, rowIndex, column), (cell || wrapper).getBoundingClientRect().top);
    });
    return wrapper;
  }
  ignoreEvent() { return true; }
}

function sourceDecorations(state, selectCell) {
  const ranges = [], cursor = state.selection.main;
  // Rich source decorations are a convenience, never a prerequisite to edit
  // a large file. The underlying CodeMirror buffer is never truncated.
  if (state.doc.length > MAX_REVEAL_LENGTH) return Decoration.none;
  const active = state.doc.lineAt(cursor.head);
  const revealed = (from, to) => cursor.empty ? from <= active.to && to >= active.from : from <= cursor.to && to >= cursor.from;
  syntaxTree(state).iterate({ enter(node) {
    const { from, to, name } = node;
    if (name === 'Table') {
      if (!revealed(from, to)) ranges.push(Decoration.replace({ block: true, widget: new TablePreview(state.doc.sliceString(from, to), from, selectCell) }).range(from, to));
      return false;
    }
    const heading = /^ATXHeading([1-6])$/.exec(name);
    if (heading) ranges.push(Decoration.line({ class: `source-heading source-heading-${heading[1]}` }).range(state.doc.lineAt(from).from));
    if (name === 'Image') return false; // Keep image syntax legible; it has no rendered text to fall back on.
    if (name === 'FencedCode' || name === 'CodeBlock') {
      for (let line = state.doc.lineAt(from).number; line <= state.doc.lineAt(to).number; line++) ranges.push(Decoration.line({ class: 'source-code-line' }).range(state.doc.line(line).from));
      return false;
    }
    if (name === 'Blockquote') for (let line = state.doc.lineAt(from).number; line <= state.doc.lineAt(to).number; line++) ranges.push(Decoration.line({ class: 'source-quote-line' }).range(state.doc.line(line).from));
    if (['StrongEmphasis', 'Emphasis', 'InlineCode', 'Strikethrough', 'Link'].includes(name)) ranges.push(Decoration.mark({ class: `source-${name.toLowerCase()}` }).range(from, to));
    if (['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'LinkMark', 'URL'].includes(name) && !revealed(from, to) && from !== to) ranges.push(Decoration.replace({}).range(from, to));
  } });
  return Decoration.set(ranges, true);
}

function isTypingUpdate(update) {
  for (const tr of update.transactions) {
    if (!tr.docChanged) continue;
    if (tr.isUserEvent('input.paste') || tr.isUserEvent('delete.cut') || tr.isUserEvent('move.drop') || tr.isUserEvent('input.drop')) return false;
  }
  return true;
}

export function createSourceEditor(parent, options) {
  const permission = new Compartment(); let syncing = false;
  let pendingAnchor = null;
  const selectTableCell = (offset, anchorTop) => {
    pendingAnchor = anchorTop;
    view.dispatch({ selection: { anchor: offset } });
    view.focus();
  };
  const decorate = state => sourceDecorations(state, selectTableCell);
  const decorations = StateField.define({
    create: decorate,
    update(value, tr) { return tr.docChanged || tr.selection || tr.effects.some(effect => effect.is(refresh)) ? decorate(tr.state) : value.map(tr.changes); },
    provide: field => EditorView.decorations.from(field)
  });
  let revealScheduled = false;
  const scheduleReveal = () => {
    if (!options.scroller || revealScheduled) return;
    revealScheduled = true;
    requestAnimationFrame(() => {
      revealScheduled = false;
      if (!view.dom.getClientRects().length) return;
      const bounds = selectionExtent(view), anchorTop = pendingAnchor;
      pendingAnchor = null;
      if (!bounds) return;
      // A table click carries the pre-reveal row position. Align the selected
      // Markdown row to it once, after CodeMirror has measured the new layout,
      // rather than racing a separate generic reveal frame.
      if (anchorTop !== null) scrollInstant(options.scroller, options.scroller.scrollTop + bounds.top - anchorTop);
      else revealBounds(options.scroller, bounds);
    });
  };
  const lockedAtCreate = Boolean(options.isUserLocked?.() ?? options.isLocked?.());
  const view = new EditorView({ parent, state: EditorState.create({ doc: options.content, extensions: [
    markdown({ base: markdownLanguage }), drawSelection(), EditorView.lineWrapping,
    permission.of([EditorState.readOnly.of(lockedAtCreate), EditorView.editable.of(!lockedAtCreate)]),
    EditorState.transactionFilter.of(tr => options.isLocked() && tr.docChanged && !tr.annotation(external) ? [] : tr),
    decorations,
    EditorView.domEventHandlers({ keydown(event) {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
        event.preventDefault(); options.undo(key === 'y' || event.shiftKey); return true;
      }
      return false;
    } }),
    keymap.of([...defaultKeymap, indentWithTab]),
    EditorView.contentAttributes.of({ 'aria-label': 'Markdown with local syntax reveal', spellcheck: 'true' }),
    EditorView.updateListener.of(update => {
      if (syncing) return;
      if (update.docChanged) {
        options.onChange(update.state.doc.toString(), { anchor: update.startState.selection.main.anchor, head: update.startState.selection.main.head }, isTypingUpdate(update));
      } else if (update.selectionSet) {
        const { anchor, head } = update.state.selection.main;
        options.onSelection?.({ anchor, head });
      }
      if (update.docChanged || update.selectionSet) scheduleReveal();
    })
  ] }) });
  if (options.content.length > MAX_REVEAL_LENGTH) queueMicrotask(() => options.message?.('Inline Markdown reveal is off for documents over 2 MiB. The complete source remains editable.'));
  return {
    view,
    selection() { return { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head }; },
    setDocument(content, selection) {
      syncing = true;
      const changes = view.state.doc.toString() === content ? undefined : { from: 0, to: view.state.doc.length, insert: content };
      view.dispatch({ changes, selection: selection ? { anchor: Math.min(selection.anchor, content.length), head: Math.min(selection.head, content.length) } : undefined, annotations: external.of(true), effects: refresh.of(true) });
      syncing = false;
    },
    revealSelection: scheduleReveal,
    setLocked(locked) { view.dispatch({ effects: permission.reconfigure([EditorState.readOnly.of(locked), EditorView.editable.of(!locked)]) }); },
    setTransitionLocked() {},
    focus() { view.focus(); },
    destroy() { view.destroy(); }
  };
}
