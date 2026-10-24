const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { basename, dirname, isWithin, samePath, pathKey, setPlatform } = require('../ui/paths.js');

beforeEach(() => setPlatform('linux'));

test('basename recognizes POSIX and Windows separators', () => {
  assert.equal(basename('/tmp/notes/idea.md'), 'idea.md');
  assert.equal(basename('C:\\Users\\ray\\Documents\\idea.md'), 'idea.md');
  assert.equal(basename('C:/Users/ray/Documents/idea.md'), 'idea.md');
  assert.equal(basename('/tmp/notes/'), 'notes');
  assert.equal(basename('C:\\Users\\ray\\notes\\'), 'notes');
});

test('basename does not return separators for roots', () => {
  assert.equal(basename('/'), '');
  assert.equal(basename('\\'), '');
  assert.equal(basename('C:\\'), '');
  assert.equal(basename('C:/'), '');
  assert.equal(basename(''), '');
});

test('dirname preserves the separator spelling used by IPC', () => {
  assert.equal(dirname('/tmp/notes/idea.md'), '/tmp/notes');
  assert.equal(dirname('C:\\Users\\ray\\note.md'), 'C:\\Users\\ray');
  assert.equal(dirname('C:/Users/ray/note.md'), 'C:/Users/ray');
  assert.equal(dirname('/tmp/notes/'), '/tmp');
  assert.equal(dirname('C:\\Users\\ray\\notes\\'), 'C:\\Users\\ray');
});

test('dirname handles roots and relative paths', () => {
  assert.equal(dirname('/note.md'), '/');
  assert.equal(dirname('C:\\note.md'), 'C:\\');
  assert.equal(dirname('C:/note.md'), 'C:/');
  assert.equal(dirname('/'), '/');
  assert.equal(dirname('C:\\'), 'C:\\');
  assert.equal(dirname('note.md'), '');
  assert.equal(dirname(''), '');
});

test('isWithin recognizes native separators and path boundaries', () => {
  assert.equal(isWithin('/tmp/notes/idea.md', '/tmp/notes'), true);
  assert.equal(isWithin('/tmp/notes/idea.md', '/tmp/notes/'), true);
  assert.equal(isWithin('/tmp/notes2/idea.md', '/tmp/notes'), false);
  assert.equal(isWithin('/tmp/notes', '/tmp/notes'), false);

  assert.equal(
    isWithin('C:\\Users\\ray\\notes\\idea.md', 'C:\\Users\\ray\\notes'),
    true
  );
  assert.equal(
    isWithin('C:\\Users\\ray\\notes\\idea.md', 'C:\\Users\\ray\\notes\\'),
    true
  );
  assert.equal(
    isWithin('C:\\Users\\ray\\notes2\\idea.md', 'C:\\Users\\ray\\notes'),
    false
  );
  assert.equal(isWithin('C:\\Users\\ray\\notes', 'C:\\Users\\ray\\notes'), false);
});

test('isWithin accepts mixed separators without changing the path', () => {
  const native = 'C:\\Users\\ray\\notes\\idea.md';
  assert.equal(isWithin(native, 'C:/Users/ray/notes'), true);
  assert.equal(isWithin('C:/Users/ray/notes/idea.md', 'C:\\Users\\ray\\notes'), true);
  assert.equal(native, 'C:\\Users\\ray\\notes\\idea.md');
});

test('samePath compares native and mixed separators but ignores trailing ones', () => {
  assert.equal(samePath('/tmp/notes', '/tmp/notes/'), true);
  assert.equal(samePath('C:\\Users\\ray\\notes', 'C:/Users/ray/notes/'), true);
  assert.equal(samePath('C:\\Users\\ray\\notes', 'C:\\Users\\ray\\notes2'), false);
});

test('roots are handled when comparing nested paths', () => {
  assert.equal(isWithin('/note.md', '/'), true);
  assert.equal(isWithin('C:\\note.md', 'C:\\'), true);
  assert.equal(samePath('C:\\', 'C:/'), true);
});

test('Windows platform comparisons ignore path case', () => {
  setPlatform('windows');
  assert.equal(samePath('C:\\Users\\Ray\\Notes\\Idea.md', 'c:\\users\\ray\\notes\\idea.md'), true);
  assert.equal(isWithin('C:\\Users\\Ray\\Notes\\Idea.md', 'c:\\users\\ray\\notes'), true);
  assert.equal(isWithin('C:\\Users\\Ray\\Notes\\Idea.md', 'C:/Users/Ray/Notes/'), true);
  assert.equal(isWithin('C:\\Users\\Ray\\Notes2\\Idea.md', 'c:\\users\\ray\\notes'), false);
  assert.equal(samePath('C:\\Users\\Ray', 'C:\\Users\\Ray2'), false);
});

test('Windows platform preserves the spelling of displayed and IPC paths', () => {
  setPlatform('windows');
  const path = 'C:\\Users\\Ray\\Notes\\Idea.md';
  assert.equal(dirname(path), 'C:\\Users\\Ray\\Notes');
  assert.equal(basename(path), 'Idea.md');
  assert.equal(pathKey(path), pathKey('c:/users/ray/notes/idea.md'));
  assert.notEqual(pathKey(path), pathKey('c:/users/ray/notes/idea2.md'));
});

test('Linux and macOS comparisons remain case-sensitive', () => {
  for (const platform of ['linux', 'macos']) {
    setPlatform(platform);
    assert.equal(samePath('/tmp/Notes', '/tmp/notes'), false);
    assert.equal(isWithin('/tmp/Notes/Idea.md', '/tmp/notes'), false);
    assert.equal(pathKey('/tmp/Notes'), '/tmp/Notes');
  }
});

test('an unknown platform defaults to case-sensitive comparisons', () => {
  setPlatform(undefined);
  assert.equal(samePath('/tmp/Notes', '/tmp/notes'), false);
});
