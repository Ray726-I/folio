const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

(async () => {
  const session = await openEditor('# A title\n\nA paragraph with `inline code`.\n\n## A section\n\nMore text.\n');
  try {
    const { page } = session;
    for (const theme of ['paper', 'graphite', 'nord', 'catppuccin', 'rose-pine', 'solarized', 'system']) {
      const styles = await page.evaluate(theme => {
        applyTheme(theme, false);
        const style = selector => getComputedStyle(document.querySelector(selector));
        const heading = style('.sidebar-heading h2');
        const meta = style('.sidebar-meta');
        const code = style('#preview :not(pre) > code');
        const body = style('#preview');
        return {
          headingSize: parseFloat(heading.fontSize), headingTransform: heading.textTransform,
          metaColor: meta.color, muted: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim(),
          codeColor: code.color, bodyColor: body.color, codeBorder: code.borderTopWidth,
          lineHeight: parseFloat(body.lineHeight) / parseFloat(body.fontSize),
        };
      }, theme);
      assert.equal(styles.headingTransform, 'none', `${theme}: sidebar heading uses sentence case`);
      assert.ok(styles.headingSize >= 12, `${theme}: sidebar heading remains readable`);
      assert.equal(styles.metaColor, await page.evaluate(() => { const el = document.createElement('span'); el.style.color = 'var(--muted)'; document.body.append(el); const color = getComputedStyle(el).color; el.remove(); return color; }), `${theme}: metadata uses the theme's muted text color`);
      assert.equal(styles.codeColor, styles.bodyColor, `${theme}: inline code uses document text color`);
      assert.equal(styles.codeBorder, '0px', `${theme}: inline code has no decorative border`);
      assert.ok(styles.lineHeight >= 1.6 && styles.lineHeight <= 1.7, `${theme}: comfortable reading rhythm`);
    }
    assert.deepEqual(session.errors, []);
    console.log('PASS: editorial foundation remains consistent across built-in themes.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
