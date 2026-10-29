'use strict';
// Preview rendering, lazy math/diagram assets, and diagram lifecycle.
let renderGeneration = 0, previewSnapshot = null, diagramThemeRevision = 0, previewLimitedKind = null;
const assetLoads = new Map();
function loadAsset(url, style = false) {
  if (assetLoads.has(url)) return assetLoads.get(url);
  const promise = new Promise((resolve, reject) => {
    const element = document.createElement(style ? 'link' : 'script');
    if (style) { element.rel = 'stylesheet'; element.href = url; }
    else { element.src = url; element.async = true; }
    element.addEventListener('load', () => resolve(), { once: true });
    element.addEventListener('error', () => { element.remove(); assetLoads.delete(url); reject(new Error(`Unable to load ${url}`)); }, { once: true });
    document.head.append(element);
  });
  assetLoads.set(url, promise);
  return promise;
}
let katexLoading = null;
function loadKatex() {
  if (window.katex) return Promise.resolve(window.katex);
  if (!katexLoading) {
    const styles = loadAsset('vendor/katex/katex.min.css', true).catch(() => {});
    katexLoading = Promise.all([styles, loadAsset('vendor/katex/katex.min.js')])
      .then(() => {
        if (!window.katex) throw new Error('KaTeX did not initialize');
        return window.katex;
      })
      .catch(error => { katexLoading = null; throw error; });
  }
  return katexLoading;
}
let outlineEntries = [], outlineActiveFrame = null, outlineActiveIndex = -1;
function setActiveOutline(index) {
  if (!outlineEntries.length) return;
  const active = Math.max(0, Math.min(index, outlineEntries.length - 1));
  if (active === outlineActiveIndex) return;
  outlineActiveIndex = active;
  outlineEntries.forEach((entry, entryIndex) => {
    const selected = entryIndex === active;
    entry.button.classList.toggle('active', selected);
    entry.button.tabIndex = selected ? 0 : -1;
    if (selected) entry.button.setAttribute('aria-current', 'location');
    else entry.button.removeAttribute('aria-current');
  });
}
function updateActiveOutline() {
  if (!outlineEntries.length) return;
  const line = $('reader-scroll').getBoundingClientRect().top + 88;
  let low = 0, high = outlineEntries.length - 1, active = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (outlineEntries[middle].element.getBoundingClientRect().top <= line) {
      active = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  setActiveOutline(active);
}
function scheduleOutlineActive() {
  if (outlineActiveFrame !== null) return;
  outlineActiveFrame = requestAnimationFrame(() => { outlineActiveFrame = null; updateActiveOutline(); });
}
$('reader-scroll').addEventListener('scroll', scheduleOutlineActive, { passive: true });
window.addEventListener('resize', scheduleOutlineActive);

$('outline-items').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...$('outline-items').querySelectorAll('.outline-link')];
  if (!buttons.length) return;
  const current = buttons.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? buttons.length - 1
    : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[next].focus();
});

