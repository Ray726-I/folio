'use strict';
// Debug-only probe injected into the real Folio main/renderer webviews by
// src/renderer.rs when FOLIO_NATIVE_PROBE=1. It exercises the actual Tauri
// command registry, ACL, caller-label gates, and renderer transport. It is not
// bundled or executed in release builds.
(() => {
  if (window.__folioNativeProbe) return;

  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const messageOf = error => String(error && error.message ? error.message : error || '').slice(0, 300);

  function bridge() {
    return window.__TAURI__ && window.__TAURI__.core &&
      typeof window.__TAURI__.core.invoke === 'function' ? window.__TAURI__ : null;
  }

  async function waitForBridge() {
    for (let index = 0; index < 200; index += 1) {
      const current = bridge();
      if (current) return current;
      await sleep(50);
    }
    throw new Error('Tauri bridge unavailable');
  }

  // ACL and native gate rejections use these phrases. A command body that ran
  // and returned its own validation error must not count as a denial.
  function looksDenied(message) {
    const lower = message.toLowerCase();
    return ['not allowed', 'only available', 'not available', 'denied', 'permission', 'acl']
      .some(term => lower.includes(term));
  }

  async function attempt(tauri, command, args) {
    try {
      await tauri.core.invoke(command, args);
      return { denied: false, rejected: false, message: '' };
    } catch (error) {
      const message = messageOf(error);
      return { denied: looksDenied(message), rejected: true, message };
    }
  }

  async function allowed(tauri, command, args, expected) {
    try {
      await tauri.core.invoke(command, args);
      return { allowed: true, message: '' };
    } catch (error) {
      const message = messageOf(error);
      return {
        allowed: typeof expected === 'string' && message.toLowerCase().includes(expected),
        message
      };
    }
  }

  function publish(result) {
    window.__folioProbeResult = result;
  }

  function reset() {
    window.__folioProbeResult = null;
    window.__folioProbeEvents = [];
  }

  async function mainPrepare() {
    reset();
    const tauri = await waitForBridge();
    const data = window.__folioProbeData || {};
    await tauri.event.listen('mermaid-render-result', event => {
      window.__folioProbeEvents.push(event && event.payload);
    });

    let doc = null;
    let openError = '';
    try {
      doc = await tauri.core.invoke('open_document', { path: data.mainPath });
    } catch (error) {
      openError = messageOf(error);
    }

    let link = '';
    let linkError = '';
    try {
      link = await tauri.core.invoke('resolve_document_link', { link: 'child.md' });
    } catch (error) {
      linkError = messageOf(error);
    }

    const resultDenied = await attempt(tauri, 'mermaid_render_result', {
      id: 'probe-main-denied',
      result: { error: { code: 'render_failed', message: 'probe' } }
    });
    const readyDenied = await attempt(tauri, 'mermaid_renderer_ready', {});

    const pass = !!doc && doc.path === data.mainPath &&
      typeof link === 'string' && link.startsWith(data.mainDir) &&
      resultDenied.denied && readyDenied.denied;
    publish({
      phase: 'main-prepared',
      docPath: doc && doc.path,
      openError,
      link,
      linkError,
      resultDenied,
      readyDenied,
      pass
    });
  }

  async function rendererProbe() {
    reset();
    const tauri = await waitForBridge();
    const data = window.__folioProbeData || {};
    const attempts = {};
    const cases = [
      ['bootstrap', {}],
      ['open_document', { path: data.otherPath }],
      ['new_document', {}],
      ['open_folder', { path: data.otherDir }],
      ['browse_directory', { path: data.otherDir }],
      ['path_is_directory', { path: data.otherDir }],
      ['render_markdown', { content: '# Probe', remoteImages: false }],
      ['set_task_checked', { content: '- [ ] Probe', taskIndex: 0, checked: true }],
      ['document_changed', {}],
      ['resolve_document_link', { link: 'child.md' }],
      ['set_title', { name: 'probe', dirty: false }],
      ['set_window_zoom', { scale: 1.0 }],
      ['open_link', { url: 'javascript:alert(1)' }],
      ['mermaid_render_request', {
        request: {
          id: 'renderer-denied',
          source: 'flowchart TD\n A-->B',
          theme: { variables: {} }
        }
      }],
      ['mermaid_render_cancel', { id: 'renderer-denied' }]
    ];

    for (const [command, args] of cases) {
      attempts[command] = await attempt(tauri, command, args);
    }

    // Only attempt a write while the document-denial probes passed, so a
    // broken gate cannot open a save dialog. The temp file is checked from
    // Rust after the run.
    if (attempts.open_document.denied && attempts.new_document.denied) {
      attempts.save_document = await attempt(tauri, 'save_document', {
        content: '# RENDERER MUTATION\n',
        saveAs: false,
        force: true
      });
    } else {
      attempts.save_document = {
        denied: false,
        rejected: false,
        message: 'skipped because the document denial probe failed'
      };
    }

    // These two commands are intentionally allowed only to this webview.
    const resultAllowed = await allowed(tauri, 'mermaid_render_result', {
      id: 'probe-not-outstanding',
      result: { error: { code: 'render_failed', message: 'probe' } }
    }, 'not outstanding');
    const readyAllowed = await allowed(tauri, 'mermaid_renderer_ready', {});

    const expected = cases.map(entry => entry[0]).concat('save_document');
    const pass = expected.every(command => attempts[command] && attempts[command].denied) &&
      resultAllowed.allowed && readyAllowed.allowed;
    publish({ phase: 'renderer', attempts, resultAllowed, readyAllowed, pass });
  }

  async function mainFinal() {
    const tauri = await waitForBridge();
    const data = window.__folioProbeData || {};

    let link = '';
    let linkError = '';
    try {
      link = await tauri.core.invoke('resolve_document_link', { link: 'child.md' });
    } catch (error) {
      linkError = messageOf(error);
    }
    const stillOriginal = typeof link === 'string' && link.startsWith(data.mainDir);

    let submitted = false;
    let submitError = '';
    const diagrams = [
      ['native-flow', 'flowchart TD\n A-->B'],
      ['native-sequence', 'sequenceDiagram\n Alice->>Bob: Hello\n Bob-->>Alice: Hi'],
      ['native-pie', 'pie title Pets\n "Dogs": 3\n "Cats": 2'],
      ['native-class', 'classDiagram\n class Animal\n Animal : +String name']
    ];
    const results = [];
    for (const [id, source] of diagrams) {
      let sent = false;
      try {
        await tauri.core.invoke('mermaid_render_request', {
          request: {
            id,
            source,
            theme: { variables: { background: '#ffffff' } }
          }
        });
        sent = true;
      } catch (error) {
        if (!submitError) submitError = messageOf(error);
      }
      const deadline = Date.now() + 20000;
      let event = null;
      while (Date.now() < deadline) {
        event = (window.__folioProbeEvents || []).find(item => item && item.id === id) || null;
        if (event) break;
        await sleep(100);
      }
      const ok = !!event && event.ok === true && event.sanitized === true &&
        typeof event.svg === 'string' && event.svg.indexOf('<svg') === 0;
      results.push({
        id,
        submitted: sent,
        ok,
        sanitized: !!event && event.sanitized === true,
        svgLength: event && event.svg ? event.svg.length : 0,
        code: event && event.error ? event.error.code : null,
        message: event && event.error ? String(event.error.message || '').slice(0, 300) : ''
      });
      if (sent) submitted = true;
    }

    const roundtrip = results.every(result => result.submitted && result.ok);
    const pass = stillOriginal && submitted && roundtrip;
    publish({
      phase: 'main-final',
      link,
      linkError,
      stillOriginal,
      submitted,
      submitError,
      results,
      roundtrip,
      pass
    });
  }

  async function rendererInstallHang() {
    const tauri = await waitForBridge();
    window.__folioProbeSeen = null;
    window.__folioHangReady = false;
    await tauri.event.listen('mermaid-render-request', event => {
      window.__folioProbeSeen = event && event.payload ? event.payload.id : null;
    });
    window.mermaid.render = () => new Promise(() => {});
    window.__folioHangReady = true;
  }

  async function mainStartHang() {
    const tauri = await waitForBridge();
    let error = '';
    try {
      await tauri.core.invoke('mermaid_render_request', {
        request: {
          id: 'native-hang',
          source: 'flowchart TD\n Hang-->Forever',
          theme: { variables: { background: '#ffffff' } }
        }
      });
    } catch (caught) {
      error = messageOf(caught);
    }
    publish({ phase: 'main-hang', submitted: !error, error, pass: !error });
  }

  async function mainCancelAndRetry() {
    const tauri = await waitForBridge();
    // Fire the retry concurrently with cancellation to exercise the exact
    // recycle race: it may be rejected, queued on the old renderer, or
    // accepted after the replacement is ready. It must never hang.
    const cancelPromise = tauri.core.invoke('mermaid_render_cancel', { id: 'native-hang' });
    const retryPromise = tauri.core.invoke('mermaid_render_request', {
      request: {
        id: 'native-retry',
        source: 'flowchart TD\n A-->B',
        theme: { variables: { background: '#ffffff' } }
      }
    });
    const [cancelResult, retryResult] = await Promise.allSettled([cancelPromise, retryPromise]);
    let cancelError = cancelResult.status === 'rejected' ? messageOf(cancelResult.reason) : '';
    let accepted = retryResult.status === 'fulfilled';
    let attempts = 1;
    let firstError = retryResult.status === 'rejected' ? messageOf(retryResult.reason) : '';

    while (!accepted && attempts < 150) {
      attempts += 1;
      try {
        await tauri.core.invoke('mermaid_render_request', {
          request: {
            id: 'native-retry',
            source: 'flowchart TD\n A-->B',
            theme: { variables: { background: '#ffffff' } }
          }
        });
        accepted = true;
        break;
      } catch (error) {
        if (!firstError) firstError = messageOf(error);
        await sleep(100);
      }
    }

    let event = null;
    if (accepted) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        event = (window.__folioProbeEvents || []).find(item => item && item.id === 'native-retry') || null;
        if (event) break;
        await sleep(100);
      }
    }
    const retryOk = accepted && !!event && event.ok === true && event.sanitized === true &&
      typeof event.svg === 'string' && event.svg.indexOf('<svg') === 0;
    publish({
      phase: 'main-recycle',
      cancelError,
      accepted,
      attempts,
      firstError,
      retryOk,
      event: event ? { id: event.id, ok: event.ok, sanitized: event.sanitized } : null,
      pass: !cancelError && retryOk
    });
  }

  window.__folioNativeProbe = {
    mainPrepare,
    rendererProbe,
    mainFinal,
    rendererInstallHang,
    mainStartHang,
    mainCancelAndRetry
  };
})();
