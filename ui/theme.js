'use strict';
// Theme definitions, palette derivation, and Mermaid colour configuration.
let omarchy = null, selectedTheme = preferences.get('theme', 'system');
const themes = [
  { id: 'system', label: 'System', detail: 'Follow light / dark appearance', swatch: 'linear-gradient(90deg, #fafafa 50%, #242424 50%)' },
  { id: 'paper', label: 'Adwaita Light', detail: 'Clean and familiar', swatch: '#fafafa' },
  { id: 'graphite', label: 'Adwaita Dark', detail: 'Soft charcoal', swatch: '#303030' },
  { id: 'nord', label: 'Nord', detail: 'Cool and quiet', swatch: '#88c0d0' },
  { id: 'catppuccin', label: 'Catppuccin Mocha', detail: 'Warm pastel accents', swatch: '#cba6f7' },
  { id: 'rose-pine', label: 'Rosé Pine', detail: 'Muted purple and rose', swatch: '#eb6f92' },
  { id: 'solarized', label: 'Solarized Light', detail: 'Warm paper', swatch: '#fdf6e3' }
];
const cssProbe = document.createElement('div');
cssProbe.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;pointer-events:none';
document.body.append(cssProbe);
function normalizeColor(value) {
  if (!value || value === 'transparent' || /^rgba?\([^,]+,[^,]+,[^,]+,\s*0(?:\.0*)?\s*\)$/.test(value) || /\/\s*0(?:\.0*)?\s*\)$/.test(value)) return 'transparent';
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value);
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
  const channels = srgb ? srgb.slice(1, 4).map(channel => Number(channel) * 255) : rgb?.slice(1, 4).map(Number);

  if (channels) return '#' + channels.map(channel => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0')).join('');
  return value;
}
function cssVarColor(name) {
  // Read solid theme tokens directly. WebKit may report transparent for an
  // off-screen probe before first layout, even while root tokens are valid.
  const declared = getComputedStyle(root).getPropertyValue(name).trim();
  if (!declared) return 'transparent';
  if (/^#[0-9a-f]{6}$/i.test(declared)) return declared.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(declared)) return '#' + [...declared.slice(1)].map(value => value + value).join('').toLowerCase();
  if (/^(?:rgba?\(|color\(srgb)/.test(declared)) return normalizeColor(declared);
  cssProbe.style.backgroundColor = '';
  cssProbe.style.backgroundColor = declared || `var(${name})`;
  // Mixed-color surface tokens still need CSS evaluation. Give the probe a
  // real layout box and flush it before inspecting the resolved background.
  cssProbe.getBoundingClientRect();
  return normalizeColor(getComputedStyle(cssProbe).backgroundColor);
}

function colorChannels(color) { return [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16)); }
function mixColors(first, second, amount) {
  const other = colorChannels(second);
  return '#' + colorChannels(first).map((channel, index) => Math.round(channel * (1 - amount) + other[index] * amount).toString(16).padStart(2, '0')).join('');
}
function colorLuminance(color) {
  return colorChannels(color).map(channel => channel / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
}
function colorContrast(first, second) {
  const a = colorLuminance(first), b = colorLuminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
function readableColor(color, background, minimum = 4.6) {
  if (colorContrast(color, background) >= minimum) return color;
  const target = colorContrast('#ffffff', background) > colorContrast('#000000', background) ? '#ffffff' : '#000000';
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 12; iteration++) {
    const middle = (low + high) / 2;
    if (colorContrast(mixColors(color, target, middle), background) >= minimum) high = middle;
    else low = middle;
  }
  return mixColors(color, target, high);
}
let paletteFrame = 0, paletteRetries = 0;
function updatePreviewPalette() {
  const names = ['bg', 'fg', 'accent', 'blue', 'purple', 'green', 'yellow', 'red'];
  const values = names.map(name => cssVarColor(`--${name}`));
  if (!values.every(value => /^#[0-9a-f]{6}$/i.test(value))) {
    // A native WebKit page can run deferred scripts before its first usable
    // layout. Keep CSS foreground fallbacks until actual theme colors exist.
    if (!paletteFrame && paletteRetries < 10) {
      paletteRetries++;
      paletteFrame = requestAnimationFrame(() => {
        paletteFrame = 0;
        if (updatePreviewPalette()) scheduleDiagramRefresh(0);
      });
    }
    return false;
  }
  paletteRetries = 0;
  if (paletteFrame) { cancelAnimationFrame(paletteFrame); paletteFrame = 0; }
  ++diagramThemeRevision;
  const [background, foreground] = values;
  const dark = colorLuminance(background) < .35;
  // Keep body text at full strength in both appearances.
  const body = readableColor(foreground, background, 7);
  const strong = readableColor(mixColors(foreground, dark ? '#ffffff' : '#000000', dark ? .06 : .12), background, 7);
  root.style.setProperty('--read-body', body);
  root.style.setProperty('--read-strong', strong);
  for (const name of ['accent', 'blue', 'purple', 'green', 'yellow', 'red']) {
    const color = values[names.indexOf(name)];
    root.style.setProperty(`--read-${name}`, readableColor(color, background));
  }

  const node = mixColors(background, foreground, .045);
  root.style.setProperty('--diagram-node', node);
  root.style.setProperty('--diagram-border', readableColor(mixColors(foreground, background, .35), node, 3));
  root.style.setProperty('--diagram-line', readableColor(mixColors(foreground, background, .22), background, 3));
  return true;
}
// Node surfaces shared by the diagram families that read primary/actor
// colours instead of the categorical palette. A 4.5% lift disappears at
// reading size, so those diagrams rendered as bare outlines on the page;
// nodes now sit on a real card with an accent-tinted border, while nested
// containers keep the quieter --diagram-node fill.
function diagramSurface() {
  const background = cssVarColor('--bg');
  const foreground = cssVarColor('--fg');
  const dark = colorLuminance(background) < .35;
  return {
    background,
    dark,
    card: mixColors(background, foreground, dark ? .12 : .07),
    cardSoft: mixColors(background, foreground, dark ? .06 : .035)
  };
}
function mermaidThemeCSS() {
  const { cardSoft } = diagramSurface();
  // Mermaid 11 derives ER attribute rows from the primary colour's lightness
  // minus 5% and 10%, so dark themes paint near-black bands inside a themed
  // entity. The rows carry no class, only that inline hsl() fill.
  return `.node[id*="-entity-"] path[fill^="hsl("] { fill: ${cardSoft} !important; }`;
}
function mermaidThemeVariables() {
  const { background, dark, card, cardSoft } = diagramSurface();
  const node = cssVarColor('--diagram-node'), border = cssVarColor('--diagram-border');
  const text = cssVarColor('--read-strong'), line = cssVarColor('--diagram-line');
  const accent = cssVarColor('--accent');
  const cardBorder = readableColor(mixColors(accent, card, .4), card, 3);
  const colors = ['blue', 'green', 'yellow', 'purple', 'red'].map(name => cssVarColor(`--read-${name}`));
  const palette = [...new Set([...colors, ...colors.map((color, index) => mixColors(color, colors[(index + 1) % colors.length], .5)), mixColors(colors[0], colors[2], .5), mixColors(colors[1], colors[3], .5)])];

  for (let index = 0; palette.length < 12 && index < 24; index++) {
    const color = mixColors(colors[index % colors.length], background, .08 + index * .02);
    if (!palette.includes(color)) palette.push(color);
  }
  const blueIndex = palette.indexOf(colors[0]), purpleIndex = palette.indexOf(colors[3]), redIndex = palette.indexOf(colors[4]);
  const doneIndex = Math.max(1, palette.indexOf(colors[1] === colors[0] ? mixColors(colors[1], colors[2], .5) : colors[1]));
  const chartInk = dark ? '#ffffff' : '#171717';
  const fills = palette.map(color => readableColor(mixColors(color, background, dark ? .45 : .75), chartInk));
  const categorical = {};
  for (let index = 0; index < palette.length; index++) {
    categorical[`pie${index + 1}`] = readableColor(palette[index], dark ? '#171717' : '#ffffff');
    categorical[`cScale${index}`] = fills[index];
    categorical[`cScaleLabel${index}`] = chartInk;
    categorical[`cScalePeer${index}`] = readableColor(palette[index], fills[index], 3);
    categorical[`cScaleInv${index}`] = categorical[`cScalePeer${index}`];
  }
  // Git graphs index their own branch colours (git0…git7) and none of the
  // cScale slots, so every branch used to fall back to the Mermaid default.
  for (let index = 0; index < 8; index++) {
    const branch = readableColor(palette[index % palette.length], background, 3);
    categorical[`git${index}`] = branch;
    categorical[`gitBranchLabel${index}`] = readableColor(chartInk, branch, 4.5);
  }
  return {
    ...categorical,
    darkMode: dark,
    background,
    fontFamily: '"Inter","Adwaita Sans","Cantarell",system-ui,sans-serif',
    fontSize: '15px',
    primaryColor: card,
    primaryTextColor: text,
    primaryBorderColor: cardBorder,
    lineColor: line,
    secondaryColor: card,
    secondaryTextColor: text,
    secondaryBorderColor: cardBorder,
    tertiaryColor: card,
    tertiaryTextColor: text,
    tertiaryBorderColor: cardBorder,
    textColor: text,
    titleColor: text,
    mainBkg: card,
    nodeBorder: cardBorder,
    clusterBkg: background,
    clusterBorder: border,
    edgeLabelBackground: background,
    actorBkg: card,
    actorBorder: cardBorder,
    actorTextColor: text,
    actorLineColor: line,
    signalColor: line,
    signalTextColor: text,
    labelBoxBkgColor: card,
    labelTextColor: text,
    labelBoxBorderColor: cardBorder,
    noteBkgColor: cardSoft,
    noteTextColor: text,
    noteBorderColor: cardBorder,
    activationBkgColor: cssVarColor('--selection'),
    activationBorderColor: cardBorder,
    compositeBackground: node,
    compositeTitleBackground: cardSoft,
    attributeBackgroundColorOdd: card,
    attributeBackgroundColorEven: cardSoft,
    sequenceNumberColor: text,
    pieSectionTextColor: dark ? '#171717' : '#ffffff',
    pieLegendTextColor: text,
    pieTitleTextColor: text,
    pieStrokeColor: background,
    pieOuterStrokeColor: border,
    pieStrokeWidth: '1.5px',
    pieOuterStrokeWidth: '1px',
    pieOpacity: '1',
    pieSectionTextSize: '15px',
    pieLegendTextSize: '15px',
    taskBkgColor: fills[blueIndex],
    taskBorderColor: categorical[`cScalePeer${blueIndex}`],
    activeTaskBkgColor: fills[purpleIndex],
    activeTaskBorderColor: categorical[`cScalePeer${purpleIndex}`],
    doneTaskBkgColor: fills[doneIndex],
    doneTaskBorderColor: categorical[`cScalePeer${doneIndex}`],
    critBkgColor: fills[redIndex],
    critBorderColor: categorical[`cScalePeer${redIndex}`],
    taskTextColor: chartInk,
    taskTextLightColor: chartInk,
    taskTextDarkColor: chartInk,
    taskTextOutsideColor: text,
    sectionBkgColor: mixColors(background, colors[0], .06),
    sectionBkgColor2: mixColors(background, colors[3], .06),
    altSectionBkgColor: background,
    gridColor: cssVarColor('--line'),
    todayLineColor: colors[4]
  };
}
function availableThemes() { return omarchy ? [...themes, { id: 'omarchy', label: 'Omarchy', detail: `Current: ${omarchy.name}`, swatch: omarchy.colors.accent || '#7d82d9' }] : themes; }
// Tokens written to the root by the Omarchy palette. Theme changes clear just
// these; a blanket style reset also dropped --text-size and the reader's
// spacing preferences, forcing a full reflow with the wrong metrics.
const inlineThemeVariables = ['--bg', '--fg', '--surface', '--panel', '--accent', '--selection', '--green', '--red', '--yellow', '--blue', '--purple', '--accent-ink',
  // Derived colours are recomputed below; drop stale ones so a palette that
  // cannot resolve yet never leaves the previous theme's reading ink behind.
  '--read-body', '--read-strong', '--read-accent', '--read-blue', '--read-purple', '--read-green', '--read-yellow', '--read-red',
  '--diagram-node', '--diagram-border', '--diagram-line'];
let diagramRefreshTimer = 0;
// Theme switches can arrive in quick succession (arrow keys in the palette,
// an OS appearance event). Coalesce the diagram refresh so only the settled
// theme pays for re-rendering every Mermaid block.
function scheduleDiagramRefresh(delay = 160) {
  clearTimeout(diagramRefreshTimer);
  diagramRefreshTimer = setTimeout(() => {
    diagramRefreshTimer = 0;
    if (typeof refreshMermaid === 'function') refreshMermaid();
    if (typeof scheduleCompanionRender === 'function') scheduleCompanionRender(0);
  }, delay);
}
function applyTheme(id, persist = true) {
  selectedTheme = id;
  for (const variable of inlineThemeVariables) root.style.removeProperty(variable);
  root.style.removeProperty('color-scheme');
  root.dataset.theme = id === 'omarchy' && !omarchy ? 'system' : id;
  if (id === 'omarchy' && omarchy) {
    const colors = omarchy.colors;
    const map = { '--bg': 'background', '--fg': 'foreground', '--surface': 'dark_background', '--panel': 'lighter_background', '--accent': 'accent', '--selection': 'selection', '--green': 'green', '--red': 'red', '--yellow': 'yellow', '--blue': 'blue', '--purple': 'magenta' };
    const fallbacks = { '--surface': 'color-mix(in srgb, var(--fg) 4%, var(--bg))', '--panel': 'color-mix(in srgb, var(--fg) 7%, var(--bg))', '--selection': 'color-mix(in srgb, var(--accent) 22%, var(--bg))' };
    for (const [variable, key] of Object.entries(map)) root.style.setProperty(variable, colors[key] || fallbacks[variable] || colors.accent || colors.foreground);
    root.style.colorScheme = omarchy.mode === 'light' ? 'light' : 'dark';
  }
  paletteRetries = 0;
  const paletteReady = updatePreviewPalette();
  const accent = getComputedStyle(root).getPropertyValue('--accent').trim();
  if (/^#[0-9a-f]{6}$/i.test(accent)) {
    const channels = [1, 3, 5].map(index => parseInt(accent.slice(index, index + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    root.style.setProperty('--accent-ink', luminance > .179 ? '#161616' : '#ffffff');
  }
  $('theme-label').textContent = id === 'omarchy' && omarchy ? `Omarchy · ${omarchy.name}` : availableThemes().find(theme => theme.id === id)?.label || 'System';
  if (persist) preferences.set('theme', id);
  if ($('command-dialog').open) renderCommands();
  if (paletteReady) scheduleDiagramRefresh();
}
