'use strict';
// Shell adapter. The engines live in the locally bundled editor/ modules.
let editor = null, editorDocument = null, editorPath = null, outlineTimer, fallbackCheckedContent = null;
let outlineRevision = 0;
let previewBlocks = [];
// Temporary protection while a queued open replaces the active document. This
// is separate from the user's persistent Lock; it starts before native
// open_document and ends after the replacement editor has mounted (or failed).
let transitionLocked = false;
function setTransitionLocked(next) {
  transitionLocked = Boolean(next);
  editor?.setTransitionLocked(transitionLocked);
}
function resetHistory() {} // History belongs to the active document controller.
function changeContent(content) { if (editor) editor.replaceContent(content); else { current.content = content; updateTitle(); scheduleStats(); } }
function undoRedo(redo = false) { return editor?.undo(redo) || false; }
function commitInlineEdit() { return Promise.resolve(true); }
function syncPreviewEditing() {}
function syncSourceFallback() {}
function previewBlockAtViewportTop() { return 0; }
function previewElementForBlock() { return $('preview').querySelector('h1,h2,p') || $('source-editor'); }

function editorPresentation(show, locked, fallback) {
  mode = show ? 'edit' : 'read'; root.dataset.mode = mode;
  const formattedButton = $('view-formatted');
  if (formattedButton) {
    formattedButton.setAttribute('aria-pressed', String(!show));
    const formattedLabel = show ? 'Show formatted view (Ctrl+E)' : 'Formatted view (Ctrl+E)';
    formattedButton.setAttribute('aria-label', formattedLabel);
    formattedButton.title = formattedLabel;
  }
  const showButton = $('show-markdown');
  showButton.setAttribute('aria-pressed', String(show));
  const showLabel = show ? 'Markdown source (Ctrl+E)' : 'Show Markdown source (Ctrl+E)';
  showButton.setAttribute('aria-label', showLabel);
  showButton.title = showLabel;
  const lockButton = $('lock-document');
  lockButton.setAttribute('aria-pressed', String(locked));
  const lockLabel = locked ? 'Unlock document editing' : 'Protect against accidental edits';
  lockButton.setAttribute('aria-label', lockLabel);
  lockButton.title = lockLabel;
  lockButton.querySelector('use')?.setAttribute('href', locked ? '#i-lock' : '#i-unlock');
  $('editor-lock-note').hidden = !locked;
  $('editor-notice').hidden = !fallback;
  $('format-tools').querySelectorAll('button,select').forEach(control => { control.disabled = locked; });
}
function revealSourceForEdit(from, to) {
  if (!editor || editor.isLocked()) return;
  const value = editor.getText();
  const safeFrom = Math.max(0, Math.min(Number.isFinite(from) ? from : 0, value.length));
  const safeTo = Math.max(0, Math.min(Number.isFinite(to) ? to : safeFrom, value.length));
  const anchor = Math.min(safeFrom, safeTo), head = Math.max(safeFrom, safeTo);
  // In-buffer source access: the Markdown projection is the same persistent
  // buffer, not a separate edit session. Switching presentation preserves
  // content, caret history and undo; selecting the exact syntax range keeps
  // keyboard focus and selection predictable.
  if (!editor.isSource()) editor.setPresentation(true, false);
  editor.selectRange(anchor, head, true);
}
function openSourceSnapshot() {
  if (!editor) return;
  editor.captureSelection?.();
  $('source-snapshot-text').value = editor.getText();
  $('source-snapshot-status').textContent = 'Exact Markdown at the time this snapshot was opened. Unsaved changes are included.';
  $('source-dialog').showModal(); $('source-snapshot-text').focus();
}
function scheduleEditorOutline() { clearTimeout(outlineTimer); outlineTimer = setTimeout(refreshEditorOutline, 180); }
function headingSlug(text) {
  // Match the native renderer's heading-id convention: lowercase, drop
  // punctuation but keep letters, digits, whitespace, hyphens and underscores,
  // then turn every remaining whitespace character into a hyphen (runs are not
  // collapsed, so "A & B" becomes "a--b" like the preview's own id).
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}
function refreshEditorOutline() {
  if (!editor || !current.active) return;
  const headings = window.FolioEditor.headings(current.content);
  const lineStarts = [0];
  for (let index = 0; index < current.content.length; index++) if (current.content[index] === '\n') lineStarts.push(index + 1);
  $('outline-items').replaceChildren(); outlineEntries = []; outlineActiveIndex = -1;
  const elements = editor.isSource() ? [] : [...$('preview').querySelectorAll('h1,h2,h3,h4,h5,h6')];
  const seenIds = new Set();
  let cursor = 0;
  for (const heading of headings) {
    let element = null;
    while (cursor < elements.length) {
      const candidate = elements[cursor];
      const extension = candidate.closest('.extension-preview');
      if (heading.raw && !extension) break;
      cursor++;
      if (!heading.raw && extension) continue;
      if (extension) {
        const pos = candidate.dataset?.sourcepos;
        const offset = pos ? lineStarts[Math.max(0, Number.parseInt(pos, 10) - 1)] : undefined;
        if (candidate.dataset.folioOutlineRevision !== String(outlineRevision) || offset !== heading.offset) continue;
      }
      if (Number(candidate.tagName.slice(1)) === heading.level) { element = candidate; break; }
    }
    const semantic = heading.semantic ?? heading.text.replace(/\$([^$\n]+)\$/g, '$1').replace(/[*_`~]/g, '');
    const text = element && element.closest('.extension-preview') ? (element.textContent.trim() || semantic) : semantic;
    let id = element?.closest('.extension-preview') ? element.id : '';
    if (!id) {
      const base = `doc-${headingSlug(text) || 'heading'}`;
      id = base;
      let suffix = 1;
      while (seenIds.has(id)) id = `${base}-${suffix++}`;
    }
    seenIds.add(id);
    const button = document.createElement('button'); button.className = 'outline-link'; button.textContent = text;
    button.dataset.level = heading.level; button.style.setProperty('--indent', `${(heading.level - 1) * 12}px`); button.tabIndex = outlineEntries.length ? -1 : 0;
    button.onclick = () => { editor.selectRange(heading.offset); setActiveOutline(outlineEntries.indexOf(entry)); element?.scrollIntoView({ block: 'center' }); };
    const entry = { id, element, button, offset: heading.offset };
    $('outline-items').append(button); outlineEntries.push(entry);
  }
  $('outline-count').textContent = outlineEntries.length ? `${outlineEntries.length} ${outlineEntries.length === 1 ? 'section' : 'sections'}` : 'No headings';
  if (!outlineEntries.length) { const empty = document.createElement('p'); empty.className = 'sidebar-empty'; empty.textContent = 'Add a heading to build the outline.'; $('outline-items').append(empty); }
  requestAnimationFrame(updateActiveOutline);
}

async function mountUnifiedEditor() {
  if (!current.active) {
    editor?.destroy(); editor = null; editorDocument = null;
    $('preview').replaceChildren(); $('source-editor').replaceChildren(); return;
  }
  if (editorDocument === current && editor) {
    if (editor.getText() !== current.content) editor.replaceContent(current.content);
    if (editor.isFallback() && current.content !== fallbackCheckedContent && current.content.length <= 2 * 1024 * 1024) {
      fallbackCheckedContent = current.content;
      try {
        const result = await invoke('render_markdown', { content: current.content, remoteImages: false });
        if (!/data-preview-limit=/.test((typeof result === 'string' ? result : result.html) || '')) { editor.setFallback(false); refreshEditorOutline(); }
      } catch {}
    }
    if (editorPath !== current.path) { editorPath = current.path; editor.refreshMedia(); }
    return;
  }
  const documentAtOpen = current, generation = ++renderGeneration;
  editor?.destroy(); editor = null; cancelMermaidPending();
  $('preview').replaceChildren(); $('source-editor').replaceChildren();
  await loadAsset('vendor/editor/editor.js');
  await loadAsset('vendor/editor/editor.css', true);
  if (current !== documentAtOpen || generation !== renderGeneration) return;
  let limited = false;
  try {
    const result = await invoke('render_markdown', { content: current.content, remoteImages: false });
    const html = typeof result === 'string' ? result : result.html;
    limited = /data-preview-limit=/.test(html || ''); previewBlocks = result.blocks || [];
  } catch { limited = true; }
  if (current !== documentAtOpen || generation !== renderGeneration) return;
  let extensionCache = null, extensionContent = null, extensionRemote = null;
  const codeHighlightCache = new Map();
  editorDocument = current; editorPath = current.path;
  fallbackCheckedContent = current.content;
  const editorOptions = {
    content: current.content, forceSource: limited, transitionLocked, richParent: $('preview'), sourceParent: $('source-editor'), scroller: $('reader-scroll'),
    onChange(content) { if (current !== documentAtOpen) return; outlineRevision++; current.content = content; previewSnapshot = null; updateTitle(); scheduleStats(); scheduleEditorOutline(); if (!$('find-bar').hidden) editor?.clearHighlight?.(); },
    onPresentation: editorPresentation, message: toast, loadKatex, remoteImages: () => remoteImages, themeRevision: () => diagramThemeRevision,
    revealSource: (from, to) => revealSourceForEdit(from, to),
    openLink(href) { const anchor = document.createElement('a'); anchor.setAttribute('href', href); followPreviewLink(anchor); },
    async renderExtension(source) {
      const snapshot = current.content;
      const revision = outlineRevision;
      const allowedRemote = remoteImages === true;
      if (extensionContent !== snapshot || extensionRemote !== allowedRemote) {
        extensionContent = snapshot;
        extensionRemote = allowedRemote;
        extensionCache = invoke('render_markdown', { content: snapshot, remoteImages: allowedRemote });
      }
      const result = await extensionCache;
      if (current !== documentAtOpen || (remoteImages === true) !== allowedRemote) throw new Error('Extension render expired');
      if (current.content !== snapshot) return editorOptions.renderExtension(source);
      const parsed = new DOMParser().parseFromString(typeof result === 'string' ? result : result.html || '', 'text/html');
      const offset = snapshot.indexOf(source), line = offset < 0 ? -1 : snapshot.slice(0, offset).split('\n').length;
      const match = [...parsed.body.querySelectorAll('[data-sourcepos]')].find(node => node.dataset.sourcepos.startsWith(`${line}:`));
      if (match?.matches('h1,h2,h3,h4,h5,h6')) match.dataset.folioOutlineRevision = String(revision);
      let html = match?.outerHTML;
      if (html === undefined && /^\s*</.test(source) && !/^---\n/.test(source)) {
        // Raw author HTML blocks are emitted without a data-sourcepos wrapper.
        // Render exactly this block through the native sanitizer instead of
        // trusting any author-provided marker; remote images follow the user's
        // explicit preference and stay blocked otherwise.
        try {
          const fallback = await invoke('render_markdown', { content: source, remoteImages: allowedRemote });
          if (current !== documentAtOpen || (remoteImages === true) !== allowedRemote) throw new Error('Extension render expired');
          if (current.content !== snapshot) return editorOptions.renderExtension(source);
          const fallbackParsed = new DOMParser().parseFromString(typeof fallback === 'string' ? fallback : fallback.html || '', 'text/html');
          html = fallbackParsed.body.innerHTML;
        } catch { html = undefined; }
      }
      const output = html ?? (/^---\n/.test(source) ? '' : null);
      if (output === null) throw new Error('No safe projection for this extension');
      // Raw projections mount asynchronously; refresh once the caller has
      // inserted the returned HTML so extension headings take their place in
      // the outline with the same source identity as the preview.
      setTimeout(scheduleEditorOutline, 0);
      return output;
    },
    async renderDiagram(source, signal) {
      if (mermaidSourceTooLarge(source)) return { ok: false };
      const { result } = await requestMermaidRender(source, signal); return result;
    },
    // Reuse the native, sanitized syntax highlighter for fenced code. The
    // result is only the inner HTML of its escaped code element; the rich
    // editor copies text nodes and token spans out of it, never markup.
    async highlightCode(code, language) {
      const key = `${language}\u0000${code}`;
      if (codeHighlightCache.has(key)) return codeHighlightCache.get(key);
      const longestRun = Math.max(2, ...[...String(code).matchAll(/`+/g)].map(match => match[0].length));
      const fence = '`'.repeat(longestRun + 1);
      const tag = /^[a-z0-9_+#.-]*$/i.test(language) ? language : '';
      const result = await invoke('render_markdown', { content: `${fence}${tag}\n${code}\n${fence}`, remoteImages: false });
      const html = typeof result === 'string' ? result : result.html;
      const parsed = new DOMParser().parseFromString(html || '', 'text/html');
      const highlightedNode = parsed.querySelector('pre code');
      // The native adapter terminates its code element with a newline. Remove
      // exactly that terminator so the token layer mirrors the node text.
      if (highlightedNode?.textContent.endsWith('\n')) {
        const walker = document.createTreeWalker(highlightedNode, NodeFilter.SHOW_TEXT);
        let last = null, current;
        while ((current = walker.nextNode())) last = current;
        if (last?.nodeValue.endsWith('\n')) last.nodeValue = last.nodeValue.slice(0, -1);
      }
      const highlighted = highlightedNode?.innerHTML || '';
      if (key.length < 100000) {
        codeHighlightCache.set(key, highlighted);
        if (codeHighlightCache.size > 100) codeHighlightCache.delete(codeHighlightCache.keys().next().value);
      }
      return highlighted;
    },
    async renderImage(destination, allowRemote) {
      // Reuse the native renderer's canonical, document-relative resolver and
      // per-file budgets. Never introduce an arbitrary-file-read command.
      const escaped = String(destination).replace(/\\/g, '/').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\n|\r/g, '');
      const result = await invoke('render_markdown', { content: `![image](<${escaped}>)`, remoteImages: allowRemote });
      if (current !== documentAtOpen) return { error: 'Image request expired' };
      const html = typeof result === 'string' ? result : result.html;
      const parsed = new DOMParser().parseFromString(html || '', 'text/html');
      const src = parsed.querySelector('img')?.getAttribute('src');
      if (!src || !/^(?:data:image\/(?:png|jpeg|gif|webp|svg\+xml|avif|bmp|x-icon);base64,|https:\/\/)/i.test(src)) return { error: 'Image unavailable or blocked. Source is preserved.' };
      return { src };
    }
  };
  try {
    editor = window.FolioEditor.create(editorOptions);
  } catch {
    // A rich-projection failure must not leave the reader pane blank. Source
    // mode has no Markdown projection step, so it can still open the document.
    $('preview').replaceChildren(); $('source-editor').replaceChildren();
    try {
      editor = window.FolioEditor.create({ ...editorOptions, forceSource: true });
    } catch (fallbackError) {
      toast('This document could not be opened in the editor. Your file is unchanged.');
      throw fallbackError;
    }
    toast('Rich view unavailable for this document. Showing Markdown source.');
  }
  $('folder-empty').hidden = true; refreshEditorOutline(); status('');
}

