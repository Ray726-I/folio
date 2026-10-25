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
cssProbe.style.position = 'fixed'; cssProbe.style.left = '-9999px'; cssProbe.style.pointerEvents = 'none';
document.body.append(cssProbe);
function normalizeColor(value) {
  if (!value) return 'transparent';
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value);
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
  const channels = srgb ? srgb.slice(1, 4).map(channel => Number(channel) * 255) : rgb?.slice(1, 4).map(Number);

  if (channels) return '#' + channels.map(channel => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0')).join('');
  return value;
}
function cssVarColor(name) {
  cssProbe.style.backgroundColor = '';
  cssProbe.style.backgroundColor = `var(${name})`;
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
function updatePreviewPalette() {
  ++diagramThemeRevision;
  const background = cssVarColor('--bg'), foreground = cssVarColor('--fg');
  const dark = colorLuminance(background) < .35;
  const body = readableColor(mixColors(foreground, background, .18), background, colorContrast(foreground, background) >= 7 ? 7 : 4.6);
  const strong = readableColor(mixColors(foreground, dark ? '#ffffff' : '#000000', dark ? .06 : .12), background, 7);
  root.style.setProperty('--read-body', body);
  root.style.setProperty('--read-strong', strong);
  for (const name of ['accent', 'blue', 'purple', 'green', 'yellow', 'red']) {
    const color = cssVarColor(`--${name}`);
    root.style.setProperty(`--read-${name}`, readableColor(dark ? mixColors(color, '#ffffff', .15) : color, background));
  }

  const node = mixColors(background, foreground, .045);
  root.style.setProperty('--diagram-node', node);
  root.style.setProperty('--diagram-border', readableColor(mixColors(foreground, background, .35), node, 3));
  root.style.setProperty('--diagram-line', readableColor(mixColors(foreground, background, .22), background, 3));
}
function mermaidThemeVariables() {
  const background = cssVarColor('--bg');
  const dark = colorLuminance(background) < .35;
  const node = cssVarColor('--diagram-node'), border = cssVarColor('--diagram-border');
  const text = cssVarColor('--read-strong'), line = cssVarColor('--diagram-line');
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
  return {
    ...categorical,
    darkMode: dark,
    background: cssVarColor('--bg'),
    fontFamily: '"Inter","Adwaita Sans","Cantarell",system-ui,sans-serif',
    fontSize: '15px',
    primaryColor: node,
    primaryTextColor: text,
    primaryBorderColor: border,
    lineColor: line,
    secondaryColor: cssVarColor('--surface'),
    secondaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryColor: node,
    tertiaryTextColor: text,
    tertiaryBorderColor: border,
    textColor: text,
    titleColor: text,
    mainBkg: node,
    nodeBorder: border,
    clusterBkg: background,
    clusterBorder: border,
    edgeLabelBackground: background,
    actorBkg: node,
    actorBorder: border,
    actorTextColor: text,
    actorLineColor: line,
    signalColor: line,
    signalTextColor: text,
    labelBoxBkgColor: background,
    labelTextColor: text,
    labelBoxBorderColor: border,
    noteBkgColor: cssVarColor('--hover'),
    noteTextColor: text,
    noteBorderColor: border,
    activationBkgColor: cssVarColor('--selection'),
    activationBorderColor: border,
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
function mermaidConfig() {
  return {
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'base', look: 'classic',
    themeVariables: mermaidThemeVariables(), fontFamily: '"Inter","Adwaita Sans","Cantarell",system-ui,sans-serif',
    flowchart: { htmlLabels: true, curve: 'basis', nodeSpacing: 36, rankSpacing: 46, padding: 16, diagramPadding: 8, useMaxWidth: true },
    sequence: { useMaxWidth: true },
    gantt: { fontSize: 14, sectionFontSize: 14, barHeight: 24, barGap: 8 }
  };
}
function availableThemes() { return omarchy ? [...themes, { id: 'omarchy', label: 'Omarchy', detail: `Current: ${omarchy.name}`, swatch: omarchy.colors.accent || '#7d82d9' }] : themes; }
function applyTheme(id, persist = true) {
  selectedTheme = id;
  root.removeAttribute('style'); zoomText(0);
  root.dataset.theme = id === 'omarchy' && !omarchy ? 'system' : id;
  if (id === 'omarchy' && omarchy) {
    const colors = omarchy.colors;
    const map = { '--bg': 'background', '--fg': 'foreground', '--surface': 'dark_background', '--panel': 'lighter_background', '--accent': 'accent', '--selection': 'selection', '--green': 'green', '--red': 'red', '--yellow': 'yellow', '--blue': 'blue', '--purple': 'magenta' };
    const fallbacks = { '--surface': 'color-mix(in srgb, var(--fg) 4%, var(--bg))', '--panel': 'color-mix(in srgb, var(--fg) 7%, var(--bg))', '--selection': 'color-mix(in srgb, var(--accent) 22%, var(--bg))' };
    for (const [variable, key] of Object.entries(map)) root.style.setProperty(variable, colors[key] || fallbacks[variable] || colors.accent || colors.foreground);
    root.style.colorScheme = omarchy.mode === 'light' ? 'light' : 'dark';
  }
  updatePreviewPalette();
  const accent = getComputedStyle(root).getPropertyValue('--accent').trim();
  if (/^#[0-9a-f]{6}$/i.test(accent)) {
    const channels = [1, 3, 5].map(index => parseInt(accent.slice(index, index + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    root.style.setProperty('--accent-ink', luminance > .179 ? '#161616' : '#ffffff');
  }
  $('theme-label').textContent = id === 'omarchy' && omarchy ? `Omarchy · ${omarchy.name}` : availableThemes().find(theme => theme.id === id)?.label || 'System';
  if (persist) preferences.set('theme', id);
  if ($('command-dialog').open) renderCommands();
  refreshMermaid();
}
