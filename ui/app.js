/* Folio's local UI. File access and Markdown parsing live in Rust. */
'use strict';
const $ = id => document.getElementById(id);
const invoke = (command, args = {}) => window.__TAURI__.core.invoke(command, args);
const listen = (event, callback) => window.__TAURI__.event.listen(event, callback);
const root = document.documentElement;
const preferences = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(`folio.${key}`)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`folio.${key}`, JSON.stringify(value)); } catch { /* a read-only profile still works */ } }
};
let current = { path: null, name: 'Untitled.md', content: '', saved: '', active: false };
let mode = 'read', busy = false, queue = Promise.resolve(), renderGeneration = 0;
let previewSnapshot = null, diagramThemeRevision = 0;
let activeFolder = null, folderEntries = [], folderVisible = true, expandedFolders = new Set(), previewBlocks = [], inlineEdit = null;
let omarchy = null, selectedTheme = preferences.get('theme', 'system');
let fontSize = Math.min(40, Math.max(12, Number(preferences.get('fontSize', 18)) || 18));
let windowZoom = Math.min(2, Math.max(.6, Number(preferences.get('windowZoom', 1)) || 1));
let outlineVisible = preferences.get('outline', false), toastTimer;
let wideLayout = preferences.get('wideLayout', false);
const themes = [
  { id: 'system', label: 'System', detail: 'Follow light / dark appearance', swatch: 'linear-gradient(90deg, #fafafa 50%, #242424 50%)' },
  { id: 'paper', label: 'Adwaita Light', detail: 'Clean and familiar', swatch: '#fafafa' },
  { id: 'graphite', label: 'Adwaita Dark', detail: 'Soft charcoal', swatch: '#303030' },
  { id: 'nord', label: 'Nord', detail: 'Cool and quiet', swatch: '#88c0d0' },
  { id: 'catppuccin', label: 'Catppuccin Mocha', detail: 'Warm pastel accents', swatch: '#cba6f7' },
  { id: 'rose-pine', label: 'Rosé Pine', detail: 'Muted purple and rose', swatch: '#eb6f92' },
  { id: 'solarized', label: 'Solarized Light', detail: 'Warm paper', swatch: '#fdf6e3' }
];
const dirty = () => current.content !== current.saved;
function icon(name) { const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); node.classList.add('icon'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#i-${name}`); node.append(use); return node; }
function toast(message) { $('toast').textContent = String(message); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
function status(message) { $('app-status').textContent = message; }
function updateTitle() {
  $('document-name').textContent = current.active ? current.name : activeFolder?.name || 'Folio';
  $('document-location').textContent = current.path ? current.path.slice(0, current.path.lastIndexOf('/')) : activeFolder?.path || (current.active ? 'Unsaved document' : 'Markdown files and folders');
  $('document-location').title = current.path || activeFolder?.path || '';
  $('dirty-dot').hidden = !dirty();
  invoke('set_title', { name: current.active ? current.name : activeFolder?.name || 'Folio', dirty: dirty() }).catch(() => {});
  const words = current.content.trim().split(/\s+/).filter(Boolean).length;
  $('word-count').textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
  $('reading-time').textContent = `${Math.max(1, Math.ceil(words / 220))} min read`;
}
function showDocument() {
  $('welcome').hidden = true; $('document-view').hidden = false; $('statusbar').hidden = false;
  document.querySelectorAll('.document-control').forEach(control => { control.hidden = !current.active; });
  resetHistory(); $('disk-banner').hidden = true; updateTitle(); setOutline(outlineVisible);
  $('folder-empty').hidden = current.active || !activeFolder;
  renderFolderEntries();
}
function setOutline(visible) { outlineVisible = visible; $('outline').hidden = !visible || !current.active; $('outline-divider').hidden = $('outline').hidden; $('outline-toggle').setAttribute('aria-pressed', String(visible)); preferences.set('outline', visible); }
function setupSidebarResize(sidebarId, dividerId, key, defaultWidth) {
  const sidebar = $(sidebarId), divider = $(dividerId);
  const property = `--${key}-sidebar-width`;
  function setWidth(value) {
    const other = sidebarId === 'file-browser' ? $('outline') : $('file-browser');
    const available = window.innerWidth - (other.hidden ? 0 : other.getBoundingClientRect().width) - 320;
    const width = Math.max(160, Math.min(Math.max(160, Math.min(560, available)), value));
    document.body.style.setProperty(property, `${width}px`);
    preferences.set(key, width);
  }
  setWidth(Number(preferences.get(key, defaultWidth)) || defaultWidth);
  divider.addEventListener('pointerdown', event => { event.preventDefault(); divider.setPointerCapture(event.pointerId); divider.classList.add('dragging'); });
  divider.addEventListener('pointermove', event => { if (divider.hasPointerCapture(event.pointerId)) setWidth(event.clientX - sidebar.getBoundingClientRect().left); });
  divider.addEventListener('pointerup', event => { if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId); divider.classList.remove('dragging'); });
  divider.addEventListener('keydown', event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(sidebar.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 20 : -20)); } });
}
setupSidebarResize('file-browser', 'folder-divider', 'folder', 235);
setupSidebarResize('outline', 'outline-divider', 'outline', 215);
async function renderPreview(restoreScroll) {
  if (previewSnapshot?.content === current.content && previewSnapshot.path === current.path) {
    syncPreviewEditing();
    if (previewSnapshot.themeRevision !== diagramThemeRevision) await refreshMermaid();
    if (restoreScroll !== undefined) $('reader-scroll').scrollTop = restoreScroll;
    status('');
    return;
  }
  const generation = ++renderGeneration;
  const content = current.content, path = current.path, themeRevision = diagramThemeRevision;
  const scrollTo = restoreScroll ?? $('reader-scroll').scrollTop;
  const reusableDiagrams = new Map();
  for (const host of $('preview').querySelectorAll('.mermaid-host[data-mermaid-source]')) {
    if (Number(host.dataset.themeRevision) !== themeRevision) continue;
    const source = host.dataset.mermaidSource;
    if (!reusableDiagrams.has(source)) reusableDiagrams.set(source, []);
    reusableDiagrams.get(source).push(host);
  }
  try {
    const result = await invoke('render_markdown', { content });
    if (generation !== renderGeneration) return;
    $('preview').innerHTML = typeof result === 'string' ? result : result.html; // Rust sanitizes the HTML.
    previewBlocks = Array.isArray(result.blocks) ? result.blocks : [];
    const sourceIndexes = new Map(previewBlocks.map((block, index) => [block.sourcepos, index]).filter(([position]) => position));
    const elements = [...$('preview').querySelectorAll(':scope > [data-sourcepos]:not(.footnotes), :scope > .footnotes > ol > li[data-sourcepos]')];
    for (const element of elements) {
      const index = sourceIndexes.get(element.dataset.sourcepos);
      if (index !== undefined) element.dataset.editIndex = String(index);
    }
    // Compatibility for older/native test responses without source positions.
    if (!sourceIndexes.size && $('preview').children.length === previewBlocks.length) {
      [...$('preview').children].forEach((element, index) => { element.dataset.editIndex = String(index); });
    }
    setupCodeLanguages();
    setupTables();
    await renderMath(generation);
    syncPreviewEditing();
    await renderDiagrams(generation, reusableDiagrams);
    if (generation !== renderGeneration) return;
    if (scrollTo !== undefined) { const container = $('reader-scroll'); container.scrollTop = Math.max(0, Math.min(scrollTo, container.scrollHeight - container.clientHeight)); }
    $('folder-empty').hidden = true;
    previewSnapshot = { content, path, themeRevision };
    syncPreviewEditing();
    if (themeRevision !== diagramThemeRevision) await refreshMermaid();
    $('outline-items').replaceChildren();
    const headings = $('preview').querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (const heading of headings) {
      const button = document.createElement('button'); button.className = 'outline-link'; button.textContent = heading.textContent;
      button.style.paddingLeft = `${10 + (Number(heading.tagName[1]) - 1) * 10}px`;
      button.onclick = async () => { const id = heading.id; if (mode !== 'read') await setMode('read'); document.getElementById(id)?.scrollIntoView({ block: 'start' }); };
      $('outline-items').append(button);
    }
    if (!headings.length) { const text = document.createElement('p'); text.className = 'empty-results'; text.textContent = 'No headings yet'; $('outline-items').append(text); }
    if (!$('find-bar').hidden) updateFind();
    status('');
  } catch (error) { status('Preview unavailable'); toast(error); }
}
function setupCodeLanguages() {
  $('preview').querySelectorAll('pre > code[class*="language-"]').forEach(code => {
    const language = [...code.classList].find(className => className.startsWith('language-'));
    if (language) code.parentElement.dataset.language = language.slice('language-'.length);
  });
}
function setupTables() {
  for (const table of $('preview').querySelectorAll('table')) {
    if (table.parentElement.classList.contains('table-scroll')) continue;
    let columns = 1;
    for (const row of table.rows) columns = Math.max(columns, [...row.cells].reduce((sum, cell) => sum + cell.colSpan, 0));
    table.style.minWidth = `${columns * 4}em`;
    const host = document.createElement('div'); host.className = 'table-scroll'; host.dataset.sourcepos = table.dataset.sourcepos || '';
    if (table.dataset.editIndex !== undefined) {
      host.dataset.editIndex = table.dataset.editIndex;
      delete table.dataset.editIndex;
    }
    table.before(host); host.append(table);
  }
}
async function renderMath(generation = renderGeneration) {
  if (typeof katex === 'undefined') return;
  const nodes = [...$('preview').querySelectorAll('[data-math-style]')];
  for (const element of nodes) {
    if (generation !== renderGeneration) return;
    const display = element.dataset.mathStyle === 'display';
    try {
      if (display && element.tagName === 'CODE') {
        const host = document.createElement('div'); host.className = 'katex-block math-block';
        const pre = element.closest('pre');
        if (pre?.dataset.sourcepos) host.dataset.sourcepos = pre.dataset.sourcepos;
        if (pre?.dataset.editIndex !== undefined) host.dataset.editIndex = pre.dataset.editIndex;
        katex.render(element.textContent, host, { displayMode: true, throwOnError: false });
        pre?.replaceWith(host);
      } else {
        katex.render(element.textContent, element, { displayMode: display, throwOnError: false });
      }
    } catch { /* keep the source text visible */ }
  }
}
const cssProbe = document.createElement('div');
cssProbe.style.position = 'fixed'; cssProbe.style.left = '-9999px'; cssProbe.style.pointerEvents = 'none';
document.body.append(cssProbe);
function normalizeColor(value) {
  if (!value) return 'transparent';
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value);
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
  const channels = srgb ? srgb.slice(1, 4).map(channel => Number(channel) * 255) : rgb?.slice(1, 4).map(Number);
  // Mermaid's derived colors require hex, including colors resolved from color-mix().
  if (channels) return '#' + channels.map(channel => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0')).join('');
  return value;
}
function cssVarColor(name) {
  cssProbe.style.backgroundColor = '';
  cssProbe.style.backgroundColor = `var(${name})`;
  return normalizeColor(getComputedStyle(cssProbe).backgroundColor);
}
function colorChannels(color) { return [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16)); }
function mixColors(first, second, amount) {
  const other = colorChannels(second);
  return '#' + colorChannels(first).map((channel, index) => Math.round(channel * (1 - amount) + other[index] * amount).toString(16).padStart(2, '0')).join('');
}
function colorLuminance(color) {
  return colorChannels(color).map(channel => channel / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
}
function colorContrast(first, second) {
  const a = colorLuminance(first), b = colorLuminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
function readableColor(color, background, minimum = 4.6) {
  if (colorContrast(color, background) >= minimum) return color;
  const target = colorContrast('#ffffff', background) > colorContrast('#000000', background) ? '#ffffff' : '#000000';
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 12; iteration++) {
    const middle = (low + high) / 2;
    if (colorContrast(mixColors(color, target, middle), background) >= minimum) high = middle;
    else low = middle;
  }
  return mixColors(color, target, high);
}
function updatePreviewPalette() {
  ++diagramThemeRevision;
  const background = cssVarColor('--bg'), foreground = cssVarColor('--fg');
  const dark = colorLuminance(background) < .35;
  const body = readableColor(mixColors(foreground, background, .18), background, colorContrast(foreground, background) >= 7 ? 7 : 4.6);
  const strong = readableColor(mixColors(foreground, dark ? '#ffffff' : '#000000', dark ? .06 : .12), background, 7);
  root.style.setProperty('--read-body', body);
  root.style.setProperty('--read-strong', strong);
  for (const name of ['accent', 'blue', 'purple', 'green', 'yellow', 'red']) {
    const color = cssVarColor(`--${name}`);
    root.style.setProperty(`--read-${name}`, readableColor(dark ? mixColors(color, '#ffffff', .15) : color, background));
  }
  // Diagram shapes stay neutral; clear outlines do the work instead of a large card.
  const node = mixColors(background, foreground, .045);
  root.style.setProperty('--diagram-node', node);
  root.style.setProperty('--diagram-border', readableColor(mixColors(foreground, background, .35), node, 3));
  root.style.setProperty('--diagram-line', readableColor(mixColors(foreground, background, .22), background, 3));
}
function mermaidThemeVariables() {
  const background = cssVarColor('--bg');
  const dark = colorLuminance(background) < .35;
  const node = cssVarColor('--diagram-node'), border = cssVarColor('--diagram-border');
  const text = cssVarColor('--read-strong'), line = cssVarColor('--diagram-line');
  const colors = ['blue', 'green', 'yellow', 'purple', 'red'].map(name => cssVarColor(`--read-${name}`));
  const palette = [...new Set([...colors, ...colors.map((color, index) => mixColors(color, colors[(index + 1) % colors.length], .5)), mixColors(colors[0], colors[2], .5), mixColors(colors[1], colors[3], .5)])];
  // Some palettes use the same blue and green; categories still need distinct fills.
  for (let index = 0; palette.length < 12 && index < 24; index++) {
    const color = mixColors(colors[index % colors.length], background, .08 + index * .02);
    if (!palette.includes(color)) palette.push(color);
  }
  const blueIndex = palette.indexOf(colors[0]), purpleIndex = palette.indexOf(colors[3]), redIndex = palette.indexOf(colors[4]);
  const doneIndex = Math.max(1, palette.indexOf(colors[1] === colors[0] ? mixColors(colors[1], colors[2], .5) : colors[1]));
  const chartInk = dark ? '#ffffff' : '#171717';
  const fills = palette.map(color => readableColor(mixColors(color, background, dark ? .45 : .75), chartInk));
  const categorical = {};
  for (let index = 0; index < palette.length; index++) {
    categorical[`pie${index + 1}`] = readableColor(palette[index], dark ? '#171717' : '#ffffff');
    categorical[`cScale${index}`] = fills[index];
    categorical[`cScaleLabel${index}`] = chartInk;
    categorical[`cScalePeer${index}`] = readableColor(palette[index], fills[index], 3);
    categorical[`cScaleInv${index}`] = categorical[`cScalePeer${index}`];
  }
  return {
    ...categorical,
    darkMode: dark,
    background: cssVarColor('--bg'),
    fontFamily: '"Adwaita Sans","Cantarell",system-ui,sans-serif',
    fontSize: '15px',
    primaryColor: node,
    primaryTextColor: text,
    primaryBorderColor: border,
    lineColor: line,
    secondaryColor: cssVarColor('--surface'),
    secondaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryColor: node,
    tertiaryTextColor: text,
    tertiaryBorderColor: border,
    textColor: text,
    titleColor: text,
    mainBkg: node,
    nodeBorder: border,
    clusterBkg: background,
    clusterBorder: border,
    edgeLabelBackground: background,
    actorBkg: node,
    actorBorder: border,
    actorTextColor: text,
    actorLineColor: line,
    signalColor: line,
    signalTextColor: text,
    labelBoxBkgColor: background,
    labelTextColor: text,
    labelBoxBorderColor: border,
    noteBkgColor: cssVarColor('--hover'),
    noteTextColor: text,
    noteBorderColor: border,
    activationBkgColor: cssVarColor('--selection'),
    activationBorderColor: border,
    sequenceNumberColor: text,
    pieSectionTextColor: dark ? '#171717' : '#ffffff',
    pieLegendTextColor: text,
    pieTitleTextColor: text,
    pieStrokeColor: background,
    pieOuterStrokeColor: border,
    pieStrokeWidth: '1.5px',
    pieOuterStrokeWidth: '1px',
    pieOpacity: '1',
    pieSectionTextSize: '15px',
    pieLegendTextSize: '15px',
    taskBkgColor: fills[blueIndex],
    taskBorderColor: categorical[`cScalePeer${blueIndex}`],
    activeTaskBkgColor: fills[purpleIndex],
    activeTaskBorderColor: categorical[`cScalePeer${purpleIndex}`],
    doneTaskBkgColor: fills[doneIndex],
    doneTaskBorderColor: categorical[`cScalePeer${doneIndex}`],
    critBkgColor: fills[redIndex],
    critBorderColor: categorical[`cScalePeer${redIndex}`],
    taskTextColor: chartInk,
    taskTextLightColor: chartInk,
    taskTextDarkColor: chartInk,
    taskTextOutsideColor: text,
    sectionBkgColor: mixColors(background, colors[0], .06),
    sectionBkgColor2: mixColors(background, colors[3], .06),
    altSectionBkgColor: background,
    gridColor: cssVarColor('--line'),
    todayLineColor: colors[4]
  };
}
function mermaidConfig() {
  return {
    startOnLoad: false, securityLevel: 'strict', theme: 'base', look: 'classic',
    themeVariables: mermaidThemeVariables(), fontFamily: '"Adwaita Sans","Cantarell",system-ui,sans-serif',
    flowchart: { htmlLabels: true, curve: 'basis', nodeSpacing: 36, rankSpacing: 46, padding: 16, diagramPadding: 8, useMaxWidth: true },
    sequence: { useMaxWidth: true },
    gantt: { fontSize: 14, sectionFontSize: 14, barHeight: 24, barGap: 8 }
  };
}
let mermaidRenderId = 0;
function showDiagramSvg(host, markup) {
  host.innerHTML = markup;
  const drawing = host.querySelector('svg');
  const width = drawing?.viewBox.baseVal.width;
  if (width > 0) {
    // Fit diagrams up to twice the pane width. Larger ones shrink less to keep
    // labels readable, then scroll; CSS also handles resizing without rendering.
    drawing.style.width = `clamp(clamp(${Math.ceil(width * .5)}px, calc(${Math.ceil(width)}px - 100%), ${Math.ceil(width * .75)}px), 100%, ${Math.ceil(width)}px)`;
    drawing.style.maxWidth = 'none';
  }
}
async function renderDiagrams(generation = renderGeneration, reusableDiagrams = new Map()) {
  if (typeof mermaid === 'undefined') return;
  const blocks = [...$('preview').querySelectorAll('pre > code.language-mermaid')].map(code => code.closest('pre'));
  if (!blocks.length) return;
  const themeRevision = diagramThemeRevision;
  try { mermaid.initialize(mermaidConfig()); } catch { try { mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' }); } catch { return; } }
  for (const pre of blocks) {
    if (generation !== renderGeneration || !pre.isConnected) return;
    const source = pre.querySelector('code.language-mermaid')?.textContent ?? '';
    const reused = reusableDiagrams.get(source)?.pop();
    const host = reused || document.createElement('div');
    host.className = 'mermaid-host';
    host.dataset.sourcepos = pre.dataset.sourcepos || ''; 
    if (pre.dataset.editIndex !== undefined) host.dataset.editIndex = pre.dataset.editIndex;
    else delete host.dataset.editIndex;
    host.dataset.mermaidSource = source;
    host.dataset.themeRevision = String(themeRevision);
    if (reused) { pre.replaceWith(host); continue; }
    const id = `mermaid-${++mermaidRenderId}`;
    try {
      const { svg } = await mermaid.render(id, source);
      showDiagramSvg(host, svg);
    } catch (error) {
      const message = document.createElement('p'); message.className = 'mermaid-error'; message.textContent = 'Mermaid diagram could not be rendered.';
      const fallback = document.createElement('pre'); fallback.className = 'mermaid-source'; fallback.textContent = source;
      host.append(message, fallback);
    }
    if (generation !== renderGeneration || !pre.isConnected) return;
    pre.replaceWith(host);
  }
}
async function refreshMermaid() {
  if (typeof mermaid === 'undefined' || !current.active || !$('preview').querySelector('.mermaid-host')) return;
  const generation = renderGeneration, themeRevision = diagramThemeRevision;
  try { mermaid.initialize(mermaidConfig()); } catch { try { mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' }); } catch { return; } }
  for (const host of $('preview').querySelectorAll('.mermaid-host[data-mermaid-source]')) {
    if (generation !== renderGeneration || themeRevision !== diagramThemeRevision) return;
    if (Number(host.dataset.themeRevision) === themeRevision) continue;
    const source = host.dataset.mermaidSource;
    const id = `mermaid-${++mermaidRenderId}`;
    try {
      const { svg } = await mermaid.render(id, source);
      if (!host.isConnected || generation !== renderGeneration || themeRevision !== diagramThemeRevision) return;
      showDiagramSvg(host, svg);
      host.dataset.themeRevision = String(themeRevision);
    } catch { /* keep the previous diagram */ }
  }
  if (previewSnapshot) previewSnapshot.themeRevision = themeRevision;
}
// History belongs to the document, rather than to a temporary textarea.
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
  current.content = content; updateTitle();
}
async function undoRedo(redo = false) {
  const from = redo ? redoStack : undoStack, to = redo ? undoStack : redoStack;
  if (!current.active || !from.length) return;
  const content = from.pop(); to.push(current.content); historyGroup = null;
  const edit = inlineEdit;
  current.content = content;
  // Keep the active line and caret when its surrounding source is unchanged.
  if (edit && content.startsWith(edit.prefix) && content.endsWith(edit.suffix)
      && content.length >= edit.prefix.length + edit.suffix.length) {
    edit.textarea.value = content.slice(edit.prefix.length, content.length - edit.suffix.length);
    resizeLiveEditor(edit.textarea);
    edit.textarea.focus();
    edit.textarea.setSelectionRange(edit.textarea.value.length, edit.textarea.value.length);
  } else {
    cancelInlineEdit(); await renderPreview();
  }
  updateTitle();
}
function syncPreviewEditing() {
  const editable = mode === 'edit';
  if (!editable) $('preview').querySelectorAll('[data-empty-edit]').forEach(node => node.remove());
  $('preview').querySelectorAll('input[type="checkbox"]').forEach(checkbox => { checkbox.disabled = !editable; });
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
function byteOffsetToUtf16(byteOffset) {
  let units = 0, bytes = 0;
  for (const character of current.content) {
    if (bytes >= byteOffset) break;
    bytes += new TextEncoder().encode(character).length; units += character.length;
  }
  return units;
}
function previewElementForBlock(index) { return $('preview').querySelector(`[data-edit-index="${index}"]`); }
function previewBlockAtViewportTop() {
  const top = $('reader-scroll').getBoundingClientRect().top;
  const elements = [...$('preview').querySelectorAll('[data-edit-index]')];
  const element = elements.find(block => block.getBoundingClientRect().bottom > top + 8) || elements.at(-1);
  return element ? Number(element.dataset.editIndex) : -1;
}
// Match parser text leaves to DOM text. This preserves Markdown punctuation,
// escapes and entities while locating the actual wrapped row under the pointer.
function mappedCharacters(original, nodes) {
  const walker = document.createTreeWalker(original, NodeFilter.SHOW_TEXT), dom = [];
  let joined = '';
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement.closest('.katex,svg,.heading-anchor,input,.footnote-backref')) continue;
    dom.push({ node, start: joined.length }); joined += node.nodeValue;
  }
  const result = []; let search = 0;
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
      const entry = dom.find(item => at >= item.start && at < item.start + item.node.length);
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
  // Delimiters before the first glyph and after the last belong to this line.
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
async function setMode(next) {
  if (!current.active) return;
  await commitInlineEdit();
  const scroll = $('reader-scroll').scrollTop;
  mode = next === 'read' ? 'read' : 'edit'; root.dataset.mode = mode;
  $('reader-scroll').hidden = false;
  $('read-mode').setAttribute('aria-pressed', String(mode === 'read'));
  $('edit-mode').setAttribute('aria-pressed', String(mode === 'edit'));
  await renderPreview(scroll);
  if (mode === 'edit' && !current.content) beginInlineEdit(editTarget($('preview').firstElementChild, 0));
  if (!$('find-bar').hidden) updateFind();
}
function requestMode(next) { return enqueue(() => setMode(next)); }
function zoomText(delta, reset = false) { fontSize = reset ? 18 : Math.min(40, Math.max(12, fontSize + delta)); root.style.setProperty('--text-size', `${fontSize}px`); preferences.set('fontSize', fontSize); status(`Document text: ${fontSize} px`); }
function zoomWindow(delta, reset = false) { windowZoom = reset ? 1 : Math.min(2, Math.max(.6, Math.round((windowZoom + delta) * 10) / 10)); $('zoom-reset').textContent = `${Math.round(windowZoom * 100)}%`; preferences.set('windowZoom', windowZoom); invoke('set_window_zoom', { scale: windowZoom }).catch(toast); }
function availableThemes() { return omarchy ? [...themes, { id: 'omarchy', label: 'Omarchy', detail: `Current: ${omarchy.name}`, swatch: omarchy.colors.accent || '#7d82d9' }] : themes; }
function applyTheme(id, persist = true) {
  selectedTheme = id;
  root.removeAttribute('style'); zoomText(0);
  root.dataset.theme = id === 'omarchy' && !omarchy ? 'system' : id;
  if (id === 'omarchy' && omarchy) {
    const colors = omarchy.colors;
    const map = { '--bg': 'background', '--fg': 'foreground', '--surface': 'dark_background', '--panel': 'lighter_background', '--accent': 'accent', '--selection': 'selection', '--green': 'green', '--red': 'red', '--yellow': 'yellow', '--blue': 'blue', '--purple': 'magenta' };
    const fallbacks = { '--surface': 'color-mix(in srgb, var(--fg) 4%, var(--bg))', '--panel': 'color-mix(in srgb, var(--fg) 7%, var(--bg))', '--selection': 'color-mix(in srgb, var(--accent) 22%, var(--bg))' };
    for (const [variable, key] of Object.entries(map)) root.style.setProperty(variable, colors[key] || fallbacks[variable] || colors.accent || colors.foreground);
    root.style.colorScheme = omarchy.mode === 'light' ? 'light' : 'dark';
  }
  updatePreviewPalette();
  const accent = getComputedStyle(root).getPropertyValue('--accent').trim();
  if (/^#[0-9a-f]{6}$/i.test(accent)) {
    const channels = [1, 3, 5].map(index => parseInt(accent.slice(index, index + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    root.style.setProperty('--accent-ink', luminance > .179 ? '#161616' : '#ffffff');
  }
  $('theme-label').textContent = id === 'omarchy' && omarchy ? `Omarchy · ${omarchy.name}` : availableThemes().find(theme => theme.id === id)?.label || 'System';
  if (persist) preferences.set('theme', id);
  if ($('command-dialog').open) renderCommands();
  refreshMermaid();
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (selectedTheme === 'system') { updatePreviewPalette(); refreshMermaid(); }
});
function ask(title, message, choices) {
  return new Promise(resolve => {
    const dialog = $('confirm-dialog'); $('confirm-title').textContent = title; $('confirm-message').textContent = message; $('confirm-actions').replaceChildren();
    const finish = value => { dialog.close(); dialog.removeEventListener('cancel', cancel); resolve(value); };
    const cancel = event => { event.preventDefault(); finish('cancel'); };
    dialog.addEventListener('cancel', cancel);
    for (const choice of choices) {
      const button = document.createElement('button'); button.className = `button ${choice.style || ''}`; button.textContent = choice.label; button.onclick = () => finish(choice.value); $('confirm-actions').append(button);
    }
    dialog.showModal(); $('confirm-actions').firstElementChild?.focus();
  });
}
async function allowDiscard() {
  if (current.active && mode === 'edit') await commitInlineEdit();
  if (!dirty()) return true;
  const result = await ask('Save your changes?', `“${current.name}” has changes that haven't been saved.`, [
    { label: 'Cancel', value: 'cancel' }, { label: 'Discard', value: 'discard', style: 'destructive' }, { label: 'Save', value: 'save', style: 'suggested' }
  ]);
  if (result === 'save') return await save() && !dirty();
  return result === 'discard';
}
function enqueue(action) {
  queue = queue.then(async () => {
    busy = true; $('open').disabled = true; $('save').disabled = true;
    try { return await action(); } catch (error) { status(''); toast(error); return false; }
    finally { busy = false; $('open').disabled = false; $('save').disabled = false; }
  });
  return queue;
}
async function openPath(path, confirmed = false) {
  if (!confirmed && !(await allowDiscard())) return false;
  status('Opening…');
  const document = await invoke('open_document', { path });
  ++renderGeneration;
  previewSnapshot = null;
  previewBlocks = [];
  current = { path: document.path, name: document.name, content: document.content, saved: document.content, active: true };
  if (activeFolder && document.path !== activeFolder.path && !document.path.startsWith(`${activeFolder.path.replace(/\/$/, '')}/`)) { activeFolder = null; folderEntries = []; expandedFolders.clear(); }
  if (activeFolder) expandParentsOf(document.path);
  savedReaderScroll = 0;
  showDocument(); $('reader-scroll').scrollTop = 0; await setMode('read'); addRecent(current.path); return true;
}
function requestOpen(path) { return enqueue(() => openPath(path)); }
let pickerListing = null, pickerSelection = null;
async function browseTo(path) {
  pickerListing = await invoke('browse_directory', { path }); pickerSelection = null;
  $('open-path').value = pickerListing.path;
  $('open-parent').disabled = !pickerListing.parent;
  $('open-selection-hint').textContent = 'Select a Markdown file or folder';
  $('open-items').replaceChildren();
  for (const entry of pickerListing.entries) {
    const row = document.createElement('button'); row.className = 'file-dialog-item'; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false');
    row.append(icon(entry.directory ? 'open' : 'file'));
    const label = document.createElement('span'); label.textContent = entry.name; row.append(label);
    row.onclick = () => {
      pickerSelection = entry;
      $('open-items').querySelectorAll('.file-dialog-item').forEach(item => item.setAttribute('aria-selected', String(item === row)));
      $('open-selection-hint').textContent = entry.directory ? 'Open selected folder' : 'Open selected Markdown file';
    };
    row.ondblclick = () => entry.directory ? browseTo(entry.path).catch(toast) : confirmOpenPicker();
    $('open-items').append(row);
  }
  if (!pickerListing.entries.length) { const empty = document.createElement('p'); empty.className = 'empty-results'; empty.textContent = 'No Markdown files or folders here'; $('open-items').append(empty); }
}
async function openChooser() {
  try {
    const initial = activeFolder?.path || current.path?.slice(0, current.path.lastIndexOf('/')) || null;
    await browseTo(initial);
    if (!$('open-dialog').open) $('open-dialog').showModal();
    $('open-items').querySelector('button')?.focus();
  } catch (error) { toast(error); }
}
function confirmOpenPicker() {
  const typed = $('open-path').value.trim();
  const path = pickerSelection?.path || typed || pickerListing?.path;
  $('open-dialog').close();
  if (path) requestOpenLocation(path);
}
function setFolderVisible(visible) {
  folderVisible = visible;
  const shown = Boolean(activeFolder && visible);
  $('file-browser').hidden = !shown;
  $('folder-divider').hidden = !shown;
  $('folder-toggle').hidden = !activeFolder;
  $('folder-toggle').setAttribute('aria-pressed', String(shown));
}
function expandParentsOf(path) {
  for (const entry of folderEntries) {
    if (entry.directory && path.startsWith(`${entry.path}/`)) expandedFolders.add(entry.path);
  }
}
function entryIsVisible(entry) {
  if (!activeFolder) return false;
  let parent = entry.path.slice(0, entry.path.lastIndexOf('/')) || '/';
  while (parent !== activeFolder.path && parent.startsWith(`${activeFolder.path.replace(/\/$/, '')}/`)) {
    if (!expandedFolders.has(parent)) return false;
    parent = parent.slice(0, parent.lastIndexOf('/')) || '/';
  }
  return true;
}
function renderFolderEntries() {
  setFolderVisible(folderVisible);
  const list = $('folder-items');
  const scrollTop = $('file-browser').scrollTop;
  list.replaceChildren();
  if (!activeFolder) return;
  $('folder-name').textContent = activeFolder.name || activeFolder.path;
  $('folder-name').title = activeFolder.path;
  for (const entry of folderEntries) {
    if (!entryIsVisible(entry)) continue;
    const button = document.createElement('button');
    button.className = `folder-entry${entry.directory ? ' directory' : ''}${current.path === entry.path ? ' selected' : ''}`;
    button.style.paddingLeft = `${7 + entry.depth * 16}px`;
    button.title = entry.path;
    if (entry.directory) {
      const expanded = expandedFolders.has(entry.path);
      button.setAttribute('aria-expanded', String(expanded));
      const chevron = icon('chevron'); chevron.classList.add('tree-chevron'); button.append(chevron);
      button.append(icon('open'));
      button.onclick = () => { expanded ? expandedFolders.delete(entry.path) : expandedFolders.add(entry.path); renderFolderEntries(); };
    } else {
      const spacer = document.createElement('span'); spacer.className = 'tree-spacer'; button.append(spacer);
      button.append(icon('file'));
      if (current.path === entry.path) button.setAttribute('aria-current', 'page');
      button.onclick = () => requestOpen(entry.path);
    }
    const label = document.createElement('span'); label.textContent = entry.name; button.append(label);
    list.append(button);
  }
  if (!folderEntries.length) { const empty = document.createElement('p'); empty.className = 'empty-results'; empty.textContent = 'No Markdown files or folders'; list.append(empty); }
  $('file-browser').scrollTop = scrollTop;
}
async function openFolderPath(path, confirmed = false) {
  if (!confirmed && !(await allowDiscard())) return false;
  await invoke('new_document');
  const listing = await invoke('open_folder', { path });
  ++renderGeneration;
  activeFolder = { path: listing.path, name: listing.name }; folderEntries = listing.entries;
  expandedFolders.clear(); folderVisible = true; savedReaderScroll = 0;
  current = { path: null, name: 'Untitled.md', content: '', saved: '', active: false };
  previewSnapshot = null;
  previewBlocks = [];
  mode = 'read'; root.dataset.mode = mode;
  $('reader-scroll').hidden = false;
  showDocument(); $('preview').replaceChildren(); $('reader-scroll').scrollTop = 0; status('');
  $('folder-empty').querySelector('h1').textContent = folderEntries.some(entry => !entry.directory) ? 'Folder opened' : 'No Markdown files';
  $('folder-empty').querySelector('p').textContent = folderEntries.some(entry => !entry.directory) ? 'Choose a Markdown file from the file tree.' : 'This folder has no Markdown files. Open another folder to browse it.';
  return true;
}
function requestOpenLocation(path) {
  return enqueue(async () => {
    if (await invoke('path_is_directory', { path })) return openFolderPath(path);
    return openPath(path);
  });
}
async function save(saveAs = false, force = false) {
  if (!current.active) return false;
  if (mode === 'edit') await commitInlineEdit();
  const snapshot = current.content;
  status('Saving…');
  try {
    const saved = await invoke('save_document', { content: snapshot, saveAs, force });
    if (!saved) { status(''); return false; }
    current.path = saved.path; current.name = saved.name; current.saved = snapshot; updateTitle(); $('disk-banner').hidden = true; addRecent(current.path); status('Saved');
    if (mode === 'read') await renderPreview();
    return true;
  } catch (error) {
    status('');
    if (!String(error).startsWith('FILE_CHANGED:')) throw error;
    const choice = await ask('This file changed on disk', 'Another app changed this file. Reload the disk version, or overwrite it with your current document.', [
      { label: 'Cancel', value: 'cancel' }, { label: 'Reload', value: 'reload' }, { label: 'Overwrite', value: 'overwrite', style: 'destructive' }
    ]);
    if (choice === 'overwrite') return save(saveAs, true);
    if (choice === 'reload') { await openPath(current.path, true); return true; }
    return false;
  }
}
function requestSave(saveAs = false) { return enqueue(() => save(saveAs)); }
function newDocument(sample = false) {
  return enqueue(async () => {
    if (!(await allowDiscard())) return;
    await invoke('new_document'); ++renderGeneration;
    previewSnapshot = null;
    previewBlocks = [];
    const content = sample ? SAMPLE : '';
    current = { path: null, name: sample ? 'Welcome.md' : 'Untitled.md', content, saved: content, active: true };
    savedReaderScroll = 0;
    showDocument(); $('reader-scroll').scrollTop = 0; await setMode(sample ? 'read' : 'edit');
  });
}
function addRecent(path) { const recent = preferences.get('recent', []); preferences.set('recent', [path, ...recent.filter(item => item !== path)].slice(0, 6)); renderRecent(); }
function renderRecent() {
  const recent = preferences.get('recent', []); $('recent-section').hidden = !recent.length; $('recent-files').replaceChildren();
  for (const path of recent.slice(0, 4)) {
    const button = document.createElement('button'); button.className = 'recent-file'; button.append(icon('file'));
    const text = document.createElement('div'), name = document.createElement('strong'), location = document.createElement('small');
    name.textContent = path.split('/').pop(); location.textContent = path.slice(0, path.lastIndexOf('/')); text.append(name, location); button.append(text); button.title = path; button.onclick = () => requestOpen(path); $('recent-files').append(button);
  }
}

let commandScope = 'commands', filteredCommands = [], selectedCommand = 0;
function allCommands() {
  const commands = [
    { label: 'Open file…', icon: 'open', shortcut: 'Ctrl+O', action: openChooser },
    { label: 'New document', icon: 'plus', shortcut: 'Ctrl+N', action: () => newDocument() },
    { label: 'Change theme…', icon: 'theme', action: () => openCommands('themes') },
    { label: 'Try a sample document', icon: 'file', action: () => newDocument(true) },
    { label: 'Clear recent files', icon: 'close', action: () => { preferences.set('recent', []); renderRecent(); toast('Recent files cleared'); } }
  ];
  if (current.active) commands.splice(2, 0,
    { label: 'Save', icon: 'save', shortcut: 'Ctrl+S', action: () => requestSave() },
    { label: 'Save as…', icon: 'save', shortcut: 'Ctrl+Shift+S', action: () => requestSave(true) },
    { label: 'Preview document', icon: 'read', action: () => requestMode('read') },
    { label: 'Edit document', icon: 'edit', action: () => requestMode('edit') },
    { label: 'Undo', icon: 'edit', shortcut: 'Ctrl+Z', action: () => enqueue(() => undoRedo()) },
    { label: 'Redo', icon: 'edit', shortcut: 'Ctrl+Shift+Z / Ctrl+Y', action: () => enqueue(() => undoRedo(true)) },
    { label: 'Find in document', icon: 'search', shortcut: 'Ctrl+F', action: openFind },
    { label: 'Toggle outline', icon: 'outline', action: () => setOutline(!outlineVisible) },
    { label: 'Toggle focus mode', icon: 'focus', shortcut: 'F11', action: toggleFocus },
    { label: wideLayout ? 'Use centered document width' : 'Use full document width', icon: wideLayout ? 'width-contract' : 'width-expand', action: toggleDocumentWidth },
    { label: 'Zoom in', icon: 'plus', shortcut: 'Ctrl+=', action: () => zoomWindow(.1) },
    { label: 'Zoom out', icon: 'minus', shortcut: 'Ctrl+-', action: () => zoomWindow(-.1) },
    { label: 'Reset window zoom', icon: 'read', shortcut: 'Ctrl+0', action: () => zoomWindow(0, true) },
    { label: 'Increase document text size', icon: 'plus', shortcut: 'Ctrl+Shift+=', action: () => zoomText(1) },
    { label: 'Decrease document text size', icon: 'minus', shortcut: 'Ctrl+Shift+-', action: () => zoomText(-1) },
    { label: 'Reset document text size', icon: 'read', shortcut: 'Ctrl+Shift+0', action: () => zoomText(0, true) }
  );
  if (activeFolder) commands.splice(2, 0, { label: 'Toggle file tree', icon: 'open', shortcut: 'Ctrl+B', action: () => setFolderVisible(!folderVisible) });
  return commands;
}
function themeCommands() { return availableThemes().map(theme => ({ ...theme, label: `Theme: ${theme.label}`, action: () => applyTheme(theme.id) })); }
function openCommands(scope = 'commands') {
  if ($('confirm-dialog').open) return;
  commandScope = scope; selectedCommand = 0; $('command-search').value = ''; $('command-search').placeholder = scope === 'themes' ? 'Search themes…' : 'Search commands or themes…';
  renderCommands(); if (!$('command-dialog').open) $('command-dialog').showModal(); $('command-search').focus();
}
function renderCommands() {
  const query = $('command-search').value.trim().toLocaleLowerCase();
  const list = commandScope === 'themes' ? themeCommands() : [...allCommands(), ...themeCommands()];
  filteredCommands = list.filter(command => `${command.label} ${command.detail || ''}`.toLocaleLowerCase().includes(query));
  selectedCommand = Math.max(0, Math.min(selectedCommand, filteredCommands.length - 1));
  $('command-scope').textContent = commandScope === 'themes' ? 'Appearance' : query ? 'Search results' : 'Commands';
  $('command-results').replaceChildren();
  if (!filteredCommands.length) { const empty = document.createElement('p'); empty.className = 'empty-results'; empty.textContent = 'No matching commands'; $('command-results').append(empty); }
  filteredCommands.forEach((command, index) => {
    const button = document.createElement('button'); button.id = `command-${index}`; button.className = `command-item${index === selectedCommand ? ' active' : ''}`;
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === selectedCommand)); button.tabIndex = -1;
    if (command.swatch) { const swatch = document.createElement('span'); swatch.className = 'theme-swatch'; swatch.style.setProperty('--swatch', command.swatch); button.append(swatch); }
    else button.append(icon(command.icon));
    const label = document.createElement('span'); label.className = 'command-label'; label.textContent = command.label; button.append(label);
    if (command.id === selectedTheme) button.append(icon('check'));
    else if (command.detail) { const detail = document.createElement('span'); detail.className = 'command-detail'; detail.textContent = command.detail; button.append(detail); }
    if (command.shortcut) { const shortcut = document.createElement('span'); shortcut.className = 'shortcut'; shortcut.textContent = command.shortcut; button.append(shortcut); }
    button.onclick = () => executeCommand(index); $('command-results').append(button);
  });
  $('command-search').setAttribute('aria-activedescendant', filteredCommands.length ? `command-${selectedCommand}` : '');
}
function executeCommand(index) {
  const command = filteredCommands[index]; if (!command) return;
  $('command-dialog').close(); Promise.resolve(command.action()).catch(toast);
}
$('command-search').addEventListener('input', () => { selectedCommand = 0; renderCommands(); });
$('command-search').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); selectedCommand = (selectedCommand + (event.key === 'ArrowDown' ? 1 : -1) + filteredCommands.length) % Math.max(1, filteredCommands.length); renderCommands(); $(`command-${selectedCommand}`)?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter') { event.preventDefault(); executeCommand(selectedCommand); }
  else if (event.key === 'Backspace' && !$('command-search').value && commandScope === 'themes') openCommands();
});
for (const id of ['command-dialog']) $(id).addEventListener('click', event => { const bounds = $(id).getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $(id).close(); });

let matches = [], findIndex = -1;
function openFind() { if (!current.active) return; if (inlineEdit) { enqueue(async () => { await commitInlineEdit(); openFind(); }); return; } $('find-bar').hidden = false; $('find-input').focus(); $('find-input').select(); updateFind(); }
function clearHighlights() { $('preview').querySelectorAll('mark[data-find]').forEach(mark => mark.replaceWith(document.createTextNode(mark.textContent))); $('preview').normalize(); }
function updateFind() {
  clearHighlights(); matches = []; findIndex = -1;
  const query = $('find-input').value.toLocaleLowerCase();
  if (!query) { $('find-result').textContent = ''; return; }
  {
    const walker = document.createTreeWalker($('preview'), NodeFilter.SHOW_TEXT), nodes = []; while (walker.nextNode()) { if (!walker.currentNode.parentElement?.closest('.mermaid-host,.katex,textarea,[hidden]')) nodes.push(walker.currentNode); }
    for (const node of nodes) {
      const text = node.nodeValue, lower = text.toLocaleLowerCase(); let cursor = 0, position = lower.indexOf(query);
      if (position === -1) continue;
      const fragment = document.createDocumentFragment();
      while (position !== -1 && matches.length < 2000) { fragment.append(document.createTextNode(text.slice(cursor, position))); const mark = document.createElement('mark'); mark.dataset.find = ''; mark.textContent = text.slice(position, position + query.length); fragment.append(mark); matches.push(mark); cursor = position + query.length; position = lower.indexOf(query, cursor); }
      fragment.append(document.createTextNode(text.slice(cursor))); node.replaceWith(fragment);
    }
  }
  if (matches.length) nextFind(1); else $('find-result').textContent = 'No matches';
}
function nextFind(direction) {
  if (!matches.length) return; findIndex = (findIndex + direction + matches.length) % matches.length;
  matches.forEach(mark => mark.classList.remove('find-active')); matches[findIndex].classList.add('find-active'); matches[findIndex].scrollIntoView({ block: 'center' });
  $('find-result').textContent = `${findIndex + 1} / ${matches.length}`;
}
function closeFind() { $('find-bar').hidden = true; clearHighlights(); $('reader-scroll').focus(); }
function toggleFocus() { document.body.classList.toggle('focus-mode'); }
function setDocumentWidth(full, persist = true) {
  const anchor = current.active ? previewElementForBlock(previewBlockAtViewportTop()) : null;
  const previousTop = anchor?.getBoundingClientRect().top;
  wideLayout = Boolean(full);
  root.dataset.documentWidth = wideLayout ? 'full' : 'centered';
  const button = $('width-toggle');
  const label = wideLayout ? 'Use centered document width' : 'Use full document width';
  button.setAttribute('aria-pressed', String(wideLayout));
  button.setAttribute('aria-label', label);
  button.title = label;
  button.querySelector('use').setAttribute('href', wideLayout ? '#i-width-contract' : '#i-width-expand');
  if (anchor && previousTop !== undefined) $('reader-scroll').scrollTop += anchor.getBoundingClientRect().top - previousTop;
  if (persist) preferences.set('wideLayout', wideLayout);
}
function toggleDocumentWidth() { setDocumentWidth(!wideLayout); }

let savedReaderScroll = 0;
$('reader-scroll').addEventListener('scroll', () => { savedReaderScroll = $('reader-scroll').scrollTop; });
$('preview').addEventListener('change', event => {
  const checkbox = event.target.closest('input[type="checkbox"][data-task-index]');
  if (!checkbox || mode !== 'edit') return;
  const taskIndex = Number(checkbox.dataset.taskIndex), checked = checkbox.checked;
  enqueue(async () => {
    await commitInlineEdit();
    changeContent(await invoke('set_task_checked', { content: current.content, taskIndex, checked }));
    await renderPreview();
  });
});
$('open').onclick = $('welcome-open').onclick = openChooser;
$('open-parent').onclick = () => pickerListing?.parent && browseTo(pickerListing.parent).catch(toast);
$('open-go').onclick = () => browseTo($('open-path').value.trim()).catch(toast);
$('open-path').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); browseTo($('open-path').value.trim()).catch(toast); } };
$('open-dialog').addEventListener('keydown', event => { if (event.altKey && event.key === 'ArrowLeft' && pickerListing?.parent) { event.preventDefault(); browseTo(pickerListing.parent).catch(toast); } });
$('open-confirm').onclick = confirmOpenPicker;
$('open-cancel').onclick = $('open-dialog-close').onclick = () => $('open-dialog').close();
$('folder-close').onclick = () => setFolderVisible(false);
$('folder-toggle').onclick = () => setFolderVisible(!folderVisible);
$('folder-refresh').onclick = () => activeFolder && enqueue(async () => { const listing = await invoke('open_folder', { path: activeFolder.path }); activeFolder = { path: listing.path, name: listing.name }; folderEntries = listing.entries; renderFolderEntries(); });
$('new').onclick = () => newDocument(); $('sample').onclick = () => newDocument(true);
$('read-mode').onclick = () => requestMode('read'); $('edit-mode').onclick = () => requestMode('edit'); $('save').onclick = () => requestSave();
$('palette-open').onclick = () => openCommands(); $('outline-toggle').onclick = () => setOutline(!outlineVisible);
$('width-toggle').onclick = toggleDocumentWidth;
$('zoom-in').onclick = () => zoomWindow(.1); $('zoom-out').onclick = () => zoomWindow(-.1); $('zoom-reset').onclick = () => zoomWindow(0, true);
$('reload').onclick = () => requestOpen(current.path); $('dismiss-disk').onclick = () => { $('disk-banner').hidden = true; };
$('find-input').oninput = updateFind; $('find-next').onclick = () => nextFind(1); $('find-previous').onclick = () => nextFind(-1); $('find-close').onclick = closeFind;
$('find-input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); nextFind(event.shiftKey ? -1 : 1); } };
$('preview').addEventListener('click', event => {
  const anchor = event.target.closest('a');
  if (mode === 'edit') {
    if (anchor) event.preventDefault();
    if (event.target.closest('input,button,textarea')) return;
    if (inlineEdit || busy) return; // Outside pointer handler commits before this click.
    beginInlineEdit(editTarget(event.target, event.clientY));
    return;
  }
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute('href'); if (!href) return;
  if (href.startsWith('#')) { let id; try { id = decodeURIComponent(href.slice(1)); } catch { return; } document.getElementById(id)?.scrollIntoView({ block: 'start' }); }
  else if (/^(https?:|mailto:)/.test(href)) invoke('open_link', { url: href }).catch(toast);
  else enqueue(async () => { const path = await invoke('resolve_document_link', { link: href }); await openPath(path); });
});
document.addEventListener('pointerdown', event => {
  if (!inlineEdit || event.target === inlineEdit.textarea || event.target.closest('dialog,#find-bar')) return;
  const checkbox = event.target.closest('input[data-task-index]');
  if (checkbox) {
    event.preventDefault();
    const taskIndex = Number(checkbox.dataset.taskIndex), checked = !checkbox.checked;
    enqueue(async () => {
      await commitInlineEdit();
      changeContent(await invoke('set_task_checked', { content: current.content, taskIndex, checked }));
      await renderPreview();
    });
    return;
  }
  if (event.target.closest('#preview') && !event.target.closest('input,button')) {
    event.preventDefault();
    const x = event.clientX, y = event.clientY;
    enqueue(async () => { await commitInlineEdit(); const target = document.elementFromPoint(x, y); if (target?.closest('#preview')) beginInlineEdit(editTarget(target, y)); });
  } else enqueue(commitInlineEdit);
});
$('preview').addEventListener('keydown', event => {
  if (mode === 'edit' && event.key === 'Enter' && !event.target.matches('textarea,input')) {
    event.preventDefault(); beginInlineEdit(editTarget(event.target, event.target.getBoundingClientRect().top + 10));
  }
});
document.addEventListener('keydown', event => {
  const control = event.ctrlKey || event.metaKey;
  if (control && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); $('command-dialog').open ? $('command-dialog').close() : openCommands(); return; }
  if ($('command-dialog').open || $('confirm-dialog').open || $('open-dialog').open) return;
  if (event.key === 'Escape') { if (!$('find-bar').hidden) closeFind(); else document.body.classList.remove('focus-mode'); return; }
  if (event.key === 'F11') { event.preventDefault(); if (current.active) toggleFocus(); return; }
  if (!control) return;
  const key = event.key.toLowerCase();
  if (key === 'z' || key === 'y') {
    if (event.target.matches('input')) return;
    event.preventDefault(); enqueue(() => undoRedo(key === 'y' || event.shiftKey));
  }
  else if (event.code === 'Equal' || key === '+' || key === '=') { event.preventDefault(); event.shiftKey ? zoomText(1) : zoomWindow(.1); }
  else if (event.code === 'Minus' || key === '-' || key === '_') { event.preventDefault(); event.shiftKey ? zoomText(-1) : zoomWindow(-.1); }
  else if (key === '0') { event.preventDefault(); event.shiftKey ? zoomText(0, true) : zoomWindow(0, true); }
  else if (key === 'o') { event.preventDefault(); openChooser(); }
  else if (key === 'b' && activeFolder) { event.preventDefault(); setFolderVisible(!folderVisible); }
  else if (key === 'n') { event.preventDefault(); newDocument(); }
  else if (key === 's') { event.preventDefault(); requestSave(event.shiftKey); }
  else if (key === 'e') { event.preventDefault(); enqueue(() => setMode(mode === 'read' ? 'edit' : 'read')); }
  else if (key === 'f') { event.preventDefault(); openFind(); }
  else if (key === 'w') { event.preventDefault(); requestClose(); }
});
async function requestClose() { return enqueue(async () => { if (await allowDiscard()) await invoke('close_window'); }); }

