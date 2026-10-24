'use strict';
(function (root, factory) {
  const paths = factory();
  if (typeof module === 'object' && module.exports) module.exports = paths;
  else root.FolioPaths = paths;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const isSeparator = character => character === '/' || character === '\\';
  const driveRoot = /^[A-Za-z]:[\\/]$/;

  function stripTrailingSeparators(value) {
    let end = value.length;
    while (end > 1 && isSeparator(value[end - 1])) {
      if (end === 3 && driveRoot.test(value.slice(0, end))) break;
      --end;
    }
    return value.slice(0, end);
  }

  function basename(path) {
    const value = stripTrailingSeparators(String(path ?? ''));
    if (!value || value === '/' || value === '\\' || driveRoot.test(value)) return '';
    let index = value.length;
    while (index > 0 && !isSeparator(value[index - 1])) --index;
    return value.slice(index);
  }

  function dirname(path) {
    const value = stripTrailingSeparators(String(path ?? ''));
    if (!value || value === '/' || value === '\\' || driveRoot.test(value)) return value;
    let index = value.length;
    while (index > 0 && !isSeparator(value[index - 1])) --index;
    if (index === 0) return '';
    if (index === 1) return value.slice(0, 1);
    if (index === 3 && driveRoot.test(value.slice(0, 3))) return value.slice(0, 3);
    return value.slice(0, index - 1);
  }

  // Comparison-only normalization. Never send this value back over IPC: the
  // original path string is what the native side expects to receive.
  let caseInsensitive = false;

  function setPlatform(platform) {
    caseInsensitive = String(platform ?? '').toLowerCase() === 'windows';
  }

  function comparisonPath(path) {
    const value = stripTrailingSeparators(String(path ?? '')).replace(/\\/g, '/');
    return caseInsensitive ? value.toLowerCase() : value;
  }

  function pathKey(path) {
    return comparisonPath(path);
  }

  function samePath(first, second) {
    const a = comparisonPath(first), b = comparisonPath(second);
    return Boolean(a) && a === b;
  }

  function isWithin(path, parent) {
    const child = comparisonPath(path), root = comparisonPath(parent);
    if (!child || !root || child === root) return false;
    return child.startsWith(root.endsWith('/') ? root : `${root}/`);
  }

  return { basename, dirname, pathKey, samePath, isWithin, setPlatform };
});
