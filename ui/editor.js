'use strict';
// In-place editing, source mapping, and undo/redo.
let previewBlocks = [], inlineEdit = null;
let undoStack = [], redoStack = [], lastEditTime = 0, historyGroup = null;
function resetHistory() { undoStack = []; redoStack = []; historyGroup = null; lastEditTime = 0; }
function changeContent(content, group = null) {
  if (content === current.content) return;
  const now = performance.now();
  if (!group || group !== historyGroup || now - lastEditTime > 650) {
    undoStack.push(current.content);
    let size = undoStack.reduce((sum, value) => sum + value.length, 0);
    while (undoStack.length > 1 && (undoStack.length > 150 || size > 8 * 1024 * 1024)) size -= undoStack.shift().length;
  }
  historyGroup = group; lastEditTime = now; redoStack = [];
  current.content = content; updateTitle(); scheduleStats();
}
async function undoRedo(redo = false) {
  const from = redo ? redoStack : undoStack, to = redo ? undoStack : redoStack;
  if (!current.active || !from.length) return;
  const content = from.pop(); to.push(current.content); historyGroup = null;
  const edit = inlineEdit;
  current.content = content;

  if (edit && content.startsWith(edit.prefix) && content.endsWith(edit.suffix)
      && content.length >= edit.prefix.length + edit.suffix.length) {
    edit.textarea.value = content.slice(edit.prefix.length, content.length - edit.suffix.length);
    resizeLiveEditor(edit.textarea);
    edit.textarea.focus();
    edit.textarea.setSelectionRange(edit.textarea.value.length, edit.textarea.value.length);
  } else {
    cancelInlineEdit(); await renderPreview();
  }
  updateTitle(); scheduleStats();
}
function syncPreviewEditing() {
  const editable = mode === 'edit';
  if (!editable) $('preview').querySelectorAll('[data-empty-edit]').forEach(node => node.remove());
  // Only generated task checkboxes (tagged with data-task-index) are ever editable;
  // author-supplied raw HTML checkboxes stay disabled so preview state cannot drift.
  $('preview').querySelectorAll('input[type="checkbox"]').forEach(checkbox => { checkbox.disabled = !(editable && checkbox.hasAttribute('data-task-index')); });
  $('preview').querySelectorAll('[data-edit-index]').forEach(block => {
    block.classList.toggle('preview-editable', editable);
    if (editable) { block.tabIndex = 0; block.title = 'Click a line to edit Markdown'; }
    else { block.removeAttribute('tabindex'); block.removeAttribute('title'); }
  });
  if (!$('preview').children.length && editable && current.active) {
    const empty = document.createElement('p'); empty.className = 'empty-edit-line';
    empty.textContent = 'Start writing…'; empty.dataset.emptyEdit = ''; $('preview').append(empty);
  }
}
function cancelInlineEdit() {
  if (!inlineEdit) return;
  inlineEdit.original.hidden = false; inlineEdit.wrapper.remove(); inlineEdit = null;
}
function resizeLiveEditor(textarea) {
  textarea.style.height = '0px'; textarea.style.height = `${Math.max(32, textarea.scrollHeight)}px`;
}
function utf8Length(codePoint) {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}
// Source positions arrive in byte offsets, but strings are indexed in UTF-16
// units. Calls are monotonically increasing within a render, so keep a cursor
// instead of rescanning the document for every inline leaf.
let offsetCursor = { content: null, byte: 0, units: 0 };
function byteOffsetToUtf16(byteOffset) {
  if (offsetCursor.content !== current.content || byteOffset < offsetCursor.byte) {
    offsetCursor = { content: current.content, byte: 0, units: 0 };
  }
  while (offsetCursor.byte < byteOffset && offsetCursor.units < current.content.length) {
    const codePoint = current.content.codePointAt(offsetCursor.units);
    offsetCursor.byte += utf8Length(codePoint);
    offsetCursor.units += codePoint > 0xFFFF ? 2 : 1;
  }
  return offsetCursor.units;
}
function previewElementForBlock(index) { return $('preview').querySelector(`[data-edit-index="${index}"]`); }
function previewBlockAtViewportTop() {
  const top = $('reader-scroll').getBoundingClientRect().top;
  const elements = [...$('preview').querySelectorAll('[data-edit-index]')];
  const element = elements.find(block => block.getBoundingClientRect().bottom > top + 8) || elements.at(-1);
  return element ? Number(element.dataset.editIndex) : -1;
}

