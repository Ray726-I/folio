const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
 const session = await openEditor('initial\n');
 const { page } = session;
 try {
  await page.evaluate(async () => {
   const original = window.__TAURI__.core.invoke;
   window.recoveryHigh = {}; window.snapshotCount = 0; window.diskText = 'disk\n';
   window.__TAURI__.core.invoke = async (command, args = {}) => {
    if (command === 'open_document') return { documentId: args.path === '/a.md' ? 'a' : 'b', path: args.path, name: args.path.slice(1), content: window.diskText, revision: 0, writable: true };
    if (command === 'activate_document' || command === 'close_document') return null;
    if (command === 'recovery_write') { if (args.revision <= (window.recoveryHigh[args.documentId] || 0)) throw Error('Stale recovery revision'); window.recoveryHigh[args.documentId] = args.revision; window.snapshotCount++; return args.revision; }
    if (command === 'recovery_saved') { if (window.failSavedFor === args.documentId) { window.failSavedFor = null; throw Error('storage unavailable'); } window.recoveryHigh[args.documentId] = Math.max(window.recoveryHigh[args.documentId] || 0, args.revision); return null; }
    if (command === 'recovery_list' || command === 'recovery_warnings') return [];
    if (command === 'close_window') throw Error('window close failed');
    if (command === 'save_document') return new Promise((resolve, reject) => { window.rejectBackgroundSave = () => reject({ code: 'file_changed', message: 'external change' }); });
    return original(command, args);
   };
   await requestOpen('/a.md');editor.replaceContent('draft A');editor.replaceContent('draft A newer');
   await recoveryWriter.flush(current);
   window.savingA = requestSave();
   await requestOpen('/b.md');window.rejectBackgroundSave();
  });
  await page.waitForSelector('#confirm-dialog[open]');
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await page.evaluate(() => window.savingA);
  assert.equal(await page.evaluate(() => current.documentId), 'a');
  assert.equal(await page.evaluate(() => current.content), 'disk\n');
  const afterReload = await page.evaluate(async () => { editor.replaceContent('after background reload');await recoveryWriter.flush(current);return { revision: current.revision, high: recoveryHigh.a, warning: $('recovery-warning').textContent }; });
  assert.equal(afterReload.revision, afterReload.high);
  assert.doesNotMatch(afterReload.warning, /Stale/);
  await page.evaluate(async () => { await requestOpen('/b.md');editor.replaceContent('draft B');await recoveryWriter.flush(current);window.failSavedFor='b';void requestClose(); });
  await page.waitForSelector('#workspace-close-dialog[open]');
  await page.locator('#workspace-close-rows select').evaluateAll(nodes => nodes.forEach(node => { node.value='discard'; }));
  await page.click('#workspace-close-confirm');await page.waitForFunction(() => !busy);
  const afterFailure = await page.evaluate(async () => { const before = snapshotCount;editor.replaceContent('still editable after aborted close');await recoveryWriter.flush(current);return { before, after: snapshotCount, retired: [...documents.values()].some(doc => recoveryWriter.state(doc.documentId).retired), tabs: documents.size }; });
  assert.equal(afterFailure.retired, false);assert.equal(afterFailure.tabs, 2);assert.ok(afterFailure.after > afterFailure.before);
  await page.evaluate(() => { void requestClose(); });await page.waitForSelector('#workspace-close-dialog[open]');
  await page.locator('#workspace-close-rows select').evaluateAll(nodes => nodes.forEach(node => { node.value='discard'; }));
  await page.click('#workspace-close-confirm');await page.waitForFunction(() => !busy);
  const afterCloseFailure = await page.evaluate(async () => { const before=snapshotCount;editor.replaceContent('after window error');await recoveryWriter.flush(current);return { before, after:snapshotCount, retired:recoveryWriter.state(current.documentId).retired }; });
  assert.equal(afterCloseFailure.retired,false);assert.ok(afterCloseFailure.after>afterCloseFailure.before);
  assert.deepEqual(session.errors, []);
  console.log('PASS: background reload preserves recovery revisions; failed discards/window close retain live recovery');
 } finally { await session.close(); }
})().catch(error => { console.error(error);process.exitCode=1; });
