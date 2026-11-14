const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const diagram = name => '```mermaid\ngraph TD;\n' + name + '-->End;\n```\n';
  const sources = ['First', 'Second', 'First', 'Third'];
  const markdown = (prose, diagrams = sources) => `${prose}\n\n${diagrams.map(diagram).join('\n')}`;
  const session = await openEditor(markdown('Before.'), { width: 1200, height: 800 });
  const { page } = session;
  try {
    await page.waitForFunction(() => document.querySelectorAll('#preview .mermaid-host svg').length === 4);
    await page.evaluate(() => {
      // Bootstrap fixtures omit the native document ID. Register it so source
      // input takes the real documentEdited -> companion debounce path.
      current.documentId = 'companion-reuse'; registerDocument(current);
      window.companionRequests = []; window.companionHeld = []; window.companionFailure = false; window.holdCompanion = false;
      const original = window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = async (command, args = {}) => {
        if (command !== 'mermaid_render_request' || mermaidPending.get(args.request.id)?.owner !== 'companion') return original(command, args);
        const request = args.request; companionRequests.push(request);
        const reply = () => {
          const id = request.id;
          const payload = companionFailure ? { id, ok: false } : { id, ok: true, sanitized: true,
            svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}"><defs><marker id="${id}-arrow"/></defs><style>#${id} { color: red; }</style><path marker-end="url(#${id}-arrow)"/><a href="#${id}-arrow"><text>diagram</text></a></svg>` };
          for (const callback of window.listeners['mermaid-render-result'] || []) callback({ payload });
        };
        if (holdCompanion) companionHeld.push(reply); else queueMicrotask(reply);
      };
      showReadingCompanion();
    });
    const settled = async (prose, count = 4) => page.waitForFunction(({ prose, count }) => {
      const root = $('companion-preview');
      return root.querySelector('p')?.textContent === prose && root.querySelectorAll('.mermaid-host').length === count && !root.querySelector('pre > code.language-mermaid');
    }, { prose, count });
    const count = () => page.evaluate(() => companionRequests.length);
    const remember = () => page.evaluate(() => { window.previousCompanionHosts = [...$('companion-preview').querySelectorAll('.mermaid-host')]; });
    const edit = async (prose, diagrams = sources) => {
      await page.locator('#document-source').fill(markdown(prose, diagrams));
      await settled(prose, diagrams.length);
    };
    const assertIds = async () => {
      const state = await page.evaluate(() => {
        const root = $('companion-preview'), ids = [...root.querySelectorAll('[id]')].map(node => node.id);
        return { ids, links: [...root.querySelectorAll('svg a')].map(node => node.getAttribute('href').slice(1)),
          markers: [...root.querySelectorAll('svg path')].map(node => node.getAttribute('marker-end').slice(5, -1)),
          styles: [...root.querySelectorAll('svg style')].map(node => node.textContent) };
      });
      assert.equal(new Set(state.ids).size, state.ids.length, 'duplicate sources retain distinct SVG IDs');
      assert.ok(state.ids.every(id => id.startsWith('companion-') && !id.startsWith('companion-companion-')), 'SVG IDs receive exactly one companion prefix');
      assert.ok([...state.links, ...state.markers].every(id => state.ids.includes(id)), 'SVG references still point to prefixed IDs');
      assert.ok(state.styles.every(css => !css.includes('#companion-companion-')), 'reusing SVGs does not prefix styles again');
    };
    await settled('Before.');
    assert.equal(await count(), 4);
    await assertIds();
    await page.evaluate(() => setDocumentMode('source'));
    await remember();
    await edit('Before.!');
    assert.equal(await count(), 4, 'editing prose must not request unchanged companion diagrams again');
    assert.equal(await page.evaluate(() => [...$('companion-preview').querySelectorAll('.mermaid-host')].every((host, i) => host === previousCompanionHosts[i])), true, 'all unchanged hosts survive prose edits');
    await assertIds();

    await remember();
    const changed = ['First', 'Changed', 'First', 'Third'];
    await edit('Changed diagram.', changed);
    assert.equal(await count(), 5, 'only the edited diagram renders again');
    assert.deepEqual(await page.evaluate(() => [...$('companion-preview').querySelectorAll('.mermaid-host')].map((host, i) => host === previousCompanionHosts[i])), [true, false, true, true]);
    await assertIds();

    await remember();
    await edit('Removed duplicate.', ['First', 'Third']);
    assert.equal(await count(), 5, 'removing diagrams preserves surviving cached hosts');
    assert.deepEqual(await page.evaluate(() => [...$('companion-preview').querySelectorAll('.mermaid-host')].map(host => previousCompanionHosts.indexOf(host))), [0, 3]);
    await edit('Added duplicate.', ['First', 'First', 'Third']);
    assert.equal(await count(), 6, 'a new duplicate gets its own rendered host');
    await assertIds();

    await remember();
    await page.evaluate(() => { ++diagramThemeRevision; scheduleDiagramRefresh(0); });
    await page.waitForFunction(() => companionRequests.length === 9 && $('companion-preview').querySelectorAll('.mermaid-host svg').length === 3);
    assert.equal(await page.evaluate(() => [...$('companion-preview').querySelectorAll('.mermaid-host')].some(host => previousCompanionHosts.includes(host))), false, 'theme refresh replaces every stale host');
    await assertIds();

    await page.evaluate(() => { companionFailure = true; });
    await edit('Failed diagram.', ['Broken']);
    assert.equal(await count(), 10);
    assert.equal(await page.locator('#companion-preview .mermaid-error').count(), 1);
    await page.evaluate(() => { companionFailure = false; });
    await edit('Retry failed diagram.', ['Broken']);
    assert.equal(await count(), 11, 'failed outputs are retried on the next render');
    assert.equal(await page.locator('#companion-preview svg').count(), 1);

    // A canceled request must never replace the newer generation or seed reuse.
    await page.evaluate(() => { holdCompanion = true; });
    await page.locator('#document-source').fill(markdown('Pending diagram.', ['Pending']));
    await page.waitForFunction(() => companionHeld.length === 1);
    await page.evaluate(() => { holdCompanion = false; });
    await edit('Latest diagram.', ['Latest']);
    await page.evaluate(() => { for (const reply of companionHeld.splice(0)) reply(); });
    await edit('Latest diagram.!', ['Latest']);
    assert.equal(await count(), 13, 'late canceled replies never replace or invalidate the latest cached SVG');
    assert.equal(await page.locator('#companion-preview .mermaid-host').count(), 1);
    await assertIds();
    assert.deepEqual(session.errors, []);
    console.log('PASS: companion reuses unchanged diagrams, preserves duplicate SVG IDs, and invalidates errors, theme changes and canceled renders.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
