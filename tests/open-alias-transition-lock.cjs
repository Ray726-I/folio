const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Regression: openPath's try/finally holds transitionLocked while it opens.
// When the backend canonicalizes an alias path and returns the documentId of an
// already-open tab, openPath returned activateDocument(...) without awaiting.
// The finally released the lock while activateDocument was still running, then
// activateDocument's own finally restored the lock to its captured `true`,
// leaving the app permanently transition-locked.
(async () => {
  const session = await openEditor('# A\n\ntext\n', { width: 1000, height: 700 });
  const { page } = session;
  try {
    await page.evaluate(() => {
      const original = window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = async (cmd, args = {}) => {
        if (cmd === 'open_document') {
          if (args.path === '/alias-a.md') {
            // The native side canonicalized the alias and reused the open tab.
            return { documentId: 'doc-a', revision: 0, path: '/a.md', name: 'a.md', content: 'disk a', writable: true };
          }
          const documentId = args.path === '/a.md' ? 'doc-a' : 'doc-b';
          return { documentId, revision: 0, path: args.path, name: args.path.split('/').pop(), content: `disk ${args.path}`, writable: true };
        }
        if (cmd === 'activate_document') return null;
        if (cmd === 'save_document') return { path: current.path, name: current.name };
        return original(cmd, args);
      };
    });
    await page.evaluate(() => requestOpen('/a.md'));
    await page.evaluate(() => requestOpen('/b.md'));
    await page.waitForFunction(() => current.documentId === 'doc-b' && !busy);
    assert.equal(await page.evaluate(() => documents.size), 2);

    const opened = await page.evaluate(() => openPath('/alias-a.md'));
    assert.equal(opened, true, 'alias open activates the canonical tab');
    assert.equal(await page.evaluate(() => current.documentId), 'doc-a');
    assert.equal(await page.evaluate(() => transitionLocked), false, 'alias open releases the transition lock');

    // The lock guards saving. A stuck lock would make Ctrl+S a silent no-op.
    const saved = await page.evaluate(async () => {
      current.content = 'edited a';
      return requestSave();
    });
    assert.equal(saved, true, 'saving still works after an alias open');
    assert.deepEqual(session.errors, []);
    console.log('PASS: alias opens that reuse an existing tab release the transition lock');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
