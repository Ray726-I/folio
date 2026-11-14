const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const s = await openEditor('a'.repeat(26) + '!\n');
  const { page } = s;
  try {
    const csp = require('../tauri.conf.json').app.security.csp;
    await page.evaluate(csp => { const meta = document.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = csp; document.head.append(meta); }, csp);
    await page.keyboard.press('Control+h');
    const duration = await page.evaluate(() => {
      $('find-regex').setAttribute('aria-pressed', 'true');
      $('find-input').value = '(a+)+$';
      const start = performance.now(); updateFind(); return performance.now() - start;
    });
    assert.ok(duration < 200, `regex search must leave the UI responsive, took ${duration}ms`);
    await page.waitForFunction(() => $('find-result').textContent.includes('too long'));
    await page.locator('#find-input').fill('a{2}');
    await page.waitForFunction(() => $('find-result').textContent === '1 / 13');
    await page.locator('#find-next').click();
    assert.equal(await page.locator('#find-result').textContent(), '2 / 13');
    await page.locator('#replace-input').fill('x');
    await page.evaluate(() => replaceMatches(true));
    await page.waitForFunction(() => current.content === 'x'.repeat(13) + '!\n');
    await page.evaluate(() => editor.replaceContent('a'.repeat(26) + '!\n'));
    await page.locator('#find-input').fill('(a+)+$');
    await page.evaluate(() => replaceMatches(true));
    await page.waitForFunction(() => $('find-result').textContent.includes('too long'));
    assert.equal(await page.evaluate(() => current.content), 'a'.repeat(26) + '!\n', 'timed-out replace preserves source');
    // A late worker must not overwrite results for a newer query.
    await page.locator('#find-input').fill('(a+)+$');
    await page.locator('#find-input').fill('!');
    await page.waitForFunction(() => $('find-result').textContent === '1 / 1');
    await page.waitForTimeout(700);
    assert.equal(await page.locator('#find-result').textContent(), '1 / 1');
    await page.evaluate(() => editor.replaceContent('😀a😀'));
    await page.locator('#find-input').fill('(?=😀)');
    await page.waitForFunction(() => $('find-result').textContent === '1 / 2');
    await page.evaluate(async () => {
      editor.replaceContent('aaa bbb\n'); $('find-input').value = 'a'; await updateFind();
      editor.replaceContent('aaa bbb!\n'); $('replace-input').value = 'X';
      const pending = replaceMatches(false);
      $('find-regex').setAttribute('aria-pressed', 'false'); $('find-input').value = 'bbb'; updateFind();
      await pending;
    });
    assert.equal(await page.evaluate(() => current.content), 'aaa bbb!\n', 'a canceled replace must not act on a newer query');
    await page.evaluate(async () => {
      // Delay delivery, keeping worker execution real, to expose the pending
      // 140ms refresh race deterministically on fast machines.
      const NativeWorker = window.Worker;
      window.Worker = class {
        constructor(url) {
          this.worker = new NativeWorker(url);
          this.worker.onmessage = event => { this.timer = setTimeout(() => this.onmessage?.(event), 200); };
          this.worker.onerror = event => this.onerror?.(event);
        }
        postMessage(data) { this.worker.postMessage(data); }
        terminate() { clearTimeout(this.timer); this.worker.terminate(); }
      };
      try {
        $('find-regex').setAttribute('aria-pressed', 'true'); $('find-input').value = 'X'; $('replace-input').value = 'Y';
        editor.replaceContent('X aaa!\n');
        await replaceMatches(true);
      } finally { window.Worker = NativeWorker; }
    });
    assert.equal(await page.evaluate(() => current.content), 'Y aaa!\n', 'a scheduled edit refresh must not cancel explicit replacement');
    assert.deepEqual(s.errors, []);
    console.log('PASS: bounded regex search/replace, cancellation, normal matching and Unicode empty matches');
  } finally { await s.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
