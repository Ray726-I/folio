const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

// Code blocks soft-wrap by default; a Wrap lines toggle allows horizontal
// scrolling without changing the underlying text or introducing line breaks.
const LONG = 'a'.repeat(150) + 'END_MARKER';
const source = [
  '# Code wrap',
  '',
  '```js',
  `const longExample = "${LONG}";`,
  '  indented = 1;',
  '\ttabbed = 2;',
  '```',
  ''
].join('\n');

async function surfaceState(page, selector = '.code-container') {
  return page.locator(selector).evaluate(container => {
    const surface = container.querySelector('.code-surface');
    const code = container.querySelector('.code-surface code');
    const highlight = container.querySelector('.code-highlight');
    const surfaceStyle = getComputedStyle(surface);
    const codeStyle = code ? getComputedStyle(code) : null;
    return {
      whiteSpaceSurface: surfaceStyle.whiteSpace,
      whiteSpaceCode: codeStyle ? codeStyle.whiteSpace : null,
      overflowX: surfaceStyle.overflowX,
      scrollWidth: surface.scrollWidth,
      clientWidth: surface.clientWidth,
      canScroll: surface.scrollWidth > surface.clientWidth + 1,
      surfaceScrollLeft: surface.scrollLeft,
      highlightScrollLeft: highlight ? highlight.scrollLeft : null,
      text: code ? code.textContent : null,
      htmlHasNoWrap: document.documentElement.hasAttribute('data-code-nowrap'),
      stored: (() => { try { return localStorage.getItem('folio.codeWrap'); } catch { return 'unavailable'; } })()
    };
  });
}

