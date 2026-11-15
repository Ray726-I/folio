'use strict';
// Outline presentation is independent of document navigation and source offsets.
// Indentation compresses with depth: full steps for the first three heading
// levels, then smaller steps so deep headings keep horizontal room.
const OUTLINE_LEVEL_INDENT = [0, 0, 14, 28, 36, 44, 52];
let outlineStateDocument = null, outlineCollapsed = new Set(), outlineContextEntry = null, outlineTabEntry = null;

function renderOutlineRows(entries, onToggle, prefix = 'outline-row-') {
  const stack = [], fragment = document.createDocumentFragment();
  entries.forEach((entry, index) => {
    while (stack.length && entries[stack[stack.length - 1]].level >= entry.level) stack.pop();
    entry.parent = stack.length ? stack[stack.length - 1] : -1;
    entry.children = [];
    if (entry.parent >= 0) entries[entry.parent].children.push(index);
    entry.depth = stack.length;
    stack.push(index);
    const row = entry.row || document.createElement('div');
    // Reconciled rows keep their active/context state alongside the reused
    // button. Replacing className would erase the row wash while the active
    // index stays unchanged, so the scroll spy has no new section to paint.
    row.classList.add('outline-row'); row.id = prefix + index;
    // Indentation follows heading level on a compressed scale (14px steps to
    // level 3, then 8px) instead of tree depth, so deep headings keep room.
    // Disclosure chevrons stay in one fixed gutter; the tree spine in CSS
    // uses depth only to decide whether a row hangs off a parent.
    row.style.setProperty('--outline-indent', `${OUTLINE_LEVEL_INDENT[Math.min(Math.max(entry.level || 1, 1), 6)] ?? 0}px`);
    row.dataset.depth = entry.depth;
    if (!entry.row) row.append(entry.button);
    entry.row = row;
    fragment.append(row);
  });
  for (const entry of entries) {
    entry.row.classList.toggle('outline-parent', Boolean(entry.children.length));
    if (!entry.children.length) {
      entry.toggle?.remove(); entry.toggle = null;
      entry.button.removeAttribute('aria-keyshortcuts');
      continue;
    }
    if (!entry.toggle) {
      const toggle = document.createElement('button'); toggle.className = 'outline-disclosure'; toggle.tabIndex = -1;
      toggle.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg>';
      toggle.onclick = () => onToggle(entry);
      entry.toggle = toggle; entry.row.prepend(toggle);
    }
    entry.button.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight');
  }
  return fragment;
}

function buildOutlineTree(previousEntries = []) {
  const list = $('outline-items'), focused = previousEntries.find(entry => entry.row?.contains(document.activeElement));
  const focusedIndex = previousEntries.indexOf(focused), focusToggle = focused?.toggle === document.activeElement;
  let scrollTop = list.scrollTop;
  if (outlineStateDocument !== current) {
    outlineStateDocument = current;
    outlineCollapsed = new Set();
    outlineContextEntry = null; outlineTabEntry = null; scrollTop = 0;
  }
  const liveKeys = new Set(outlineEntries.map(entry => entry.key || entry.id));
  outlineCollapsed = new Set([...outlineCollapsed].filter(key => liveKeys.has(key)));
  const fragment = renderOutlineRows(outlineEntries, toggleOutlineEntry);
  list.replaceChildren(fragment);
  applyOutlineVisibility();
  if (focused) {
    let target = outlineEntries.includes(focused) ? focused : outlineEntries[Math.min(focusedIndex, outlineEntries.length - 1)];
    while (target?.row.hidden) target = outlineEntries[target.parent];
    if (!target) target = outlineEntries.find(entry => !entry.row.hidden);
    (focusToggle && target?.toggle ? target.toggle : target?.button)?.focus({ preventScroll: true });
  }
  list.scrollTop = scrollTop;
}

function toggleOutlineEntry(entry, expand = outlineCollapsed.has(entry.key || entry.id)) {
  if (!entry.children.length) return;
  if (expand) outlineCollapsed.delete(entry.key || entry.id); else outlineCollapsed.add(entry.key || entry.id);
  applyOutlineVisibility();
  if (document.activeElement.closest('.outline-row')?.hidden) entry.button.focus({ preventScroll: true });
}

function applyOutlineRowVisibility(entries, collapsed) {
  entries.forEach(entry => {
    let shown = true;
    for (let parent = entry.parent; parent >= 0; parent = entries[parent].parent) {
      if (collapsed.has(entries[parent].key || entries[parent].id)) { shown = false; break; }
    }
    entry.row.hidden = !shown;
    if (entry.toggle) {
      const expanded = !collapsed.has(entry.key || entry.id);
      entry.toggle.setAttribute('aria-expanded', String(expanded));
      entry.toggle.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + entry.text);
      entry.toggle.title = expanded ? 'Collapse section' : 'Expand section';
    }
  });
}

function applyOutlineVisibility() {
  applyOutlineRowVisibility(outlineEntries, outlineCollapsed);
  $('outline-count').textContent = outlineEntries.length ? `${outlineEntries.length} ${outlineEntries.length === 1 ? 'section' : 'sections'}` : 'No headings';
  syncOutlineContext();
}

function syncOutlineContext() {
  outlineContextEntry?.button.classList.remove('active-ancestor');
  // Companion mirror of the paint() row state below: the ancestor wash lives
  // on the row so it never depends on :has() matching alone either.
  outlineContextEntry?.row?.classList.remove('is-active-ancestor');
  let index = outlineActiveIndex;
  while (index >= 0 && outlineEntries[index]?.row.hidden) index = outlineEntries[index].parent;
  outlineContextEntry = index >= 0 ? outlineEntries[index] : null;
  if (outlineContextEntry && index !== outlineActiveIndex) {
    outlineContextEntry.button.classList.add('active-ancestor');
    outlineContextEntry.row?.classList.add('is-active-ancestor');
  }
  const tabEntry = outlineContextEntry || outlineEntries.find(entry => !entry.row.hidden);
  if (outlineTabEntry !== tabEntry) {
    if (outlineTabEntry) outlineTabEntry.button.tabIndex = -1;
    if (tabEntry) tabEntry.button.tabIndex = 0;
    outlineTabEntry = tabEntry;
  }
  return outlineContextEntry?.button;
}

function focusOutlineEntry(entry) {
  if (!entry || entry.row.hidden) return;
  entry.button.focus({ preventScroll: true });
  entry.button.scrollIntoView({ block: 'nearest' });
}

function navigateOutline(event, allEntries, collapsed, toggle) {
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const entries = allEntries.filter(entry => !entry.row.hidden);
  const index = entries.findIndex(entry => entry.row.contains(document.activeElement));
  const entry = entries[index];
  if (!entry) return;
  event.preventDefault();
  if (event.key === 'ArrowRight') {
    if (collapsed.has(entry.key || entry.id)) toggle(entry, true);
    else focusOutlineEntry(entry.children.map(child => allEntries[child]).find(child => !child.row.hidden));
  } else if (event.key === 'ArrowLeft') {
    if (entry.children.length && !collapsed.has(entry.key || entry.id)) toggle(entry, false);
    else focusOutlineEntry(allEntries[entry.parent]);
  } else {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
    focusOutlineEntry(entries[next]);
  }
}
$('outline-items').addEventListener('keydown', event => {
  if (focusedPane === 'companion') navigateOutline(event, companionOutlineEntries, companionOutlineCollapsed, toggleCompanionOutlineEntry);
  else navigateOutline(event, outlineEntries, outlineCollapsed, toggleOutlineEntry);
});
