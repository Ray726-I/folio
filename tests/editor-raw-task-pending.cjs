const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

(async () => {
  const bundle = buildEditorBundle();
  const source = '> [!NOTE]\n> - [ ] First\n> - [ ] Second\n';
  const session = await openIsolatedEditor(source, bundle.outfile);
  try {
    const { page } = session;
    await page.waitForSelector('.extension-preview input[type=checkbox]:not([disabled])');
    const result = await page.evaluate(async () => {
      const original = window.__TAURI__.core.invoke;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      window.__TAURI__.core.invoke = async (command, args) => {
        if (command === 'render_markdown') await gate;
        return original(command, args);
      };
      const old = document.querySelector('.extension-preview input[type=checkbox]');
      const reordered = '> [!NOTE]\n> - [ ] Second\n> - [ ] First\n';
      current.content = reordered;
      editor.replaceContent(reordered);
      const disabled = old.disabled || !old.isConnected;
      old.checked = true;
      old.dispatchEvent(new Event('change', { bubbles: true }));
      const after = current.content;
      release();
      return { disabled, after, reordered };
    });
    assert.ok(result.disabled, 'old controls are synchronously disabled or detached');
    assert.equal(result.after, result.reordered, 'stale control cannot mutate reordered tasks');
    await page.waitForFunction(() => document.querySelector('.extension-preview input[type=checkbox]:not([disabled])'));
    await page.locator('.extension-preview input[type=checkbox]').first().check();
    await page.waitForFunction(() => current.content.includes('- [x] Second'));
    assert.deepEqual(session.errors, []);
    console.log('PASS: pending raw task projections fail closed until the new projection mounts.');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
