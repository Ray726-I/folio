import { createRichEditor } from './rich.js';
import { tokenizer, editorStats, resetEditorStats } from './model.js';
import { editDebug } from './source-edits.js';
import { headingFromRawBlock } from './headings.js';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-tables/style/tables.css';

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
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
export function create(options) {
  let content = options.content, locked = false, transitionLocked = Boolean(options.transitionLocked), richEditor = null;
  let history = [], future = [], groupTime = 0, groupSelection = null, sourceSelection = { anchor: 0, head: 0 };
  let sourceOnly = false, richStale = false;
  let disposed = false, mediaEpoch = 0, imageCount = 0, imageBytes = 0, cachedImageBytes = 0;
  const consent = new Set(), imageCache = new Map();
  function selection() { return sourceOnly ? sourceSelection : (richEditor?.selection() || sourceSelection); }
  function notify() { options.onChange(content); }
  const isLocked = () => locked || transitionLocked;
  const isUserLocked = () => locked;
  function record(next, after, before, typing = true) {
    if (isLocked() || next === content) return;
    if (next.length > MAX_SOURCE_BYTES / 4 && new TextEncoder().encode(next).length > MAX_SOURCE_BYTES) {
      options.message('This edit would exceed the 20 MiB document limit. The previous document is preserved.');
      richEditor?.setDocument(content, before || sourceSelection);
      return;
    }
    const now = Date.now();
    const previousSelection = before || sourceSelection;
    // A new undo group starts only for adjacent typing at the same collapsed
    // caret; a caret jump, paste or command ends the previous one.
    const adjacent = groupSelection && previousSelection.anchor === previousSelection.head &&
      groupSelection.anchor === previousSelection.anchor && groupSelection.head === previousSelection.head;
    if (!typing || !groupTime || !adjacent || now - groupTime > 650) {
      history.push({ content, selection: previousSelection });
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
  const shared = { ...options, reserveImage, isLocked, isUserLocked, checkpoint: () => { groupTime = 0; }, undo: redo => undo(redo) };
  // Match the native renderer's authority normalization: browsers ignore
  // embedded tabs/newlines, trim control/space edges, and treat backslashes in
  // special-scheme URLs as slashes. Missing one of these forms would let the
  // preview paint a placeholder but deny that image a working per-image Load.
  function remoteImageDestination(value) {
    const normalized = String(value || '')
      .replace(/[\t\n\r]/g, '')
      .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
    const slashed = normalized.replace(/\\/g, '/').toLowerCase();
    return slashed.startsWith('//') || slashed.startsWith('http:') || slashed.startsWith('https:') || normalized.startsWith('\\');
  }
  async function resolveImage(destination, allow) {
    const key = String(destination || ''), epoch = mediaEpoch;
    const remote = remoteImageDestination(key);
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
  function ensureRich() {
    if (!richEditor) richEditor = createRichEditor(options.richParent, { ...shared, content, resolveImage,
      onChange(next, after, before, typing) { record(next, after, before, typing); }
    });
  }
  function sync(next, target = sourceSelection, logical = false) {
    content = next; sourceSelection = target;
    richStale = false;
    ensureRich(); richEditor.setDocument(content, target, { logical });
  }
  function syncRich() {
    if (!richStale) return;
    richStale = false;
    ensureRich();
    richEditor.setDocument(content, sourceSelection, { logical: true });
  }
  function undo(redo = false) {
    if (isLocked()) return false;
    const from = redo ? future : history, to = redo ? history : future;
    const entry = from.pop(); if (!entry) return false;
    to.push({ content, selection: selection() }); groupTime = 0;
    if (sourceOnly) {
      content = entry.content; sourceSelection = entry.selection || sourceSelection;
      richStale = true; notify(); return true;
    }
    sync(entry.content, entry.selection, true); notify(); return true;
  }
  ensureRich();
  options.onPresentation?.(false, locked, false);
  return {
    getText: () => content,
    captureSession() { return { content, history: history.slice(), future: future.slice(), selection: { ...selection() }, sourceOnly, locked }; },
    restoreSession(session) {
      if (!session) return;
      content = session.content; history = session.history.slice(); future = session.future.slice(); groupTime = 0;
      sourceSelection = { ...session.selection }; sourceOnly = Boolean(session.sourceOnly); locked = Boolean(session.locked);
      richStale = sourceOnly; richEditor.setDocument(content, sourceSelection, { logical: true }); richEditor.setLocked(locked);
    },
    getHeadings: () => richEditor?.headings() ?? null,
    sourceAtCoords: coords => sourceOnly ? null : richEditor?.sourceAtCoords(coords) ?? null,
    context: () => richEditor?.context?.() ?? null,
    openBlockMenu: (anchor, trigger) => richEditor?.openBlockMenu?.(anchor, trigger),
    stats: () => ({ ...editorStats(), edit: editDebug }),
    resetStats: resetEditorStats,
    debugSelection() {
      const state = richEditor?.view?.state;
      if (!state) return null;
      return { from: state.selection.from, to: state.selection.to, anchor: state.selection.anchor, head: state.selection.head, type: state.selection.constructor.name };
    },
    checkpoint() { groupTime = 0; },
    getSelection: selection,
    captureSelection() { richEditor?.captureSelection?.(); },
    isLocked: () => locked,
    // Source-only mode updates the canonical buffer without synchronizing the
    // hidden rich editor on every keystroke. The rich view catches up on exit.
    isSource: () => sourceOnly,
    setSourceOnly(next, selection) {
      const wanted = Boolean(next);
      if (wanted === sourceOnly) return;
      if (wanted) {
        sourceSelection = selection || richEditor?.selection() || sourceSelection;
        sourceOnly = true;
        return;
      }
      if (selection) sourceSelection = selection;
      sourceOnly = false;
      if (richStale) syncRich();
      else richEditor?.setDocument(content, sourceSelection, { logical: true });
    },
    setSourceSelection(selection) { if (selection) sourceSelection = { anchor: selection.anchor, head: selection.head }; },
    replaceSource(next, selection, typing = true, before = null) {
      if (next === content) { if (selection) sourceSelection = selection; return; }
      record(next, selection, before || sourceSelection, typing);
      if (selection) sourceSelection = selection;
      richStale = true;
    },
    syncRich,
    setLocked(next) {
      // Transition protection is temporary and owned by the app. An unlock
      // attempt while a document is being replaced must not clear either the
      // protection or the user's persistent Lock.
      if (transitionLocked) return;
      locked = Boolean(next); groupTime = 0; richEditor?.setLocked(locked); options.onPresentation?.(false, locked, false);
    },
    setTransitionLocked(next) { transitionLocked = Boolean(next); groupTime = 0; richEditor?.setTransitionLocked?.(); },
    replaceContent(next) {
      if (next === content) return;
      if (sourceOnly) { this.replaceSource(next, sourceSelection, false); return; }
      record(next, sourceSelection, selection(), false); sync(content);
    },
    selectAll() { groupTime = 0; richEditor?.selectAll(); },
    selectRange(anchor, head = anchor, focus = true) {
      groupTime = 0;
      // Selection requests carry exact source offsets; keep them as the rich
      // bookmark so formatting delimiters survive projection normalization.
      sync(content, { anchor, head }, true);
      revealScrollerBounds(options.scroller, selectionBounds(richEditor?.view));
      if (focus) this.focus();
    },
    undo,
    // Source-mode insertion is handled by the shell because the textarea owns
    // the caret there. In Edit mode the rich engine applies the exact splice.
    insertMarkdown(markdown, selection = null) {
      if (isLocked()) return false;
      if (!sourceOnly) return Boolean(richEditor?.insertMarkdown?.(markdown, selection));
      const anchor = Number(selection?.anchor ?? sourceSelection.anchor);
      const head = Number(selection?.head ?? sourceSelection.head);
      if (!Number.isInteger(anchor) || !Number.isInteger(head)) return false;
      const from = Math.max(0, Math.min(anchor, head, content.length));
      const to = Math.max(0, Math.min(Math.max(anchor, head), content.length));
      const next = content.slice(0, from) + markdown + content.slice(to);
      if (next === content) return false;
      const after = { anchor: from + markdown.length, head: from + markdown.length };
      record(next, after, { anchor: from, head: to }, false);
      richStale = true;
      return content === next;
    },
    command(name, arg) { if (isLocked()) return false; groupTime = 0; const applied = richEditor?.command(name, arg) !== false; groupTime = 0; return applied; },
    highlightRange(anchor, head = anchor) { richEditor?.setSearchHighlight(anchor, head); },
    clearHighlight() { richEditor?.clearSearchHighlight?.(); },
    focus() { richEditor?.focus(); },
    refreshMedia(revoke = false) { mediaEpoch++; imageCache.clear(); cachedImageBytes = 0; if (revoke) consent.clear(); richEditor?.refreshMedia(); },
    destroy() { disposed = true; mediaEpoch++; richEditor?.destroy(); }
  };
}
