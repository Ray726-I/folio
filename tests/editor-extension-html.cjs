const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

// Raw author HTML blocks have no generated data-sourcepos wrapper in the native
// projection. The extension view must still show the sanitized block instead of
// failing closed, without trusting any author-provided marker or loading remote
// content.
(async () => {
  const bundle = buildEditorBundle();
  process.on('exit', () => bundle.cleanup());
  const source = '# H\n\n<div class="note"><p>Visible safe HTML text</p><script>alert(1)</script><img src="https://example.com/tracker.png"></div>\n\nAfter\n';
  const session = await openIsolatedEditor(source, bundle.outfile, { width: 900, height: 620 });
  const { page, errors, requests } = session;
  try {
    await page.waitForFunction(() => !editor.isSource());
    await page.waitForFunction(() => document.querySelector('.extension-preview p')?.textContent === 'Visible safe HTML text');

    const state = await page.evaluate(() => {
      const preview = document.querySelector('.extension-preview');
      return {
        html: preview?.innerHTML || '',
        text: preview?.textContent || '',
        hasScript: Boolean(preview?.querySelector('script')),
        hasRemoteImage: Boolean(preview?.querySelector('img[src^="http"]')),
        unavailable: preview?.textContent?.includes('Rendered view unavailable') || false
      };
    });
    assert.equal(state.unavailable, false, 'a sanitized raw HTML block must not render as unavailable');
    assert.equal(state.text.trim(), 'Visible safe HTML text', 'safe HTML text must be visible');
    assert.match(state.html, /<div class="note">/);
    assert.equal(state.hasScript, false, 'scripts must be stripped from author HTML');
    assert.equal(state.hasRemoteImage, false, 'remote images must stay blocked by default');
    assert.deepEqual(requests, [], 'rendering the block must not make network requests');

    // The explicit remote-image preference is safe to honour: only after the
    // user opts in does the sanitized projection carry the remote URL.
    await page.evaluate(() => toggleRemoteImages());
    await page.waitForFunction(() => document.querySelector('.extension-preview img[src^="https://example.com/tracker.png"]') !== null);
    assert.equal(await page.evaluate(() => remoteImages), true);
    assert.ok(requests.includes('https://example.com/tracker.png'), 'opt-in remote extension images may load');

    assert.deepEqual(errors, []);
    console.log('PASS: sanitized raw HTML blocks render safely without generated sourcepos.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
