const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

// Author HTML images inside a raw extension block are sanitized by the native
// renderer, which replaces a blocked remote source with an opaque placeholder.
// The extension view must still offer the same explicit per-image Load control
// as Markdown image atoms, preserve author dimensions, make no request before
// that click, and keep Load available under Lock. Parsing the raw block must
// never start image/iframe/style loads, even in webviews where an "inert"
// DOMParser document is not inert for resource loading.
(async () => {
  const bundle = buildEditorBundle();
  process.on('exit', () => bundle.cleanup());
  const url = 'https://example.com/formatted-html-image.png';
  const second = 'https://example.com/second-formatted-image.png';
  const frame = 'https://example.com/embedded-frame';
  const inline = 'https://example.com/inline-image.png';
  const source = `# Formatted HTML\n\n<img src="${url}" alt="formatted" width="321" height="123">\n<img src="${second}" alt="second" width="200" height="80">\n<iframe src="${frame}"></iframe>\n\nInline <span><img src="${inline}"></span> source stays literal.\n\nAfter\n`;
  const session = await openIsolatedEditor(source, bundle.outfile, { width: 900, height: 620 });
  const { page, errors, requests } = session;
  try {
    await page.locator('#preview .ProseMirror').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('.extension-preview img[width]').length === 2);
    await page.waitForFunction(() => document.querySelectorAll('.extension-preview .extension-image-load').length === 2);

    const state = await page.evaluate(() => {
      const preview = document.querySelector('.extension-preview');
      const img = preview?.querySelector('img[width="321"]');
      const second = preview?.querySelector('img[width="200"]');
      const controls = [...(preview?.querySelectorAll('.extension-image-load') || [])];
      return {
        src: img?.getAttribute('src') || '',
        width: img?.getAttribute('width') || '',
        height: img?.getAttribute('height') || '',
        alt: img?.getAttribute('alt') || '',
        secondSrc: second?.getAttribute('src') || '',
        controls: controls.length,
        controlText: controls.map(control => control.textContent),
        inline: document.querySelector('.html-inline')?.innerHTML || ''
      };
    });
    assert.match(state.src, /^data:image\/svg\+xml;base64,/, 'remote author HTML image defaults to the native blocked placeholder');
    assert.match(state.secondSrc, /^data:image\/svg\+xml;base64,/, 'the second remote image also defaults to the blocked placeholder');
    assert.equal(state.width, '321', 'author width survives sanitization');
    assert.equal(state.height, '123', 'author height survives sanitization');
    assert.equal(state.alt, 'formatted', 'author alt survives sanitization');
    assert.equal(state.controls, 2, 'each blocked author HTML image offers its own explicit Load control');
    assert.deepEqual(state.controlText, ['Load image', 'Load image']);
    assert.ok(!state.inline.includes('<img'), 'inline raw HTML containing an image falls back to the safe literal chip');
    assert.deepEqual(requests, [], 'viewing, hovering and focusing blocked author HTML must not fetch image, iframe or style resources');

    await page.locator('.extension-preview img[width="321"]').hover();
    await page.locator('.extension-preview .extension-image-load button').first().focus();
    assert.deepEqual(requests, [], 'hover and focus must not fetch the image; only an explicit Load may');

    // Load must remain available under Lock, must not mutate the document, and
    // must consent only to the clicked destination.
    await page.locator('#lock-document').click();
    await page.waitForFunction(() => editor.isLocked());
    const before = await page.evaluate(() => current.content);
    await page.locator('.extension-preview .extension-image-load button').first().click();
    await page.waitForFunction(value => document.querySelector('.extension-preview img[width="321"]')?.getAttribute('src') === value, url);

    const loaded = await page.evaluate(() => {
      const preview = document.querySelector('.extension-preview');
      const img = preview?.querySelector('img[width="321"]');
      const second = preview?.querySelector('img[width="200"]');
      return {
        src: img?.getAttribute('src') || '',
        width: img?.getAttribute('width') || '',
        height: img?.getAttribute('height') || '',
        secondSrc: second?.getAttribute('src') || '',
        loadButtons: [...preview.querySelectorAll('.extension-image-load')].length
      };
    });
    assert.equal(loaded.src, url, 'explicit Load shows the consented remote source');
    assert.equal(loaded.width, '321', 'loaded image keeps author width');
    assert.equal(loaded.height, '123', 'loaded image keeps author height');
    assert.match(loaded.secondSrc, /^data:image\/svg\+xml;base64,/, 'loading one image leaves the other blocked');
    assert.equal(loaded.loadButtons, 1, 'the clicked Load control disappears while the other remains');
    assert.deepEqual(requests, [url], 'only the explicit consent may request the first remote image');
    assert.ok(!requests.includes(frame), 'raw iframe source must not be fetched during preview parsing');
    assert.ok(!requests.includes(inline), 'inline raw image markup must not be fetched during fallback parsing');
    assert.equal(await page.evaluate(() => current.content), before, 'loading an image must not change the Markdown source');
    assert.equal(await page.evaluate(() => editor.isLocked()), true, 'image Load works while the document stays locked');

    // The remaining image has independent consent and still works after unlock.
    await page.locator('#lock-document').click();
    assert.ok(!requests.includes(second), 'the second image is not fetched until its own Load click');
    await page.locator('.extension-preview .extension-image-load button').first().click();
    await page.waitForFunction(value => document.querySelector('.extension-preview img[width="200"]')?.getAttribute('src') === value, second);
    assert.equal(requests.filter(request => request === second).length, 1, 'the second image is fetched exactly once after its own Load click');
    assert.equal(requests.at(-1), second, 'no other remote resource is fetched by the Load action');
    assert.ok(requests.every(request => request === url || request === second), 'only explicitly loaded images may be requested');

    assert.deepEqual(errors, []);
    console.log('PASS: author HTML images use network-inert parsing, keep dimensions, load per-image, and stay offline until Load.');
  } finally { await session.close(); }

  // Native sanitization foster-parents an image placed directly after a table
  // row, so sanitized document order no longer matches source order. Identity
  // pairing must still attach each URL to its own rendered image.
  const cellUrl = 'https://example.com/table-cell-image.png';
  const fosteredUrl = 'https://example.com/fostered-table-image.png';
  const reordered = `# Table\n\n<table><tr><td><img src="${cellUrl}" alt="cell" width="111" height="222"></td></tr><img src="${fosteredUrl}" alt="fostered" width="333" height="444"></table>\n`;
  const pairing = await openIsolatedEditor(reordered, bundle.outfile, { width: 900, height: 620 });
  try {
    const { page, errors, requests } = pairing;
    await page.waitForFunction(() => document.querySelectorAll('.extension-preview img[width]').length === 2);
    await page.waitForFunction(() => document.querySelectorAll('.extension-image-load').length === 2);
    const order = await page.evaluate(() => [...document.querySelectorAll('.extension-preview img[width]')].map(img => img.getAttribute('width')));
    assert.deepEqual(order, ['333', '111'], 'native foster parenting puts the trailing table image before the cell image');
    assert.deepEqual(requests, []);

    await page.locator('.extension-preview img[width="111"] + .extension-image-load button').click();
    await page.waitForFunction(value => document.querySelector('.extension-preview img[width="111"]')?.getAttribute('src') === value, cellUrl);
    assert.deepEqual(requests, [cellUrl], 'the reordered cell image loads its own URL, not the first rendered position');

    await page.locator('.extension-preview img[width="333"] + .extension-image-load button').click();
    await page.waitForFunction(value => document.querySelector('.extension-preview img[width="333"]')?.getAttribute('src') === value, fosteredUrl);
    assert.deepEqual(requests, [cellUrl, fosteredUrl], 'each reordered image loads only its own destination');
    assert.deepEqual(errors, []);
    console.log('PASS: reordered sanitized images pair by identity and load their own destinations.');
  } finally { await pairing.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
