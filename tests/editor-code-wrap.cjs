const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');

// Code blocks soft-wrap by default; a Wrap lines entry in the code-block
// context menu toggles horizontal scrolling without changing text or source.
// No visible button is parked on the block.
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

async function openCodeMenu(page) {
  const menu = page.locator('.folio-document-menu');
  await page.locator('.code-container').first().click({ button: 'right' });
  await menu.waitFor({ state: 'visible' });
  return menu;
}

async function wrapMenuItem(page) {
  const menu = await openCodeMenu(page);
  const item = menu.getByRole('menuitemcheckbox', { name: /wrap lines/i });
  assert.equal(await item.count(), 1, 'code context menu exposes Wrap lines');
  return { menu, item };
}

(async () => {
  const bundle = buildEditorBundle();
  const session = await openIsolatedEditor(source, bundle.outfile, { width: 600, height: 700 });
  const { page } = session;
  const text = () => page.evaluate(() => current.content);
  try {
    await page.waitForFunction(() => document.querySelector('.code-container')?.classList.contains('code-highlighted'));

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

    // No visible button is parked on the block.
    assert.equal(await page.locator('.code-wrap-toggle').count(), 0, 'no visible Wrap toggle button in block');
    assert.equal(await page.locator('.code-container button').count(), 0, 'code block exposes no visible buttons');
    assert.equal(await page.evaluate(() => document.activeElement?.classList?.contains('code-wrap-toggle')), false, 'no toggle to steal focus on load');

    // Context menu entry exists, reflects state, stays enabled.
    {
      const { menu, item } = await wrapMenuItem(page);
      assert.equal(await item.getAttribute('aria-checked'), 'true', 'menu wrap is checked while wrapping');
      assert.equal(await item.isEnabled(), true, 'wrap entry works in Edit mode');
      assert.equal(await menu.getAttribute('role'), 'menu', 'context menu keeps menu role');
      // Keyboard: arrows move within the menu, Escape dismisses.
      await item.focus();
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitemcheckbox', 'Wrap entry is reachable by keyboard');
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
    }

    // Toggle off via the context menu: scroll mode, same text, no new breaks.
    {
      const { item } = await wrapMenuItem(page);
      await item.click();
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-code-nowrap'));
    }
    const scrolled = await surfaceState(page);
    assert.equal(scrolled.htmlHasNoWrap, true, 'menu toggle off adds data-code-nowrap');
    assert.equal(scrolled.stored, 'false', 'wrap preference persists as folio.codeWrap=false');
    assert.match(scrolled.whiteSpaceSurface, /^pre$/, 'surface stops wrapping when toggled off');
    assert.equal(scrolled.canScroll, true, 'unwrapped long line must overflow for horizontal scrolling');
    assert.equal(await text(), source, 'toggling wrap must not rewrite source or insert line breaks');
    {
      const { item } = await wrapMenuItem(page);
      assert.equal(await item.getAttribute('aria-checked'), 'false', 'menu reflects scroll mode');
      await page.keyboard.press('Escape');
    }

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

    // Toggle back on via the context menu: wraps again, same text.
    {
      const { item } = await wrapMenuItem(page);
      await item.click();
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-code-nowrap'));
    }
    const rewrapped = await surfaceState(page);
    assert.equal(rewrapped.canScroll, false, 're-enabling wrap removes horizontal overflow');
    assert.match(rewrapped.whiteSpaceCode, /pre-wrap/, 'code wraps again');
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
    {
      const { item } = await wrapMenuItem(page);
      await item.click();
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-code-nowrap'));
    }
    await page.locator('.code-surface code').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.waitForFunction(() => current.content.includes('!'));
    assert.ok((await text()).includes('!'), 'typing with wrap off edits source');
    assert.ok((await text()).includes('// edited'), 'earlier wrap-on edit survives wrap-off typing');
    const afterEdits = await surfaceState(page);
    assert.equal(afterEdits.text.includes(LONG), true, 'long line still single logical line after edits');
    assert.equal(afterEdits.text.split('\n').filter(l => l.includes('END_MARKER')).length, 1, 'soft wrap never splits the logical line');
    // Restore wrap for the remaining checks.
    {
      const { item } = await wrapMenuItem(page);
      await item.click();
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-code-nowrap'));
    }

    // Preferences panel switch mirrors the same global state.
    await page.locator('#view-menu-button').click();
    await page.waitForFunction(() => !document.getElementById('view-menu').hidden);
    const pref = page.locator('#preference-code-wrap');
    assert.equal(await pref.count(), 1, 'Document preferences exposes Wrap long code lines');
    assert.equal(await pref.isChecked(), true, 'preferences switch is on while wrapping');
    await pref.click();
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-code-nowrap'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('view-menu').hidden);
    {
      const { item } = await wrapMenuItem(page);
      assert.equal(await item.getAttribute('aria-checked'), 'false', 'context menu follows the preferences switch');
      await page.keyboard.press('Escape');
    }
    assert.ok((await text()).includes('// edited'), 'preferences toggle preserves text');
    await page.locator('#view-menu-button').click();
    await page.waitForFunction(() => !document.getElementById('view-menu').hidden);
    await page.locator('#preference-code-wrap').click();
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-code-nowrap'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('view-menu').hidden);
    {
      const { item } = await wrapMenuItem(page);
      assert.equal(await item.getAttribute('aria-checked'), 'true', 're-enabling in preferences re-wraps code');
      await page.keyboard.press('Escape');
    }
    await page.keyboard.press('Escape');

    // Read mode (locked): same wrapping, menu entry stays enabled, text intact.
    await page.evaluate(() => setDocumentMode('reading'));
    await page.waitForFunction(() => document.querySelector('.code-container'));
    const readState = await surfaceState(page);
    assert.equal(readState.canScroll, false, 'reading mode wraps by default too');
    assert.equal(await page.locator('.code-wrap-toggle').count(), 0, 'reading mode has no visible toggle either');
    assert.equal(await page.locator('.code-fence-info').first().isDisabled(), true, 'fence info stays locked in Read mode');
    {
      const { item } = await wrapMenuItem(page);
      assert.equal(await item.isEnabled(), true, 'Wrap entry stays available in Read mode');
      await item.click();
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-code-nowrap'));
    }
    const readScroll = await surfaceState(page);
    assert.equal(readScroll.canScroll, true, 'reading mode scrolls when wrap is off');
    assert.ok((await text()).includes('END_MARKER'), 'reading-mode toggle preserves text');
    {
      const { item } = await wrapMenuItem(page);
      await item.click();
      await page.waitForFunction(() => !document.documentElement.hasAttribute('data-code-nowrap'));
    }

    // Non-code blocks must not offer wrapping.
    await page.evaluate(() => setDocumentMode('edit'));
    await page.locator('#preview h1').first().click({ button: 'right' });
    await page.locator('.folio-document-menu').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.folio-document-menu').getByRole('menuitemcheckbox', { name: /wrap lines/i }).count(), 0, 'plain blocks have no Wrap entry');
    await page.keyboard.press('Escape');

    // Persistence: reload keeps the chosen wrap mode.
    {
      const { item } = await wrapMenuItem(page);
      await item.click();
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-code-nowrap'));
    }
    await page.reload();
    await page.waitForFunction(() => typeof editor !== 'undefined' && editor && !busy);
    await page.evaluate(() => setDocumentMode('edit'));
    await page.waitForFunction(() => document.querySelector('.code-container'));
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-code-nowrap')), true, 'wrap-off survives reload');
    assert.equal(await page.evaluate(() => { try { return localStorage.getItem('folio.codeWrap'); } catch { return null; } }), 'false', 'stored preference survives reload');
    assert.equal(await text(), source, 'reload restores the document text unchanged');

    assert.deepEqual(session.errors, []);
    console.log('PASS: code blocks wrap by default with a persisted context-menu Wrap lines entry; text and indentation survive in read/edit.');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
