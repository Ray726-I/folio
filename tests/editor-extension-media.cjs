const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

(async () => {
  const bundle = buildEditorBundle();
  const url = 'https://example.com/folio-private-image.png';
  const source = `> [!NOTE]\n> ![remote](${url})\n\n<img src="${url}" alt="html">\n<img src="file:///etc/passwd" alt="local">\n`;
  const session = await openIsolatedEditor(source, bundle.outfile);
  try {
    const { page, requests } = session;
    await page.waitForFunction(() => document.querySelectorAll('.extension-preview img').length === 3);
    const remoteImages = '.extension-preview img:not([alt="local"])';
    assert.ok((await page.locator(remoteImages).evaluateAll(nodes => nodes.map(n => n.getAttribute('src')))).every(src => src.startsWith('data:image/')), 'remote images default to native blocked placeholders');
    assert.equal(await page.locator('.extension-preview img[alt="local"]').getAttribute('src'), null, 'unsafe file URL is removed by native sanitization');
    assert.ok(!requests.includes(url), 'no unconsented network request');
    await page.evaluate(() => toggleRemoteImages());
    await page.waitForFunction(value => [...document.querySelectorAll('.extension-preview img:not([alt="local"])')].every(n => n.getAttribute('src') === value), url);
    assert.ok(requests.includes(url), 'global permission permits native-sanitized remote images');
    await page.evaluate(() => toggleRemoteImages());
    assert.ok((await page.locator('.extension-preview img').evaluateAll(nodes => nodes.map(n => n.getAttribute('src')))).every(src => !src || !src.startsWith('https:')), 'revoke removes remote sources synchronously');
    await page.waitForFunction(() => [...document.querySelectorAll('.extension-preview img:not([alt="local"])')].length === 2 && [...document.querySelectorAll('.extension-preview img:not([alt="local"])')].every(n => n.getAttribute('src')?.startsWith('data:image/')));
    const priorRequests = requests.filter(request => request === url).length;
    await page.evaluate(() => {
      const original = window.__TAURI__.core.invoke;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      window.releaseImageRender = release;
      window.heldImageRenders = 0;
      window.__TAURI__.core.invoke = async (command, args) => {
        if (command === 'render_markdown' && args.remoteImages) { window.heldImageRenders++; await gate; }
        return original(command, args);
      };
      toggleRemoteImages();
    });
    await page.waitForFunction(() => window.heldImageRenders > 0);
    await page.evaluate(() => { toggleRemoteImages(); window.releaseImageRender(); });
    await page.waitForFunction(() => [...document.querySelectorAll('.extension-preview img:not([alt="local"])')].length === 2 && [...document.querySelectorAll('.extension-preview img:not([alt="local"])')].every(n => n.getAttribute('src')?.startsWith('data:image/')));
    await page.waitForTimeout(200);
    assert.equal(requests.filter(request => request === url).length, priorRequests, 'late permitted results cannot load after permission is revoked');
    assert.equal(await page.evaluate(() => current.content), source);
    assert.deepEqual(session.errors, []);
    console.log('PASS: extension images follow global consent, refresh on revoke, and preserve native sanitization and source.');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
