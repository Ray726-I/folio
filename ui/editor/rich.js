import { Fragment } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection, Selection, AllSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark, setBlockType, wrapIn, chainCommands, exitCode } from 'prosemirror-commands';
import { splitListItem, sinkListItem, liftListItem, wrapInList } from 'prosemirror-schema-list';
import { fixTables, goToNextCell, addRowAfter, addColumnAfter, deleteRow, deleteColumn, deleteTable, TableView, CellSelection, isInTable, cellAround, nextCell } from 'prosemirror-tables';
import { inputRules, wrappingInputRule, textblockTypeInputRule, InputRule } from 'prosemirror-inputrules';
import { schema, parseSource, updateSource, sourceToRich, richToSource, sourceMapping, richMapping } from './model.js';
import { buildLedger, applySourcePatches } from './source-ledger.js';
import { tryTextEdits } from './source-edits.js';

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'OS', 'Super', 'Hyper']);

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
  function replaceLogicalSelection(insert, origin = 'typing', explicitRange = null) {
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
    const committed = commitCandidate(parsed, { anchor: from + insert.length, head: from + insert.length }, origin === 'typing' || origin === 'paste');
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
  function revealLinkSource(from, to, href) {
    if (options.isLocked() || !options.revealSource) return;
    const needle = String(href || '');
    const verified = verifiedSourceRange(from, to);
    if (verified) {
      if (needle) {
        const start = model.source.indexOf(needle, verified.to);
        if (start >= verified.to && start <= verified.to + needle.length + 10) {
          options.revealSource(start, start + needle.length);
          return;
        }
      }
      options.revealSource(verified.from, verified.to);
      return;
    }
    const mapped = richMapping(model, from, { bias: 'right' });
    if (mapped && Number.isInteger(mapped.source)) {
      if (needle) {
        const start = model.source.indexOf(needle, mapped.source);
        if (start >= mapped.source && start <= mapped.source + needle.length + 10) {
          options.revealSource(start, start + needle.length);
          return;
        }
      }
      options.revealSource(mapped.source, mapped.source);
    }
  }
  function revealAtomSource(pmPos, attrText) {
    if (options.isLocked() || !options.revealSource) return;
    const mapped = richMapping(model, pmPos, { bias: 'right' });
    const owner = mapped?.owner;
    let from = owner?.sourceFrom, to = owner?.sourceTo;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > model.source.length || from >= to) {
      if (Number.isInteger(mapped?.source)) options.revealSource(mapped.source, mapped.source);
      return;
    }
    const needle = String(attrText ?? '');
    if (needle) {
      const inner = model.source.indexOf(needle, from);
      if (inner >= from && inner + needle.length <= to) {
        options.revealSource(inner, inner + needle.length);
        return;
      }
    }
    options.revealSource(from, to);
  }
  function revealCurrentSelection() {
    if (options.isLocked() || !options.revealSource) return;
    try {
      const selection = sourceSelection(view.state);
      options.revealSource(selection.anchor, selection.head);
    } catch {}
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
    const edit = button('✎', () => {
      if (options.isLocked()) return;
      let pos = null;
      try { pos = getPos(); } catch { pos = null; }
      if (pos != null) revealAtomSource(pos, node.attrs.tex);
      else revealCurrentSelection();
    });
    edit.classList.add('math-edit'); edit.setAttribute('aria-label', 'Edit formula'); edit.title = 'Edit formula';
    formula.addEventListener('mousedown', event => { if (event.button !== 0) return; event.preventDefault(); if (!options.isLocked()) edit.click(); });
    dom.append(formula, edit); let generation = 0;
    const render = async () => {
      const current = ++generation; formula.textContent = node.attrs.tex; formula.classList.remove('math-error');
      try { const katex = await options.loadKatex(); if (current !== generation) return; katex.render(node.attrs.tex, formula, { displayMode: !node.isInline, throwOnError: true, trust: false, strict: 'warn' }); }
      catch { if (current === generation) { formula.textContent = node.attrs.tex; formula.classList.add('math-error'); formula.title = 'Formula could not be rendered. Its source is preserved.'; } }
      edit.disabled = options.isLocked();
    };
    render(); const refresh = () => { edit.disabled = options.isLocked(); }; refreshers.add(refresh);
    return { dom, update(next) { if (next.type !== node.type) return false; node = next; render(); return true; }, stopEvent: () => true, ignoreMutation: () => true, destroy() { generation++; refreshers.delete(refresh); } };
  }
  function imageView(node, editorView, getPos) {
    const dom = document.createElement('span'); dom.className = 'image-widget'; dom.contentEditable = 'false'; let generation = 0;
    const lease = options.reserveImage();
    const edit = button('Edit image', () => {
      if (options.isLocked()) return;
      let pos = null;
      try { pos = getPos(); } catch { pos = null; }
      if (pos != null) revealAtomSource(pos, node.attrs.src);
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
    const code = document.createElement('code'); pre.append(code);
    const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'Diagram source'; details.append(summary, pre);
    let generation = 0, source = null, theme = null, abortController = null;
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
          dom.classList.toggle('code-highlighted', highlightCode.textContent === sourceText && highlightCode.childNodes.length > 0);
        } catch { if (current === highlightGeneration) { highlightCode.replaceChildren(); dom.classList.remove('code-highlighted'); } }
      }, 60);
    };
    const render = async () => {
      const language = node.attrs.params.trim().split(/\s/)[0]; dom.dataset.language = language;
      if (language !== 'mermaid') {
        dom.classList.remove('mermaid-host'); delete dom.dataset.mermaidSource;
        code.className = /^[a-z0-9_+#.-]+$/i.test(language) ? `language-${language}` : '';
        if (pre.parentNode !== dom || highlight.nextSibling !== pre) dom.replaceChildren(highlight, pre);
        scheduleHighlight(language);
        return;
      }
      clearHighlight();
      dom.classList.add('mermaid-host'); dom.dataset.mermaidSource = node.textContent;
      if (pre.parentNode !== details) details.append(summary, pre);
      if (!drawing.isConnected || !details.isConnected) dom.replaceChildren(drawing, details);
      if (source === node.textContent && theme === options.themeRevision()) return;
      source = node.textContent; theme = options.themeRevision(); const current = ++generation;
      dom.dataset.themeRevision = String(theme);
      abortController?.abort(); abortController = new AbortController();
      drawing.replaceChildren(); drawing.textContent = 'Rendering diagram…';
      try {
        const outcome = await options.renderDiagram(source, abortController.signal);
        if (current !== generation || !dom.isConnected) return;
        if (outcome?.ok && outcome.sanitized && outcome.svg) { drawing.innerHTML = outcome.svg; details.open = false; }
        else { drawing.textContent = outcome?.error?.code === 'unsupported_external_images' ? 'This diagram needs external images, which are blocked while rendering offline.' : 'Mermaid diagram could not be rendered.'; drawing.className = 'mermaid-error'; code.className = 'mermaid-source'; details.open = true; }
      } catch { if (current === generation) { drawing.textContent = 'Mermaid diagram could not be rendered.'; drawing.className = 'mermaid-error'; details.open = true; } }
    };
    render(); refreshers.add(render);
    return { dom, contentDOM: code, update(next) { if (next.type !== node.type) return false; node = next; render(); return true; }, ignoreMutation: mutation => mutation.type === 'attributes' || !pre.contains(mutation.target), destroy() { generation++; clearTimeout(highlightTimer); highlightGeneration++; abortController?.abort(); refreshers.delete(render); } };
  }
  // Reading selections may start, cross and end inside a rendered projection.
  // ProseMirror maps any DOM position inside an atom to the atom boundary and
  // rewrites the DOM range, which truncates cross-block drags to the editable
  // side. While a drag is active the editor's selection observer is paused so
  // the native range is left alone; it is re-synced on release (or on the
  // next edit/pointer gesture if a reading range is still standing). The
  // guarded range always covers rendered text, never the literal source.
  let selectionGuarded = false;
  function previewIntersectsSelection() {
    try {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
      const previews = view?.dom.querySelectorAll('.extension-preview');
      if (!previews || !previews.length) return false;
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        for (const preview of previews) if (range.intersectsNode(preview)) return true;
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
    if (previewIntersectsSelection()) return;
    setSelectionGuarded(false);
    try { view?.domObserver.flush(); } catch {}
  }
  function resyncGuardedSelection() {
    if (!selectionGuarded) return;
    setSelectionGuarded(false);
    try { view?.domObserver.flush(); } catch {}
  }
  function copyGuardedSelection(event) {
    const data = event.clipboardData;
    if (!data || !previewIntersectsSelection()) return false;
    const text = window.getSelection()?.toString() ?? '';
    if (!text) return false;
    event.preventDefault();
    try { data.setData('text/plain', text); } catch {}
    return true;
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
    const edit = button(/^---\n/.test(node.textContent) ? 'Edit front matter' : 'Edit source', () => {
      if (options.isLocked()) return;
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
    });
    edit.classList.add('extension-edit');
    edit.setAttribute('aria-label', /^---\n/.test(node.textContent) ? 'Edit front matter source' : 'Edit Markdown source');
    edit.title = 'Edit source in Markdown view';
    actions.append(edit);
    dom.append(projection, actions);
    let generation = 0;
    const render = async () => {
      const current = ++generation;
      try { const html = await options.renderExtension(node.textContent); if (generation === current && dom.isConnected) projection.innerHTML = html; }
      catch { if (current === generation) projection.textContent = 'Rendered view unavailable. Use Edit source to inspect the exact Markdown.'; }
    };
    Promise.resolve().then(render);
    const refresh = () => { edit.disabled = options.isLocked(); syncEditability(); };
    refreshers.add(refresh); refresh();
    const removeListeners = () => { refreshers.delete(refresh); };
    // Atom view: the literal source is not mounted in the reading DOM, so no
    // duplicate selectable text exists here. All source edits go through the
    // explicit source presentation via the edit action above.
    return { dom, update(next) { if (next.type !== node.type) return false; node = next; Promise.resolve().then(render); return true; }, ignoreMutation: () => true, stopEvent: event => event.target.closest('button') != null, destroy() { generation++; removeListeners(); } };
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
        'Mod-a': selectAllLogical,
        Backspace: deleteLogical(true), Delete: deleteLogical(false),
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
  view = new EditorView(parent, {
    // Keep the view focusable during temporary transition protection; the
    // transaction filter below enforces the effective lock for document edits.
    state: stateFor(model.doc), editable: () => !options.isUserLocked(),
    attributes: { 'aria-label': 'Formatted Markdown editor', spellcheck: 'true' },
    nodeViews: { list_item: listItem, image: imageView, math_inline: mathView, math_block: mathView, code_block: codeView, raw_block: rawView, table: node => new TableView(node, 80) },
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
        setBookmark(commit.selection.anchor, commit.selection.head, result.state);
        commitOutcome = true;
        options.onChange(model.source, sourceSelection(result.state), beforeSelection, commit.typing);
        return;
      }
      const nextModel = changed ? tryTextEdits(model, result.transactions, result.state.doc) || updateSource(result.state.doc, model) : model;
      if (changed && nextModel.source !== model.source) { revision++; bookmark = null; }
      model = nextModel;
      view.updateState(result.state);
      if (tabMeta) tabSelection = { from: result.state.selection.from, to: result.state.selection.to, anchor: result.state.selection.anchor, head: result.state.selection.head };
      if (changed) {
        const typing = !tr.getMeta('folio-action') && tr.steps.every(step => { const json = step.toJSON(); return json.stepType === 'replace' && (!json.slice || json.slice.content?.every(node => node.type === 'text')); });
        options.onChange(model.source, sourceSelection(result.state), beforeSelection, typing);
      }
    },
    handleKeyDown(editor, event) {
      if (event.isComposing) return false;
      if (NAVIGATION_KEYS.has(event.key)) { releaseBookmark(); tabSelection = null; }
      if (event.key === 'Enter' || event.key === 'Tab') captureDOMSelection();
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) { options.undo(key === 'y' || event.shiftKey); return true; }
      return false;
    },
    handleTextInput(editor, from, to, text) {
      if (editor.composing) return false;
      const range = bookmarkRange(editor.state);
      if (range) {
        if (bookmark.all) {
          if (!(editor.state.selection instanceof AllSelection)) return false;
          return replaceLogicalSelection(text, 'typing', { from: 0, to: model.source.length, all: true, collapsed: false }).handled;
        }
        const pmFrom = Math.min(bookmark.pmAnchor, bookmark.pmHead), pmTo = Math.max(bookmark.pmAnchor, bookmark.pmHead);
        if (from !== pmFrom || to !== pmTo) return false;
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
        return copyGuardedSelection(event);
      },
      cut(editor, event) {
        // Cutting a reading range must never mutate the document: serve the
        // rendered text as a copy and keep the Markdown intact.
        if (copyGuardedSelection(event)) return true;
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
  // A drag ending outside the editor (or cancelled) still settles the guard.
  window.addEventListener('pointerup', releaseSelectionGuard);
  window.addEventListener('pointercancel', releaseSelectionGuard);
  window.addEventListener('blur', releaseSelectionGuard);
  return {
    view,
    captureSelection() {
      captureDOMSelection();
    },
    selection: () => sourceSelection(view.state),
    setDocument(content, selection, meta = {}) {
      if (content !== model.source) {
        revision++; bookmark = null;
        model = parseSource(content);
        const state = stateFor(model.doc, selection);
        view.updateState(state);
        if (meta.logical && selection) setBookmark(selection.anchor, selection.head, state);
      } else if (selection) {
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
    },
    setLocked() { view.setProps({ editable: () => !options.isUserLocked() }); for (const refresh of refreshers) refresh(); },
    setTransitionLocked() { for (const refresh of refreshers) refresh(); },
    refreshMedia() { for (const refresh of refreshers) refresh(); },
    focus: () => view.focus(),
    command(name) {
      if (options.isLocked()) return;
      const commands = {
        bold: toggleMark(schema.marks.strong), italic: toggleMark(schema.marks.em), code: toggleMark(schema.marks.code), strike: toggleMark(schema.marks.strike),
        paragraph: setBlockType(schema.nodes.paragraph), heading: setBlockType(schema.nodes.heading, { level: 2 }),
        bullet: wrapInList(schema.nodes.bullet_list), numbered: wrapInList(schema.nodes.ordered_list), quote: wrapIn(schema.nodes.blockquote),
        row: addRowAfter, column: addColumnAfter, 'delete-row': deleteRow, 'delete-column': deleteColumn, 'delete-table': deleteTable
      };
      if (name === 'table') {
        const cell = header => schema.nodes[header ? 'table_header' : 'table_cell'].createAndFill();
        const table = schema.nodes.table.create(null, [schema.nodes.table_row.create(null, [cell(true), cell(true)]), schema.nodes.table_row.create(null, [cell(false), cell(false)])]);
        view.dispatch(view.state.tr.replaceSelectionWith(table).scrollIntoView());
      } else if (name === 'math' || name === 'link' || name === 'image') {
        // Creating a link, formula or image starts from the exact Markdown
        // syntax in the shared buffer. Reveal the current position in the
        // source projection for direct typing instead of a detached prompt.
        // Existing links, formulas and images already reveal their own
        // URL/TeX/src range through their click/Edit affordances above.
        revealCurrentSelection();
        return;
      } else commands[name]?.(view.state, view.dispatch, view);
      view.focus();
    },
    destroy() {
      window.removeEventListener('pointerup', releaseSelectionGuard);
      window.removeEventListener('pointercancel', releaseSelectionGuard);
      window.removeEventListener('blur', releaseSelectionGuard);
      view.destroy();
    }
  };
}
