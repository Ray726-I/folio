'use strict';
// Shell adapter. The engines live in the locally bundled editor/ modules.
let editor = null, editorDocument = null, editorPath = null, outlineTimer, fallbackCheckedContent = null;
let previewBlocks = [];
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
  const showButton = $('show-markdown');
  showButton.setAttribute('aria-pressed', String(show));
  const showLabel = show ? 'Hide Markdown (Ctrl+E)' : 'Show Markdown near the cursor (Ctrl+E)';
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
function openEditorAction(title, value, apply, open) {
  if (!editor || editor.isLocked()) return;
  const documentAtOpen = current;
  $('editor-action-title').textContent = title; $('editor-action-value').value = value;
  $('editor-action-open').hidden = !open;
  $('editor-action-open').onclick = () => { $('editor-action-dialog').close(); open?.(); };
  $('editor-action-form').onsubmit = event => {
    event.preventDefault();
    if (current === documentAtOpen && !editor.isLocked()) apply($('editor-action-value').value);
    $('editor-action-dialog').close(); editor?.focus();
  };
  $('editor-action-dialog').showModal(); $('editor-action-value').focus(); $('editor-action-value').select();
}
function openSourceSnapshot() {
  if (!editor) return;
  editor.captureSelection?.();
  $('source-snapshot-text').value = editor.getText();
  $('source-snapshot-status').textContent = 'Exact Markdown at the time this snapshot was opened. Unsaved changes are included.';
  $('source-dialog').showModal(); $('source-snapshot-text').focus();
}
function scheduleEditorOutline() { clearTimeout(outlineTimer); outlineTimer = setTimeout(refreshEditorOutline, 180); }
function refreshEditorOutline() {
  if (!editor || !current.active) return;
  const headings = window.FolioEditor.headings(current.content);
  $('outline-items').replaceChildren(); outlineEntries = []; outlineActiveIndex = -1;
  const elements = [...$('preview').querySelectorAll('h1,h2,h3,h4,h5,h6')];
  for (const [index, heading] of headings.entries()) {
    const button = document.createElement('button'); button.className = 'outline-link'; button.textContent = heading.text;
    button.dataset.level = heading.level; button.style.setProperty('--indent', `${(heading.level - 1) * 12}px`); button.tabIndex = index ? -1 : 0;
    const id = `doc-${heading.text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || index}`;
    button.onclick = () => { editor.selectRange(heading.offset); setActiveOutline(index); elements[index]?.scrollIntoView({ block: 'center' }); };
    $('outline-items').append(button); outlineEntries.push({ id, element: elements[index], button, offset: heading.offset });
  }
  $('outline-count').textContent = headings.length ? `${headings.length} ${headings.length === 1 ? 'section' : 'sections'}` : 'No headings';
  if (!headings.length) { const empty = document.createElement('p'); empty.className = 'sidebar-empty'; empty.textContent = 'Add a heading to build the outline.'; $('outline-items').append(empty); }
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
  let extensionCache = null, extensionContent = null;
  editorDocument = current; editorPath = current.path;
  fallbackCheckedContent = current.content;
  const editorOptions = {
    content: current.content, forceSource: limited, richParent: $('preview'), sourceParent: $('source-editor'), scroller: $('reader-scroll'),
    onChange(content) { if (current !== documentAtOpen) return; current.content = content; previewSnapshot = null; updateTitle(); scheduleStats(); scheduleEditorOutline(); },
    onPresentation: editorPresentation, message: toast, loadKatex, remoteImages: () => remoteImages, themeRevision: () => diagramThemeRevision,
    editText: (title, value, apply) => openEditorAction(title, value, apply),
    editLink: (value, apply, open) => openEditorAction('Link URL', value, apply, open),
    openLink(href) { const anchor = document.createElement('a'); anchor.setAttribute('href', href); followPreviewLink(anchor); },
    async renderExtension(source) {
      if (extensionContent !== current.content) {
        extensionContent = current.content;
        extensionCache = invoke('render_markdown', { content: current.content, remoteImages: false });
      }
      const result = await extensionCache;
      if (current !== documentAtOpen) return '';
      const parsed = new DOMParser().parseFromString(typeof result === 'string' ? result : result.html || '', 'text/html');
      const offset = current.content.indexOf(source), line = offset < 0 ? -1 : current.content.slice(0, offset).split('\n').length;
      const match = [...parsed.body.querySelectorAll('[data-sourcepos]')].find(node => node.dataset.sourcepos.startsWith(`${line}:`));
      const html = match?.outerHTML || (/^---\n/.test(source) ? '' : null);
      if (html === null) throw new Error('No safe projection for this extension');
      return html;
    },
    async renderDiagram(source, signal) {
      if (mermaidSourceTooLarge(source)) return { ok: false };
      const { result } = await requestMermaidRender(source, signal); return result;
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

$('show-markdown').addEventListener('mousedown', event => event.preventDefault());
$('show-markdown').onclick = () => enqueue(async () => { const next = mode !== 'edit'; await renderPreview(); editor?.setPresentation(next); refreshEditorOutline(); });
$('lock-document').onclick = () => editor?.setLocked(!editor.isLocked());
$('source-snapshot').onclick = openSourceSnapshot;
$('source-snapshot-close').onclick = () => { $('source-dialog').close(); editor?.focus(); };
$('source-snapshot-copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('source-snapshot-text').value); $('source-snapshot-status').textContent = 'Snapshot copied.'; }
  catch { $('source-snapshot-text').focus(); $('source-snapshot-text').select(); document.execCommand('copy'); $('source-snapshot-status').textContent = 'Snapshot selected for copying.'; }
};
$('editor-action-cancel').onclick = () => { $('editor-action-dialog').close(); editor?.focus(); };
for (const id of ['source-dialog', 'editor-action-dialog']) $(id).addEventListener('cancel', event => {
  event.preventDefault(); $(id).close(); editor?.focus();
});
$('format-tools').addEventListener('mousedown', event => { if (event.target.closest('button')) event.preventDefault(); });
$('format-tools').addEventListener('click', event => { const command = event.target.closest('[data-editor-command]')?.dataset.editorCommand; if (command) editor?.command(command); });
