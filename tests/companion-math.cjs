const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// The rich editor accepts LaTeX \[ … \] and \( … \) delimiters. The companion
// renders through the native Markdown renderer, which only understands dollar
// math, so the shell normalizes bracket delimiters before rendering.
(async () => {
  const source = '# Math\n\n\\[\nf(x) = x^2\n\\]\n\nInline \\(a+b\\).\n\n```\n\\(not math\\)\n```\n';
  const session = await openEditor(source, { width: 1200, height: 800 });
  const { page } = session;
  try {
    await page.evaluate(() => showReadingCompanion());
    await page.waitForSelector('#companion-preview h1');
    await page.waitForFunction(() => document.querySelectorAll('#companion-preview [data-math-style]').length === 2);
    await page.waitForFunction(() => document.querySelectorAll('#companion-preview .katex').length >= 2, null, { timeout: 5000 });
    const state = await page.evaluate(() => ({
      display: document.querySelectorAll('#companion-preview [data-math-style="display"]').length,
      inline: document.querySelectorAll('#companion-preview [data-math-style="inline"]').length,
      katex: document.querySelectorAll('#companion-preview .katex').length,
      code: document.querySelector('#companion-preview pre code')?.textContent || '',
      content: current.content,
    }));
    assert.equal(state.display, 1, 'bracket display math renders as display math in the companion');
    assert.equal(state.inline, 1, 'bracket inline math renders as inline math in the companion');
    assert.equal(state.katex, 2, 'both companion math nodes are typeset with KaTeX');
    assert.match(state.code, /\\\(not math\\\)/, 'bracket delimiters inside code fences stay literal');
    assert.equal(state.content, source, 'normalizing companion math never edits the document');
    assert.deepEqual(session.errors, []);
    console.log('PASS: companion renders bracket TeX delimiters as math without touching source.');
  } finally {
    await session.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