async function renderPreview(restoreScroll) {
  if (previewSnapshot?.content === current.content && previewSnapshot.path === current.path) {
    syncPreviewEditing();
    syncSourceFallback();
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
    const result = await invoke('render_markdown', { content, remoteImages });
    if (generation !== renderGeneration) return;
    $('preview').innerHTML = typeof result === 'string' ? result : result.html;
    previewBlocks = Array.isArray(result.blocks) ? result.blocks : [];
    const limitNode = $('preview').querySelector('[data-preview-limit]');
    previewLimitedKind = limitNode ? (limitNode.dataset.previewLimit || 'limit') : null;
    const sourceIndexes = new Map(previewBlocks.map((block, index) => [block.sourcepos, index]).filter(([position]) => position));
    const elements = [...$('preview').querySelectorAll(':scope > [data-sourcepos]:not(.footnotes), :scope > .footnotes > ol > li[data-sourcepos]')];
    for (const element of elements) {
      const index = sourceIndexes.get(element.dataset.sourcepos);
      if (index !== undefined) element.dataset.editIndex = String(index);
    }

    if (!sourceIndexes.size && $('preview').children.length === previewBlocks.length) {
      [...$('preview').children].forEach((element, index) => { element.dataset.editIndex = String(index); });
    }
    setupCodeLanguages();
    setupTables();
    await renderMath(generation);
    if (generation !== renderGeneration) return;
    syncPreviewEditing();
    await renderDiagrams(generation, reusableDiagrams);
    if (generation !== renderGeneration) return;
    if (scrollTo !== undefined) { const container = $('reader-scroll'); container.scrollTop = Math.max(0, Math.min(scrollTo, container.scrollHeight - container.clientHeight)); }
    $('folder-empty').hidden = true;
    previewSnapshot = { content, path, themeRevision, limited: previewLimitedKind };
    syncPreviewEditing();
    syncSourceFallback();
    if (themeRevision !== diagramThemeRevision) await refreshMermaid();
    $('outline-items').replaceChildren();
    outlineEntries = [];
    outlineActiveIndex = -1;
    const headings = $('preview').querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (const heading of headings) {
      const level = Number(heading.tagName[1]);
      const button = document.createElement('button');
      button.className = 'outline-link';
      button.textContent = heading.textContent;
      button.title = heading.textContent;
      button.dataset.level = String(level);
      button.style.setProperty('--indent', `${(level - 1) * 12}px`);
      button.tabIndex = -1;
      button.onclick = async () => {
        const id = heading.id;
        if (mode !== 'read') await setMode('read');
        document.getElementById(id)?.scrollIntoView({ block: 'start' });
        setActiveOutline(outlineEntries.findIndex(entry => entry.id === id));
      };
      $('outline-items').append(button);
      outlineEntries.push({ id: heading.id, element: heading, button });
    }
    if (outlineEntries.length) {
      outlineEntries[0].button.tabIndex = 0;
      $('outline-count').textContent = `${outlineEntries.length} ${outlineEntries.length === 1 ? 'section' : 'sections'}`;
    } else {
      $('outline-count').textContent = 'No headings';
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      const title = document.createElement('strong');
      title.textContent = 'No headings';
      const hint = document.createElement('span');
      hint.textContent = 'Add a heading to build the outline.';
      empty.append(title, hint);
      $('outline-items').append(empty);
    }
    requestAnimationFrame(updateActiveOutline);
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
  if (!$('preview').querySelector('[data-math-style]')) return;
  try { await loadKatex(); } catch { return; }
  if (generation !== renderGeneration) return;
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
        window.katex.render(element.textContent, host, { displayMode: true, throwOnError: false });
        pre?.replaceWith(host);
      } else {
        window.katex.render(element.textContent, element, { displayMode: display, throwOnError: false });
      }
    } catch {}
  }
}
// Mermaid diagrams render in the offline renderer webview over a native
// bridge; the main page never loads or executes Mermaid itself. Results are
// routed by request id. Only payloads that are ok AND backend-sanitized are
// inserted; everything else becomes text plus the diagram source.
let mermaidBridgeId = 0;
const mermaidPending = new Map();
let mermaidBridgeListener = null;
function onMermaidRenderResult(event) {
  const payload = event && typeof event === 'object' && 'payload' in event ? event.payload : event;
  const pending = payload && typeof payload.id === 'string' ? mermaidPending.get(payload.id) : undefined;
  if (!pending) return;
  mermaidPending.delete(payload.id);
  pending.resolve(payload ?? null);
}
function ensureMermaidBridge() {
  if (!mermaidBridgeListener) {
    mermaidBridgeListener = listen('mermaid-render-result', onMermaidRenderResult).catch(error => {
      mermaidBridgeListener = null;
      throw error;
    });
  }
  return mermaidBridgeListener;
}
function cancelMermaidPending() {
  if (!mermaidPending.size) return;
  for (const [id, pending] of mermaidPending) {
    mermaidPending.delete(id);
    pending.resolve(null);
    invoke('mermaid_render_cancel', { id }).catch(() => {});
  }
}
const MAX_MERMAID_SOURCE_BYTES = 256 * 1024;
function mermaidSourceTooLarge(source) {
  try {
    return new TextEncoder().encode(source).length > MAX_MERMAID_SOURCE_BYTES;
  } catch {
    return (source || '').length > MAX_MERMAID_SOURCE_BYTES;
  }
}
async function requestMermaidRender(source) {
  const id = `m${++mermaidBridgeId}`;
  await ensureMermaidBridge();
  let resolveResult;
  const result = new Promise(resolve => { resolveResult = resolve; });
  mermaidPending.set(id, { resolve: resolveResult });
  try {
    await invoke('mermaid_render_request', { request: { id, source, theme: { variables: mermaidThemeVariables() } } });
  } catch (error) {
    mermaidPending.delete(id);
    throw error;
  }
  return { id, result: await result };
}
function showMermaidFallback(host, source, offline) {
  const message = document.createElement('p');
  message.className = 'mermaid-error';
  message.textContent = offline
    ? 'This diagram needs external images, which are blocked while rendering offline.'
    : 'Mermaid diagram could not be rendered.';
  const fallback = document.createElement('pre');
  fallback.className = 'mermaid-source';
  fallback.textContent = source;
  host.append(message, fallback);
}
async function renderMermaidHost(host, source, generation, pre) {
  if (!mermaidSourceTooLarge(source)) {
    let outcome;
    try {
      ({ result: outcome } = await requestMermaidRender(source));
    } catch {
      outcome = { ok: false };
    }
    if (outcome === null || outcome === undefined) return false;
    if (generation !== renderGeneration || !pre.isConnected) return false;
    if (outcome.ok === true && outcome.sanitized === true && typeof outcome.svg === 'string' && outcome.svg) {
      showDiagramSvg(host, outcome.svg);
      return true;
    }
    showMermaidFallback(host, source, outcome?.error?.code === 'unsupported_external_images');
    return true;
  }
  showMermaidFallback(host, source, false);
  return true;
}
async function renderDiagrams(generation = renderGeneration, reusableDiagrams = new Map()) {
  if (generation !== renderGeneration) return;
  cancelMermaidPending();
  if (!$('preview').querySelector('pre > code.language-mermaid')) return;
  const blocks = [...$('preview').querySelectorAll('pre > code.language-mermaid')].map(code => code.closest('pre'));
  if (!blocks.length) return;
  const themeRevision = diagramThemeRevision;
  for (const pre of blocks) {
    if (generation !== renderGeneration || !pre.isConnected) return;
    const source = pre.querySelector('code.language-mermaid')?.textContent ?? '';
    const candidate = reusableDiagrams.get(source)?.pop();
    const reused = candidate && Number(candidate.dataset.themeRevision) === themeRevision ? candidate : null;
    const host = reused || document.createElement('div');
    host.className = 'mermaid-host';
    host.dataset.sourcepos = pre.dataset.sourcepos || '';
    if (pre.dataset.editIndex !== undefined) host.dataset.editIndex = pre.dataset.editIndex;
    else delete host.dataset.editIndex;
    host.dataset.mermaidSource = source;
    host.dataset.themeRevision = String(themeRevision);
    if (reused) { pre.replaceWith(host); continue; }
    if (!await renderMermaidHost(host, source, generation, pre)) return;
    if (generation !== renderGeneration || !pre.isConnected) return;
    pre.replaceWith(host);
  }
}
async function refreshMermaid() {
  if (!current.active || !$('preview').querySelector('.mermaid-host')) return;
  const generation = renderGeneration, themeRevision = diagramThemeRevision;
  for (const host of $('preview').querySelectorAll('.mermaid-host[data-mermaid-source]')) {
    if (generation !== renderGeneration || themeRevision !== diagramThemeRevision) return;
    if (Number(host.dataset.themeRevision) === themeRevision) continue;
    const source = host.dataset.mermaidSource;
    if (mermaidSourceTooLarge(source)) continue;
    let outcome;
    try {
      ({ result: outcome } = await requestMermaidRender(source));
    } catch { continue; }
    if (outcome === null || outcome === undefined) return;
    if (!host.isConnected || generation !== renderGeneration || themeRevision !== diagramThemeRevision) return;
    if (outcome.ok === true && outcome.sanitized === true && typeof outcome.svg === 'string' && outcome.svg) {
      showDiagramSvg(host, outcome.svg);
      host.dataset.themeRevision = String(themeRevision);
    }
  }
  if (previewSnapshot) previewSnapshot.themeRevision = themeRevision;
}
function showDiagramSvg(host, markup) {
  host.innerHTML = markup;
  const drawing = host.querySelector('svg');
  const width = drawing?.viewBox?.baseVal?.width;
  if (width > 0) {
    drawing.style.width = `clamp(clamp(${Math.ceil(width * .5)}px, calc(${Math.ceil(width)}px - 100%), ${Math.ceil(width * .75)}px), 100%, ${Math.ceil(width)}px)`;
    drawing.style.maxWidth = 'none';
  }
}
