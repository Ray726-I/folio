(() => {
  const preview = document.getElementById('preview');
  if (!preview) return;
  let dialog, viewport, canvas, zoomStatus, zoomIn, zoomOut, title, fitButton, closeButton;
  let origin = null, returnFocus = null, drawing = null, size = null, originalImage = null, originalImageSrc = null;
  let scale = 1, fitting = true, sequence = 0, viewerKind = 'diagram', mathFontSize = 16, nativePinch = null;
  const MIN_SCALE = .05, MAX_SCALE = 4, GUTTER = 48;

  function renderedSvg(host) {
    if (!host?.matches('.mermaid-host') || !host.isConnected) return null;
    if (host.dataset.diagramState && host.dataset.diagramState !== 'rendered') return null;
    return host.querySelector('svg');
  }
  function renderedImage(host) {
    if (!host?.matches('.image-widget') || !host.isConnected) return null;
    const image = host.querySelector('img');
    return image?.complete && image.naturalWidth > 0 ? image : null;
  }
  const hostSelector = '.mermaid-host, .image-widget, .math-block, .tableWrapper';
  function renderedContent(host) {
    if (!host?.isConnected) return null;
    if (host.matches('.math-block')) return host.matches('.math-formula') ? host : host.querySelector('.math-formula');
    if (host.matches('.tableWrapper')) return host.querySelector('table');
    return null;
  }

  function enhance(host) {
    if (!host?.matches(hostSelector)) return;
    const image = host.matches('.image-widget');
    const kind = image ? 'image' : host.matches('.math-block') ? 'math' : host.matches('.tableWrapper') ? 'table' : 'diagram';
    const action = host.querySelector(':scope > .diagram-expand');
    if (!(image ? renderedImage(host) : kind === 'diagram' ? renderedSvg(host) : renderedContent(host))) { action?.remove(); return; }
    if (action) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'diagram-expand';
    button.contentEditable = 'false'; button.title = `Expand ${kind}`;
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-haspopup', 'dialog');
    host.append(button);
  }

  function close() { if (dialog?.open) dialog.close(); }

  function viewportAnchor(anchor) {
    if (!viewport) return { x: 0, y: 0 };
    const width = viewport.clientWidth, height = viewport.clientHeight;
    if (!anchor) return { x: width / 2, y: height / 2 };
    return {
      x: Math.max(0, Math.min(Math.max(0, width - 1), anchor.x)),
      y: Math.max(0, Math.min(Math.max(0, height - 1), anchor.y)),
    };
  }

  function pointerAnchor(event) {
    if (!viewport) return { x: 0, y: 0 };
    const bounds = viewport.getBoundingClientRect();
    const x = (typeof event?.clientX === 'number' ? event.clientX : bounds.left + bounds.width / 2) - bounds.left;
    const y = (typeof event?.clientY === 'number' ? event.clientY : bounds.top + bounds.height / 2) - bounds.top;
    return viewportAnchor({ x, y });
  }

  // WebKitGTK reports pinch coordinates as fractions of the webview, not CSS
  // client coordinates. Map them through the CSS viewport so page zoom and
  // device scale do not move the anchor.
  function fractionAnchor(detail) {
    if (!viewport || typeof detail?.xFraction !== 'number' || typeof detail?.yFraction !== 'number') return null;
    const width = window.innerWidth || document.documentElement.clientWidth || 0;
    const height = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!width || !height) return null;
    return pointerAnchor({ clientX: detail.xFraction * width, clientY: detail.yFraction * height });
  }

  function applyScale(nextScale, fit = false, anchor = null) {
    if (!drawing) return;
    // Capture the content point under the anchor before layout changes so
    // zooming keeps the viewport center (buttons) or the pointer (wheel,
    // pinch) over the same diagram content instead of jumping to the origin.
    let anchorClientX = 0, anchorClientY = 0, offsetX = 0, offsetY = 0;
    let viewportRect = null;
    if (!fit && viewport && drawing.isConnected) {
      const centered = viewportAnchor(anchor);
      viewportRect = viewport.getBoundingClientRect();
      anchorClientX = viewportRect.left + centered.x;
      anchorClientY = viewportRect.top + centered.y;
      const drawingRect = drawing.getBoundingClientRect();
      offsetX = anchorClientX - drawingRect.left;
      offsetY = anchorClientY - drawingRect.top;
    }
    const oldScale = scale;
    fitting = fit;
    scale = fit ? nextScale : Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    drawing.style.width = `${size.width * scale}px`;
    drawing.style.height = `${size.height * scale}px`;
    const scaledContent = drawing.querySelector(':scope > .diagram-viewer-scaled');
    if (scaledContent && viewerKind === 'math') {
      scaledContent.style.transform = '';
      scaledContent.style.width = `${size.width * scale}px`;
      scaledContent.style.fontSize = `${mathFontSize * scale}px`;
    } else if (scaledContent) scaledContent.style.transform = `scale(${scale})`;
    canvas.style.width = `${size.width * scale + GUTTER}px`;
    canvas.style.height = `${size.height * scale + GUTTER}px`;
    zoomStatus.textContent = `${Math.round(scale * 100)}%`;
    zoomIn.disabled = scale >= MAX_SCALE;
    zoomOut.disabled = scale <= MIN_SCALE;
    if (fit) {
      viewport.scrollTo(0, 0);
      return;
    }
    if (viewportRect && oldScale) {
      const factor = scale / oldScale;
      if (factor !== 1) {
        // The drawing origin can shift when small content is flex-centered,
        // so measure after layout and move scroll to keep the same content
        // point under the anchor.
        const updated = drawing.getBoundingClientRect();
        const desiredLeft = anchorClientX - offsetX * factor;
        const desiredTop = anchorClientY - offsetY * factor;
        viewport.scrollLeft += updated.left - desiredLeft;
        viewport.scrollTop += updated.top - desiredTop;
      }
    }
  }

  function fit() {
    if (!drawing) return;
    const maxFit = viewerKind === 'math' || viewerKind === 'diagram' ? 2 : 1;
    const widthFit = Math.max(1, viewport.clientWidth - GUTTER) / size.width;
    const heightFit = Math.max(1, viewport.clientHeight - GUTTER) / size.height;
    applyScale(Math.min(maxFit, widthFit, viewerKind === 'table' ? Infinity : heightFit), true);
  }
  function openAtReadableSize() {
    fit();
    const minimum = viewerKind === 'math' ? 1.5 : viewerKind === 'diagram' ? 1 : 0;
    if (scale < minimum) applyScale(minimum);
  }

  function createViewer() {
    dialog = document.createElement('dialog');
    dialog.className = 'diagram-viewer'; dialog.id = 'diagram-viewer';
    dialog.setAttribute('aria-label', 'Expanded diagram');
    dialog.setAttribute('aria-modal', 'true');
    const toolbar = document.createElement('div'); toolbar.className = 'diagram-viewer-toolbar';
    title = document.createElement('h2'); title.textContent = 'Diagram';
    const controls = document.createElement('div'); controls.className = 'diagram-viewer-controls';
    const button = (label, text, action) => {
      const control = document.createElement('button'); control.type = 'button';
      control.className = 'button'; control.textContent = text;
      control.setAttribute('aria-label', label); control.title = label;
      control.addEventListener('click', action); return control;
    };
    zoomStatus = document.createElement('output'); zoomStatus.className = 'diagram-viewer-zoom';
    zoomStatus.setAttribute('aria-label', 'Diagram zoom'); zoomStatus.setAttribute('aria-live', 'polite');
    zoomOut = button('Zoom out', '−', () => applyScale(scale / 1.25));
    zoomIn = button('Zoom in', '+', () => applyScale(scale * 1.25));
    closeButton = button('Close diagram', 'Close', close); closeButton.autofocus = true;
    fitButton = button('Fit diagram', 'Fit', fit);
    controls.append(fitButton, button('Actual size', '100%', () => applyScale(1)),
      zoomOut, zoomStatus, zoomIn, closeButton);
    toolbar.append(title, controls);
    viewport = document.createElement('div'); viewport.className = 'diagram-viewer-viewport'; viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', 'Diagram. Use arrow keys to scroll.');
    canvas = document.createElement('div'); canvas.className = 'diagram-viewer-canvas';
    viewport.append(canvas); dialog.append(toolbar, viewport); document.body.append(dialog);
    // Trackpad pinch and Ctrl+scroll zoom the expanded diagram. Ordinary
    // scrolling is untouched, buttons keep the viewport center under the
    // same content, and wheel/pinch keep the pointer over the same content.
    // Safari/WKWebView pinch fires gesture events that can arrive alongside
    // a synthesized Ctrl+wheel; the gesture flag suppresses the duplicate.
    let gestureActive = false, gestureBase = 1, gestureAnchor = null;
    const endGesture = () => { gestureActive = false; gestureAnchor = null; };
    viewport.addEventListener('wheel', event => {
      if (!dialog.open || !drawing) return;
      if (gestureActive) { event.preventDefault(); return; }
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      let delta = event.deltaY;
      if (event.deltaMode === 1) delta *= 16;
      else if (event.deltaMode === 2) delta *= viewport.clientHeight || 400;
      if (!delta && event.deltaX) {
        delta = event.deltaX;
        if (event.deltaMode === 1) delta *= 16;
        else if (event.deltaMode === 2) delta *= viewport.clientHeight || 400;
      }
      if (!delta) return;
      applyScale(scale * Math.exp(-delta / 300), false, pointerAnchor(event));
    }, { passive: false });
    const startGesture = event => {
      if (!dialog.open || !drawing) return;
      event.preventDefault();
      gestureActive = true;
      gestureBase = scale;
      gestureAnchor = pointerAnchor(event);
    };
    const updateGesture = event => {
      if (!dialog.open || !drawing) return;
      event.preventDefault();
      if (!gestureActive) {
        gestureActive = true;
        gestureBase = scale;
        gestureAnchor = pointerAnchor(event);
      }
      const pinch = typeof event.scale === 'number' && event.scale > 0 ? event.scale : 1;
      const anchor = typeof event.clientX === 'number' && typeof event.clientY === 'number'
        ? pointerAnchor(event)
        : gestureAnchor;
      applyScale(gestureBase * pinch, false, anchor);
    };
    viewport.addEventListener('gesturestart', startGesture, { passive: false });
    viewport.addEventListener('gesturechange', updateGesture, { passive: false });
    viewport.addEventListener('gestureend', endGesture);
    viewport.addEventListener('gesturecancel', endGesture);
    // Linux pinch arrives from the native GTK event router. It is ignored
    // unless this modal is open, so pinching the document never zooms the page.
    nativePinch = detail => {
      if (!dialog.open || !drawing || !detail) return;
      const phase = detail.phase;
      if (phase === 'end' || phase === 'cancel') { endGesture(); return; }
      if (phase !== 'start' && phase !== 'change') return;
      const pinch = typeof detail.scale === 'number' && detail.scale > 0 ? detail.scale : 1;
      const anchor = fractionAnchor(detail);
      if (phase === 'start') {
        gestureActive = true;
        gestureBase = scale;
        gestureAnchor = anchor || pointerAnchor(null);
        return;
      }
      if (!gestureActive) {
        // A change can arrive without a begin when the viewer opened mid-gesture.
        gestureActive = true;
        gestureBase = scale / pinch;
      }
      gestureAnchor = anchor || gestureAnchor || pointerAnchor(null);
      applyScale(gestureBase * pinch, false, gestureAnchor);
    };
    window.addEventListener('folio:diagram-pinch', event => { if (nativePinch) nativePinch(event.detail); });
    dialog.addEventListener('close', () => {
      endGesture();
      // Native close events are queued. A newer open already owns this state.
      if (dialog.open) return;
      canvas.replaceChildren(); drawing = null; size = null; origin = null; originalImage = null; originalImageSrc = null;
      const previous = returnFocus; returnFocus = null;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    });
    // Native dialogs retarget backdrop events to the dialog element. Check
    // coordinates too: blank space inside the panel is not the backdrop.
    const outsidePanel = event => {
      const bounds = dialog.getBoundingClientRect();
      return event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom;
    };
    let backdropPress = false;
    dialog.addEventListener('pointerdown', event => {
      backdropPress = event.button === 0 && event.target === dialog && outsidePanel(event);
    });
    dialog.addEventListener('pointercancel', () => { backdropPress = false; });
    dialog.addEventListener('click', event => {
      const dismiss = backdropPress && event.target === dialog && outsidePanel(event);
      backdropPress = false;
      if (dismiss) { event.preventDefault(); event.stopPropagation(); close(); return; }
      // A diagram is a static projection here; SVG links must not navigate.
      if (event.target.closest('a')) event.preventDefault();
      event.stopPropagation();
    });
    // Keep application-wide shortcuts from acting behind the native modal.
    dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll('button:not(:disabled), [tabindex="0"]')];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    new ResizeObserver(() => { if (dialog.open && fitting) fit(); }).observe(viewport);
  }

  function open(host, button) {
    const svg = renderedSvg(host), image = renderedImage(host), content = renderedContent(host), source = svg || image || content;
    if (!source) return;
    if (!dialog) createViewer();
    const kind = image ? 'image' : host.matches('.math-block') ? 'math' : host.matches('.tableWrapper') ? 'table' : 'diagram';
    viewerKind = kind;
    const label = kind[0].toUpperCase() + kind.slice(1);
    dialog.setAttribute('aria-label', `Expanded ${kind}`); title.textContent = label;
    fitButton.setAttribute('aria-label', `Fit ${kind}`); fitButton.title = `Fit ${kind}`;
    closeButton.setAttribute('aria-label', `Close ${kind}`); closeButton.title = `Close ${kind}`;
    zoomStatus.setAttribute('aria-label', `${label} zoom`);
    viewport.setAttribute('aria-label', `${label}. Use arrow keys to scroll.`);
    if (image) {
      size = { width: image.naturalWidth, height: image.naturalHeight };
      drawing = image.cloneNode(false); drawing.style.maxWidth = 'none'; drawing.style.maxHeight = 'none';
      originalImage = image; originalImageSrc = image.currentSrc || image.src;
      origin = host; returnFocus = button; canvas.replaceChildren(drawing);
      dialog.showModal(); openAtReadableSize(); return;
    }
    originalImage = null; originalImageSrc = null;
    if (content) {
      if (kind === 'math') mathFontSize = parseFloat(getComputedStyle(content).fontSize) || 16;
      const rect = content.getBoundingClientRect();
      const math = kind === 'math' ? content.querySelector('.katex-html') : null;
      const mathRect = math?.getBoundingClientRect();
      const parts = math ? [...math.querySelectorAll(':scope > .katex-base')].map(node => node.getBoundingClientRect()).filter(box => box.width > 0) : [];
      const bounds = parts.reduce((acc, box) => ({ left: Math.min(acc.left, box.left), right: Math.max(acc.right, box.right) }), { left: Infinity, right: -Infinity });
      const formulaWidth = parts.length ? bounds.right - bounds.left : 0;
      size = mathRect && mathRect.width > 0
        ? { width: Math.max(1, formulaWidth || math.scrollWidth), height: Math.max(math.scrollHeight, mathRect.height) }
        : { width: Math.max(1, content.scrollWidth, rect.width), height: Math.max(1, content.scrollHeight, rect.height) };
      const copy = content.cloneNode(true);
      for (const element of [copy, ...copy.querySelectorAll('*')]) {
        element.removeAttribute('id'); element.removeAttribute('contenteditable'); element.removeAttribute('tabindex');
        element.classList.remove('selectedCell');
        if (element.matches('input, button, select, textarea')) element.disabled = true;
      }
      copy.querySelectorAll('.diagram-expand').forEach(element => element.remove());
      drawing = document.createElement('div'); drawing.className = 'markdown diagram-viewer-content';
      const inner = document.createElement('div'); inner.className = 'diagram-viewer-scaled';
      inner.style.width = `${size.width}px`; inner.append(copy); drawing.append(inner);
      origin = host; returnFocus = button; canvas.replaceChildren(drawing);
      dialog.showModal();
      if (kind === 'table') {
        size.width = Math.max(size.width, viewport.clientWidth - GUTTER);
        inner.style.width = `${size.width}px`;
        drawing.style.width = `${size.width}px`;
        size.width = Math.max(size.width, copy.scrollWidth);
        inner.style.width = `${size.width}px`;
        size.height = Math.max(1, copy.getBoundingClientRect().height);
      }
      openAtReadableSize(); return;
    }
    const viewBox = svg.viewBox?.baseVal, rect = svg.getBoundingClientRect();
    size = { width: viewBox?.width || svg.width?.baseVal?.value || rect.width || 300,
      height: viewBox?.height || svg.height?.baseVal?.value || rect.height || 150 };
    drawing = svg.cloneNode(true);
    // Isolate fragment references and Mermaid's scoped style selectors from
    // the still-visible source SVG. No source text or renderer is involved.
    const prefix = `folio-expanded-${++sequence}-`, ids = new Map();
    for (const node of [drawing, ...drawing.querySelectorAll('[id]')]) {
      if (node.id) { ids.set(node.id, prefix + node.id); node.id = prefix + node.id; }
    }
    // Tokenize references once, then use map lookups. Iterating all IDs for
    // every attribute is quadratic on large diagrams and also confuses hex
    // colors with fragment references when a node ID happens to be "fff".
    const fragmentUrl = /url\(\s*(["']?)#([^"'()\s]+)\1\s*\)/gi;
    const selectorId = /#((?:\\[0-9a-fA-F]{1,6}\s?|\\[^\r\n\f]|[\w\u0080-\uFFFF-])+)/g;
    const rewriteUrls = value => value.replace(fragmentUrl, (original, quote, id) =>
      ids.has(id) ? `url(${quote}#${ids.get(id)}${quote})` : original);
    const rewriteSelectors = value => value.replace(selectorId, (original, token) => {
      const id = token.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([^\r\n\f])/g, (_, hex, character) =>
        hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : character);
      return ids.has(id) ? `#${CSS.escape(ids.get(id))}` : original;
    });
    const rewriteCss = value => rewriteUrls(value).replace(/(^|[{}])([^{}]*)(?=\{)/g,
      (_, boundary, selector) => boundary + (/^\s*@/.test(selector) ? selector : rewriteSelectors(selector)));
    for (const node of [drawing, ...drawing.querySelectorAll('*')]) {
      for (const attr of [...node.attributes]) {
        let value = attr.value;
        if (attr.name === 'aria-labelledby' || attr.name === 'aria-describedby') {
          value = value.split(/\s+/).map(id => ids.get(id) || id).join(' ');
        } else if (attr.localName === 'href' && value.startsWith('#') && ids.has(value.slice(1))) {
          value = `#${ids.get(value.slice(1))}`;
        } else if (value.includes('url(')) value = rewriteUrls(value);
        if (value !== attr.value) node.setAttributeNS(attr.namespaceURI, attr.name, value);
      }
      if (node.tagName.toLowerCase() === 'style') node.textContent = rewriteCss(node.textContent);
    }
    if (!drawing.getAttribute('viewBox')) drawing.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
    drawing.style.maxWidth = 'none'; drawing.style.maxHeight = 'none';
    drawing.removeAttribute('tabindex');
    for (const node of drawing.querySelectorAll('a, [tabindex]')) node.setAttribute('tabindex', '-1');
    origin = host; returnFocus = button; canvas.replaceChildren(drawing);
    dialog.showModal(); openAtReadableSize();
  }

  // The native layer owns GTK touchpad pinch so WebKitGTK cannot page-zoom.
  // Re-dispatch it as a DOM event; the viewer decides whether it is relevant.
  if (window.__TAURI__ && typeof listen === 'function') {
    listen('diagram-pinch', event => {
      window.dispatchEvent(new CustomEvent('folio:diagram-pinch', { detail: event?.payload }));
    }).catch(() => {});
  }

  // Capture the action before ProseMirror can turn the click into a document
  // selection. The node view already ignores mutations outside its source.
  preview.addEventListener('pointerdown', event => {
    if (event.target.closest('.diagram-expand')) event.stopPropagation();
  }, true);
  preview.addEventListener('keydown', event => {
    if (event.target.closest('.diagram-expand')) event.stopPropagation();
  }, true);
  preview.addEventListener('click', event => {
    const button = event.target.closest('.diagram-expand');
    if (!button) return;
    event.preventDefault(); event.stopPropagation(); open(button.closest(hostSelector), button);
  }, true);

  for (const eventName of ['load', 'error']) preview.addEventListener(eventName, event => {
    if (event.target instanceof HTMLImageElement) enhance(event.target.closest('.image-widget'));
  }, true);

  // Inspect only changed diagram hosts and newly inserted subtrees. Typing in
  // an unrelated paragraph never scans or rebuilds the document's diagrams.
  new MutationObserver(mutations => {
    if (origin && (!origin.isConnected || (originalImage && (!originalImage.isConnected || (originalImage.currentSrc || originalImage.src) !== originalImageSrc)))) close();
    const changed = new Set();
    for (const mutation of mutations) {
      const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
      const host = target?.closest(hostSelector);
      if (host) changed.add(host);
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches(hostSelector)) changed.add(node);
        for (const child of node.querySelectorAll(hostSelector)) changed.add(child);
      }
      // A code node can change its language and cease being a diagram.
      if (mutation.type === 'attributes' && target?.querySelector(':scope > .diagram-expand') && !host) {
        target.querySelector(':scope > .diagram-expand').remove();
      }
    }
    for (const host of changed) enhance(host);
  }).observe(preview, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-diagram-state', 'class', 'src'] });
  for (const host of preview.querySelectorAll(hostSelector)) enhance(host);
})();
