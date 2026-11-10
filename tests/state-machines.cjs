const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const session = await openEditor('# State\n\nA paragraph for machine checks.\n');
  const { page } = session;
  try {
    const machine = id => page.evaluate(id => FolioState.get(id).state, id);
    const context = id => page.evaluate(id => FolioState.get(id).context, id);
    const snapshot = () => page.evaluate(() => FolioState.snapshot());

    const initial = await snapshot();
    for (const id of ['surface', 'mode', 'save', 'find', 'companion', 'preview', 'menu', 'modals']) assert.ok(initial.machines[id], `${id} machine is registered`);
    assert.equal(initial.machines.surface.state, 'document');
    assert.equal(initial.machines.preview.state, 'ready');
    assert.doesNotThrow(() => JSON.stringify(initial), 'snapshots are JSON-safe for agents and issue reports');

    // Mode: the three visible modes are authoritative, and read-only is an
    // orthogonal context flag rather than a fourth mode.
    await page.evaluate(() => setDocumentMode('edit'));
    assert.equal(await machine('mode'), 'edit');
    await page.evaluate(() => setDocumentMode('source'));
    assert.equal(await machine('mode'), 'source');
    await page.evaluate(() => setDocumentMode('reading'));
    assert.equal(await machine('mode'), 'reading');
    await page.evaluate(() => { documentReadOnly = true; syncDocumentMode(); });
    assert.equal((await context('mode')).readOnly, true);
    await page.evaluate(() => toggleDocumentReadOnly());
    assert.equal((await context('mode')).readOnly, false);

    // An illegal transition is rejected and recorded, never applied.
    await page.evaluate(() => { current.writable = false; syncDocumentMode(); });
    const rejected = await page.evaluate(() => FolioState.get('mode').send('EDIT', { source: 'test' }));
    assert.equal(rejected, false, 'Edit is rejected for a non-writable document');
    assert.equal(await machine('mode'), 'reading', 'a rejected event leaves the mode untouched');
    assert.ok((await page.evaluate(() => FolioState.violations())).some(entry => entry.machine === 'mode' && entry.event === 'EDIT'));
    await page.evaluate(() => { current.writable = true; syncDocumentMode(); FolioState.resetViolations(); });

    // Save: the indicator is projected through one state name.
    await page.evaluate(() => setDocumentMode('edit'));
    await page.evaluate(() => editor.replaceContent('# State\n\nChanged.\n'));
    assert.equal(await machine('save'), 'dirty');
    await page.evaluate(() => requestSave());
    await page.waitForFunction(() => current.content === current.saved && !busy);
    assert.equal(await machine('save'), 'clean');
    await page.evaluate(() => { saveStatus = { error: 'Disk is full' }; updateTitle(); });
    assert.equal(await machine('save'), 'error');
    assert.equal((await context('save')).error, 'Disk is full');
    await page.evaluate(() => { current.autoSavePaused = true; saveStatus = { error: 'changed externally' }; updateTitle(); });
    assert.equal(await machine('save'), 'paused');
    assert.equal(await page.locator('#save-state').textContent(), 'Paused');
    assert.match(await page.locator('#save-state').getAttribute('aria-label'), /Automatic saving paused/);
    await page.evaluate(() => { current.autoSavePaused = false; saveStatus = null; updateTitle(); });

    // Find and Replace: one machine for both bars.
    await page.evaluate(() => openFind());
    assert.equal(await machine('find'), 'find');
    await page.evaluate(() => openReplace());
    assert.equal(await machine('find'), 'replace');
    await page.locator('#find-regex').click();
    await page.evaluate(() => { $('find-input').value = '['; updateFind(); });
    assert.equal((await context('find')).invalid, true);
    await page.evaluate(() => { $('find-input').value = 'paragraph'; updateFind(); });
    assert.equal((await context('find')).invalid, false);
    await page.locator('#find-regex').click();
    await page.evaluate(() => closeFind());
    assert.equal(await machine('find'), 'closed');

    // Companion: following and pinned are distinct, and closing clears both.
    await page.evaluate(() => showReadingCompanion());
    assert.equal(await machine('companion'), 'following');
    await page.evaluate(() => showReadingCompanion(current, false));
    assert.equal(await machine('companion'), 'pinned');
    await page.evaluate(() => closeReadingCompanion());
    assert.equal(await machine('companion'), 'hidden');

    // Menus and the native dialog stack are observed from the real DOM.
    await page.locator('#menu-file-button').click();
    await page.waitForFunction(() => FolioState.get('menu').state === 'open');
    assert.equal((await context('menu')).active, 'open-menu');
    await page.evaluate(() => closeAllMenus());
    await page.waitForFunction(() => FolioState.get('menu').state === 'closed');
    await page.evaluate(() => openCommands());
    await page.waitForFunction(() => FolioState.get('modals').state === 'open');
    assert.ok((await context('modals')).stack.includes('command-dialog'));
    await page.evaluate(() => $('command-dialog').close());
    await page.waitForFunction(() => FolioState.get('modals').state === 'idle');

    // The inspector is the human-readable mirror of the same snapshot.
    await page.evaluate(() => FolioState.openInspector());
    assert.equal(await page.locator('#state-inspector').evaluate(dialog => dialog.open), true);
    assert.match(await page.locator('.state-inspector-output').textContent(), /mode\s+(reading|edit|source)/);
    await page.evaluate(() => $('state-inspector').close());

    // Normal operation must not leave an invariant broken.
    assert.deepEqual(await page.evaluate(() => FolioState.violations()), []);
    assert.deepEqual(session.errors, []);
    console.log('PASS: explicit machines reject illegal events, project save/find/companion state, observe menus and dialogs, and expose a JSON snapshot.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
