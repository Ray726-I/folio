const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

// Extension syntax can force a heading block into the raw fallback. The outline
// must still list that heading at its real source offset, following ordinary
// headings must not shift, and duplicate headings must use the native slug
// suffix convention so links such as #repeat-1 resolve.
(async () => {
  const bundle = buildEditorBundle();
  process.on('exit', () => bundle.cleanup());
  const source = '# :smile: Welcome\n\n## Real section\n\n# Repeat\n\n# Repeat\n\n[go](#repeat-1)\n';
  const session = await openIsolatedEditor(source, bundle.outfile, { width: 900, height: 700 });
  const { page, errors } = session;
  try {
    await page.waitForFunction(() => !editor.isSource());
    await page.evaluate(() => { if (document.getElementById('outline').hidden) setOutline(true); });
    await page.waitForFunction(() => document.querySelectorAll('#outline-items .outline-link').length === 4);
    await page.waitForFunction(() => document.querySelector('#outline-items .outline-link')?.textContent === '😄 Welcome');

    const outline = await page.evaluate(() => [...document.querySelectorAll('#outline-items .outline-link')].map(button => button.textContent));
    assert.deepEqual(outline, ['😄 Welcome', 'Real section', 'Repeat', 'Repeat']);

    // Clicking the extension heading must select its own block, not Real section.
    await page.locator('#outline-items .outline-link').first().click();
    assert.equal(await page.evaluate(() => editor.getSelection().anchor), source.indexOf(':smile:'),
      'the extension heading maps to the start of its visible text');
    await page.locator('#outline-items .outline-link').nth(1).click();
    assert.equal(await page.evaluate(() => editor.getSelection().anchor), source.indexOf('Real section'),
      'the heading after an extension heading maps to the next heading text');

    // Native duplicate slugs are doc-repeat and doc-repeat-1. The outline must
    // carry those identities, and a #repeat-1 link must resolve to the second.
    const ids = await page.evaluate(() => outlineEntries.map(entry => entry.id));
    assert.deepEqual(ids, ['doc--welcome', 'doc-real-section', 'doc-repeat', 'doc-repeat-1']);

    await page.evaluate(() => {
      const anchor = document.createElement('a');
      anchor.setAttribute('href', '#repeat-1');
      followPreviewLink(anchor);
    });
    const secondRepeat = source.lastIndexOf('# Repeat');
    assert.equal(await page.evaluate(() => editor.getSelection().anchor), secondRepeat,
      'a #repeat-1 link must select the second duplicate heading');

    // find the first Repeat through the outline and re-check #doc-repeat-1 too.
    await page.evaluate(() => {
      const anchor = document.createElement('a');
      anchor.setAttribute('href', '#doc-repeat-1');
      followPreviewLink(anchor);
    });
    assert.equal(await page.evaluate(() => editor.getSelection().anchor), secondRepeat,
      'the doc-prefixed duplicate id must resolve too');

    const shifted = 'A new paragraph\n\n' + source;
    await page.evaluate(value => { current.content = value; editor.replaceContent(value); refreshEditorOutline(); }, shifted);
    assert.equal(await page.locator('#outline-items .outline-link').count(), 4, 'shifted extension heading remains in current source outline');
    await page.locator('#outline-items .outline-link').first().click();
    assert.equal(await page.evaluate(() => editor.getSelection().anchor), shifted.indexOf(':smile:'), 'stale extension sourcepos never selects the old offset');

    await page.evaluate(() => { current.content = '# Math $x$\n\n## Before\n'; editor.replaceContent(current.content); refreshEditorOutline(); });
    assert.deepEqual(await page.evaluate(() => outlineEntries.map(entry => entry.id)), ['doc-math-x', 'doc-before']);
    await page.evaluate(() => { current.content = '# Changed\n\n## New\n'; editor.replaceContent(current.content); refreshEditorOutline(); });
    assert.deepEqual(await page.locator('#outline-items .outline-link').allTextContents(), ['Changed', 'New'], 'the outline follows the current document, not a stale rich DOM');
    await page.locator('#outline-items .outline-link').nth(1).click();
    assert.equal(await page.evaluate(() => editor.getSelection().anchor), '# Changed\n\n## '.length);
    // Markdown mode removed in the single-editor migration.

    assert.deepEqual(errors, []);
    console.log('PASS: extension headings keep their offset, and duplicate heading links use native slug identities.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
