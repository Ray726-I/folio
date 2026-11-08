'use strict';
// Shell adapter. The engines live in the locally bundled editor/ modules.
let editor = null, editorDocument = null, editorPath = null, outlineTimer, fallbackCheckedContent = null;
let outlineRevision = 0, outlineFallbackIdentity = 0;
// Anything larger is shown read-only: ProseMirror would have to parse it in JS.
const MAX_RICH_LENGTH = 2 * 1024 * 1024;
// Temporary protection while a queued open replaces the active document. This
// is separate from the user's persistent Lock; it starts before native
// open_document and ends after the replacement editor has mounted (or failed).
let transitionLocked = false;
function setTransitionLocked(next) {
  transitionLocked = Boolean(next);
  editor?.setTransitionLocked(transitionLocked);
  if (typeof current !== 'undefined') syncDocumentMode();
}
function changeContent(content) { if (editor) editor.replaceContent(content); else { current.content = content; documentEdited(); updateTitle(); scheduleStats(); } }
function undoRedo(redo = false) { return editor?.undo(redo) || false; }
function editorPresentation(_show, locked, fallback) {
  // One editing surface: the document is always the formatted editor.
  mode = 'read'; root.dataset.mode = mode;
  const lockButton = $('lock-document');
  lockButton.setAttribute('aria-pressed', String(locked));
  const lockLabel = locked ? 'Unlock document editing' : 'Protect against accidental edits';
  lockButton.setAttribute('aria-label', 'Open as read-only');
  lockButton.title = lockLabel;
  lockButton.querySelector('use')?.setAttribute('href', locked ? '#i-lock' : '#i-unlock');
  $('editor-lock-note').hidden = !locked;
  $('editor-notice').hidden = !fallback;

}
// Kept for blocks whose exact byte range the ledger cannot prove. Atoms with a
// provable range open their own in-place editor instead of reaching this.
function revealSourceForEdit() {
  toast('This block’s exact source could not be located. Edit it from the source snapshot.');
}
function openSourceSnapshot() {
  if (!current.active) return;
  // Without a mounted editor (over-limit documents) the snapshot still shows
  // the canonical buffer, so the exact bytes stay copyable.
  closeAllMenus();
  editor?.captureSelection?.();
  $('source-snapshot-text').value = editor ? editor.getText() : current.content;
  $('source-snapshot-status').textContent = 'Exact Markdown at the time this snapshot was opened. Unsaved changes are included.';
  $('source-dialog').showModal(); $('source-snapshot-text').focus();
  $('source-snapshot-text').setSelectionRange(0, 0); $('source-snapshot-text').scrollTop = 0;
}
function scheduleEditorOutline() { clearTimeout(outlineTimer); outlineTimer = setTimeout(refreshEditorOutline, 500); }
// Outline entries point at the heading's line start. Placing the caret there
// inserts text before the `#` markers and silently demotes the heading to a
// paragraph. Land on the first visible character through any list/quote prefix
// instead; Setext headings already start at their text.
function headingCaretOffset(offset) {
  const end = current.content.indexOf('\n', offset);
  const line = current.content.slice(offset, end < 0 ? current.content.length : end);
  const match = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(#{1,6})(?:[ \t]+|$)/.exec(line);
  return match ? offset + match[0].length : offset;
}
function headingSlug(text) {
  // Match the native renderer's heading-id convention: lowercase, drop
  // punctuation but keep letters, digits, whitespace, hyphens and underscores,
  // then turn every remaining whitespace character into a hyphen (runs are not
  // collapsed, so "A & B" becomes "a--b" like the preview's own id).
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}
function lineStartsFor(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1);
  return starts;
}
function refreshEditorOutline() {
  if (focusedPane === 'companion') { refreshCompanionOutline(); return; }
  if (!editor || !current.active) return;
  if ($('outline').hidden && !(dockVisible && dockTab === 'outline')) return;
  const headings = (!editor.isSource?.() && editor.getHeadings?.()) || window.FolioEditor.headings(current.content);
  $('outline').hidden = !headings.length || !dockVisible || dockTab !== 'outline'; $('outline-divider').hidden = $('outline').hidden;
  const previousEntries = outlineEntries;
  const previousByKey = new Map((outlineStateDocument === current ? previousEntries : []).filter(entry => entry.key).map(entry => [entry.key, entry]));
  const previousActive = previousEntries[outlineActiveIndex];
  const nextEntries = [];
  let treeChanged = headings.length !== previousEntries.length;
  let lineStarts;
  const elements = [...$('preview').querySelectorAll('h1,h2,h3,h4,h5,h6')];
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
        if (!lineStarts) lineStarts = lineStartsFor(current.content);
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
    let entry = heading.key ? previousByKey.get(heading.key) : null;
    if (!entry) {
      const button = document.createElement('button'); button.className = 'outline-link'; button.tabIndex = -1;
      entry = { button, key: heading.key || `outline-fallback-${++outlineFallbackIdentity}` };
      button.onclick = () => {
        const caret = headingCaretOffset(entry.offset);
        if (documentMode === 'source') { jumpToSource(caret); setActiveOutline(outlineEntries.indexOf(entry), { instant: true }); return; }
        // Claim the highlight first so rapid scroll events from this jump do
        // not repaint it, then place the heading on the spy line the follower
        // reads. Same offset both sides means the follower converges on the
        // clicked heading instead of the one above it. Instant: a jump must
        // land, never animate past intermediate headings.
        suppressOutlineFollow(600);
        editor.selectRange(caret);
        const index = outlineEntries.indexOf(entry);
        setActiveOutline(index, { instant: true });
        const target = entry.element;
        if (target?.isConnected) {
          const reader = $('reader-scroll');
          const behavior = reader.style.scrollBehavior; reader.style.scrollBehavior = 'auto';
          reader.scrollTop += target.getBoundingClientRect().top - reader.getBoundingClientRect().top - OUTLINE_SPY_OFFSET;
          reader.style.scrollBehavior = behavior;
        }
      };
      treeChanged = true;
    }
    if (entry !== previousEntries[nextEntries.length] || entry.level !== heading.level) treeChanged = true;
    if (entry.text !== text) {
      entry.button.textContent = text; entry.button.title = text;
      if (entry.toggle) entry.toggle.setAttribute('aria-label', (outlineCollapsed.has(entry.key || id) ? 'Expand ' : 'Collapse ') + text);
    }
    if (entry.level !== heading.level) {
      entry.button.dataset.level = heading.level;
    }
    Object.assign(entry, { id, element, offset: heading.offset, level: heading.level, text });
    nextEntries.push(entry);
  }
  outlineEntries = nextEntries;
  outlineActiveIndex = previousActive ? outlineEntries.indexOf(previousActive) : -1;
  $('outline-count').textContent = outlineEntries.length ? `${outlineEntries.length} ${outlineEntries.length === 1 ? 'section' : 'sections'}` : 'No headings';
  // The companion reuses this list for its own buttons, and the dock can show
  // the panel without rebuilding it: if the live DOM is not our rows, rebuild
  // even when the heading data itself did not change.
  const domStale = $('outline-items').firstElementChild !== (outlineEntries[0]?.row ?? null);
  if (treeChanged || outlineStateDocument !== current || domStale) buildOutlineTree(previousEntries);
  if (!outlineEntries.length && !$('outline-items').querySelector('.sidebar-empty')) { const empty = document.createElement('p'); empty.className = 'sidebar-empty'; empty.textContent = 'Add a heading to build the outline.'; $('outline-items').append(empty); }
  const activeAtRefresh = outlineActiveIndex;
  requestAnimationFrame(() => { if (outlineActiveIndex === activeAtRefresh) updateActiveOutline(); });
}

