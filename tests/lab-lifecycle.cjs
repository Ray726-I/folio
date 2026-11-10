const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const session = await openEditor('# Test\n\nFirst paragraph.\n\nSecond paragraph.\n', undefined, { reading: true });
  const { page } = session;
  try {
    assert.equal(await page.locator('#reading-guide-toolbar').count(), 0, 'disabled guide mounts no controls');
    assert.equal(await page.evaluate(() => availableThemes().some(theme => theme.id === 'retro-terminal')), false);
    await page.evaluate(() => applyTheme('nord'));
    await page.locator('#menu-view-button').click();
    await page.locator('#application-view-menu').getByRole('menuitem', { name: 'Folio Lab' }).click();
    await page.getByRole('button', { name: 'Use Retro Terminal' }).click();
    assert.equal(await page.evaluate(() => availableThemes().some(theme => theme.id === 'retro-terminal')), true);
    await page.evaluate(() => {
      window.labObserverCounts = { created: 0, disconnected: 0 };
      for (const name of ['MutationObserver', 'ResizeObserver']) {
        const Original = window[name];
        window[name] = class extends Original {
          constructor(callback) { super(callback); window.labObserverCounts.created++; }
          disconnect() { window.labObserverCounts.disconnected++; return super.disconnect(); }
        };
      }
    });
    await page.getByRole('button', { name: 'Enable Reading Guide' }).click();
    await page.keyboard.press('Escape');
    await page.evaluate(() => setDocumentMode('reading'));
    await page.waitForFunction(() => document.getElementById('reading-guide-position')?.textContent.includes('1 of 2'));
    const guideLayout = await page.locator('#reading-guide-toolbar').evaluate(el => {
      const toolbar = el.getBoundingClientRect(), body = el.closest('.document-body').getBoundingClientRect();
      return { parent: el.parentElement?.className, width: Math.round(toolbar.width), bodyWidth: Math.round(body.width) };
    });
    assert.equal(guideLayout.parent, 'document-body', 'guide toolbar sits above the pane layout, not inside it');
    assert.ok(Math.abs(guideLayout.width - guideLayout.bodyWidth) < 2, 'guide toolbar spans the document body');
    await page.locator('#menu-view-button').click();
    await page.locator('#application-view-menu').getByRole('menuitem', { name: 'Folio Lab' }).click();
    await page.getByRole('button', { name: 'Disable Reading Guide' }).click();
    assert.equal(await page.locator('#reading-guide-toolbar').count(), 0, 'disabling removes guide controls');
    assert.equal(await page.locator('#reading-guide-marker').count(), 0, 'disabling removes marker');
    assert.deepEqual(await page.evaluate(() => window.labObserverCounts), { created: 5, disconnected: 5 }, 'disabling disconnects extension observers');
    assert.equal(await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      return $('reader-scroll').dispatchEvent(event);
    }), true, 'disabled guide no longer handles arrow keys');
    await page.getByRole('button', { name: 'Disable Retro Terminal' }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'nord', 'disabling restores the previous theme');
    assert.equal(await page.evaluate(() => availableThemes().some(theme => theme.id === 'retro-terminal')), false);
    assert.equal(await page.locator('#preference-theme option[value="retro-terminal"]').count(), 0);
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'nord');
    assert.equal(await page.locator('#reading-guide-toolbar').count(), 0);
    assert.equal(await page.evaluate(() => availableThemes().some(theme => theme.id === 'retro-terminal')), false);
    await page.locator('#menu-view-button').click();
    await page.locator('#application-view-menu').getByRole('menuitem', { name: 'Folio Lab' }).click();
    await page.getByRole('button', { name: 'Enable Reading Guide' }).click();
    await page.keyboard.press('Escape');
    await page.evaluate(() => setDocumentMode('reading'));
    await page.waitForFunction(() => document.getElementById('reading-guide-position')?.textContent.includes('1 of 2'));
    await page.locator('#reader-scroll').focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.getElementById('reading-guide-position').textContent.includes('2 of 2'));
    await page.evaluate(() => { localStorage.setItem('folio.theme', JSON.stringify('retro-terminal')); localStorage.removeItem('folio.labRetroEnabled'); });
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'retro-terminal');
    assert.equal(await page.evaluate(() => availableThemes().some(theme => theme.id === 'retro-terminal')), true, 'old active theme remains available after upgrading');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('menu-view-button')).fontFamily.includes('JetBrains Mono'));
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
