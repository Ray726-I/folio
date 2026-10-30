import { createRichEditor } from './rich.js';
import { createSourceEditor } from './source.js';
import { tokenizer } from './model.js';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-tables/style/tables.css';

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_RICH_LENGTH = 2 * 1024 * 1024;
function setScrollInstant(scroller, top) {
  const behavior = scroller.style.scrollBehavior;
  scroller.style.scrollBehavior = 'auto';
  scroller.scrollTop = top;
  scroller.style.scrollBehavior = behavior;
}
const REVEAL_MARGIN = 24;
function revealScrollerBounds(scroller, bounds) {
  if (!scroller || !bounds) return;
  const rect = scroller.getBoundingClientRect();
  const min = rect.top + REVEAL_MARGIN, max = rect.bottom - REVEAL_MARGIN;
  let delta = 0;
  if (bounds.top < min) delta = bounds.top - min;
  else if (bounds.bottom > max) delta = bounds.bottom - max;
  // Match the source presenter: bypass the shell's smooth scrolling so a find
  // jump lands immediately instead of leaving the selection thousands of
  // pixels behind.
  if (delta) setScrollInstant(scroller, scroller.scrollTop + delta);
}
function selectionBounds(view) {
  if (!view) return null;
  const { anchor, head } = view.state.selection;
  try {
    const anchorRect = view.coordsAtPos(anchor), headRect = view.coordsAtPos(head);
    if (!anchorRect || !headRect) return null;
    return { top: Math.min(anchorRect.top, headRect.top), bottom: Math.max(anchorRect.bottom, headRect.bottom) };
  } catch { return null; }
}
export function headings(content) {
  const lines = [0]; for (let i = 0; i < content.length; i++) if (content[i] === '\n') lines.push(i + 1);
  const tokens = tokenizer.parse(content, {}), result = [];
  tokens.forEach((token, index) => {
    if (token.type !== 'heading_open') return;
    const inline = tokens[index + 1];
    const semantic = (inline?.children || []).map(child => {
      if (['text', 'code_inline', 'math_inline', 'image'].includes(child.type)) return child.content;
      if (child.type === 'softbreak' || child.type === 'hardbreak') return ' ';
      return '';
    }).join('');
    result.push({ level: +token.tag.slice(1), text: inline?.content || '', semantic, offset: lines[token.map?.[0]] || 0 });
  });
  // Extension syntax (shortcodes, wikilinks, footnotes...) falls back to a raw
  // block, but a heading that starts that block is still a real rendered
  // heading. Keep it in the outline so headings after it are not misdirected
  // to the wrong preview element.
  tokens.forEach(token => {
    if (token.type !== 'raw_block' || !token.map) return;
    const offset = lines[token.map[0]] || 0;
    const end = lines[token.map[1]] ?? content.length;
    const heading = headingFromRawBlock(content.slice(offset, end));
    if (heading) result.push({ ...heading, offset, raw: true });
  });
  result.sort((a, b) => a.offset - b.offset);
  return result;
}
function headingFromRawBlock(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  if (!lines.length) return null;
  // Blockquote and list markers can prefix a heading inside an extension block.
  const prefix = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?/;
  const first = lines[0].replace(prefix, '');
  // Author HTML blocks keep their headings in the projection, not in the
  // tokenizer fallback; never invent an ATX/setext heading from markup.
  if (first.trimStart().startsWith('<')) return null;
  const atx = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+[ \t]*)?$/.exec(first);
  if (atx) return { level: atx[1].length, text: atx[2].trim() };
  const underline = lines[1] && /^[ \t]*(=+|-+)[ \t]*$/.exec(lines[1]);
  if (underline && first.trim()) return { level: underline[1][0] === '=' ? 1 : 2, text: first.trim() };
  return null;
}
export function create(options) {
  let content = options.content, locked = false, transitionLocked = Boolean(options.transitionLocked), showMarkdown = false, sourceEditor = null, richEditor = null;
  let history = [], future = [], groupTime = 0, groupSelection = null, sourceSelection = { anchor: 0, head: 0 };
  let forceSource = options.forceSource || content.length > MAX_RICH_LENGTH;
  let sourceOrigin = false;
  const noteSourceOrigin = event => {
    if (!(showMarkdown || forceSource)) return;
    if (event?.type === 'keydown') {
      const key = event.key.toLowerCase();
      // Presentation/undo shortcuts are not source caret placement.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'e' || key === 'z' || key === 'y')) return;
    }
    sourceOrigin = true;
  };
  options.sourceParent?.addEventListener('mousedown', noteSourceOrigin);
  options.sourceParent?.addEventListener('keydown', noteSourceOrigin);
  let disposed = false, mediaEpoch = 0, imageCount = 0, imageBytes = 0, cachedImageBytes = 0;
  const consent = new Set(), imageCache = new Map();
  function selection() { return showMarkdown || forceSource ? sourceEditor?.selection() || sourceSelection : richEditor?.selection() || sourceSelection; }
  function notify() { options.onChange(content); }
  const isLocked = () => locked || transitionLocked;
  const isUserLocked = () => locked;
  function record(next, after, before, typing = true) {
    if (isLocked() || next === content) return;
    if (next.length > MAX_SOURCE_BYTES / 4 && new TextEncoder().encode(next).length > MAX_SOURCE_BYTES) { options.message('This edit would exceed the 20 MiB document limit. The previous document is preserved.'); sync(content, before); return; }
    const now = Date.now();
    const previousSelection = before || sourceSelection;
    const adjacent = groupSelection && previousSelection.anchor === previousSelection.head &&
      groupSelection.anchor === previousSelection.anchor && groupSelection.head === previousSelection.head;
    if (!typing || !groupTime || !adjacent || now - groupTime > 650) {
      history.push({ content, selection: before || sourceSelection, fallback: forceSource });
      let size = history.reduce((sum, entry) => sum + entry.content.length, 0);
      while (history.length > 1 && (history.length > 150 || size > 8 * 1024 * 1024)) size -= history.shift().content.length;
    }
    groupTime = typing ? now : 0; future = []; content = next; sourceSelection = after || selection();
    groupSelection = { ...sourceSelection }; notify();
  }
  function reserveImage() {
    const allowed = ++imageCount <= 200; let bytes = 0, released = false;
    return {
      allowed,
      assign(src) {
        const next = src.startsWith('data:') ? src.length : 0;
        if (!allowed || imageBytes - bytes + next > 32 * 1024 * 1024) return false;
        imageBytes += next - bytes; bytes = next; return true;
      },
      release() { if (!released) { imageCount--; imageBytes -= bytes; released = true; } }
    };
  }
  const shared = { ...options, reserveImage, isLocked, isUserLocked, undo: redo => undo(redo) };
  async function resolveImage(destination, allow) {
    const key = String(destination || ''), epoch = mediaEpoch;
    const remote = /^(?:[a-z][a-z\d+.-]*:)?[/\\]{2}/i.test(key) || /^https?:/i.test(key);
    if (allow) consent.add(key);
    if (remote && !options.remoteImages() && !consent.has(key)) {
      let domain = 'remote host'; try { domain = new URL(key.startsWith('//') ? `https:${key}` : key).hostname; } catch {}
      return { blocked: true, domain };
    }
    if (!imageCache.has(key)) {
      const pending = options.renderImage(key, remote && (options.remoteImages() || consent.has(key))).catch(() => ({ error: 'Image unavailable' }));
      imageCache.set(key, pending);
      pending.then(result => {
        if (imageCache.get(key) !== pending) return;
        const bytes = result.src?.startsWith('data:') ? result.src.length : 0;
        cachedImageBytes += bytes;
        // Bound cache lifetime as paths are edited, independently of displayed
        // image leases. Cached promises carry only native-sanitized results.
        pending.imageBytes = bytes;
        while (imageCache.size > 200 || cachedImageBytes > 32 * 1024 * 1024) {
          const oldest = imageCache.keys().next().value, entry = imageCache.get(oldest);
          cachedImageBytes -= entry.imageBytes || 0; imageCache.delete(oldest);
        }
      });
    }
    const result = await imageCache.get(key);
    if (disposed || epoch !== mediaEpoch) return { error: 'Image request expired' };
    return result;
  }
  function ensureSource() {
    if (!sourceEditor) sourceEditor = createSourceEditor(options.sourceParent, { ...shared, content,
      onChange(next, before, typing) { sourceOrigin = true; const after = sourceEditor.selection(); record(next, after, before, typing); },
      onSelection(selection) {
        // A caret jump or click ends the current undo group even before the
        // next edit arrives; offsets alone cannot distinguish the intent.
        sourceSelection = selection;
        if (!groupSelection || groupSelection.anchor !== selection.anchor || groupSelection.head !== selection.head) groupTime = 0;
      }
    });
  }
  function ensureRich() {
    if (!richEditor) richEditor = createRichEditor(options.richParent, { ...shared, content, resolveImage,
      onChange(next, after, before, typing) { record(next, after, before, typing); }
    });
  }
  function sync(next, target = sourceSelection, logical = false) {
    content = next; sourceSelection = target;
    if (showMarkdown || forceSource) { ensureSource(); sourceEditor.setDocument(content, target); }
    else { ensureRich(); richEditor.setDocument(content, target, { logical }); }
  }
  function presentation(next, focus = false) {
    if (!showMarkdown && !forceSource) richEditor?.captureSelection?.();
    const wasSource = showMarkdown || forceSource;
    const saved = selection(), scroller = options.scroller, top = scroller.scrollTop;
    const previousView = showMarkdown || forceSource ? sourceEditor?.view : richEditor?.view;
    let previousY = null;
    try { previousY = previousView?.coordsAtPos(previousView.state.selection.main?.head ?? previousView.state.selection.head)?.top; } catch {}
    showMarkdown = Boolean(next); sourceSelection = saved;
    options.richParent.hidden = showMarkdown || forceSource;
    options.sourceParent.hidden = !showMarkdown && !forceSource;
    if (showMarkdown || forceSource) { ensureSource(); sourceEditor.setDocument(content, saved); sourceOrigin = wasSource ? sourceOrigin : false; }
    else { ensureRich(); richEditor.setDocument(content, saved, { logical: wasSource && sourceOrigin }); sourceOrigin = false; }
    options.onPresentation(showMarkdown, locked, forceSource);
    setScrollInstant(scroller, top);
    sourceEditor?.view.requestMeasure();
    if (showMarkdown || forceSource) sourceEditor?.revealSelection();
    if (focus) (showMarkdown || forceSource ? sourceEditor : richEditor).focus();
    const viewport = scroller.getBoundingClientRect();
    if (previousY !== null && previousY >= viewport.top && previousY <= viewport.bottom) requestAnimationFrame(() => {
      if (disposed) return;
      const activeView = showMarkdown || forceSource ? sourceEditor?.view : richEditor?.view;
      try { const y = activeView.coordsAtPos(activeView.state.selection.main?.head ?? activeView.state.selection.head)?.top; if (y !== undefined) setScrollInstant(scroller, scroller.scrollTop + y - previousY); } catch {}
    });
  }
  function undo(redo = false) {
    if (isLocked()) return false;
    const from = redo ? future : history, to = redo ? history : future;
    const entry = from.pop(); if (!entry) return false;
    to.push({ content, selection: selection(), fallback: forceSource }); groupTime = 0;
    sourceOrigin = true;
    forceSource = Boolean(entry.fallback) || entry.content.length > MAX_RICH_LENGTH;
    sync(entry.content, entry.selection, true); presentation(showMarkdown, false); notify(); return true;
  }
  // Source-only fallback documents can still accept formatting Markdown. The
  // rich engine is intentionally not mounted for them, so apply the same
  // inline syntax directly to the CodeMirror buffer.
  function sourceCommand(name) {
    const view = sourceEditor?.view;
    if (!view || isLocked()) return false;
    const range = view.state.selection.main;
    const from = Math.min(range.from, range.to), to = Math.max(range.from, range.to);
    const selected = view.state.doc.sliceString(from, to);
    const replace = (insert, anchor, head = anchor) => {
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + anchor, head: from + head }, userEvent: 'input' });
      view.focus(); return true;
    };
    const wrap = (open, close = open) => replace(open + selected + close, open.length, open.length + selected.length);
    if (name === 'bold') return wrap('**');
    if (name === 'italic') return wrap('*');
    if (name === 'code') return wrap('`');
    if (name === 'strike') return wrap('~~');
    if (name === 'math') return selected ? wrap('$') : replace('$x$', 1, 2);
    const destinationText = selected && !/\s/.test(selected) && !/[()]/.test(selected)
      && /^(?:[a-z][a-z\d+.-]*:\S+|\/\/\S+|\/{1,2}\S*|\.{1,2}\/\S+|[\w.-]+\/[\w./-]*)$/i.test(selected);
    if (name === 'link') {
      if (destinationText) return replace(`[${selected}](${selected})`, selected.length + 3, selected.length * 2 + 3);
      if (selected) return replace(`[${selected}](https://example.com)`, selected.length + 3, selected.length + 22);
      return replace('[text](https://example.com)', 1, 5);
    }
    if (name === 'image') {
      if (destinationText) return replace(`![image](${selected})`, 2, 7);
      if (selected) return replace(`![${selected}](image.png)`, selected.length + 4, selected.length + 13);
      return replace('![alt](image.png)', 2, 5);
    }
    const prefix = name === 'heading' ? '## ' : name === 'bullet' ? '- ' : name === 'numbered' ? '1. ' : name === 'quote' ? '> ' : null;
    if (!prefix) return false;
    const lineFrom = view.state.doc.lineAt(from).from;
    const lineTo = view.state.doc.lineAt(to).to;
    const lines = view.state.doc.sliceString(lineFrom, lineTo).split('\n');
    const insert = lines.map(line => prefix + line).join('\n');
    view.dispatch({ changes: { from: lineFrom, to: lineTo, insert }, selection: { anchor: lineFrom + insert.length }, userEvent: 'input' });
    view.focus(); return true;
  }
  presentation(false);
  return {
    getText: () => content,
    checkpoint() { groupTime = 0; },
    getSelection: selection,
    captureSelection() { if (!showMarkdown && !forceSource) richEditor?.captureSelection?.(); },
    isLocked: () => locked,
    isSource: () => showMarkdown || forceSource,
    isFallback: () => forceSource,
    setFallback(value) { forceSource = Boolean(value) || content.length > MAX_RICH_LENGTH; presentation(showMarkdown, false); },
    setPresentation: (next, focus = true) => presentation(next, focus),
    setLocked(next) {
      // Transition protection is temporary and owned by the app. An unlock
      // attempt while a document is being replaced must not clear either the
      // protection or the user's persistent Lock.
      if (transitionLocked) return;
      locked = Boolean(next); groupTime = 0; sourceEditor?.setLocked(locked); richEditor?.setLocked(locked); options.onPresentation(showMarkdown, locked, forceSource);
    },
    setTransitionLocked(next) {
      transitionLocked = Boolean(next); groupTime = 0;
      // Keep the editor focusable while transition protection is active: both
      // engines reject document-changing transactions against the effective
      // lock. Only refresh widget affordances here.
      sourceEditor?.setTransitionLocked?.(); richEditor?.setTransitionLocked?.();
    },
    replaceContent(next) { if (next !== content) { record(next, sourceSelection, selection(), false); sync(content); } },
    selectRange(anchor, head = anchor, focus = true) {
      if (showMarkdown || forceSource) sourceOrigin = true;
      groupTime = 0;
      // Selection requests carry exact source offsets. Keep them as the rich
      // bookmark so formatted matches (including their Markdown delimiters)
      // survive projection normalization and presentation switches.
      sync(content, { anchor, head }, true);
      if (showMarkdown || forceSource) sourceEditor?.revealSelection();
      else revealScrollerBounds(options.scroller, selectionBounds(richEditor?.view));
      if (focus) this.focus();
    },
    undo,
    command(name) {
      if (isLocked()) return;
      groupTime = 0;
      // A source-forced document never mounts the rich engine. Apply the
      // Markdown command to the source buffer instead of dereferencing null.
      if (forceSource) { sourceCommand(name); groupTime = 0; return; }
      if (showMarkdown) presentation(false);
      groupTime = 0;
      richEditor?.command(name);
      groupTime = 0;
    },
    highlightRange(anchor, head = anchor) {
      if (!showMarkdown && !forceSource) richEditor?.setSearchHighlight(anchor, head);
    },
    clearHighlight() { richEditor?.clearSearchHighlight?.(); },
    focus() { (showMarkdown || forceSource ? sourceEditor : richEditor)?.focus(); },
    refreshMedia(revoke = false) { mediaEpoch++; imageCache.clear(); cachedImageBytes = 0; if (revoke) consent.clear(); richEditor?.refreshMedia(); },
    destroy() { disposed = true; mediaEpoch++; options.sourceParent?.removeEventListener('mousedown', noteSourceOrigin); options.sourceParent?.removeEventListener('keydown', noteSourceOrigin); sourceEditor?.destroy(); richEditor?.destroy(); }
  };
}
