const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');
(async () => {
  const source = Array.from({ length: 60 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1}: text for the reader to follow.\n`).join('\n');
  const session = await openEditor(source, { width: 1200, height: 650 });
  const { page } = session;
  try {
    await page.evaluate(() => showReadingCompanion());
    await page.waitForSelector('#companion-preview h2');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const sync = page.getByRole('checkbox', { name: 'Sync scroll' });
    assert.equal(await sync.isVisible(), true);
    await page.locator('#reader-scroll').evaluate(el => { el.scrollTop = el.scrollHeight * .5; });
    await sync.check();
    await page.waitForFunction(() => document.getElementById('companion-scroll').scrollTop > 500, null, { timeout: 3000 });
    const alignment = await page.evaluate(() => {
      const main = $('reader-scroll').getBoundingClientRect(), right = $('companion-scroll').getBoundingClientRect();
      const offset = editor.sourceAtCoords({ left: main.left + main.width / 2, top: main.top + 16 });
      const leftLine = offset == null ? null : current.content.slice(0, offset).split('\n').length;
      const visible = companionSyncPositions.find(entry => entry.node.getBoundingClientRect().bottom > right.top + 2);
      return { leftLine, rightLine: visible?.line };
    });
    assert.notEqual(alignment.leftLine, null, 'formatted editor maps screen position to source');
    assert.ok(Math.abs(alignment.leftLine - alignment.rightLine) <= 4, `panes show the same source area: ${JSON.stringify(alignment)}`);
    await page.evaluate(() => { $('companion-scroll').scrollTop = 0; $('reader-scroll').scrollTop = $('reader-scroll').scrollHeight * .7; });
    await page.waitForFunction(() => document.getElementById('companion-scroll').scrollTop > 800, null, { timeout: 3000 });
    await page.evaluate(() => { window.otherDoc = { documentId: 'other', name: 'Other.md', content: '# Other', saved: '# Other', active: true, revision: 0 }; showReadingCompanion(window.otherDoc, false); });
    assert.equal(await sync.isVisible(), false, 'sync is hidden for different documents');
    await page.evaluate(() => showReadingCompanion(current, false));
    assert.equal(await sync.isVisible(), true, 'sync is offered for the same document even when pinned');
    await page.waitForFunction(() => $('companion-preview').querySelectorAll('h2').length === 60);
    await sync.check();
    await page.evaluate(() => { $('companion-scroll').scrollTop = 0; $('reader-scroll').scrollTop = 0; });
    await page.evaluate(() => { $('reader-scroll').scrollTop = $('reader-scroll').scrollHeight * .5; });
    await page.waitForFunction(() => $('companion-scroll').scrollTop > 500, null, { timeout: 3000 });
    await page.evaluate(() => setDocumentMode('reading'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => { $('companion-scroll').scrollTop = 0; $('reader-scroll').scrollTop = $('reader-scroll').scrollHeight * .6; });
    await page.waitForFunction(() => $('companion-scroll').scrollTop > 500, null, { timeout: 3000 });
    await page.evaluate(() => setDocumentMode('source'));
    await page.locator('#document-source').evaluate(el => { el.scrollTop = el.scrollHeight * .7; });
    await page.waitForFunction(() => $('companion-scroll').scrollTop > 800, null, { timeout: 3000 });
    assert.deepEqual(session.errors, []);
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
