const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Regression: save() always wrote status('Saving…') for the active document,
// then the new early `if (automatic) return true` path skipped every later
// status update. Background autosaves therefore left "Saving…" stuck forever.
(async () => {
  const session = await openEditor('# H\n\ntext\n', { width: 1000, height: 700 });
  const { page } = session;
  try {
    await page.evaluate(() => {
      const original = window.__TAURI__.core.invoke;
      window.__TAURI__.core.invoke = async (cmd, args = {}) => cmd === 'save_document'
        ? { path: current.path, name: current.name }
        : original(cmd, args);
      current.content = `${current.content}\nedited`;
    });

    const automatic = await page.evaluate(async () => {
      status('Background probe');
      const result = await save(false, false, current, true);
      return { result, status: $('app-status').textContent };
    });
    assert.equal(automatic.result, true, 'automatic save succeeds');
    assert.notEqual(automatic.status, 'Saving…', 'automatic save does not leave Saving… behind');
    assert.equal(automatic.status, 'Background probe', 'automatic save leaves the current status untouched');

    const manual = await page.evaluate(async () => {
      current.content = `${current.content}\nmanual edit`;
      const result = await save(false, false, current, false);
      return { result, status: $('app-status').textContent };
    });
    assert.equal(manual.result, true, 'manual save succeeds');
    assert.equal(manual.status, 'Saved', 'manual save still reports Saved');
    assert.deepEqual(session.errors, []);
    console.log('PASS: automatic saves stay silent; manual saves still report Saved');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
