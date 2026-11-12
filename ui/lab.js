'use strict';
// Bundled extras share the app's context; each owns its activation and cleanup.
const labDialog = $('lab-dialog');
function syncLabThemeOptions() {
  const select = $('preference-theme');
  const enabled = preferences.get('labRetroEnabled', selectedTheme === 'retro-terminal');
  const option = select.querySelector('[value="retro-terminal"]');
  if (enabled && !option) {
    const next = document.createElement('option'); next.value = 'retro-terminal'; next.textContent = 'Retro Terminal'; select.append(next);
  } else if (!enabled) option?.remove();
  select.value = selectedTheme;
}
function activateRetroTheme() {
  if (!$('lab-retro-style')) {
    const style = document.createElement('link');
    style.id = 'lab-retro-style'; style.rel = 'stylesheet'; style.href = 'retro-terminal.css';
    style.onload = () => { if (selectedTheme === 'retro-terminal') applyTheme('retro-terminal', false); };
    document.head.append(style);
  }
  syncLabThemeOptions();
  return () => {
    if (selectedTheme === 'retro-terminal') {
      const previous = preferences.get('labRetroPreviousTheme', 'system');
      const fallback = availableThemes().some(theme => theme.id === previous) ? previous : 'system';
      applyTheme(fallback);
    }
    $('lab-retro-style')?.remove();
    syncLabThemeOptions();
  };
}
function activateReadingGuide() {
  const guideReader = $('reader-scroll'), guidePane = guideReader.closest('.pane-layout') || guideReader;
  guidePane.before($('reading-guide-template').content.cloneNode(true));
  $('reading-guide-toolbar').hidden = !current.active;
  document.body.classList.add('lab-reading-guide');
  if (typeof syncDocumentChrome === 'function') syncDocumentChrome();
// The marker is a separate overlay: it never changes the editor's document DOM.
const guideMarker = $('reading-guide-marker');
const controller = new AbortController(), signal = controller.signal;
let guideTimer = 0;
let guideParagraph = null, guideFrame = 0, guideFollowScroll = false, guideProgrammaticScroll = false;
function guideEnabled() {
  return document.body.classList.contains('lab-reading-guide') && root.dataset.documentMode === 'reading' && current.active && focusedPane !== 'companion';
}
function guideParagraphs() {
  return [...$('preview').querySelectorAll('p')].filter(node => node.textContent.trim() && node.getClientRects().length);
}
function scheduleGuide(followScroll = false) {
  guideFollowScroll ||= followScroll;
  if (!guideFrame) guideFrame = requestAnimationFrame(updateReadingGuide);
}
function updateReadingGuide() {
  guideFrame = 0;
  const followScroll = guideFollowScroll; guideFollowScroll = false;
  if (!guideEnabled()) { guideMarker.hidden = true; return; }
  const blocks = guideParagraphs();
  const reader = guideReader.getBoundingClientRect();
  if (!blocks.includes(guideParagraph) || followScroll) {
    const target = reader.top + 16;
    guideParagraph = blocks.find(node => node.getBoundingClientRect().bottom >= target) || blocks[blocks.length - 1] || null;
  }
  const index = blocks.indexOf(guideParagraph);
  $('reading-guide-position').textContent = index < 0 ? 'No paragraphs' : `${index + 1} of ${blocks.length}`;
  $('reading-guide-previous').disabled = index <= 0;
  $('reading-guide-next').disabled = index < 0 || index >= blocks.length - 1;
  if (!guideParagraph) { guideMarker.hidden = true; return; }
  const box = guideParagraph.getBoundingClientRect();
  const top = Math.max(box.top, reader.top), bottom = Math.min(box.bottom, reader.bottom);
  guideMarker.hidden = bottom <= top;
  Object.assign(guideMarker.style, { left: `${Math.max(reader.left, box.left - 12)}px`, top: `${top}px`, width: `${Math.min(reader.right, box.right + 12) - Math.max(reader.left, box.left - 12)}px`, height: `${Math.max(0, bottom - top)}px` });
}
function moveReadingGuide(delta) {
  const blocks = guideParagraphs();
  const index = blocks.indexOf(guideParagraph);
  guideParagraph = blocks[Math.max(0, Math.min(blocks.length - 1, index + delta))] || null;
  if (guideParagraph) {
    const box = guideParagraph.getBoundingClientRect(), reader = guideReader.getBoundingClientRect();
    if (box.top < reader.top || box.bottom > reader.bottom) {
      guideProgrammaticScroll = true;
      guideParagraph.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      clearTimeout(guideTimer);
      guideTimer = setTimeout(() => { guideProgrammaticScroll = false; }, 150);
    }
  }
  scheduleGuide();
}
$('reading-guide-previous').addEventListener('click', () => moveReadingGuide(-1), { signal });
$('reading-guide-next').addEventListener('click', () => moveReadingGuide(1), { signal });
document.addEventListener('keydown', event => {
  if (!guideEnabled() || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const target = event.target;
  const inReader = target === document.body || target === root || guideReader.contains(target);
  const inGuide = $('reading-guide-toolbar').contains(target);
  if ((!inReader && !inGuide) || document.querySelector('dialog[open]')) return;
  if (!inGuide && (target.closest?.('input, textarea, select, button, a, [contenteditable="true"]') || !window.getSelection()?.isCollapsed)) return;
  event.preventDefault();
  moveReadingGuide(event.key === 'ArrowDown' ? 1 : -1);
}, { signal });
guideReader.addEventListener('scroll', () => scheduleGuide(!guideProgrammaticScroll), { passive: true, signal });
window.addEventListener('resize', () => scheduleGuide(), { signal });
const resizeObserver = new ResizeObserver(() => scheduleGuide());
resizeObserver.observe(guideReader);
const previewObserver = new MutationObserver(() => scheduleGuide());
previewObserver.observe($('preview'), { childList: true, subtree: true });
const rootObserver = new MutationObserver(() => scheduleGuide());
rootObserver.observe(root, { attributes: true, attributeFilter: ['data-document-mode', 'data-theme', 'data-reading-font', 'data-document-width'] });
const paneObserver = new MutationObserver(() => scheduleGuide());
paneObserver.observe($('document-view'), { attributes: true, attributeFilter: ['data-focused-pane'] });
const bodyObserver = new MutationObserver(() => scheduleGuide());
bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
scheduleGuide();

return () => {
  controller.abort(); resizeObserver.disconnect(); previewObserver.disconnect(); rootObserver.disconnect(); paneObserver.disconnect(); bodyObserver.disconnect();
  cancelAnimationFrame(guideFrame); clearTimeout(guideTimer);
  $('reading-guide-toolbar')?.remove(); guideMarker.remove();
  document.body.classList.remove('lab-reading-guide');
  if (typeof syncDocumentChrome === 'function') syncDocumentChrome();
};
}
const labExtensions = new Map([
  ['retro-terminal', { id: 'retro-terminal', name: 'Retro Terminal', version: '1.0.0', type: 'theme', preference: 'labRetroEnabled', activate: activateRetroTheme }],
  ['reading-guide', { id: 'reading-guide', name: 'Reading Guide', version: '1.0.0', type: 'reading', preference: 'labReadingGuide', activate: activateReadingGuide }]
]);
function setLabExtension(id, enabled) {
  const extension = labExtensions.get(id);
  if (!extension || Boolean(extension.cleanup) === enabled) return;
  preferences.set(extension.preference, enabled);
  if (enabled) extension.cleanup = extension.activate();
  else { extension.cleanup(); extension.cleanup = null; }
}
function syncLab() {
  const retroEnabled = Boolean(labExtensions.get('retro-terminal').cleanup);
  const active = selectedTheme === 'retro-terminal';
  $('lab-retro').textContent = active ? 'Using Retro Terminal' : 'Use Retro Terminal';
  $('lab-retro').disabled = active;
  $('lab-retro-disable').hidden = !retroEnabled;
  const enabled = Boolean(labExtensions.get('reading-guide').cleanup);
  $('lab-guide').textContent = enabled ? 'Disable Reading Guide' : 'Enable Reading Guide';
  $('lab-guide').setAttribute('aria-pressed', String(enabled));
}
function openLab() { syncLab(); if (labDialog.open) { $('lab-close').focus(); return; } labDialog.showModal(); $('lab-close').focus(); }
$('lab-search').addEventListener('input', event => {
  const query = event.target.value.trim().toLocaleLowerCase();
  let visible = 0;
  for (const card of labDialog.querySelectorAll('[data-lab-search]')) {
    card.hidden = !card.dataset.labSearch.includes(query);
    if (!card.hidden) visible++;
  }
  $('lab-empty').hidden = visible > 0;
});
$('lab-close').addEventListener('click', () => labDialog.close());
$('lab-retro').addEventListener('click', () => { setLabExtension('retro-terminal', true); applyTheme('retro-terminal'); syncLab(); });
$('lab-retro-disable').addEventListener('click', () => { setLabExtension('retro-terminal', false); syncLab(); });
$('lab-guide').addEventListener('click', () => {
  setLabExtension('reading-guide', !labExtensions.get('reading-guide').cleanup);
  syncLab();
});
for (const extension of labExtensions.values()) {
  const fallback = extension.id === 'retro-terminal' && selectedTheme === 'retro-terminal';
  if (preferences.get(extension.preference, fallback)) setLabExtension(extension.id, true);
}