function switchPresentation(show) {
  return enqueue(async () => { await renderPreview(); editor?.setPresentation(show); refreshEditorOutline(); });
}
$('view-switch').addEventListener('mousedown', event => { if (event.target.closest('button')) event.preventDefault(); });
$('view-switch').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const segments = [...$('view-switch').querySelectorAll('button')];
  if (!segments.length) return;
  event.preventDefault();
  const current = segments.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? segments.length - 1
    : (current + (event.key === 'ArrowRight' ? 1 : -1) + segments.length) % segments.length;
  segments[next].focus();
});
$('show-markdown').onclick = () => { if (mode !== 'edit') switchPresentation(true); };
$('view-formatted').onclick = () => { if (mode !== 'read') switchPresentation(false); };
$('lock-document').onclick = () => editor?.setLocked(!editor.isLocked());
$('source-snapshot').onclick = openSourceSnapshot;
$('source-snapshot-close').onclick = () => { $('source-dialog').close(); editor?.focus(); };
$('source-snapshot-copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('source-snapshot-text').value); $('source-snapshot-status').textContent = 'Snapshot copied.'; }
  catch { $('source-snapshot-text').focus(); $('source-snapshot-text').select(); document.execCommand('copy'); $('source-snapshot-status').textContent = 'Snapshot selected for copying.'; }
};
$('source-dialog').addEventListener('cancel', event => {
  event.preventDefault(); $('source-dialog').close(); editor?.focus();
});
$('format-tools').addEventListener('mousedown', event => { if (event.target.closest('button')) event.preventDefault(); });
$('format-tools').addEventListener('click', event => { const command = event.target.closest('[data-editor-command]')?.dataset.editorCommand; if (command) editor?.command(command); });
