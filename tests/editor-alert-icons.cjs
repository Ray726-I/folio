const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Alert titles carry a small outline theme-colored icon immediately before
// the visible title text. Body paragraphs stay aligned (no icon, no indent),
// ordinary blockquotes stay plain, and source/editing behavior is untouched.
const source = `> [!NOTE]
> Note body here.

> [!TIP]
> Tip body here.

> [!IMPORTANT]
> Important body here.

> [!WARNING]
> Warning body here.

> [!CAUTION]
> Caution body here.

> Plain quote body.
`;

const EXPECTED = [
  { kind: 'note', title: 'Note', icon: 'i-alert-note' },
  { kind: 'tip', title: 'Tip', icon: 'i-alert-tip' },
  { kind: 'important', title: 'Important', icon: 'i-alert-important' },
  { kind: 'warning', title: 'Warning', icon: 'i-alert-warning' },
  { kind: 'caution', title: 'Caution', icon: 'i-alert-caution' },
];

async function checkAlerts(page, scopeSelector, label) {
  for (const { kind, title, icon } of EXPECTED) {
    const alert = page.locator(`${scopeSelector} .markdown-alert-${kind}`);
    assert.equal(await alert.count(), 1, `${label}: .markdown-alert-${kind} renders`);
    const titleEl = alert.locator('.markdown-alert-title');
    assert.equal(await titleEl.count(), 1, `${label}: ${kind} has one title`);
    assert.equal((await titleEl.first().textContent()).trim(), title, `${label}: ${kind} title text preserved`);
    const svg = titleEl.locator('svg');
    assert.equal(await svg.count(), 1, `${label}: ${kind} title has exactly one icon`);
    const useHref = await svg.first().locator('use').getAttribute('href');
    assert.ok(useHref === `#${icon}`, `${label}: ${kind} icon references #${icon}, got ${useHref}`);
    assert.equal(await svg.first().getAttribute('aria-hidden'), 'true', `${label}: ${kind} icon is decorative`);
    // Icon sits immediately before the title text (first child, small).
    const firstChild = await titleEl.first().evaluate(el => {
      const first = el.firstElementChild;
      return first ? { tag: first.tagName.toLowerCase(), textAfter: el.textContent.trim() } : null;
    });
    assert.equal(firstChild?.tag, 'svg', `${label}: ${kind} icon is immediately before title text`);
    const box = await svg.first().boundingBox();
    assert.ok(box && box.width > 0 && box.width < 32 && box.height > 0 && box.height < 32, `${label}: ${kind} icon is small, got ${JSON.stringify(box)}`);
    // Body stays aligned: no icon inside body, body left edge matches title text area.
    const body = alert.locator('p:not(.markdown-alert-title)');
    assert.ok(await body.count() >= 1, `${label}: ${kind} has a body paragraph`);
    assert.equal(await body.first().locator('svg').count(), 0, `${label}: ${kind} body has no icon`);
    const colors = await titleEl.first().evaluate(el => {
      const svgEl = el.querySelector('svg');
      const titleColor = getComputedStyle(el).color;
      const iconColor = svgEl ? getComputedStyle(svgEl).color : null;
      const display = getComputedStyle(el).display;
      return { titleColor, iconColor, display };
    });
    assert.equal(colors.display, 'flex', `${label}: ${kind} title lays out icon and text inline`);
    assert.equal(colors.iconColor, colors.titleColor, `${label}: ${kind} icon inherits the theme title color`);
    assert.notEqual(colors.titleColor, 'rgba(0, 0, 0, 0)', `${label}: ${kind} title color is readable`);
  }
  // Ordinary blockquote stays plain (native blockquote in edit mode lives
  // outside the extension projection, so check the whole preview).
  const quotes = page.locator(`#preview blockquote:not(.markdown-alert)`);
  assert.ok(await quotes.count() >= 1, `${label}: ordinary blockquote renders`);
  assert.equal(await quotes.first().locator('svg').count(), 0, `${label}: ordinary blockquote has no icon`);
}

(async () => {
  // Edit mode: alerts render as extension projections.
  {
    const session = await openEditor(source);
    try {
      const { page } = session;
      await page.waitForSelector('#preview .extension-preview .markdown-alert-note .markdown-alert-title');
      await page.evaluate(() => document.fonts.ready);
      for (const theme of ['paper', 'graphite']) {
        await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
        await page.waitForTimeout(120);
        await checkAlerts(page, '#preview .extension-preview', `edit/${theme}`);
      }
      // Source is untouched and the projection title still reads once.
      assert.ok((await page.evaluate(() => current.content)).includes('> [!NOTE]'), 'edit: source keeps alert markers');
      assert.deepEqual(session.errors, []);
    } finally { await session.close(); }
  }
  // Reading mode: alerts render directly in the preview.
  {
    const session = await openEditor(source, undefined, { reading: true });
    try {
      const { page } = session;
      await page.waitForSelector('#preview .markdown-alert-note .markdown-alert-title');
      await page.evaluate(() => document.fonts.ready);
      for (const theme of ['paper', 'graphite']) {
        await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
        await page.waitForTimeout(120);
        await checkAlerts(page, '#preview', `read/${theme}`);
      }
      assert.deepEqual(session.errors, []);
    } finally { await session.close(); }
  }
  console.log('PASS: alert titles carry small theme-colored outline icons; bodies stay aligned; plain quotes stay plain in edit and reading, light and dark.');
})().catch(error => { console.error(error); process.exitCode = 1; });