// A single in-place value editor backed by the existing action dialog. Used
// for link and image destinations so they no longer require switching the
// document to a Markdown presentation.
function editValue({ title, value, placeholder = '' }) {
  const dialog = $('editor-action-dialog'), form = $('editor-action-form');
  const input = $('editor-action-value'), openButton = $('editor-action-open');
  $('editor-action-title').textContent = title || 'Edit';
  input.value = value || '';
  input.placeholder = placeholder;
  openButton.hidden = true;
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return; settled = true;
      form.removeEventListener('submit', onSubmit); dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onClose); $('editor-action-cancel').removeEventListener('click', onCancelClick);
      if (dialog.open) dialog.close();
      resolve(result);
    };
    const onSubmit = event => { event.preventDefault(); finish(input.value); };
    const onCancel = event => { event.preventDefault(); finish(null); };
    const onCancelClick = () => finish(null);
    const onClose = () => finish(null);
    form.addEventListener('submit', onSubmit); dialog.addEventListener('cancel', onCancel);
    $('editor-action-cancel').addEventListener('click', onCancelClick); dialog.addEventListener('close', onClose);
    dialog.showModal();
    input.focus(); input.select();
  });
}

async function mountUnifiedEditor() {
  if (!current.active) {
    editor?.destroy(); editor = null; editorDocument = null;
    $('preview').replaceChildren(); return;
  }
  if (editorDocument === current && editor) {
    if (editor.getText() !== current.content) editor.replaceContent(current.content);
    if (editorPath !== current.path) { editorPath = current.path; editor.refreshMedia(); }
    return;
  }
  const documentAtOpen = current, generation = ++renderGeneration;
  editor?.destroy(); editor = null; cancelMermaidPending();
  $('preview').replaceChildren();
  $('preview').classList.add('is-mounting');
  const finishMounting = () => $('preview').classList.remove('is-mounting');
  try {
    await loadAsset('vendor/editor/editor.js');
    await loadAsset('vendor/editor/editor.css', true);
  } catch (error) {
    finishMounting();
    throw error;
  }
  if (current !== documentAtOpen || generation !== renderGeneration) { finishMounting(); return; }
  // The native budgets are not the only ceiling: ProseMirror has to parse the
  // document again in JS, and the two-engine build refused anything over this
  // size. Check it first so an oversized file never pays a native render probe
  // it cannot use.
  let limited = current.content.length > MAX_RICH_LENGTH ? 'source-bytes' : false;
  if (!limited) {
    try {
      const result = await invoke('preview_check', { content: current.content });
      limited = result?.limited ? String(result.limited) : false;
    } catch { limited = true; }
  }
  if (current !== documentAtOpen || generation !== renderGeneration) { finishMounting(); return; }
  if (limited) {
    // ProseMirror cannot represent this document within the editor budgets, so
    // a second text engine is not worth keeping for it. Show the complete
    // Markdown read-only, keep Save exact, and never truncate.
    const shown = document.createElement('pre');
    shown.className = 'document-over-limit';
    shown.setAttribute('role', 'region');
    shown.setAttribute('aria-label', 'Markdown source, read-only');
    shown.setAttribute('tabindex', '0');
    shown.textContent = current.content;
    $('preview').replaceChildren(shown);
    $('editor-notice').hidden = false;
    editorDocument = current; editorPath = current.path; fallbackCheckedContent = current.content;
    finishMounting();
    status('');
    return;
  }
  $('editor-notice').hidden = true;
  let extensionCache = null, extensionContent = null, extensionRemote = null;
  const codeHighlightCache = new Map();
  editorDocument = current; editorPath = current.path;
  fallbackCheckedContent = current.content;
  const editorOptions = {
    content: current.content, transitionLocked, richParent: $('preview'), scroller: $('reader-scroll'),
    onChange(content) { if (current !== documentAtOpen) return; outlineRevision++; current.content = content; documentEdited(); previewSnapshot = null; updateTitle(); scheduleStats(); scheduleEditorOutline(); if (!$('find-bar').hidden) scheduleFindRefresh(); },
    onPresentation: editorPresentation, message: toast, loadKatex, remoteImages: () => remoteImages, themeRevision: () => diagramThemeRevision,
    revealSource: (from, to) => revealSourceForEdit(from, to), editValue, editClipboard,
    openLink(href) { const anchor = document.createElement('a'); anchor.setAttribute('href', href); followPreviewLink(anchor); },
    async renderExtension(source) {
      const snapshot = current.content;
      const revision = outlineRevision;
      const allowedRemote = remoteImages === true;
      if (extensionContent !== snapshot || extensionRemote !== allowedRemote) {
        extensionContent = snapshot;
        extensionRemote = allowedRemote;
        extensionCache = invoke('render_markdown', { documentId: documentAtOpen.documentId, content: snapshot, remoteImages: allowedRemote }).then(result => {
          const parsed = new DOMParser().parseFromString(typeof result === 'string' ? result : result.html || '', 'text/html');
          const byLine = new Map();
          for (const element of parsed.body.querySelectorAll('[data-sourcepos]')) {
            const line = Number.parseInt(element.dataset.sourcepos, 10);
            if (!byLine.has(line)) byLine.set(line, element);
          }
          return byLine;
        });
      }
      const byLine = await extensionCache;
      if (current !== documentAtOpen || (remoteImages === true) !== allowedRemote) throw new Error('Extension render expired');
      if (current.content !== snapshot) return editorOptions.renderExtension(source);
      const offset = snapshot.indexOf(source), line = offset < 0 ? -1 : snapshot.slice(0, offset).split('\n').length;
      const match = byLine.get(line);
      if (match?.matches('h1,h2,h3,h4,h5,h6')) match.dataset.folioOutlineRevision = String(revision);
      let html = match?.outerHTML;
      if (html === undefined && /^\s*</.test(source) && !/^---\n/.test(source)) {
        // Raw author HTML blocks are emitted without a data-sourcepos wrapper.
        // Render exactly this block through the native sanitizer instead of
        // trusting any author-provided marker; remote images follow the user's
        // explicit preference and stay blocked otherwise.
        try {
          const fallback = await invoke('render_markdown', { documentId: documentAtOpen.documentId, content: source, remoteImages: allowedRemote });
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
      const lang = /^[a-z0-9_+#.-]*$/i.test(language) ? language : null;
      const result = await invoke('highlight_code', { code, language: lang });
      const html = typeof result === 'string' ? result : result?.html || '';
      const parsed = new DOMParser().parseFromString(`<code>${html}</code>`, 'text/html');
      const highlightedNode = parsed.querySelector('code');
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
      const result = await invoke('render_markdown', { documentId: documentAtOpen.documentId, content: `![image](<${escaped}>)`, remoteImages: allowRemote });
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
    editor.restoreSession?.(current.view?.editor);
  } catch {
    // There is no second engine to retry into. Show the complete Markdown
    // read-only so the document is still inspectable and Save stays exact.
    const shown = document.createElement('pre');
    shown.className = 'document-over-limit';
    shown.textContent = current.content;
    $('preview').replaceChildren(shown);
    editor = null; editorDocument = null;
    finishMounting();
    toast('This document could not be opened in the editor. Its Markdown is shown read-only; your file is unchanged.');
    return;
  }
  syncDocumentMode();
  finishMounting();
  $('folder-empty').hidden = true; refreshEditorOutline(); status('');
}

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
