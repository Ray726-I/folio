const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Focused regression: header controls must not shift horizontally when the
// save state flips between Saved and Edited. The indicator keeps a compact,
// stable footprint (fixed width near the old Saved width, end-aligned); the
// short "Edited" label carries the full "Unsaved changes" meaning in its
// accessible name and tooltip.
(async () => {
  const session = await openEditor('# Title\n\nA paragraph.\n');
  const { page } = session;
  try {
    const box = id =>
      page.locator(`#${id}`).evaluate(node => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, width: rect.width };
      });

    // Start clean: save once so the indicator reads Saved.
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => current.content === current.saved && !busy);
    assert.equal(await page.locator('#save-state').textContent(), 'Saved');
    assert.equal(await page.locator('#save-state').getAttribute('data-state'), 'saved');

    const clean = {
      state: await box('save-state'),
      viewSwitch: await box('view-switch'),
      lock: await box('lock-document'),
      save: await box('save'),
      palette: await box('palette-open'),
    };

    // Compact footprint: near the old Saved width, nowhere near the 116px gap.
    assert.ok(
      clean.state.width <= 72,
      `save-state must stay compact near Saved width (got ${clean.state.width}px, old gap was 116px)`,
    );

    // Make the document dirty.
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' DIRTY');
    await page.waitForFunction(() => current.content !== current.saved);
    assert.equal(await page.locator('#save-state').textContent(), 'Edited');
    assert.equal(await page.locator('#save-state').getAttribute('data-state'), 'dirty');
    assert.equal(await page.locator('#save-state').isHidden(), false);
    const gap = await page.locator('#save-state').evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      return range.getBoundingClientRect().left - node.previousElementSibling.getBoundingClientRect().right;
    });
    assert.ok(gap <= 22, `save label must sit close to its divider (gap ${gap}px)`);
    // Accessible full meaning: short label still announces unsaved changes.
    assert.match(
      await page.locator('#save-state').getAttribute('aria-label'),
      /unsaved changes/i,
      'dirty accessible name must carry the full "unsaved changes" meaning',
    );
    assert.match(
      await page.locator('#save-state').evaluate(node => node.title),
      /unsaved changes/i,
      'dirty tooltip must carry the full "unsaved changes" meaning',
    );

    const dirty = {
      state: await box('save-state'),
      viewSwitch: await box('view-switch'),
      lock: await box('lock-document'),
      save: await box('save'),
      palette: await box('palette-open'),
    };

    // Stable footprint: the indicator keeps its width across states.
    assert.ok(
      Math.abs(dirty.state.width - clean.state.width) <= 1,
      `save-state width must stay fixed (Saved ${clean.state.width}px vs Edited ${dirty.state.width}px)`,
    );
    // Compact in both states.
    assert.ok(
      dirty.state.width <= 72,
      `dirty save-state must stay compact (got ${dirty.state.width}px, old gap was 116px)`,
    );
    // Neighbors must not shift: view switch, lock, save, palette stay put.
    for (const key of ['viewSwitch', 'lock', 'save', 'palette']) {
      assert.ok(
        Math.abs(dirty[key].x - clean[key].x) <= 1.5,
        `${key} shifted by ${(dirty[key].x - clean[key].x).toFixed(2)}px when save state changed`,
      );
    }

    // Readable states preserved: the dirty short label fits without ellipsis.
    assert.equal(
      await page.locator('#save-state').evaluate(node => node.scrollWidth > node.clientWidth + 1),
      false,
      'Edited must fit without truncation at desktop width',
    );
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => current.content === current.saved && !busy);
    assert.equal(
      await page.locator('#save-state').evaluate(node => node.scrollWidth > node.clientWidth + 1),
      false,
      'Saved must fit without truncation at desktop width',
    );
    // Go dirty again for the narrow check.
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' NARROW');
    await page.waitForFunction(() => current.content !== current.saved);

    // Keep the label near the divider rather than leaving a visible gap.
    assert.equal(await page.locator('#save-state').evaluate(node => getComputedStyle(node).textAlign), 'start');

    // Narrow headers keep the same guarantee with a compact fixed width.
    await page.setViewportSize({ width: 600, height: 800 });
    await page.waitForTimeout(250);
    const narrowDirtyWidth = (await box('save-state')).width;
    assert.equal(await page.locator('#save-state').isHidden(), false, 'narrow widths must keep the save state visible');
    assert.ok(
      narrowDirtyWidth <= 72,
      `narrow save-state must stay compact (got ${narrowDirtyWidth}px)`,
    );
    assert.equal(
      await page.locator('#save-state').evaluate(node => node.scrollWidth > node.clientWidth + 1),
      false,
      'Edited must fit without truncation at narrow width',
    );
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => current.content === current.saved && !busy);
    const narrowClean = await box('save-state');
    assert.equal(await page.locator('#save-state').isHidden(), false, 'narrow widths must keep the save state visible');
    assert.ok(
      Math.abs(narrowClean.width - narrowDirtyWidth) <= 1,
      `narrow save-state width must stay fixed (${narrowClean.width}px vs ${narrowDirtyWidth}px)`,
    );

    assert.deepEqual(session.errors, []);
    console.log('PASS: save-state keeps a compact stable footprint; Saved/Edited do not shift header controls.');
  } finally {
    await session.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
