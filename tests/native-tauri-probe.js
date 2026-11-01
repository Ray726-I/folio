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

  async function waitFor(predicate, timeout, label) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const value = await predicate();
        if (value) return value;
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${label}${lastError ? `: ${messageOf(lastError)}` : ''}`);
  }

  function activeEditor() {
    try {
      return typeof editor !== 'undefined' && editor ? editor : null;
    } catch {
      return null;
    }
  }

  function activeWithin(selector) {
    const root = document.querySelector(selector);
    return !!root && root.contains(document.activeElement);
  }

  function clickElement(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`missing #${id}`);
    element.click();
    return element;
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

  // Debug-only real WebKit smoke for the unified editor. It opens a disposable
  // temp document through the app's own openPath lifecycle, then uses the same
  // public surfaces a user reaches (presentation button, lock button, snapshot
  // dialog, save button) plus explicitly programmatic selection/input. It does
  // not dispatch synthetic keyboard events or claim IME input.
  async function mainEditor() {
    reset();
    const started = Date.now();
    const report = {
      phase: 'main-editor',
      programmaticSelection: true,
      programmaticInput: true,
      syntheticKeyboard: false,
      ime: false
    };
    try {
      await waitForBridge();
      const data = window.__folioProbeData || {};
      const source = data.editorSource;
      if (typeof source !== 'string') throw new Error('editor source fixture missing');
      if (typeof openPath !== 'function') throw new Error('app openPath lifecycle unavailable');

      // Open through the real app lifecycle: native open_document IPC, app
      // state, document view, lazy editor bundle, and initial render.
      const opened = await openPath(data.editorPath);
      report.openReturned = Boolean(opened);
      await waitFor(
        () => !!activeEditor() && !!document.querySelector('#preview .ProseMirror'),
        25000,
        'unified editor mount'
      );
      const instance = activeEditor();
      await waitFor(
        () => instance.getText() === source && current.path === data.editorPath,
        5000,
        'native document content'
      );

      const root = document.querySelector('#preview .ProseMirror');
      const script = [...document.scripts].find(node =>
        (node.getAttribute('src') || '').endsWith('vendor/editor/editor.js'));
      const stylesheet = [...document.querySelectorAll('link[rel="stylesheet"]')].find(node =>
        (node.getAttribute('href') || '').endsWith('vendor/editor/editor.css'));
      const headings = window.FolioEditor && typeof window.FolioEditor.headings === 'function'
        ? window.FolioEditor.headings(source).length : 0;

      report.bundle = {
        global: !!window.FolioEditor &&
          typeof window.FolioEditor.create === 'function' &&
          typeof window.FolioEditor.headings === 'function',
        script: !!script,
        stylesheet: !!stylesheet,
        headings,
        pass: !!window.FolioEditor &&
          typeof window.FolioEditor.create === 'function' &&
          typeof window.FolioEditor.headings === 'function' &&
          !!script && !!stylesheet && headings === 1
      };
      report.opened = {
        path: current.path,
        name: current.name,
        contentExact: instance.getText() === source,
        savedExact: current.saved === source,
        viewVisible: !document.getElementById('document-view').hidden,
        pass: current.path === data.editorPath &&
          instance.getText() === source &&
          current.saved === source &&
          !document.getElementById('document-view').hidden
      };
      report.clean = {
        root: !!root,
        contentEditable: root ? root.getAttribute('contenteditable') : null,
        heading: document.querySelector('#preview h1')
          ? document.querySelector('#preview h1').textContent : '',
        sourceMode: instance.isSource(),
        noticeHidden: document.getElementById('editor-notice').hidden,
        dirtyHidden: document.getElementById('dirty-dot').hidden,
        pass: !!root &&
          root.getAttribute('contenteditable') === 'true' &&
          root.getClientRects().length > 0 &&
          document.querySelector('#preview h1') &&
          document.querySelector('#preview h1').textContent === 'Native editor smoke' &&
          instance.isSource() === false &&
          document.getElementById('editor-notice').hidden === true &&
          document.getElementById('dirty-dot').hidden === true
      };

      // Focus mode is a shell-level toggle, not an editor mutation.
      if (typeof toggleFocus !== 'function') throw new Error('toggleFocus unavailable');
      toggleFocus();
      const focusModeOn = document.body.classList.contains('focus-mode');
      toggleFocus();
      const focusModeRestored = !document.body.classList.contains('focus-mode');
      report.focusMode = {
        on: focusModeOn,
        restored: focusModeRestored,
        pass: focusModeOn && focusModeRestored
      };

      // Programmatic selection in the single editor: the caret and a range must
      // round-trip through the public API and the DOM selection, with focus
      // staying in the one editing surface.
      const paragraphText = 'Intro paragraph with ';
      const paragraphStart = source.indexOf(paragraphText);
      if (paragraphStart < 0) throw new Error('selection anchor text missing');
      const rangeStart = paragraphStart + 'Intro '.length;
      const rangeLength = 'paragraph with'.length;
      instance.selectRange(rangeStart);
      await sleep(50);
      const richFocus = activeWithin('#preview .ProseMirror');
      const richCaret = instance.getSelection();
      instance.selectRange(rangeStart, rangeStart + rangeLength);
      await sleep(80);
      const richSelection = instance.getSelection();
      const richDomText = String(window.getSelection());
      report.selection = {
        anchorOffset: rangeStart,
        rangeLength,
        richFocus,
        richCaret,
        richSelection,
        richDomText: richDomText.slice(0, 80),
        pass: richFocus &&
          richCaret.anchor === rangeStart &&
          richCaret.head === rangeStart &&
          richSelection.anchor === rangeStart &&
          richSelection.head === rangeStart + rangeLength &&
          richDomText.includes('paragraph with')
      };

      // The snapshot dialog must expose the exact native-loaded source.
      clickElement('source-snapshot');
      await waitFor(
        () => document.getElementById('source-dialog').open,
        3000,
        'source snapshot dialog'
      );
      const snapshot = document.getElementById('source-snapshot-text');
      const snapshotText = snapshot.value;
      const snapshotReadonly = snapshot.readOnly === true;
      clickElement('source-snapshot-close');
      report.snapshot = {
        exact: snapshotText === source,
        readonly: snapshotReadonly,
        bytes: snapshotText.length,
        pass: snapshotText === source && snapshotReadonly
      };

      // Lock through the real button, then attempt edits through legitimate
      // public APIs and a programmatic DOM input command. None may change the
      // source, dirty state, or DOM.
      clickElement('lock-document');
      await waitFor(() => instance.isLocked(), 3000, 'editor lock');
      const lockedRoot = document.querySelector('#preview .ProseMirror');
      const lockedText = instance.getText();
      const lockedEditable = lockedRoot.getAttribute('contenteditable');
      const lockNoteVisible = !document.getElementById('editor-lock-note').hidden;
      const toolbarDisabled = [...document.querySelectorAll('#format-tools button')]
        .every(button => button.disabled);
      const mutationErrors = [];
      try {
        instance.replaceContent(lockedText + '\n\nLOCKED BY REPLACE\n');
      } catch (error) {
        mutationErrors.push(messageOf(error));
      }
      instance.command('bold');
      const undoWhileLocked = instance.undo();
      try {
        document.execCommand('insertText', false, 'LOCKED');
      } catch (error) {
        mutationErrors.push(messageOf(error));
      }
      await sleep(300);
      const lockedUnchanged = instance.getText() === lockedText &&
        current.content === lockedText &&
        document.getElementById('dirty-dot').hidden === true;
      const lockedDomClean = !String(lockedRoot.textContent || '').includes('LOCKED');
      clickElement('lock-document');
      await waitFor(() => !instance.isLocked(), 3000, 'editor unlock');
      const unlockedEditable = document.querySelector('#preview .ProseMirror')
        .getAttribute('contenteditable');
      report.lock = {
        lockedEditable,
        unlockedEditable,
        lockNoteVisible,
        toolbarDisabled,
        undoWhileLocked,
        lockedUnchanged,
        lockedDomClean,
        mutationErrors,
        pass: lockedEditable === 'false' &&
          unlockedEditable === 'true' &&
          lockNoteVisible &&
          toolbarDisabled &&
          undoWhileLocked === false &&
          lockedUnchanged &&
          lockedDomClean
      };

      // Programmatic selection + input command while unlocked. The native save
      // round trip uses the resulting exact source whether WebKit's editing
      // command changed the DOM or the public replaceContent API had to be
      // used as the deterministic fallback.
      const marker = 'Native editor smoke';
      const markerIndex = source.indexOf(marker);
      if (markerIndex < 0) throw new Error('edit marker missing');
      const insertAt = markerIndex + marker.length;
      const expected = source.slice(0, insertAt) + ' PROBE' + source.slice(insertAt);
      instance.selectRange(insertAt, insertAt);
      await waitFor(() => {
        const selection = instance.getSelection();
        return selection.anchor === insertAt && selection.head === insertAt;
      }, 3000, 'edit caret');
      const beforeEdit = instance.getText();
      let inputCommandError = '';
      try {
        document.execCommand('insertText', false, ' PROBE');
      } catch (error) {
        inputCommandError = messageOf(error);
      }
      let inputCommandChanged = false;
      try {
        await waitFor(() => instance.getText() !== beforeEdit, 2500, 'input command');
        inputCommandChanged = true;
      } catch {}
      const inputCommandExact = instance.getText() === expected;
      if (!inputCommandExact) {
        instance.replaceContent(expected);
        await sleep(80);
      }
      const editedText = instance.getText();
      const editExact = editedText === expected;
      report.edit = {
        method: inputCommandExact ? 'document.execCommand(insertText)'
          : 'editor.replaceContent fallback',
        inputCommandChanged,
        inputCommandExact,
        inputCommandError,
        editExact,
        pass: editExact
      };

      let saveError = '';
      if (editExact) {
        clickElement('save');
        try {
          await waitFor(
            () => !busy &&
              current.saved === expected &&
              instance.getText() === expected &&
              document.getElementById('dirty-dot').hidden,
            25000,
            'native save roundtrip'
          );
        } catch (error) {
          saveError = messageOf(error);
        }
      }
      const toast = document.getElementById('toast');
      report.save = {
        path: current.path,
        savedContent: current.saved === expected,
        dirtyCleared: document.getElementById('dirty-dot').hidden,
        toast: toast && !toast.hidden ? String(toast.textContent || '').slice(0, 200) : '',
        saveError,
        pass: editExact &&
          !saveError &&
          current.path === data.editorPath &&
          current.saved === expected &&
          current.content === expected &&
          document.getElementById('dirty-dot').hidden === true
      };

      report.pass = report.bundle.pass &&
        report.opened.pass &&
        report.clean.pass &&
        report.focusMode.pass &&
        report.selection.pass &&
        report.snapshot.pass &&
        report.lock.pass &&
        report.edit.pass &&
        report.save.pass;
      report.editorPass = report.pass;
      report.elapsedMs = Date.now() - started;
      publish(report);
    } catch (error) {
      report.pass = false;
      report.editorPass = false;
      report.error = messageOf(error);
      report.elapsedMs = Date.now() - started;
      publish(report);
    }
  }

  window.__folioNativeProbe = {
    mainPrepare,
    rendererProbe,
    mainFinal,
    rendererInstallHang,
    mainStartHang,
    mainCancelAndRetry,
    mainEditor
  };
})();
