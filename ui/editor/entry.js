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
export function headings(content) {
  const lines = [0]; for (let i = 0; i < content.length; i++) if (content[i] === '\n') lines.push(i + 1);
  const tokens = tokenizer.parse(content, {}), result = [];
  tokens.forEach((token, index) => { if (token.type === 'heading_open') result.push({ level: +token.tag.slice(1), text: tokens[index + 1]?.content || '', offset: lines[token.map?.[0]] || 0 }); });
  return result;
}
export function create(options) {
  let content = options.content, locked = false, showMarkdown = false, sourceEditor = null, richEditor = null;
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
  function record(next, after, before, typing = true) {
    if (locked || next === content) return;
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
  const shared = { ...options, reserveImage, isLocked: () => locked, undo: redo => undo(redo) };
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
    if (locked) return false;
    const from = redo ? future : history, to = redo ? history : future;
    const entry = from.pop(); if (!entry) return false;
    to.push({ content, selection: selection(), fallback: forceSource }); groupTime = 0;
    sourceOrigin = true;
    forceSource = Boolean(entry.fallback) || entry.content.length > MAX_RICH_LENGTH;
    sync(entry.content, entry.selection, true); presentation(showMarkdown, false); notify(); return true;
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
    setLocked(next) { locked = Boolean(next); groupTime = 0; sourceEditor?.setLocked(locked); richEditor?.setLocked(locked); options.onPresentation(showMarkdown, locked, forceSource); },
    replaceContent(next) { if (next !== content) { record(next, sourceSelection, selection(), false); sync(content); } },
    selectRange(anchor, head = anchor, focus = true) {
      if (showMarkdown || forceSource) sourceOrigin = true;
      groupTime = 0;
      sync(content, { anchor, head });
      if (showMarkdown || forceSource) sourceEditor?.revealSelection();
      if (focus) this.focus();
    },
    undo,
    command(name) { if (locked) return; if (showMarkdown || forceSource) presentation(false); groupTime = 0; richEditor.command(name); groupTime = 0; },
    focus() { (showMarkdown || forceSource ? sourceEditor : richEditor)?.focus(); },
    refreshMedia(revoke = false) { mediaEpoch++; imageCache.clear(); cachedImageBytes = 0; if (revoke) consent.clear(); richEditor?.refreshMedia(); },
    destroy() { disposed = true; mediaEpoch++; options.sourceParent?.removeEventListener('mousedown', noteSourceOrigin); options.sourceParent?.removeEventListener('keydown', noteSourceOrigin); sourceEditor?.destroy(); richEditor?.destroy(); }
  };
}
