'use strict';
// Offline Mermaid renderer. This document is the only place Mermaid executes.
// It has no document/file/dialog/opener commands; its only native writes are
// bounded render results for requests delivered by the main webview. The
// renderer sanitizer is an early filter; src/renderer.rs parses and sanitizes
// the SVG/CSS again on the trusted side before the main webview sees it.
(() => {
  const MAX_SOURCE_BYTES = 256 * 1024;
  const MAX_SVG_BYTES = 8 * 1024 * 1024;
  const MAX_ERROR_MESSAGE = 1024;
  const ACTIVE_RENDER_TIMEOUT = 65000;
  const CANCELLED_ACTIVE_GRACE = 750;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ALLOWED_ERROR_CODES = new Set(['render_failed', 'invalid_source', 'unsupported_external_images', 'cancelled', 'internal_error']);

  // Deliberately excludes scripts, images, links, foreignObject, animation
  // elements, and other constructs that can navigate or load resources.
  const SAFE_SVG_TAGS = new Set([
    'svg', 'g', 'defs', 'symbol', 'use', 'marker', 'pattern', 'clippath', 'lineargradient',
    'radialgradient', 'stop', 'filter', 'feblend', 'fecolormatrix', 'fecomponenttransfer',
    'fecomposite', 'feconvolvematrix', 'fediffuselighting', 'fedisplacementmap', 'fedistantlight',
    'fedropshadow', 'feflood', 'fefunca', 'fefuncb', 'fefuncg', 'fefuncr', 'fegaussianblur',
    'femerge', 'femergenode', 'femorphology', 'feoffset', 'fepointlight', 'fespecularlighting',
    'fespotlight', 'fetile', 'feturbulence', 'path', 'rect', 'circle', 'ellipse', 'line',
    'polyline', 'polygon', 'text', 'tspan', 'textpath', 'title', 'desc', 'style', 'switch', 'view'
  ]);

  const URL_ATTRIBUTES = new Set([
    'fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end',
    'cursor', 'color-profile', 'shape-inside'
  ]);

  class RendererFailure extends Error {
    constructor(code, message) {
      super(message);
      this.code = ALLOWED_ERROR_CODES.has(code) ? code : 'render_failed';
    }
  }

  function boundedMessage(error) {
    const text = String(error && error.message ? error.message : error || 'Mermaid could not render this diagram.');
    return text.slice(0, MAX_ERROR_MESSAGE);
  }

  function readString(input, start) {
    const quote = input[start];
    let index = start + 1;
    while (index < input.length) {
      if (input[index] === '\\') { index += 2; continue; }
      if (input[index] === quote) return { value: input.slice(start + 1, index), end: index + 1 };
      index += 1;
    }
    return { value: input.slice(start + 1), end: input.length };
  }

  function readFunction(input, start) {
    let quote = null;
    for (let index = start; index < input.length; index += 1) {
      const character = input[index];
      if (quote) {
        if (character === '\\') { index += 1; continue; }
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === ')') return { value: input.slice(start, index), end: index + 1 };
    }
    return { value: input.slice(start), end: input.length };
  }

  function skipAtRule(input, start) {
    let depth = 0;
    for (let index = start; index < input.length; index += 1) {
      const character = input[index];
      if (character === '"' || character === "'") { index = readString(input, index).end - 1; continue; }
      if (character === '{') depth += 1;
      else if (character === '}') {
        if (depth > 0) depth -= 1;
        if (depth === 0) return index + 1;
      } else if (character === ';' && depth === 0) return index + 1;
    }
    return input.length;
  }

  function skipDeclaration(input, start) {
    for (let index = start; index < input.length; index += 1) {
      const character = input[index];
      if (character === '"' || character === "'") { index = readString(input, index).end - 1; continue; }
      if (character === ';' || character === '}') return index + 1;
    }
    return input.length;
  }

  function startsWithAsciiIgnoreCase(input, index, text) {
    if (index + text.length > input.length) return false;
    for (let offset = 0; offset < text.length; offset += 1) {
      const actual = input.charCodeAt(index + offset);
      const expected = text.charCodeAt(offset);
      const actualLower = actual >= 65 && actual <= 90 ? actual + 32 : actual;
      const expectedLower = expected >= 65 && expected <= 90 ? expected + 32 : expected;
      if (actualLower !== expectedLower) return false;
    }
    return true;
  }

  function isIdentifierCharacter(code) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) || code === 95 || code === 45 || code > 127;
  }

  function normalizeCssScheme(value) {
    let decoded = value.replace(/\\\r?\n/g, '');
    decoded = decoded.replace(/\\([0-9a-f]{1,6})\s?/gi, (match, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    });
    return decoded.replace(/[\t\n\r\f]/g, '').toLowerCase();
  }

  // Linear CSS scanner. Comments become a space (never empty text, so tokens
  // cannot be joined into url()/scheme tokens); external url()/scheme/at-rule
  // constructs are reported and neutralised while local fragment URLs survive.
  function sanitizeCss(input) {
    if (typeof input !== 'string') return { value: '', external: false };
    let external = false;
    let output = '';
    let index = 0;
    while (index < input.length) {
      if (input[index] === '/' && input[index + 1] === '*') {
        const end = input.indexOf('*/', index + 2);
        output += ' ';
        index = end < 0 ? input.length : end + 2;
        continue;
      }
      if (input[index] === '/' && input[index + 1] === '/') {
        external = true;
        index = skipDeclaration(input, index);
        continue;
      }
      if (input[index] === '@') {
        const keyword = (/^@([a-z-]+)/i.exec(input.slice(index, index + 80)) || [])[1]?.toLowerCase() || '';
        if (keyword === 'import') external = true;
        index = skipAtRule(input, index);
        continue;
      }
      if (input[index] === '\\') {
        external = true;
        index += 2;
        continue;
      }
      if (startsWithAsciiIgnoreCase(input, index, 'url(')) {
        const result = readFunction(input, index + 4);
        const target = result.value.trim().replace(/^['"]|['"]$/g, '');
        if (/^#[^\s"'()<>]+$/.test(target)) output += `url(${target})`;
        else {
          external = true;
          output += 'none';
        }
        index = result.end;
        continue;
      }
      if (startsWithAsciiIgnoreCase(input, index, 'expression(') ||
          startsWithAsciiIgnoreCase(input, index, '-moz-binding') ||
          startsWithAsciiIgnoreCase(input, index, 'behavior')) {
        external = true;
        index = skipDeclaration(input, index);
        continue;
      }
      if (input[index] === '"' || input[index] === "'") {
        const result = readString(input, index);
        const value = normalizeCssScheme(result.value);
        if (value.includes('://') || value.startsWith('//') || value.includes('data:') ||
            value.includes('http:') || value.includes('https:') ||
            value.includes('javascript:') || value.includes('blob:') || value.includes('file:')) {
          external = true;
          output += '""';
        } else {
          output += input.slice(index, result.end);
        }
        index = result.end;
        continue;
      }
      if (isIdentifierCharacter(input.charCodeAt(index))) {
        let end = index + 1;
        while (end < input.length && isIdentifierCharacter(input.charCodeAt(end))) end += 1;
        const identifier = normalizeCssScheme(input.slice(index, end));
        let lookahead = end;
        while (lookahead < input.length && /\s/.test(input[lookahead])) lookahead += 1;
        if (/^(?:https?|data|javascript|blob|filesystem|file)$/.test(identifier) && input[lookahead] === ':') {
          external = true;
          index = skipDeclaration(input, index);
          continue;
        }
        output += input.slice(index, end);
        index = end;
        continue;
      }
      output += input[index];
      index += 1;
    }
    return { value: output, external };
  }

  function sanitizeUrlValue(value) {
    if (typeof value !== 'string') return { value: null, external: false };
    if (value.length > 4096) return { value: null, external: true };
    const cleaned = sanitizeCss(value);
    if (cleaned.external) return { value: null, external: true };
    const trimmed = cleaned.value.trim();
    return { value: trimmed ? cleaned.value : null, external: false };
  }

  function hasExternalReference(node) {
    const elements = [node, ...node.querySelectorAll('*')];
    for (const element of elements) {
      const tag = element.localName.toLowerCase();
      if (['image', 'feimage', 'img', 'script', 'iframe', 'object', 'embed', 'link', 'audio', 'video'].includes(tag)) return true;
      for (const attribute of element.attributes) {
        const value = attribute.value.toLowerCase();
        if (value.includes('http:') || value.includes('https:') || value.includes('data:') ||
            value.includes('javascript:') || value.startsWith('//')) return true;
      }
    }
    return false;
  }

  /**
   * Structured SVG sanitizer used before a result leaves the renderer.
   * Returns `{ svg, external }`; `external` means the diagram needed resources
   * that offline mode does not support (the caller reports a fallback error).
   */
  function sanitizeSvg(markup) {
    if (typeof markup !== 'string') throw new RendererFailure('invalid_source', 'The diagram renderer returned no SVG.');
    if (markup.length > MAX_SVG_BYTES) throw new RendererFailure('render_failed', 'The diagram is too large to display safely.');
    let parsed;
    try {
      parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
    } catch {
      throw new RendererFailure('render_failed', 'The diagram renderer returned malformed SVG.');
    }
    if (parsed.querySelector('parsererror')) throw new RendererFailure('render_failed', 'The diagram renderer returned malformed SVG.');
    const root = parsed.documentElement;
    if (!root || root.namespaceURI !== SVG_NS || root.localName.toLowerCase() !== 'svg') {
      throw new RendererFailure('render_failed', 'The diagram renderer returned a non-SVG document.');
    }

    let external = false;
    const visit = element => {
      if (!element || element.nodeType !== 1) return;
      const tag = element.localName.toLowerCase();
      if (element.namespaceURI !== SVG_NS || !SAFE_SVG_TAGS.has(tag)) {
        if (tag === 'image' || tag === 'feimage') external = true;
        else if (tag === 'foreignobject' && hasExternalReference(element)) external = true;
        element.remove();
        return;
      }

      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        const local = attribute.localName.toLowerCase();
        if (name.startsWith('on') || local.startsWith('on')) {
          element.removeAttributeNode(attribute);
          continue;
        }
        if (local === 'href') {
          if (!/^#[^\s"'()<>]+$/.test(attribute.value.trim())) {
            external = true;
            element.removeAttributeNode(attribute);
          }
          continue;
        }
        if (name === 'src') {
          external = true;
          element.removeAttributeNode(attribute);
          continue;
        }
        if (local === 'style') {
          const cleaned = sanitizeCss(attribute.value);
          if (cleaned.external) external = true;
          if (cleaned.value.trim()) attribute.value = cleaned.value;
          else element.removeAttributeNode(attribute);
          continue;
        }
        if (URL_ATTRIBUTES.has(local)) {
          const cleaned = sanitizeUrlValue(attribute.value);
          if (cleaned.external) external = true;
          if (cleaned.value === null) element.removeAttributeNode(attribute);
          else attribute.value = cleaned.value;
        }
      }

      if (tag === 'style') {
        const cleaned = sanitizeCss(element.textContent || '');
        if (cleaned.external) external = true;
        if (cleaned.value.trim()) element.textContent = cleaned.value;
        else element.remove();
        return;
      }
      for (const child of [...element.childNodes]) {
        if (child.nodeType === 1) visit(child);
        else if (child.nodeType === 7) child.remove();
      }
    };
    visit(root);
    return { svg: new XMLSerializer().serializeToString(root), external };
  }

  function hasExternalImageSource(source) {
    // UX hint only; the strict CSP is the actual network boundary.
    return /@\{\s*[^}]*\bimg\s*:/i.test(source) || /<img\b/i.test(source);
  }

  let renderSequence = 0;

  async function render(request) {
    if (!request || typeof request.source !== 'string') throw new RendererFailure('invalid_source', 'The render request is invalid.');
    if (request.source.length > MAX_SOURCE_BYTES) throw new RendererFailure('invalid_source', 'The Mermaid source exceeds the renderer limit.');    if (hasExternalImageSource(request.source)) {
      throw new RendererFailure('unsupported_external_images', 'Mermaid images from the network are not available in offline mode.');
    }
    if (!window.mermaid || typeof window.mermaid.render !== 'function') {
      throw new RendererFailure('internal_error', 'The bundled Mermaid renderer did not load.');
    }

    const themeVariables = {};
    const variables = request.theme && request.theme.variables;
    if (variables && typeof variables === 'object') {
      for (const [key, value] of Object.entries(variables).slice(0, 256)) {
        if (typeof value === 'string' || typeof value === 'boolean') themeVariables[key] = value;
      }
    }

    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'base',
      look: 'classic',
      htmlLabels: false,
      themeVariables,
      fontFamily: '"Inter","Adwaita Sans","Cantarell",system-ui,sans-serif',
      flowchart: { htmlLabels: false, curve: 'basis', nodeSpacing: 36, rankSpacing: 46, padding: 16, diagramPadding: 8, useMaxWidth: true },
      sequence: { useMaxWidth: true },
      gantt: { fontSize: 14, sectionFontSize: 14, barHeight: 24, barGap: 8 }
    });

    let rendered;
    try {
      rendered = await window.mermaid.render(`folio-mermaid-${++renderSequence}`, request.source);
    } catch (error) {
      const message = boundedMessage(error);
      const code = /image|img|load|fetch/i.test(message) ? 'unsupported_external_images' : 'render_failed';
      throw new RendererFailure(code, message);
    }
    const markup = typeof rendered === 'string' ? rendered : rendered && rendered.svg;
    if (typeof markup !== 'string' || !markup.trim()) {
      throw new RendererFailure('render_failed', 'Mermaid returned no SVG.');
    }
    const sanitized = sanitizeSvg(markup);
    if (sanitized.external) {
      throw new RendererFailure('unsupported_external_images', 'Mermaid images from the network are not available in offline mode.');
    }
    if (sanitized.svg.length > MAX_SVG_BYTES) {
      throw new RendererFailure('render_failed', 'The diagram is too large to display safely.');
    }
    return { svg: sanitized.svg };
  }

  let active = null;
  let activeToken = 0;
  const queue = [];
  const cancelled = new Set();

  function rememberCancelled(id) {
    cancelled.add(id);
    while (cancelled.size > 256) cancelled.delete(cancelled.values().next().value);
  }

  function releaseActive(id, token) {
    if (!active || active.id !== id || active.token !== token) return;
    rememberCancelled(id);
    clearTimeout(active.timer);
    active = null;
    pump();
  }

  function enqueue(request) {
    if (!request || typeof request !== 'object') return;
    const id = request.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
    if ((active && active.id === id) || queue.some(item => item.id === id)) return;
    if (queue.length >= 32) return;
    if (cancelled.delete(id)) return;
    queue.push(request);
    pump();
  }

  function cancel(id) {
    if (typeof id !== 'string') return;
    const index = queue.findIndex(item => item.id === id);
    if (index >= 0) queue.splice(index, 1);
    if (active && active.id === id) {
      // Mermaid has no cancellation API. Native recycling terminates this
      // webview; retain a short deadline so a stalled render cannot block the
      // queue if native recovery is delayed.
      rememberCancelled(id);
      clearTimeout(active.timer);
      const token = active.token;
      active.timer = setTimeout(() => releaseActive(id, token), CANCELLED_ACTIVE_GRACE);
    }
  }

  async function submitResult(id, result) {
    const tauri = window.__TAURI__;
    if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
      await tauri.core.invoke('mermaid_render_result', { id, result });
    }
  }

  async function pump() {
    if (active) return;
    const request = queue.shift();
    if (!request) return;
    const token = ++activeToken;
    const timer = setTimeout(() => releaseActive(request.id, token), ACTIVE_RENDER_TIMEOUT);
    active = { id: request.id, token, timer };
    try {
      const result = await render(request);
      if (!cancelled.has(request.id)) {
        try { await submitResult(request.id, result); } catch {}
      }
    } catch (error) {
      if (!cancelled.has(request.id)) {
        const code = error && error.code ? error.code : 'render_failed';
        try {
          await submitResult(request.id, { error: { code: ALLOWED_ERROR_CODES.has(code) ? code : 'render_failed', message: boundedMessage(error) } });
        } catch {}
      }
    } finally {
      if (active && active.token === token) {
        clearTimeout(active.timer);
        active = null;
      }
      cancelled.delete(request.id);
      pump();
    }
  }

  const api = Object.freeze({
    version: 1,
    sanitizeSvg,
    renderRequest: request => render(request)
  });
  window.FolioMermaidRenderer = api;

  const tauri = window.__TAURI__;
  if (tauri && tauri.event && typeof tauri.event.listen === 'function' && tauri.core && typeof tauri.core.invoke === 'function') {
    (async () => {
      try {
        await tauri.event.listen('mermaid-render-request', event => enqueue(event && event.payload));
        await tauri.event.listen('mermaid-render-cancel', event => cancel(event && event.payload && event.payload.id));
        await tauri.core.invoke('mermaid_renderer_ready');
      } catch {}
    })();
  }
})();
