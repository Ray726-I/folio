'use strict';
const $ = id => document.getElementById(id);
const invoke = (command, args = {}) => window.__TAURI__.core.invoke(command, args);
const listen = (event, callback) => window.__TAURI__.event.listen(event, callback);
const root = document.documentElement;
const { basename, dirname, isWithin, pathKey, samePath, setPlatform } = window.FolioPaths;
const preferences = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(`folio.${key}`)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`folio.${key}`, JSON.stringify(value)); } catch {} }
};
