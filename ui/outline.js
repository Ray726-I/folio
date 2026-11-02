'use strict';
// Outline presentation is independent of document navigation and source offsets.
let outlineStateDocument = null, outlineCollapsed = new Set(), outlineContextEntry = null;

function buildOutlineTree() {
  if (outlineStateDocument !== current) {
    outlineStateDocument = current;
    outlineCollapsed = new Set();
    $('outline-items').scrollTop = 0;
  }
  const stack = [], fragment = document.createDocumentFragment();
  outlineEntries.forEach((entry, index) => {
    while (stack.length && outlineEntries[stack[stack.length - 1]].level >= entry.level) stack.pop();
    entry.parent = stack.length ? stack[stack.length - 1] : -1;
    entry.children = [];
    if (entry.parent >= 0) outlineEntries[entry.parent].children.push(index);
    entry.depth = stack.length;
    stack.push(index);
    const row = document.createElement('div'); row.className = 'outline-row'; row.id = 'outline-row-' + index;
    row.style.setProperty('--outline-indent', Math.min(entry.depth, 4) * 12 + 'px');
    row.append(entry.button); entry.row = row;
    fragment.append(row);
  });
  for (const entry of outlineEntries) {
    entry.row.classList.toggle('outline-parent', Boolean(entry.children.length));
    if (!entry.children.length) continue;
    const toggle = document.createElement('button'); toggle.className = 'outline-disclosure'; toggle.tabIndex = -1;
    toggle.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg>';
    toggle.onclick = () => toggleOutlineEntry(entry);
    entry.toggle = toggle; entry.row.prepend(toggle);
    entry.button.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight');
  }
  $('outline-items').replaceChildren(fragment);
  applyOutlineVisibility();
}

function toggleOutlineEntry(entry, expand = outlineCollapsed.has(entry.id)) {
  if (!entry.children.length) return;
  if (expand) outlineCollapsed.delete(entry.id); else outlineCollapsed.add(entry.id);
  applyOutlineVisibility();
  if (document.activeElement.closest('.outline-row')?.hidden) entry.button.focus({ preventScroll: true });
}

function applyOutlineVisibility() {
  outlineEntries.forEach(entry => {
    let shown = true;
    for (let parent = entry.parent; parent >= 0; parent = outlineEntries[parent].parent) {
      if (outlineCollapsed.has(outlineEntries[parent].id)) { shown = false; break; }
    }
    entry.row.hidden = !shown;
    if (entry.toggle) {
      const expanded = !outlineCollapsed.has(entry.id);
      entry.toggle.setAttribute('aria-expanded', String(expanded));
      entry.toggle.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + entry.text);
      entry.toggle.title = expanded ? 'Collapse section' : 'Expand section';
    }
  });
  $('outline-count').textContent = outlineEntries.length ? `${outlineEntries.length} ${outlineEntries.length === 1 ? 'section' : 'sections'}` : 'No headings';
  syncOutlineContext();
}

function syncOutlineContext() {
  outlineContextEntry?.button.classList.remove('active-ancestor');
  let index = outlineActiveIndex;
  while (index >= 0 && outlineEntries[index]?.row.hidden) index = outlineEntries[index].parent;
  outlineContextEntry = index >= 0 ? outlineEntries[index] : null;
  if (outlineContextEntry && index !== outlineActiveIndex) outlineContextEntry.button.classList.add('active-ancestor');
  const tabEntry = outlineContextEntry || outlineEntries.find(entry => !entry.row.hidden);
  for (const entry of outlineEntries) entry.button.tabIndex = entry === tabEntry ? 0 : -1;
  return outlineContextEntry?.button;
}

function focusOutlineEntry(entry) {
  if (!entry || entry.row.hidden) return;
  entry.button.focus({ preventScroll: true });
  entry.button.scrollIntoView({ block: 'nearest' });
}

$('outline-items').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const entries = outlineEntries.filter(entry => !entry.row.hidden);
  const index = entries.findIndex(entry => entry.row.contains(document.activeElement));
  const entry = entries[index];
  if (!entry) return;
  event.preventDefault();
  if (event.key === 'ArrowRight') {
    if (outlineCollapsed.has(entry.id)) toggleOutlineEntry(entry, true);
    else focusOutlineEntry(entry.children.map(child => outlineEntries[child]).find(child => !child.row.hidden));
  } else if (event.key === 'ArrowLeft') {
    if (entry.children.length && !outlineCollapsed.has(entry.id)) toggleOutlineEntry(entry, false);
    else focusOutlineEntry(outlineEntries[entry.parent]);
  } else {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
    focusOutlineEntry(entries[next]);
  }
});
