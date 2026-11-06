const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('# Heading\n\nText\n');
  try {
    const { page } = session;
    const outline = page.getByRole('button', { name: 'Outline', exact: true });
    const files = page.getByRole('button', { name: 'Files', exact: true });
    assert.equal(await outline.getAttribute('aria-pressed', { timeout: 3000 }), 'true');
    assert.equal(await page.locator('#outline').isVisible(), true);
    assert.equal(await page.locator('#file-browser').isHidden(), true);
    // The rail is the only sidebar control; the old header toggles are gone.
    assert.equal(await page.locator('#outline-toggle, #folder-toggle').count(), 0, 'the header no longer duplicates the rail toggles');
    assert.equal(await page.locator('#palette-open').count(), 0, 'the command window lives on the keyboard, not in the header');
    await files.click();
    assert.equal(await files.getAttribute('aria-pressed'), 'true');
    assert.equal(await outline.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#outline').isHidden(), true);
    assert.equal(await page.locator('#file-browser').isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Open folder', exact: true }).count() > 0, true);
    // Pressing the open mode closes the dock; pressing it again reopens it.
    await files.click();
    assert.equal(await page.locator('#file-browser').isHidden(), true, 'pressing the active mode closes the sidebar');
    assert.equal(await files.getAttribute('aria-pressed'), 'false');
    await files.click();
    assert.equal(await page.locator('#file-browser').isVisible(), true, 'pressing the closed mode reopens the sidebar');
    assert.equal(await files.getAttribute('aria-pressed'), 'true');
    // Switching modes keeps the dock open; the other mode closes independently.
    await outline.click();
    assert.equal(await page.locator('#outline').isVisible(), true);
    assert.equal(await page.locator('#file-browser').isHidden(), true);
    await outline.click();
    assert.equal(await page.locator('#outline').isHidden(), true);
    assert.equal(await outline.getAttribute('aria-pressed'), 'false');

    // The rail's search button toggles the in-document find bar.
    const search = page.getByRole('button', { name: 'Search document', exact: true });
    assert.equal(await search.getAttribute('aria-pressed'), 'false');
    await search.click();
    assert.equal(await page.locator('#find-bar').isHidden(), false, 'search opens the find bar');
    assert.equal(await search.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'find-input', 'search focuses the find input');
    await search.click();
    assert.equal(await page.locator('#find-bar').isHidden(), true, 'search closes the find bar again');
    assert.equal(await search.getAttribute('aria-pressed'), 'false');
    // The command window is still available from the keyboard.
    await page.keyboard.press('Control+Shift+P');
    assert.equal(await page.evaluate(() => document.getElementById('command-dialog').open), true, 'Ctrl+Shift+P still opens the command window');
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
