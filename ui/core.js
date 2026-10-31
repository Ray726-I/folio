'use strict';
const $ = id => document.getElementById(id);
const invoke = (command, args = {}) => window.__TAURI__.core.invoke(command, args);
const listen = (event, callback) => window.__TAURI__.event.listen(event, callback);
const root = document.documentElement;
function updateCompactHeader() {
  const screenWidth = window.screen?.availWidth || window.screen?.width || window.innerWidth;
  root.toggleAttribute('data-compact-modes', window.innerWidth < screenWidth * 0.67);
  root.toggleAttribute('data-compact-saved', window.innerWidth < screenWidth * 0.55);
}
window.addEventListener('resize', updateCompactHeader);
updateCompactHeader();
const header = document.querySelector('.headerbar');
const headerSides = [header.querySelector('.header-start'), header.querySelector('.header-end')];
function updateHeaderTitleSpace() {
  const width = Math.max(...headerSides.map(side => side.getBoundingClientRect().width));
  header.style.setProperty('--header-side-reserve', `${Math.ceil(width + 18)}px`);
}
const headerObserver = new ResizeObserver(updateHeaderTitleSpace);
headerSides.forEach(side => headerObserver.observe(side));
window.addEventListener('resize', updateHeaderTitleSpace);
updateHeaderTitleSpace();
const { basename, dirname, isWithin, pathKey, samePath, setPlatform } = window.FolioPaths;
const preferences = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(`folio.${key}`)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`folio.${key}`, JSON.stringify(value)); } catch {} }
};
