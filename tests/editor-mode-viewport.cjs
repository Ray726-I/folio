const assert = require('node:assert/strict');
const { buildEditorBundle, openIsolatedEditor } = require('./editor-temp-bundle.cjs');
const source = '# Viewport\n\n' + Array.from({ length: 90 }, (_, i) => `## Section ${i}\n\n${'A long paragraph that wraps differently in each view. '.repeat(6)}\n`).join('\n');
(async () => {
  const bundle = buildEditorBundle();
  const session = await openIsolatedEditor(source, bundle.outfile, { width: 1000, height: 700 });
  try {
    const { page } = session;
    await page.waitForTimeout(250);
    await page.evaluate(() => { const s = document.querySelector('#reader-scroll'); s.style.scrollBehavior = 'auto'; s.scrollTop = 5000; });
    await page.waitForTimeout(100);
    const anchor = await page.evaluate(() => {
      const s = document.querySelector('#reader-scroll'), y = s.getBoundingClientRect().top + 80;
      const el = [...document.querySelectorAll('#preview h2')].find(e => e.getBoundingClientRect().top >= y);
      return { text: el.textContent, y: el.getBoundingClientRect().top };
    });
    await page.locator('#show-markdown').click();
    await page.waitForSelector('#source-editor .cm-content');
    await page.waitForFunction(({ text, y }) => {
      const line = [...document.querySelectorAll('#source-editor .cm-line')].find(e => e.textContent.includes(text));
      return line && Math.abs(line.getBoundingClientRect().top - y) < 180;
    }, anchor, { timeout: 5000 });
    const sourceY = await page.evaluate(text => {
      const cm = document.querySelector('#source-editor .cm-content');
      const line = [...cm.querySelectorAll('.cm-line')].find(e => e.textContent.includes(text));
      return line?.getBoundingClientRect().top;
    }, anchor.text);
    const debug = await page.evaluate(() => ({ scroll: document.querySelector('#reader-scroll').scrollTop, lines: [...document.querySelectorAll('#source-editor .cm-line')].filter(e => e.textContent.includes('Section')).slice(0, 5).map(e => e.textContent) }));
    assert.ok(sourceY != null && Math.abs(sourceY - anchor.y) < 180, `Markdown should retain ${anchor.text} (${anchor.y} -> ${sourceY}) ${JSON.stringify(debug)}`);
    await page.mouse.move(700, 400);
    for (let i = 0; i < 5; i++) {
      const before = await page.locator('#reader-scroll').evaluate(e => e.scrollTop);
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(160);
      const after = await page.locator('#reader-scroll').evaluate(e => e.scrollTop);
      assert.ok(after > before + 50, `Markdown wheel should scroll freely (${before} -> ${after})`);
    }
    const markdownAnchor = await page.evaluate(() => {
      const s = document.querySelector('#reader-scroll'), y = s.getBoundingClientRect().top + 80;
      const el = [...document.querySelectorAll('#source-editor .cm-line')].find(e => /Section \d+/.test(e.textContent) && e.getBoundingClientRect().top >= y);
      const match = el?.textContent.match(/Section \d+/);
      return match ? { text: match[0], y: el.getBoundingClientRect().top } : null;
    });
    assert.ok(markdownAnchor, 'Markdown should have a visible section after scrolling');
    await page.locator('#view-formatted').click();
    await page.waitForTimeout(400);
    const richY = await page.evaluate(text => [...document.querySelectorAll('#preview h2')].find(e => e.textContent === text)?.getBoundingClientRect().top, markdownAnchor.text);
    assert.ok(richY != null && Math.abs(richY - markdownAnchor.y) < 180, `Formatted should retain ${markdownAnchor.text} (${markdownAnchor.y} -> ${richY})`);
    assert.deepEqual(session.errors, []);
    console.log('PASS: mode switches retain the visible section when the caret is offscreen.');
  } finally { await session.close(); bundle.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
