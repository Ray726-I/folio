const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Document preferences is a settings surface, not a command menu: it has to
// stay aligned, agree with itself (readout vs thumb), apply changes without
// stalling the pointer, and remain on screen at any window size.
(async () => {
  const session = await openEditor('# Report\n\nA paragraph.\n\n## Next\n\nMore text.\n', { width: 1180, height: 900 });
  const { page } = session;
  try {
    await page.evaluate(() => applyTheme('graphite', false));
    await page.locator('#view-menu-button').click();
    await page.waitForFunction(() => !document.getElementById('view-menu').hidden);

    // Structure and focus.
    assert.equal(await page.getByRole('dialog', { name: 'Document preferences' }).count(), 1);
    assert.equal(await page.locator('#view-menu-button').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'preference-font', 'opening focuses the first preference');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#preferences-title').length), 1);

    // Look: interface typography, mono readouts, real elevation, no platform
    // form controls leaking a different accent.
    const look = await page.evaluate(() => {
      const panel = document.getElementById('view-menu');
      const range = document.getElementById('preference-width');
      const output = document.getElementById('preference-width-value');
      const row = range.closest('.preference-row');
      const right = element => Math.round(element.getBoundingClientRect().right);
      const visible = label => label.offsetParent !== null && !label.closest('.preference-disclosure:not([open])');
      const labels = [...panel.querySelectorAll('.preference-label')].filter(visible);
      const rowLabels = labels.filter(label => !label.closest('.preference-subrow'));
      return {
        labelFont: getComputedStyle(row.querySelector('.preference-label')).fontFamily,
        readoutFont: getComputedStyle(output).fontFamily,
        readoutNumeric: getComputedStyle(output).fontVariantNumeric,
        shadow: getComputedStyle(panel).boxShadow,
        radius: getComputedStyle(panel).borderRadius,
        switchAppearance: getComputedStyle(document.getElementById('preference-open-edit')).appearance,
        controls: [
          right(document.getElementById('preference-font')),
          right(document.getElementById('preference-theme')),
          right(output),
          right(document.getElementById('preference-open-edit'))
        ],
        labelLefts: new Set(rowLabels.map(label => Math.round(label.getBoundingClientRect().left))).size,
        clipped: labels.filter(label => label.scrollWidth > label.clientWidth + 1).map(label => label.textContent),
        wrapped: labels.filter(label => label.getClientRects().length > 1).map(label => label.textContent)
      };
    });
    assert.match(look.labelFont, /^Inter/, 'preference labels use the interface typeface');
    assert.match(look.readoutFont, /JetBrains Mono/, 'readouts use the mono face');
    assert.match(look.readoutNumeric, /tabular-nums/, 'readouts do not shift while a slider moves');
    assert.notEqual(look.shadow, 'none', 'the panel carries elevation');
    assert.equal(look.radius, '12px');
    assert.equal(look.switchAppearance, 'none', 'switches are drawn from theme tokens, not the platform');
    assert.equal(new Set(look.controls).size, 1, `every control shares one right edge: ${look.controls}`);
    assert.equal(look.labelLefts, 1, 'labels share one left edge');
    assert.deepEqual(look.clipped, [], 'no preference label is cut off');
    assert.deepEqual(look.wrapped, [], 'no preference label wraps at desktop width');

    // Every readout matches the thumb's snapped value, including the defaults
    // that used to fall between two range steps (900px off a 40px grid).
    const values = await page.evaluate(() => [...document.querySelectorAll('.preference-slider')].map(slider => {
      const input = slider.querySelector('input'), output = slider.querySelector('output');
      const min = Number(input.min), max = Number(input.max);
      return {
        id: input.id,
        value: Number(input.value),
        readout: output.value,
        readoutTrimmed: output.value.replace(/(px|em)$/, ''),
        fill: Number(/([\d.]+)%/.exec(input.style.getPropertyValue('--preference-fill'))?.[1])
      };
    }));
    assert.equal(values.length, 4);
    for (const entry of values) {
      assert.equal(Number(entry.readoutTrimmed), entry.value, `${entry.id} readout agrees with its thumb`);
      const input = await page.locator(`#${entry.id}`).evaluate(node => ({ min: Number(node.min), max: Number(node.max) }));
      const expected = ((entry.value - input.min) / (input.max - input.min)) * 100;
      assert.ok(Math.abs(entry.fill - expected) < 0.01, `${entry.id} track fill follows the value`);
    }

    // A drag can deliver several input events per frame; the expensive
    // document restyle must run once for all of them.
    const coalesced = await page.evaluate(async () => {
      const count = { applies: 0, original: null };
      count.original = window.applyDocumentPreferences;
      window.applyDocumentPreferences = () => { count.applies++; count.original(); };
      const input = document.getElementById('preference-width');
      const before = input.value;
      for (const value of [640, 720, 800]) {
        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const immediate = document.getElementById('preference-width-value').value;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const applied = count.applies;
      window.applyDocumentPreferences = count.original;
      input.value = before;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { applied, immediate };
    });
    assert.equal(coalesced.immediate, '800px', 'the readout follows the pointer immediately');
    assert.equal(coalesced.applied, 1, 'three input events in one frame cost one restyle');

    // Theme selection is acknowledged before the window is recoloured: the
    // change handler must not synchronously restyle the whole document.
    const theme = await page.evaluate(() => {
      const select = document.getElementById('preference-theme');
      const before = document.documentElement.dataset.theme;
      select.value = 'nord';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { before, immediately: document.documentElement.dataset.theme };
    });
    assert.equal(theme.immediately, theme.before, 'the theme applies after the select has painted');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'nord');
    assert.equal(await page.evaluate(() => !document.getElementById('view-menu').hidden), true, 'the panel stays open while browsing themes');
    assert.equal(await page.locator('#preference-theme').inputValue(), 'nord');

    // Switches read as one control: clicking the row or the switch toggles the
    // preference, and the rendering toggles live behind the disclosure.
    await page.locator('.preference-row', { hasText: 'Open documents in Edit mode' }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('folio.openInEditMode')), 'false');
    await page.locator('.preference-row', { hasText: 'Open documents in Edit mode' }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('folio.openInEditMode')), 'true');
    // The touchpad toggle must reach the native side; the IPC is stubbed here,
    // and tests/acl.rs guards the real command registration.
    await page.locator('.preference-row', { hasText: 'Touchpad pinch to zoom' }).click();
    assert.deepEqual(await page.evaluate(() => calls.filter(call => call.command === 'set_touchpad_zoom').at(-1)?.args), { enabled: true });
    assert.equal(await page.evaluate(() => localStorage.getItem('folio.touchpadZoom')), 'true');
    await page.locator('.preference-row', { hasText: 'Touchpad pinch to zoom' }).click();
    await page.locator('.preference-disclosure summary').click();
    assert.equal(await page.locator('.preference-disclosure').evaluate(node => node.open), true);
    await page.locator('.preference-row', { hasText: 'Tables' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-plain-tables')), true);
    await page.locator('.preference-row', { hasText: 'Tables' }).click();

    // Layout actions toggle in place and leave the panel open for a second
    // change, unlike a menu item that dismisses the whole surface.
    await page.locator('#width-toggle').click();
    assert.equal(await page.locator('#width-toggle').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => !document.getElementById('view-menu').hidden), true, 'toggling width keeps the panel open');
    await page.locator('#width-toggle').click();
    assert.equal(await page.locator('#width-toggle').getAttribute('aria-pressed'), 'false');
    await page.locator('#format-toggle').click();
    assert.equal(await page.locator('#format-tools').isHidden(), true, 'the toolbar hides from the panel');
    assert.equal(await page.evaluate(() => !document.getElementById('view-menu').hidden), true, 'toggling the toolbar keeps the panel open');

    // Keyboard: Tab stays inside the panel and wraps, Escape dismisses and
    // returns focus to the trigger.
    await page.locator('#preference-font').focus();
    const focusables = await page.evaluate(() => preferencesFocusables().length);
    for (let index = 1; index < focusables; index++) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'preferences-close', 'Tab wraps to the first control');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'source-snapshot', 'Shift+Tab wraps from the top');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.getElementById('view-menu').hidden), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'view-menu-button', 'Escape returns focus to the preferences button');

    // The command palette closes the panel instead of stacking over it.
    await page.locator('#view-menu-button').click();
    await page.keyboard.press('Control+Shift+P');
    assert.equal(await page.evaluate(() => document.getElementById('view-menu').hidden), true, 'opening commands dismisses preferences');
    await page.keyboard.press('Escape');

    // Reset restores defaults and leaves every control in sync.
    await page.evaluate(() => { const input = document.getElementById('preference-width'); input.value = '1200'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.locator('#view-menu-button').click();
    await page.locator('#preferences-reset').click();
    const reset = await page.evaluate(() => ({
      width: document.getElementById('preference-width').value,
      output: document.getElementById('preference-width-value').value,
      lineHeight: document.getElementById('preference-line-height').value,
      spacing: document.getElementById('preference-spacing').value,
      theme: document.getElementById('preference-theme').value,
      font: document.getElementById('preference-font').value,
      storedWidth: localStorage.getItem('folio.contentWidth'),
      toolbar: !document.getElementById('format-tools').hidden,
      open: !document.getElementById('view-menu').hidden
    }));
    assert.equal(reset.width, '900');
    assert.equal(reset.output, '900px');
    assert.equal(reset.lineHeight, '1.7');
    assert.equal(reset.spacing, '1.15');
    assert.equal(reset.theme, 'system');
    assert.equal(reset.font, 'sans');
    assert.equal(reset.storedWidth, 'null');
    assert.equal(reset.toolbar, true, 'reset restores the formatting toolbar');
    assert.equal(reset.open, true, 'reset does not dismiss the panel');

    // The panel never leaves the window: a narrow, short viewport would place
    // a trigger-anchored 372px surface off the left edge without clamping.
    await page.setViewportSize({ width: 470, height: 560 });
    await page.waitForTimeout(120);
    const placement = await page.locator('#view-menu').evaluate(node => {
      const box = node.getBoundingClientRect();
      return { left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom), viewport: [innerWidth, innerHeight] };
    });
    assert.ok(placement.left >= 8, `panel left edge stays on screen (got ${placement.left})`);
    assert.ok(placement.right <= placement.viewport[0] - 8, `panel right edge stays on screen (got ${placement.right})`);
    assert.ok(placement.top >= 8, `panel top edge stays on screen (got ${placement.top})`);
    assert.ok(placement.bottom <= placement.viewport[1] - 8, `panel bottom edge stays on screen (got ${placement.bottom})`);
    assert.equal(await page.evaluate(() => document.querySelector('.preferences-body').scrollHeight > document.querySelector('.preferences-body').clientHeight), true, 'the body scrolls instead of overflowing');

    assert.deepEqual(session.errors, []);
    console.log('PASS: preferences panel layout, snapping, coalesced restyle, deferred theme, switches, reset and viewport clamp');
  } finally {
    await session.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