function mappedCharacters(original, nodes) {
  const walker = document.createTreeWalker(original, NodeFilter.SHOW_TEXT), dom = [];
  let joined = '';
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement.closest('.katex,svg,.anchor,input,.footnote-backref')) continue;
    dom.push({ node, start: joined.length }); joined += node.nodeValue;
  }
  const result = []; let search = 0, domIndex = 0;
  for (const leaf of nodes.filter(node => node.text && ['text', 'code'].includes(node.kind))) {
    const found = joined.indexOf(leaf.text, search);
    if (found < 0) continue;
    search = found + leaf.text.length;
    const start = byteOffsetToUtf16(leaf.start), end = byteOffsetToUtf16(leaf.end);
    const raw = current.content.slice(start, end); let rawIndex = 0, visibleIndex = 0;
    for (const character of leaf.text) {
      let sourceStart = start + rawIndex, sourceEnd;
      if (leaf.kind === 'code') { sourceStart = start; sourceEnd = end; }
      else {
        if (raw[rawIndex] === '\\' && raw[rawIndex + 1] === character) rawIndex++;
        if (raw[rawIndex] === '&') {
          const entity = /^&(?:#x[\da-f]+|#\d+|[a-z]+);/i.exec(raw.slice(rawIndex));
          if (entity) {
            const decoder = document.createElement('textarea'); decoder.innerHTML = entity[0];
            if (decoder.value === character) { rawIndex += entity[0].length; sourceEnd = start + rawIndex; }
          }
        }
        if (sourceEnd === undefined) { rawIndex += character.length; sourceEnd = start + rawIndex; }
      }
      const at = found + visibleIndex;
      while (domIndex < dom.length && at >= dom[domIndex].start + dom[domIndex].node.length) domIndex++;
      const entry = domIndex < dom.length && at >= dom[domIndex].start ? dom[domIndex] : null;
      if (entry) {
        const offset = at - entry.start, range = document.createRange();
        range.setStart(entry.node, offset); range.setEnd(entry.node, Math.min(entry.node.length, offset + character.length));
        const rect = range.getBoundingClientRect();
        if (rect.width && rect.height) result.push({ node: entry.node, offset, length: character.length, start: sourceStart, end: sourceEnd, rect });
      }
      visibleIndex += character.length;
    }
  }
  return result;
}
function editTarget(target, y) {
  const blockElement = target.closest('[data-edit-index]');
  const block = previewBlocks[Number(blockElement?.dataset.editIndex)];
  if (!block) {
    if (target.closest('[data-empty-edit]')) return { original: target.closest('[data-empty-edit]'), start: 0, end: 0 };
    return null;
  }
  const nodes = block.nodes || [];
  let original = target.closest('.mermaid-host,.math-block,.table-scroll,pre')
    || target.closest('p,h1,h2,h3,h4,h5,h6,li,dt,dd') || blockElement;
  if (!blockElement.contains(original)) original = blockElement;
  const metadata = nodes.find(node => node.sourcepos === original.dataset.sourcepos) || block;
  let start = byteOffsetToUtf16(metadata.start), end = byteOffsetToUtf16(metadata.end);
  const whole = original.matches('pre,.mermaid-host,.math-block,.table-scroll') || metadata.kind === 'code-block';
  if (whole) return { original, start, end, code: true };
  const leaves = nodes.filter(node => node.start >= metadata.start && node.end <= metadata.end);
  const chars = mappedCharacters(original, leaves);
  if (!chars.length) return { original, start, end };
  const nearest = chars.reduce((best, char) => Math.abs(char.rect.top + char.rect.height / 2 - y) < Math.abs(best.rect.top + best.rect.height / 2 - y) ? char : best);
  const row = chars.filter(char => Math.abs(char.rect.top + char.rect.height / 2 - (nearest.rect.top + nearest.rect.height / 2)) < nearest.rect.height * .55);
  const first = row[0], last = row.at(-1);
  const firstIndex = chars.indexOf(first), lastIndex = chars.indexOf(last);

  start = firstIndex === 0 ? start : first.start;
  end = lastIndex === chars.length - 1 ? end : last.end;
  const before = document.createRange(); before.selectNodeContents(original); before.setEnd(first.node, first.offset);
  const after = document.createRange(); after.selectNodeContents(original); after.setStart(last.node, last.offset + last.length);
  return { original, start, end, before: before.cloneContents(), after: after.cloneContents() };
}
function beginInlineEdit(edit) {
  if (mode !== 'edit' || inlineEdit || !edit) return;
  const { original, start, end } = edit;
  const wrapper = document.createElement('div'); wrapper.className = 'live-editor' + (edit.code ? ' live-code' : '');
  const style = getComputedStyle(original);
  for (const property of ['fontSize', 'lineHeight', 'fontWeight', 'marginTop', 'marginBottom']) wrapper.style[property] = style[property];
  const textarea = document.createElement('textarea'); textarea.value = current.content.slice(start, end); textarea.spellcheck = false;
  textarea.placeholder = 'Start writing…'; textarea.setAttribute('aria-label', edit.code ? 'Edit Markdown block' : 'Edit Markdown line');
  for (const [fragment, className] of [[edit.before, 'live-before'], [edit.after, 'live-after']]) {
    if (!fragment?.textContent) continue;
    const part = document.createElement('div'); part.className = className; part.append(fragment);
    part.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    if (className === 'live-before') wrapper.append(part); else edit.afterElement = part;
  }
  wrapper.append(textarea); if (edit.afterElement) wrapper.append(edit.afterElement);
  original.hidden = true; original.after(wrapper);
  inlineEdit = { ...edit, wrapper, textarea, prefix: current.content.slice(0, start), suffix: current.content.slice(end), group: {} };
  textarea.addEventListener('input', () => {
    if (inlineEdit?.textarea !== textarea) return;
    changeContent(inlineEdit.prefix + textarea.value + inlineEdit.suffix, inlineEdit.group); resizeLiveEditor(textarea);
  });
  textarea.addEventListener('keydown', event => {
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
      event.preventDefault(); event.stopPropagation(); enqueue(commitInlineEdit);
    } else if (event.key === 'Tab') { event.preventDefault(); textarea.setRangeText('  ', textarea.selectionStart, textarea.selectionEnd, 'end'); textarea.dispatchEvent(new Event('input')); }
  });
  textarea.addEventListener('blur', () => {
    setTimeout(() => { if (inlineEdit?.textarea === textarea && document.activeElement !== textarea) enqueue(commitInlineEdit); }, 0);
  });
  textarea.focus(); resizeLiveEditor(textarea); textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}
async function commitInlineEdit() {
  if (!inlineEdit) return true;
  cancelInlineEdit(); historyGroup = null; await renderPreview(); return true;
}
