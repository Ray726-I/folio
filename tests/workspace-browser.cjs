const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
 const s = await openEditor('initial\n');
 try {
  const { page } = s;
  await page.evaluate(() => {
   const original = window.__TAURI__.core.invoke; let serial = 0;
   window.__TAURI__.core.invoke = async (cmd, args = {}) => {
    if (cmd === 'open_document') return { documentId: `doc-${++serial}`, path: args.path, name: args.path.split('/').pop(), content: `${args.path}\n`, writable: true };
    if (cmd === 'new_document') return { documentId: `doc-${++serial}`, revision: 0 };
    if (/^(activate_document|close_document|recovery_)/.test(cmd)) { calls.push({ command: cmd, args }); return cmd === 'recovery_list' ? [] : null; }
    return original(cmd, args);
   };
   return requestOpen('/a.md');
  });
  await page.evaluate(() => editor.replaceContent('edited A\n'));
  await Promise.race([page.evaluate(() => requestOpen('/b.md')), new Promise((_, reject) => setTimeout(() => reject(Error('opening B blocked by destructive discard dialog')), 2500))]);
  assert.equal(await page.locator('[role=tab]').count(), 2);
  await page.evaluate(() => requestOpen('/a.md'));
  assert.equal(await page.evaluate(() => current.content), 'edited A\n');
  await page.evaluate(() => editor.undo());
  assert.equal(await page.evaluate(() => current.content), '/a.md\n', 'undo survives unmount and tab switch');
  assert.equal(await page.locator('[role=tab]').count(), 2, 'opening canonical path activates existing tab');
  await page.evaluate(() => setDocumentMode('source'));
  await page.fill('#document-source', 'source A');
  await page.evaluate(() => { const input = $('document-source'); input.setSelectionRange(3, 3); input.dispatchEvent(new Event('select')); toggleDocumentReadOnly(); });
  await page.evaluate(() => requestOpen('/b.md'));
  await page.evaluate(() => requestOpen('/a.md'));
  assert.deepEqual(await page.evaluate(() => ({ mode: documentMode, locked: documentReadOnly, selection: $('document-source').selectionStart, content: current.content })), { mode: 'source', locked: true, selection: 3, content: 'source A' });
  await page.evaluate(() => { toggleDocumentReadOnly(); editor.undo(); syncDocumentMode(); });
  assert.equal(await page.evaluate(() => current.content), '/a.md\n', 'source history survives tab switches');
  await page.keyboard.press('Control+t'); await page.waitForFunction(() => current.name.startsWith('Untitled '));
  assert.equal(await page.locator('[role=tab]').count(), 3);
  await page.keyboard.press('Control+w'); await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2);
  await page.keyboard.press('Control+Shift+t'); await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 3);
  // Saving A while B is active must update A's saved snapshot, even if A changes during IPC.
  const saved = await page.evaluate(async () => {
   const a = [...documents.values()].find(d => d.path === '/a.md');
   a.content = 'snapshot A'; documentEdited(a);
   const original = window.__TAURI__.core.invoke;
   let release; const pending = new Promise(r => release = r);
   window.__TAURI__.core.invoke = (cmd, args) => cmd === 'save_document' ? pending.then(() => ({ path: '/a.md', name: 'a.md' })) : original(cmd, args);
   const saving = save(false, false, a);
   a.content = 'later A'; documentEdited(a); release(); await saving;
   window.__TAURI__.core.invoke = original;
   return { baseline: a.saved, content: a.content, active: current.name, state: saveStatus };
  });
  assert.equal(saved.baseline, 'snapshot A'); assert.equal(saved.content, 'later A');
  assert.equal(saved.state, null, 'inactive save cannot change the active tab save indicator');
  await page.click('#document-more-button');
  await page.click('#all-documents');
  await page.fill('#command-search', 'a.md');
  assert.equal(await page.locator('#command-list button').count(), 1, 'all documents is searchable');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { void requestClose(); });
  await page.waitForSelector('#confirm-dialog[open]');
  assert.equal(await page.locator('#confirm-title').textContent(), 'Save changes before closing?');
  const closeChoices = await page.locator('#confirm-actions button').allTextContents();
  assert.ok(closeChoices.includes('Cancel'), 'window close offers Cancel');
  assert.ok(closeChoices.some(label => /^Discard( all)?$/.test(label)), 'window close offers a discard action');
  assert.ok(closeChoices.some(label => /^Save( all)?$/.test(label)), 'window close offers a save action');
  const tabsBefore = await page.locator('[role=tab]').count();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => !busy);
  assert.equal(await page.locator('[role=tab]').count(), tabsBefore, 'cancel keeps every tab');
  await page.evaluate(() => {
   const original = window.__TAURI__.core.invoke;
   window.__TAURI__.core.invoke = async (cmd, args) => {
    if (cmd === 'recovery_list') return [{ documentId: 'recovered', revision: 8, name: '<draft>.md', originalPath: '/missing/draft.md', snapshotTime: Date.now() }];
    if (cmd === 'recovery_warnings') return [{ message: '<unsafe> snapshot damaged' }];
    if (cmd === 'recovery_restore') return { documentId: 'recovered', revision: 8, name: '<draft>.md', originalPath: '/missing/draft.md', path: null, content: 'recovered thought', saved: '', writable: true };
    return original(cmd, args);
   };
   void reviewRecovery();
  });
  await page.waitForSelector('#recovery-dialog[open]');
  assert.equal(await page.locator('#recovery-rows label').count(), 1);
  assert.match(await page.locator('#recovery-rows').innerText(), /missing/);
  await page.click('#recovery-not-now');
  await page.evaluate(() => { void reviewRecovery(); });
  await page.waitForSelector('#recovery-dialog[open]');
  await page.click('#recovery-restore');
  await page.waitForFunction(() => current.documentId === 'recovered' && editorDocument === current && !!editor);
  const recovered = await page.evaluate(() => { editor.replaceContent('continued thought'); return { revision: current.revision, original: current.originalPath, path: current.path, content: current.content }; });
  assert.equal(recovered.revision, 9); assert.equal(recovered.original, '/missing/draft.md'); assert.equal(recovered.path, null);
  assert.match(await page.locator('#recovery-warning').innerText(), /<unsafe>/);
  assert.equal(await page.locator('#recovery-warning unsafe').count(), 0, 'native warning is text, never markup');
  await page.evaluate(() => { window.liveReviewFinished = false; void reviewRecovery().then(() => { window.liveReviewFinished = true; }); });
  await page.waitForFunction(() => window.liveReviewFinished, undefined, { timeout: 2500 });
  assert.equal(await page.locator('#recovery-dialog').evaluate(d => d.open), false, 'live document recovery cannot be discarded through startup review');
  await page.evaluate(() => {
   const original = window.__TAURI__.core.invoke;
   window.__TAURI__.core.invoke = (cmd, args) => cmd === 'save_document' ? new Promise(resolve => { window.releaseCloseSave = () => resolve({ path: '/saved-recovered.md', name: 'saved-recovered.md' }); }) : original(cmd, args);
   window.closingDraft = closeWorkspaceDocument(current);
  });
  await page.waitForSelector('#confirm-dialog[open]');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => !!window.releaseCloseSave);
  await page.evaluate(() => { editor.replaceContent('later unsaved draft'); window.releaseCloseSave(); });
  await page.evaluate(() => window.closingDraft);
  assert.equal(await page.evaluate(() => documents.has('recovered')), true, 'new edits while closing save is pending keep the tab open');
  await page.evaluate(() => {
   const original = window.__TAURI__.core.invoke;
   window.__TAURI__.core.invoke = (cmd, args) => cmd === 'open_document' && args.reuseExisting === false ? Promise.resolve({ documentId: current.documentId, revision: 0, path: current.path, name: current.name, content: 'fresh disk', writable: true }) : original(cmd, args);
   $('disk-banner').hidden = false;
  });
  await page.click('#reload');
  await page.waitForSelector('#confirm-dialog[open]', { timeout: 2500 });
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.waitForFunction(() => !busy);
  assert.equal(await page.evaluate(() => current.content), 'fresh disk', 'explicit Reload bypasses tab activation and reads disk');
  assert.equal(await page.evaluate(() => current.saved), 'fresh disk');
  await page.evaluate(async () => {
   await closeWorkspaceDocument(current);
   const original = window.__TAURI__.core.invoke;
   window.__TAURI__.core.invoke = (cmd, args) => cmd === 'open_document' && args.path === '/saved-recovered.md' ? Promise.resolve({ documentId: 'reopened-external', revision: 0, path: args.path, name: 'saved-recovered.md', content: 'external update', writable: true }) : original(cmd, args);
   await reopenDocument();
  });
  assert.equal(await page.evaluate(() => current.content), 'external update', 'reopen uses the fresh disk baseline after an external edit');
  assert.equal(await page.evaluate(() => current.saved), 'external update');
  await page.evaluate(() => {
   const original = window.__TAURI__.core.invoke;
   window.__TAURI__.core.invoke = (cmd, args) => cmd === 'save_document' ? Promise.resolve({ path: '/saved-recovered.md', name: 'saved-recovered.md' }) : original(cmd, args);
   editor.replaceContent('reopened edit'); requestSave();
  });
  await page.waitForFunction(() => current.content === current.saved && !busy);
  assert.equal(await page.evaluate(() => current.closing), undefined, 'reopened tabs are not stuck in the closing state');
  await page.evaluate(() => {
   const original = window.__TAURI__.core.invoke;
   window.__TAURI__.core.invoke = (cmd, args) => cmd === 'recovery_discard' && args.documentId === current.documentId ? new Promise(resolve => { window.releaseDiscard = resolve; }) : original(cmd, args);
   window.closePending = closeWorkspaceDocument(current);
  });
  await page.waitForFunction(() => !!window.releaseDiscard);
  assert.equal(await page.evaluate(() => { const before = current.content; editor.replaceContent('too late'); return current.content === before; }), true, 'committing closure locks the outgoing editor');
  await page.evaluate(() => window.releaseDiscard()); await page.evaluate(() => window.closePending);
  assert.deepEqual(s.errors, []);
  await page.screenshot({ path: '/tmp/folio-workspace-tabs.png' });
  console.log('workspace tabs/history/reopen, save isolation, recovery review and close cancellation passed');
 } finally { await s.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
