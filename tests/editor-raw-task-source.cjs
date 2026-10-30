const assert = require('node:assert/strict');
const path = require('node:path');
require('esbuild').buildSync({ entryPoints: ['ui/editor/rich.js'], bundle: true, packages: 'external', platform: 'node', format: 'cjs', outfile: 'target/editor-raw-task-source.cjs', logLevel: 'silent' });
const { rawTaskMarkers } = require(path.resolve('target/editor-raw-task-source.cjs'));

const source = '- [x] first\n- [ ] second\n  - [ ] nested\n    - [X] deep\n';
assert.deepEqual(rawTaskMarkers(source), [
  { offset: 3, checked: true },
  { offset: 15, checked: false },
  { offset: 30, checked: false },
  { offset: 47, checked: true }
]);

// Escaped list markers and escaped brackets are not tasks; a fenced example
// must not contribute a position even though its text looks identical.
for (const text of ['- \\[ ] escaped bracket\n', '\\- [ ] escaped marker\n', '```\n- [ ] fenced fake\n```\n', 'Prose [ ] is not a task\n']) {
  assert.deepEqual(rawTaskMarkers(text), [], text);
}

// Nested tasks and tasks inside a blockquote retain source order.
assert.deepEqual(rawTaskMarkers('> - [ ] quote\n>   - [x] nested quote\n'), [
  { offset: 5, checked: false },
  { offset: 21, checked: true }
]);

// Duplicate text is resolved by position, never by text lookup.
assert.deepEqual(rawTaskMarkers('- [ ] duplicate\n- [ ] duplicate\n'), [
  { offset: 3, checked: false },
  { offset: 19, checked: false }
]);

// CRLF source keeps offsets byte-exact.
assert.deepEqual(rawTaskMarkers('- [ ] a\r\n  - [x] b\r\n'), [
  { offset: 3, checked: false },
  { offset: 14, checked: true }
]);

console.log('PASS: raw task markers are source-exact for nested lists, escapes, fences, blockquotes, duplicates and CRLF.');