const SAMPLE = `# A quiet place for your words

Folio opens **individual Markdown files**. Read comfortably, switch to editing when you need to, and save right back to disk.

## Make yourself at home

Use the search button in the header, or **Ctrl+Shift+P**, to open the command window. Search for a theme and press Enter to apply it.

> [!NOTE]
> When Omarchy is detected, choose the **Omarchy** theme to follow your current desktop palette automatically.

## A few useful shortcuts

| Action | Shortcut |
| :--- | :--- |
| Open a file or folder | Ctrl+O |
| Read or edit | Ctrl+E |
| Save | Ctrl+S |
| Zoom the whole app | Ctrl+= / Ctrl+- |
| Change document text size | Ctrl+Shift+= / Ctrl+Shift+- |
| Reset app zoom | Ctrl+0 |

## Plain text, beautifully rendered

- [x] Tables, task lists, and footnotes
- [x] Code with syntax highlighting
- [x] Links and local images
- [ ] Your next idea

\`\`\`rust
fn main() {
    let message = "Hello, Folio!";
    println!("{message}");
}
\`\`\`

Your files stay yours. This sample is just a starting point.[^1]

[^1]: Editing this sample and pressing Ctrl+S lets you save your own copy.
`;

async function start() {
  zoomText(0); zoomWindow(0); renderRecent(); setDocumentWidth(wideLayout, false);
  if (!window.__TAURI__) { toast('Open Folio from your app menu to enable file access.'); return; }
  await listen('request-close', requestClose);
  await listen('open-files', event => { for (const path of event.payload) requestOpenLocation(path); });
  await listen('system-theme', event => { omarchy = event.payload; if (selectedTheme === 'omarchy') applyTheme('omarchy', false); else if ($('command-dialog').open) renderCommands(); });
  const state = await invoke('bootstrap'); omarchy = state.theme;
  if (preferences.get('theme', null) === null && omarchy) selectedTheme = 'omarchy';
  applyTheme(selectedTheme, false);
  for (const path of state.paths) requestOpenLocation(path);
  await window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(event => {
    const type = event.payload.type; $('drop-overlay').hidden = type !== 'over' && type !== 'enter';
    if (type === 'drop') { $('drop-overlay').hidden = true; for (const path of event.payload.paths) requestOpenLocation(path); }
  });
  setInterval(async () => {
    if (!current.path || busy || document.hidden) return;
    const path = current.path;
    try { const changed = await invoke('document_changed'); if (path === current.path) $('disk-banner').hidden = !changed; } catch { /* a transient disk error will be shown when saving */ }
  }, 3000);
}
start().catch(error => { toast(error); console.error(error); });