(async () => {
  const bundle = buildEditorBundle();
  const session = await openIsolatedEditor(source, bundle.outfile, { width: 600, height: 700 });
  const { page } = session;
  const text = () => page.evaluate(() => current.content);
  try {
    await page.waitForFunction(() => document.querySelector('.code-container')?.classList.contains('code-highlighted'));
    const container = page.locator('.code-container').first();

    // Default: wrap on, no horizontal overflow, indentation intact.
    const initial = await surfaceState(page);
    assert.equal(initial.htmlHasNoWrap, false, 'wrap is on by default (no data-code-nowrap)');
    assert.match(initial.whiteSpaceSurface, /pre-wrap/, 'surface wraps by default');
    assert.match(initial.whiteSpaceCode, /pre-wrap/, 'code wraps by default');
    assert.equal(initial.canScroll, false, 'wrapped long line must not overflow horizontally');
    assert.ok(initial.text.includes(LONG), 'long line text is intact');
    assert.ok(initial.text.includes('  indented = 1;'), 'leading spaces are preserved');
    assert.ok(initial.text.includes('\ttabbed = 2;'), 'tabs are preserved');
    assert.equal(await text(), source, 'wrapping must not change the Markdown source');

    // Accessible per-block toggle exists and reflects state.
    const toggle = container.locator('.code-wrap-toggle');
    assert.equal(await toggle.count(), 1, 'each code block exposes a Wrap lines toggle');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'toggle is pressed while wrapping');
    assert.match((await toggle.textContent()) || '', /wrap/i, 'toggle names wrapping');
    assert.equal(await toggle.isEnabled(), true, 'toggle works in Edit mode');
    assert.equal(await page.evaluate(() => document.activeElement?.classList?.contains('code-wrap-toggle')), false, 'toggle does not steal focus on load');

    // Keyboard: the toggle is a focusable button and Enter flips to scroll mode.
    await toggle.focus();
    assert.equal(await page.evaluate(() => document.activeElement?.classList?.contains('code-wrap-toggle')), true, 'Wrap toggle is reachable by keyboard');
    assert.equal(await toggle.getAttribute('tabindex'), null, 'toggle uses the native tab order');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-code-nowrap'));
    const scrolled = await surfaceState(page);
    assert.equal(scrolled.htmlHasNoWrap, true, 'toggle off adds data-code-nowrap');
    assert.equal(scrolled.stored, 'false', 'wrap preference persists as folio.codeWrap=false');
    assert.match(scrolled.whiteSpaceSurface, /^pre$/, 'surface stops wrapping when toggled off');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'toggle reflects scroll mode');
    assert.equal(scrolled.canScroll, true, 'unwrapped long line must overflow for horizontal scrolling');
    assert.equal(await text(), source, 'toggling wrap must not rewrite source or insert line breaks');

    // Horizontal scroll stays in sync in scroll mode and preserves text.
    const sync = await page.locator('.code-container').evaluate(async c => {
      const surface = c.querySelector('.code-surface'), highlight = c.querySelector('.code-highlight');
      surface.scrollLeft = surface.scrollWidth;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { surface: surface.scrollLeft, highlight: highlight.scrollLeft, max: surface.scrollWidth - surface.clientWidth };
    });
    assert.ok(sync.surface > 0 && sync.max > 0, 'scroll mode must allow scrolling to the line end');
    assert.ok(Math.abs(sync.highlight - sync.surface) <= 1, 'highlight must follow the surface while scrolled');
    assert.equal(await text(), source, 'scrolling must not change the document');
    await page.locator('.code-container').evaluate(c => { c.querySelector('.code-surface').scrollLeft = 0; });

    // Toggle back on via click: wraps again, same text, no inserted breaks.
    await toggle.click();
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-code-nowrap'));
    const rewrapped = await surfaceState(page);
    assert.equal(rewrapped.canScroll, false, 're-enabling wrap removes horizontal overflow');
    assert.match(rewrapped.whiteSpaceCode, /pre-wrap/, 'code wraps again');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'toggle is pressed again');
    assert.equal(rewrapped.stored, 'true', 'wrap preference persists as folio.codeWrap=true');
    assert.equal(await text(), source, 're-wrapping must not insert line breaks');
    assert.ok(!(await page.locator('.code-surface code').first().evaluate(el => el.textContent.includes('\n'.repeat(2)))), 'no extra blank lines introduced');

    // Editing round-trips in both modes: type with wrap on, then with wrap off.
    await page.locator('.code-surface code').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' // edited');
    await page.waitForFunction(() => current.content.includes('// edited'));
    assert.ok((await text()).includes('// edited'), 'typing with wrap on edits source');
    assert.ok((await text()).includes(LONG), 'long line survives editing');
    await toggle.click();
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-code-nowrap'));
    await page.locator('.code-surface code').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.waitForFunction(() => current.content.includes('!'));
    assert.ok((await text()).includes('!'), 'typing with wrap off edits source');
    assert.ok((await text()).includes('// edited'), 'earlier edit survives wrap-off typing');
    const afterEdits = await surfaceState(page);
    assert.equal(afterEdits.text.includes(LONG), true, 'long line still single logical line after edits');
    assert.equal(afterEdits.text.split('\n').filter(l => l.includes('END_MARKER')).length, 1, 'soft wrap never splits the logical line');
    // Restore wrap for the remaining checks.
    await toggle.click();
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-code-nowrap'));

    // Preferences panel switch mirrors the same global state.
    await page.locator('#view-menu-button').click();
    await page.waitForFunction(() => !document.getElementById('view-menu').hidden);
    const pref = page.locator('#preference-code-wrap');
    assert.equal(await pref.count(), 1, 'Document preferences exposes Wrap long code lines');
    assert.equal(await pref.isChecked(), true, 'preferences switch is on while wrapping');
    await pref.click();
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-code-nowrap'));
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'per-block toggle follows the preferences switch');
    assert.ok((await text()).includes('// edited'), 'preferences toggle preserves text');
    await pref.click();
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-code-nowrap'));
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 're-enabling in preferences re-wraps code');
    await page.keyboard.press('Escape');

    // Read mode (locked): same wrapping, toggle stays enabled, text intact.
    await page.evaluate(() => setDocumentMode('reading'));
    await page.waitForFunction(() => document.querySelector('.code-container'));
    const readState = await surfaceState(page);
    assert.equal(readState.canScroll, false, 'reading mode wraps by default too');
    assert.equal(await toggle.isEnabled(), true, 'Wrap toggle stays available in Read mode');
    assert.equal(await page.locator('.code-fence-info').first().isDisabled(), true, 'fence info stays locked in Read mode');
    await toggle.click();
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-code-nowrap'));
    const readScroll = await surfaceState(page);
    assert.equal(readScroll.canScroll, true, 'reading mode scrolls when wrap is off');
    assert.ok((await text()).includes('END_MARKER'), 'reading-mode toggle preserves text');
    await toggle.click();
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-code-nowrap'));

    // Persistence: reload keeps the chosen wrap mode.
    await toggle.click();
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-code-nowrap'));
    await page.reload();
    await page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
    await page.evaluate(() => setDocumentMode('edit'));
    await page.waitForFunction(() => document.querySelector('.code-container'));
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-code-nowrap')), true, 'wrap-off survives reload');
    assert.equal(await page.evaluate(() => { try { return localStorage.getItem('folio.codeWrap'); } catch { return null; } }), 'false', 'stored preference survives reload');
    assert.equal(await text(), source, 'reload restores the document text unchanged');

    assert.deepEqual(session.errors, []);
    console.log('PASS: code blocks wrap by default with a persisted Wrap lines toggle; text and indentation survive in read/edit.');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
