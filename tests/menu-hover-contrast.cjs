const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Chrome menus paint hover with the --hover token. That token has to read as a
// change against the surfaces it lands on (panel menus, toolbar surface, page
// background) without turning a tinted theme grey: a theme's hover must be a
// step in that theme's own hue, not a neutral wash.
const MATTE_BLACK = {
  name: 'Matte Black',
  mode: 'dark',
  colors: {
    background: '#121212', foreground: '#bebebe', dark_background: '#0d0d0d',
    lighter_background: '#1e1e1e', accent: '#e68e0d', selection: '#2a2a2a',
    green: '#ffc107', red: '#d35f5f', yellow: '#b91c1c', blue: '#e68e0d', magenta: '#d35f5f'
  }
};
const CATPPUCCIN_LATTE = {
  name: 'Catppuccin Latte',
  mode: 'light',
  colors: {
    background: '#eff1f5', foreground: '#4c4f69', dark_background: '#e3e4e8',
    lighter_background: '#dce0e8', accent: '#1e66f5', selection: '#ccd0da',
    green: '#40a02b', red: '#d20f39', yellow: '#df8e1d', blue: '#1e66f5', magenta: '#ea76cb'
  }
};

function parseColor(value) {
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value);
  if (srgb) return { r: +srgb[1] * 255, g: +srgb[2] * 255, b: +srgb[3] * 255, a: srgb[4] === undefined ? 1 : +srgb[4] };
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(value);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] === undefined ? 1 : +rgb[4] };
  throw new Error(`Unparsed colour: ${value}`);
}
const chroma = color => Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
const hue = color => {
  const max = Math.max(color.r, color.g, color.b), min = Math.min(color.r, color.g, color.b), delta = max - min;
  if (delta === 0) return 0;
  const angle = max === color.r ? ((color.g - color.b) / delta + (color.g < color.b ? 6 : 0)) * 60
    : max === color.g ? ((color.b - color.r) / delta + 2) * 60
    : ((color.r - color.g) / delta + 4) * 60;
  return angle;
};
const shift = (first, second) => ((first.r - second.r) + (first.g - second.g) + (first.b - second.b)) / 3;
const hueDistance = (first, second) => Math.abs(((first - second + 540) % 360) - 180);

(async () => {
  const session = await openEditor('# A title\n\nSome text.\n', undefined, { reading: true });
  try {
    const { page } = session;
    const cases = [
      { theme: 'omarchy', palette: MATTE_BLACK, label: 'Omarchy · Matte Black' },
      { theme: 'omarchy', palette: CATPPUCCIN_LATTE, label: 'Omarchy · Catppuccin Latte' },
      { theme: 'paper', label: 'Adwaita Light' },
      { theme: 'graphite', label: 'Adwaita Dark' },
      { theme: 'nord', label: 'Nord' },
      { theme: 'catppuccin', label: 'Catppuccin Mocha' },
      { theme: 'rose-pine', label: 'Rosé Pine' },
      { theme: 'solarized', label: 'Solarized Light' }
    ];

    for (const testCase of cases) {
      await page.evaluate(({ theme, palette }) => {
        document.documentElement.removeAttribute('style');
        if (palette) { omarchy = palette; applyTheme('omarchy', false); }
        else applyTheme(theme, false);
      }, { theme: testCase.theme, palette: testCase.palette || null });
      await page.locator('#menu-file-button').focus();
      await page.keyboard.press('ArrowDown');
      await page.locator('#open-menu > .menu-item').nth(2).hover();
      const measured = await page.evaluate(() => {
        const item = document.querySelectorAll('#open-menu > .menu-item')[2];
        const sample = value => {
          const probe = document.createElement('span');
          probe.style.background = value;
          document.body.append(probe);
          const color = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return color;
        };
        return {
          hovered: item.matches(':hover'),
          fill: getComputedStyle(item).backgroundColor,
          token: sample('var(--hover)'),
          panel: sample('var(--panel)'),
          surface: sample('var(--surface)'),
          bg: sample('var(--bg)'),
          light: getComputedStyle(document.documentElement).colorScheme.includes('light')
        };
      });
      await page.keyboard.press('Escape');

      assert.equal(measured.hovered, true, `${testCase.label}: the row is under the pointer`);
      assert.deepEqual(parseColor(measured.fill), parseColor(measured.token), `${testCase.label}: the row paints the theme's hover colour`);
      const fill = parseColor(measured.token);
      assert.equal(fill.a, 1, `${testCase.label}: hover is an opaque palette colour`);
      for (const surface of ['panel', 'surface', 'bg']) {
        const base = parseColor(measured[surface]);
        const delta = shift(fill, base);
        const label = `${testCase.label}: hover against --${surface}`;
        assert.ok(Math.abs(delta) >= 8, `${label} moves by at least 8 levels (was ${delta.toFixed(1)})`);
        assert.equal(Math.sign(delta), measured.light ? -1 : 1, `${label} follows the theme direction (${delta.toFixed(1)})`);
      }
      const panel = parseColor(measured.panel);
      if (chroma(panel) >= 12) {
        assert.ok(chroma(fill) >= chroma(panel) * .6, `${testCase.label}: hover keeps the panel's colour (${chroma(fill).toFixed(0)} vs ${chroma(panel).toFixed(0)})`);
        assert.ok(hueDistance(hue(fill), hue(panel)) <= 12, `${testCase.label}: hover keeps the panel's hue (${hue(fill).toFixed(0)} vs ${hue(panel).toFixed(0)})`);
      }
    }

    assert.deepEqual(session.errors, []);
    console.log('PASS: hover is a distinct step of each theme\'s own surface, not a grey wash.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
