(() => {
  const preview = document.getElementById('preview');
  if (!preview) return;
  let dialog, viewport, canvas, zoomStatus, zoomIn, zoomOut;
  let origin = null, returnFocus = null, drawing = null, size = null;
  let scale = 1, fitting = true, sequence = 0;
  const MIN_SCALE = .05, MAX_SCALE = 4, GUTTER = 48;

  function renderedSvg(host) {
    if (!host?.matches('.mermaid-host') || !host.isConnected) return null;
    if (host.dataset.diagramState && host.dataset.diagramState !== 'rendered') return null;
    return host.querySelector('svg');
  }

  function enhance(host) {
    if (!host?.matches('.mermaid-host')) return;
    const action = host.querySelector(':scope > .diagram-expand');
    if (!renderedSvg(host)) { action?.remove(); return; }
    if (action) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'diagram-expand';
    button.contentEditable = 'false'; button.title = 'Expand diagram';
    button.setAttribute('aria-label', 'Expand diagram');
    button.setAttribute('aria-haspopup', 'dialog');
    host.append(button);
  }

  function close() { if (dialog?.open) dialog.close(); }

  function applyScale(nextScale, fit = false) {
    if (!drawing) return;
    fitting = fit;
    scale = fit ? nextScale : Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    drawing.style.width = `${size.width * scale}px`;
    drawing.style.height = `${size.height * scale}px`;
    canvas.style.width = `${size.width * scale + GUTTER}px`;
    canvas.style.height = `${size.height * scale + GUTTER}px`;
    zoomStatus.textContent = `${Math.round(scale * 100)}%`;
    zoomIn.disabled = scale >= MAX_SCALE;
    zoomOut.disabled = scale <= MIN_SCALE;
    viewport.scrollTo(0, 0);
  }

  function fit() {
    if (!drawing) return;
    applyScale(Math.min(1, Math.max(1, viewport.clientWidth - GUTTER) / size.width,
      Math.max(1, viewport.clientHeight - GUTTER) / size.height), true);
  }

  function createViewer() {
    dialog = document.createElement('dialog');
    dialog.className = 'diagram-viewer'; dialog.id = 'diagram-viewer';
    dialog.setAttribute('aria-label', 'Expanded diagram');
    dialog.setAttribute('aria-modal', 'true');
    const toolbar = document.createElement('div'); toolbar.className = 'diagram-viewer-toolbar';
    const title = document.createElement('h2'); title.textContent = 'Diagram';
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
    const closeButton = button('Close diagram', 'Close', close); closeButton.autofocus = true;
    controls.append(button('Fit diagram', 'Fit', fit), button('Actual size', '100%', () => applyScale(1)),
      zoomOut, zoomStatus, zoomIn, closeButton);
    toolbar.append(title, controls);
    viewport = document.createElement('div'); viewport.className = 'diagram-viewer-viewport'; viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', 'Diagram. Use arrow keys to scroll.');
    canvas = document.createElement('div'); canvas.className = 'diagram-viewer-canvas';
    viewport.append(canvas); dialog.append(toolbar, viewport); document.body.append(dialog);
    dialog.addEventListener('close', () => {
      // Native close events are queued. A newer open already owns this state.
      if (dialog.open) return;
      canvas.replaceChildren(); drawing = null; size = null; origin = null;
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
    const svg = renderedSvg(host);
    if (!svg) return;
    if (!dialog) createViewer();
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
    dialog.showModal(); fit();
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
    event.preventDefault(); event.stopPropagation(); open(button.closest('.mermaid-host'), button);
  }, true);

  // Inspect only changed diagram hosts and newly inserted subtrees. Typing in
  // an unrelated paragraph never scans or rebuilds the document's diagrams.
  new MutationObserver(mutations => {
    if (origin && !origin.isConnected) close();
    const changed = new Set();
    for (const mutation of mutations) {
      const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
      const host = target?.closest('.mermaid-host');
      if (host) changed.add(host);
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches('.mermaid-host')) changed.add(node);
        for (const child of node.querySelectorAll('.mermaid-host')) changed.add(child);
      }
      // A code node can change its language and cease being a diagram.
      if (mutation.type === 'attributes' && target?.querySelector(':scope > .diagram-expand') && !host) {
        target.querySelector(':scope > .diagram-expand').remove();
      }
    }
    for (const host of changed) enhance(host);
  }).observe(preview, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-diagram-state', 'class'] });
  for (const host of preview.querySelectorAll('.mermaid-host')) enhance(host);
})();
