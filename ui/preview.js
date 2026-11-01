'use strict';
// Preview rendering, lazy math/diagram assets, and diagram lifecycle.
let renderGeneration = 0, previewSnapshot = null, diagramThemeRevision = 0;
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
  const previous = outlineActiveIndex;
  outlineActiveIndex = active;
  const paint = entryIndex => {
    const entry = outlineEntries[entryIndex];
    if (!entry) return;
    const selected = entryIndex === active;
    entry.button.classList.toggle('active', selected);
    entry.button.tabIndex = selected ? 0 : -1;
    if (selected) entry.button.setAttribute('aria-current', 'location');
    else entry.button.removeAttribute('aria-current');
  };
  paint(previous);
  paint(active);
}
function updateActiveOutline() {
  if (!outlineEntries.length) return;
  if ($('outline').hidden) return;
  const line = $('reader-scroll').getBoundingClientRect().top + 88;
  let low = 0, high = outlineEntries.length - 1, active = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((outlineEntries[middle].element?.getBoundingClientRect().top ?? Infinity) <= line) {
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
  await mountUnifiedEditor();
  if (restoreScroll !== undefined) $('reader-scroll').scrollTop = restoreScroll;
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
async function requestMermaidRender(source, signal) {
  const id = `m${++mermaidBridgeId}`;
  await ensureMermaidBridge();
  let resolveResult;
  const result = new Promise(resolve => { resolveResult = resolve; });
  mermaidPending.set(id, { resolve: resolveResult });
  const abort = () => {
    if (!mermaidPending.has(id)) return;
    mermaidPending.delete(id); resolveResult(null);
    invoke('mermaid_render_cancel', { id }).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    if (!signal?.aborted) await invoke('mermaid_render_request', { request: { id, source, theme: { variables: mermaidThemeVariables() } } });
  } catch (error) {
    mermaidPending.delete(id);
    throw error;
  }
  try { return { id, result: await result }; }
  finally { signal?.removeEventListener('abort', abort); }
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
  if (editor) { editor.refreshMedia(); return; }
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
