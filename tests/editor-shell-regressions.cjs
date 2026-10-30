const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

const A = '# Alpha\n\nAlpha paragraph.\n';
const B = '# Beta\n\nBeta paragraph.\n';
const TASKS = '# Tasks\n\n- [ ] alpha\n- [ ] beta\n';
const A_PATH = '/tmp/test.md';
const B_PATH = '/tmp/beta.md';
const FOLDER_PATH = '/tmp/notes';
const FOLDER_LISTING = {
  name: 'notes',
  entries: [{ path: '/tmp/notes/note.md', name: 'note.md', directory: false, depth: 0 }],
  truncated: false,
  skipped: 0
};

async function waitForPendingOpen(page, path) {
  await page.waitForFunction(expected => window.openGateState(expected)?.pending === true, path);
}
async function waitForPendingFolder(page, path) {
  await page.waitForFunction(expected => window.folderGateState(expected)?.pending === true, path);
}
async function waitForPendingNewDocument(page) {
  await page.waitForFunction(() => window.newDocumentGateState()?.pending === true);
}
async function snapshot(page) {
  return page.evaluate(() => ({
    path: current.path, content: current.content, text: editor.getText(), saved: current.saved,
    dirty: current.content !== current.saved, mode, busy
  }));
}
async function assertPendingOpenRejected(page, before, label) {
  const after = await snapshot(page);
  assert.deepEqual({ path: after.path, content: after.content, text: after.text, dirty: after.dirty }, {
    path: before.path, content: before.content, text: before.text, dirty: before.dirty
  }, `${label} must be rejected while the open of ${B_PATH} is pending`);
}
async function assertPendingReplacementRejected(page, before, label) {
  const after = await snapshot(page);
  assert.deepEqual({ path: after.path, content: after.content, text: after.text, dirty: after.dirty }, {
    path: before.path, content: before.content, text: before.text, dirty: before.dirty
  }, `${label} must be rejected while the current document is being replaced`);
}
async function editorDomState(page) {
  return page.evaluate(() => {
    const rich = document.querySelector('#preview .ProseMirror');
    const source = document.querySelector('#source-editor .cm-content');
    const visible = node => Boolean(node && node.getClientRects().length);
    return {
      mode,
      richVisible: visible(rich),
      sourceVisible: visible(source),
      richText: rich?.textContent ?? '',
      richStrong: rich?.querySelectorAll('strong').length ?? 0,
      sourceText: source?.textContent ?? ''
    };
  });
}
async function pasteInto(page, selector, text) {
  await page.evaluate(({ selector, text }) => {
    const target = document.querySelector(selector);
    const data = new DataTransfer(); data.setData('text/plain', text);
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, { selector, text });
}

async function presentationToggle() {
  const session = await openEditor('# Title\n\nA paragraph.\n');
  try {
    const { page } = session;
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() => !busy && mode === 'edit');
    assert.equal(await page.locator('#source-editor .cm-content').evaluate(node => node.contains(document.activeElement)), true,
      'Ctrl+E must focus the new presentation so typing continues without another click');
    await page.keyboard.type('SOURCE');
    assert.equal(await page.evaluate(() => current.content), '# Title\n\nA paragraph.SOURCE\n');
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() => !busy && mode === 'read');
    await page.keyboard.type('RICH');
    assert.equal(await page.evaluate(() => current.content), '# Title\n\nA paragraph.SOURCERICH\n');
    assert.deepEqual(session.errors, []);
    console.log('PASS: keyboard presentation toggle keeps typing focus and caret in both directions.');
  } finally { await session.close(); }
}

// Acceptance scenario 1: clean A, B's native open deferred after the discard
// guard, rich input/undo/formatting must not mutate A.
async function richPendingOpen() {
  const session = await openEditor(A);
  const { page } = session;
  try {
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    const before = await snapshot(page);
    assert.equal(before.path, A_PATH);
    assert.equal(before.dirty, false, 'A must start clean so the open needs no discard prompt');

    await session.holdOpen(B_PATH, B);
    await page.evaluate(path => { void requestOpen(path); }, B_PATH);
    await waitForPendingOpen(page, B_PATH);
    assert.equal((await snapshot(page)).path, A_PATH, 'A must remain current while B is pending');
    assert.equal(await page.locator('#preview .ProseMirror').evaluate(node => node.contains(document.activeElement)), true,
      'rich editor must retain focus before testing rejected keyboard input');

    await page.keyboard.type('RICH');
    await assertPendingOpenRejected(page, before, 'Rich editor typing');

    await page.evaluate(() => editor.command('heading'));
    await assertPendingOpenRejected(page, before, 'Rich editor formatting command');

    await page.evaluate(() => editor.undo());
    await assertPendingOpenRejected(page, before, 'Rich editor undo');

    await session.releaseOpen(B_PATH);
    await page.waitForFunction(path => current.path === path && !busy, B_PATH);
    const after = await snapshot(page);
    assert.equal(after.path, B_PATH);
    assert.equal(after.content, B, 'B must become current after the deferred open completes');
    assert.equal(after.text, B);
    assert.equal(after.mode, 'read');
    assert.equal(await page.evaluate(() => editor.isLocked()), false, 'the freshly opened document must be editable');
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    assert.equal(await page.locator('#preview .ProseMirror').evaluate(node => node.contains(document.activeElement)), true,
      'rich editor must receive focus before testing resumed typing');
    await page.keyboard.type('RESUMED');
    const resumed = await snapshot(page);
    assert.equal(resumed.content, '# Beta\n\nBeta paragraph.RESUMED\n');
    assert.equal(resumed.text, resumed.content, 'the rich editor must expose the resumed edit');
    assert.deepEqual(session.errors, []);
    console.log('PASS: pending native open rejects rich typing, formatting, and undo without mutating A, and B is editable afterwards.');
  } finally { await session.close(); }
}

// Acceptance scenario 1 (source presentation): clean A in Markdown presentation,
// B deferred; CodeMirror input must not mutate A.
async function sourcePendingOpen() {
  const session = await openEditor(A);
  const { page } = session;
  try {
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() => !busy && mode === 'edit');
    await page.locator('#source-editor .cm-content').click();
    const before = await snapshot(page);
    assert.equal(before.path, A_PATH);
    assert.equal(before.dirty, false);
    assert.equal(await page.evaluate(() => editor.isSource()), true);

    await session.holdOpen(B_PATH, B);
    await page.evaluate(path => { void requestOpen(path); }, B_PATH);
    await waitForPendingOpen(page, B_PATH);
    assert.equal(await page.locator('#source-editor .cm-content').evaluate(node => node.contains(document.activeElement)), true,
      'Markdown editor must retain focus before testing rejected keyboard input');

    await page.keyboard.type('MARKDOWN');
    await assertPendingOpenRejected(page, before, 'Markdown source typing');

    await page.evaluate(() => editor.undo());
    await assertPendingOpenRejected(page, before, 'Markdown source undo');

    await session.releaseOpen(B_PATH);
    await page.waitForFunction(path => current.path === path && !busy, B_PATH);
    const after = await snapshot(page);
    assert.equal(after.path, B_PATH);
    assert.equal(after.content, B);
    assert.equal(after.text, B);
    assert.equal(after.mode, 'read');
    assert.equal(await page.evaluate(() => editor.isLocked()), false);
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() => !busy && mode === 'edit');
    assert.equal(await page.locator('#source-editor .cm-content').evaluate(node => node.contains(document.activeElement)), true,
      'Markdown editor must receive focus before testing resumed typing');
    await page.keyboard.type('RESUMED');
    const resumed = await snapshot(page);
    assert.equal(resumed.content, '# Beta\n\nBeta paragraph.RESUMED\n');
    assert.equal(resumed.text, resumed.content, 'the Markdown source editor must expose the resumed edit');
    assert.deepEqual(session.errors, []);
    console.log('PASS: pending native open rejects Markdown source typing and undo without mutating A, and B is editable afterwards.');
  } finally { await session.close(); }
}

// Folder scans are async too: typing after the discard check but before the
// scan resolves must not edit A, which is about to be replaced by the folder view.
async function folderPendingOpen() {
  const session = await openEditor(A);
  const { page } = session;
  try {
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    const before = await snapshot(page);
    assert.equal(before.path, A_PATH);
    assert.equal(before.dirty, false, 'A must start clean so the folder open needs no discard prompt');

    await session.holdFolder(FOLDER_PATH, FOLDER_LISTING);
    await page.evaluate(path => { void enqueue(() => openFolderPath(path)); }, FOLDER_PATH);
    await waitForPendingFolder(page, FOLDER_PATH);
    assert.equal((await snapshot(page)).path, A_PATH, 'A must remain current while the folder scan is pending');

    await page.keyboard.type('LOST');
    await assertPendingOpenRejected(page, before, 'Typing while a folder open is pending');

    await session.releaseFolder(FOLDER_PATH);
    await page.waitForFunction(path => !busy && activeFolder?.path === path && !current.active, FOLDER_PATH);
    assert.equal(await page.evaluate(() => $('folder-name').textContent), 'notes', 'the released folder must become active');
    assert.equal(await page.evaluate(() => current.path), null, 'the folder view must not retain the previous document path');
    assert.equal(await page.evaluate(() => editor), null, 'the previous document editor must be torn down with the folder view');
    assert.deepEqual(session.errors, []);
    console.log('PASS: typing while a folder scan is pending cannot mutate the outgoing document, and the released folder opens.');
  } finally { await session.close(); }
}

// A failed folder scan must leave A and its persistent user Lock intact; the
// temporary transition guard must never be mistaken for the user Lock.
async function folderRejectedOpenPreservesLock() {
  const session = await openEditor(A);
  const { page } = session;
  try {
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.evaluate(() => editor.setLocked(true));
    const before = await snapshot(page);

    await session.holdFolder(FOLDER_PATH, FOLDER_LISTING, 'SIMULATED_FOLDER_FAILURE');
    await page.evaluate(path => { void enqueue(() => openFolderPath(path)); }, FOLDER_PATH);
    await waitForPendingFolder(page, FOLDER_PATH);
    await page.evaluate(() => editor.setLocked(false));
    assert.equal(await page.evaluate(() => editor.isLocked()), true,
      'an unlock attempt during a folder transition must not clear the persistent user Lock');

    await page.keyboard.type('BLOCKED');
    await assertPendingOpenRejected(page, before, 'Typing while a folder transition is protected and user-locked');

    await session.rejectFolder(FOLDER_PATH, 'SIMULATED_FOLDER_FAILURE');
    await page.waitForFunction(() => !busy);
    const after = await snapshot(page);
    assert.deepEqual({ path: after.path, content: after.content, text: after.text, dirty: after.dirty }, {
      path: before.path, content: before.content, text: before.text, dirty: before.dirty
    }, 'a rejected folder scan must leave A path/content/dirty intact');
    assert.equal(await page.evaluate(() => editor.isLocked()), true, 'folder rejection cleanup must retain the user Lock');
    assert.match(await page.locator('#toast').textContent(), /SIMULATED_FOLDER_FAILURE/, 'the rejected folder scan must be reported');

    await page.evaluate(() => editor.setLocked(false));
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.type('RESUMED');
    const resumed = await snapshot(page);
    assert.equal(resumed.content, '# Alpha\n\nAlpha paragraph.RESUMED\n', 'an explicit unlock must restore editing after folder rejection');
    assert.deepEqual(session.errors, []);
    console.log('PASS: a rejected folder scan preserves A and the persistent user Lock, which remains independent of transition protection.');
  } finally { await session.close(); }
}

// Acceptance scenario 5: a native open/read rejection leaves A untouched and
// restores editing and ordinary history after transition protection is released.
async function rejectedOpenCleanup() {
  const session = await openEditor(A);
  const { page } = session;
  try {
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    const before = await snapshot(page);
    assert.equal(before.dirty, false);

    await session.holdOpen(B_PATH, B, 'SIMULATED_OPEN_FAILURE');
    await page.evaluate(path => { void requestOpen(path); }, B_PATH);
    await waitForPendingOpen(page, B_PATH);
    await page.keyboard.type('BLOCKED');
    await assertPendingOpenRejected(page, before, 'Typing during a failing open');

    await session.rejectOpen(B_PATH, 'SIMULATED_OPEN_FAILURE');
    await page.waitForFunction(() => !busy);
    const after = await snapshot(page);
    assert.deepEqual({ path: after.path, content: after.content, text: after.text, dirty: after.dirty }, {
      path: before.path, content: before.content, text: before.text, dirty: before.dirty
    }, 'a rejected native open must leave A path/content/dirty intact');
    assert.equal(await page.evaluate(() => editor.isLocked()), false, 'rejection cleanup must not leave a lock behind');
    assert.match(await page.locator('#toast').textContent(), /SIMULATED_OPEN_FAILURE/, 'the rejected open must be reported');

    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.type('RESUMED');
    const resumed = await snapshot(page);
    assert.equal(resumed.content, '# Alpha\n\nAlpha paragraph.RESUMED\n', 'editing must resume after rejection');
    await page.evaluate(() => editor.undo());
    const undone = await snapshot(page);
    assert.deepEqual({ content: undone.content, text: undone.text, dirty: undone.dirty }, {
      content: before.content, text: before.text, dirty: before.dirty
    }, 'ordinary undo must keep working after rejection cleanup');
    assert.deepEqual(session.errors, []);
    console.log('PASS: rejected native open preserves A, releases transition protection, and restores editing/undo.');
  } finally { await session.close(); }
}

// Persistent Lock is user state, not transition state: an unlock attempt while
// a native open is pending must neither bypass protection nor clear the lock.
async function rejectionPreservesUserLock() {
  const session = await openEditor(A);
  const { page } = session;
  try {
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.evaluate(() => editor.setLocked(true));
    const before = await snapshot(page);

    await session.holdOpen(B_PATH, B, 'SIMULATED_OPEN_FAILURE');
    await page.evaluate(path => { void requestOpen(path); }, B_PATH);
    await waitForPendingOpen(page, B_PATH);
    await page.evaluate(() => editor.setLocked(false));
    assert.equal(await page.evaluate(() => editor.isLocked()), true,
      'an unlock attempt during a transition must not clear the persistent user Lock');

    await page.keyboard.type('BLOCKED');
    await assertPendingOpenRejected(page, before, 'Typing while transition-protected and user-locked');

    await session.rejectOpen(B_PATH, 'SIMULATED_OPEN_FAILURE');
    await page.waitForFunction(() => !busy);
    const after = await snapshot(page);
    assert.deepEqual({ path: after.path, content: after.content, text: after.text, dirty: after.dirty }, {
      path: before.path, content: before.content, text: before.text, dirty: before.dirty
    }, 'rejection cleanup must retain user-locked A content');
    assert.equal(await page.evaluate(() => editor.isLocked()), true, 'rejection cleanup must retain the user Lock');
    await page.keyboard.type('STILLBLOCKED');
    await assertPendingOpenRejected(page, after, 'Typing after cleanup while still user-locked');

    await page.evaluate(() => editor.setLocked(false));
    assert.equal(await page.evaluate(() => editor.isLocked()), false);
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.type('RESUMED');
    const resumed = await snapshot(page);
    assert.equal(resumed.content, '# Alpha\n\nAlpha paragraph.RESUMED\n', 'an explicit unlock must restore editing');
    assert.deepEqual(session.errors, []);
    console.log('PASS: transition protection rejects edits without altering the persistent user Lock, which survives rejection cleanup.');
  } finally { await session.close(); }
}

// A stored-mark transaction (Ctrl+B) does not change the document, but it must
// still be rejected during transition protection or later typing inherits bold.
async function richStoredMarkRejection() {
  const session = await openEditor(A);
  const { page } = session;
  try {
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    const before = await snapshot(page);

    await session.holdOpen(B_PATH, B, 'SIMULATED_OPEN_FAILURE');
    await page.evaluate(path => { void requestOpen(path); }, B_PATH);
    await waitForPendingOpen(page, B_PATH);
    // Deliver the shortcut directly to the active rich view so focus races
    // cannot make this regression silently pass without exercising the keymap.
    await page.evaluate(() => {
      const target = document.querySelector('#preview .ProseMirror');
      target.focus();
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await assertPendingOpenRejected(page, before, 'Ctrl+B stored mark during transition');

    await session.rejectOpen(B_PATH, 'SIMULATED_OPEN_FAILURE');
    await page.waitForFunction(() => !busy);
    await page.keyboard.type('PLAIN');
    const after = await snapshot(page);
    assert.equal(after.content, '# Alpha\n\nAlpha paragraph.PLAIN\n',
      'a rejected Ctrl+B must not leave a stored bold mark that bolds the next typing');
    assert.equal(after.text, after.content);
    assert.ok(!/\*\*|__/.test(after.content), 'serialized Markdown must remain plain after rejected Ctrl+B');
    assert.deepEqual(session.errors, []);
    console.log('PASS: Ctrl+B during a pending open cannot leave a latent bold mark after rejection.');
  } finally { await session.close(); }
}

// The visible editor DOM, not only the controller buffer, must agree with A for
// the whole transition.
async function transitionEditorDomConsistency() {
  const session = await openEditor(A);
  const { page } = session;
  try {
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    const before = await snapshot(page);
    const beforeDom = await editorDomState(page);

    await session.holdOpen(B_PATH, B, 'SIMULATED_OPEN_FAILURE');
    await page.evaluate(path => { void requestOpen(path); }, B_PATH);
    await waitForPendingOpen(page, B_PATH);

    await page.keyboard.type('NOPE');
    assert.deepEqual(await editorDomState(page), beforeDom, 'rich DOM must not show rejected typing during transition');
    await page.evaluate(() => editor.command('heading'));
    assert.deepEqual(await editorDomState(page), beforeDom, 'rich DOM must not change for a rejected command during transition');
    await page.keyboard.press('Control+b');
    assert.deepEqual(await editorDomState(page), beforeDom, 'rich DOM must not change for a rejected stored mark during transition');
    await assertPendingOpenRejected(page, before, 'Rich DOM attempts during transition');

    await session.rejectOpen(B_PATH, 'SIMULATED_OPEN_FAILURE');
    await page.waitForFunction(() => !busy);
    assert.deepEqual(await editorDomState(page), beforeDom, 'rich DOM must be restored consistently after rejection');
    assert.deepEqual(session.errors, []);
    console.log('PASS: the active rich editor DOM stays consistent with A throughout a rejected open transition.');
  } finally { await session.close(); }
}

// Task widgets and rich paste are document-changing input paths that must also
// reject during the transition.
async function transitionTaskAndRichPaste() {
  const session = await openEditor(TASKS);
  const { page } = session;
  try {
    await page.locator('#preview p').first().click();
    const before = await snapshot(page);
    await session.holdOpen(B_PATH, B, 'SIMULATED_OPEN_FAILURE');
    await page.evaluate(path => { void requestOpen(path); }, B_PATH);
    await waitForPendingOpen(page, B_PATH);

    const attempted = await page.evaluate(() => {
      const box = document.querySelector('#preview .task-item input');
      if (!box) return false;
      // Bypass the disabled attribute so the change handler itself is exercised.
      box.disabled = false; box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    });
    assert.equal(attempted, true, 'the fixture must render a task checkbox');
    await assertPendingOpenRejected(page, before, 'Task checkbox toggle during transition');

    await page.locator('#preview .ProseMirror').focus();
    await page.keyboard.press('Control+a');
    await pasteInto(page, '#preview .ProseMirror', 'PASTED');
    await assertPendingOpenRejected(page, before, 'Rich paste during transition');

    await session.rejectOpen(B_PATH, 'SIMULATED_OPEN_FAILURE');
    await page.waitForFunction(() => !busy);
    assert.equal((await snapshot(page)).content, TASKS, 'rejected task/paste attempts must not mutate A');
    assert.deepEqual(session.errors, []);
    console.log('PASS: task toggles and rich paste are rejected during the transition and leave A unchanged.');
  } finally { await session.close(); }
}

// Source presentation: paste and DOM state must also stay on A while B is pending.
async function sourceTransitionPaste() {
  const session = await openEditor(A);
  const { page } = session;
  try {
    await page.locator('#preview p').click();
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() => !busy && mode === 'edit');
    await page.locator('#source-editor .cm-content').click();
    const before = await snapshot(page);
    const beforeDom = await editorDomState(page);

    await session.holdOpen(B_PATH, B, 'SIMULATED_OPEN_FAILURE');
    await page.evaluate(path => { void requestOpen(path); }, B_PATH);
    await waitForPendingOpen(page, B_PATH);
    await page.keyboard.type('NOPE');
    await pasteInto(page, '#source-editor .cm-content', 'PASTED');
    await page.evaluate(() => editor.undo());
    await assertPendingOpenRejected(page, before, 'Source typing/paste/undo during transition');
    assert.deepEqual(await editorDomState(page), beforeDom, 'source DOM must remain A during the transition');

    await session.rejectOpen(B_PATH, 'SIMULATED_OPEN_FAILURE');
    await page.waitForFunction(() => !busy);
    assert.deepEqual(await editorDomState(page), beforeDom, 'source DOM must be restored after rejection');
    assert.deepEqual(session.errors, []);
    console.log('PASS: source typing, paste, and undo are rejected without changing the visible source DOM.');
  } finally { await session.close(); }
}

// Home and New also await the native new_document reset before replacing the
// document. Rich input during that wait must not mutate the outgoing document.
async function homePendingRejectsRichEdits() {
  const session = await openEditor(A);
  const { page } = session;
  try {
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    const before = await snapshot(page);
    assert.equal(before.path, A_PATH);
    assert.equal(before.dirty, false, 'A must start clean so Home needs no discard prompt');

    await session.holdNewDocument();
    await page.evaluate(() => { void goHome(); });
    await waitForPendingNewDocument(page);
    assert.equal((await snapshot(page)).path, A_PATH, 'A must remain current while Home is pending');
    assert.equal(await page.locator('#preview .ProseMirror').evaluate(node => node.contains(document.activeElement)), true,
      'rich editor must retain focus before testing rejected keyboard input');

    await page.keyboard.type('RICH');
    await assertPendingReplacementRejected(page, before, 'Rich typing while Home is pending');
    await page.evaluate(() => editor.command('heading'));
    await assertPendingReplacementRejected(page, before, 'Rich formatting while Home is pending');
    await page.evaluate(() => editor.undo());
    await assertPendingReplacementRejected(page, before, 'Rich undo while Home is pending');

    await session.releaseNewDocument();
    await page.waitForFunction(() => !busy && $('document-view').hidden);
    assert.equal(await page.evaluate(() => current.active), false, 'Home must leave no active document');
    assert.equal(await page.evaluate(() => editor), null, 'Home must tear down the previous editor');
    assert.equal(await page.evaluate(() => $('home').disabled), true, 'Home must be unavailable on the welcome screen');
    assert.deepEqual(session.errors, []);
    console.log('PASS: pending Home rejects rich typing, formatting, and undo without mutating A, then reaches the welcome screen.');
  } finally { await session.close(); }
}

// The source presentation is a separate mutation path; New must protect it too.
async function newPendingRejectsSourceEdits() {
  const session = await openEditor(A);
  const { page } = session;
  try {
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() => !busy && mode === 'edit');
    await page.locator('#source-editor .cm-content').click();
    const before = await snapshot(page);
    assert.equal(before.path, A_PATH);
    assert.equal(before.dirty, false);
    assert.equal(await page.evaluate(() => editor.isSource()), true);

    await session.holdNewDocument();
    await page.evaluate(() => { void newDocument(); });
    await waitForPendingNewDocument(page);
    assert.equal((await snapshot(page)).path, A_PATH, 'A must remain current while New is pending');
    assert.equal(await page.locator('#source-editor .cm-content').evaluate(node => node.contains(document.activeElement)), true,
      'Markdown editor must retain focus before testing rejected keyboard input');

    await page.keyboard.type('MARKDOWN');
    await assertPendingReplacementRejected(page, before, 'Markdown source typing while New is pending');
    await pasteInto(page, '#source-editor .cm-content', 'PASTED');
    await assertPendingReplacementRejected(page, before, 'Markdown source paste while New is pending');
    await page.evaluate(() => editor.undo());
    await assertPendingReplacementRejected(page, before, 'Markdown source undo while New is pending');

    await session.releaseNewDocument();
    await page.waitForFunction(() => !busy && current.active && current.name === 'Untitled.md');
    const after = await snapshot(page);
    assert.equal(after.path, null, 'New must create an unsaved document');
    assert.equal(after.content, '', 'New must start with an empty buffer');
    assert.equal(after.dirty, false);
    assert.equal(after.mode, 'read');
    assert.equal(await page.evaluate(() => editor.isLocked()), false, 'the new document must be editable');
    await page.locator('#preview .ProseMirror').click();
    await page.keyboard.type('FRESH');
    assert.match((await snapshot(page)).content, /FRESH/, 'the new document must accept edits after the transition');
    assert.deepEqual(session.errors, []);
    console.log('PASS: pending New rejects Markdown source typing, paste, and undo without mutating A, then creates an editable document.');
  } finally { await session.close(); }
}

// A failed native reset must preserve A and its persistent Lock; an unlock
// attempt during the pending transition must not bypass protection.
async function newRejectionPreservesDocumentAndLock() {
  const session = await openEditor(A);
  const { page } = session;
  try {
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.evaluate(() => editor.setLocked(true));
    const before = await snapshot(page);
    assert.equal(before.dirty, false);

    await session.holdNewDocument('SIMULATED_NEW_DOCUMENT_FAILURE');
    await page.evaluate(() => { void newDocument(); });
    await waitForPendingNewDocument(page);
    await page.evaluate(() => editor.setLocked(false));
    assert.equal(await page.evaluate(() => editor.isLocked()), true,
      'an unlock attempt during a New transition must not clear the persistent user Lock');
    await page.keyboard.type('BLOCKED');
    await assertPendingReplacementRejected(page, before, 'Typing while New is pending and user-locked');

    await session.rejectNewDocument('SIMULATED_NEW_DOCUMENT_FAILURE');
    await page.waitForFunction(() => !busy);
    const after = await snapshot(page);
    assert.deepEqual({ path: after.path, content: after.content, text: after.text, dirty: after.dirty }, {
      path: before.path, content: before.content, text: before.text, dirty: before.dirty
    }, 'a rejected New must leave A path/content/dirty intact');
    assert.equal(await page.evaluate(() => current.active), true, 'a rejected New must keep A open');
    assert.equal(await page.evaluate(() => editor.isLocked()), true, 'New rejection cleanup must retain the user Lock');
    assert.match(await page.locator('#toast').textContent(), /SIMULATED_NEW_DOCUMENT_FAILURE/, 'the rejected New must be reported');

    await page.evaluate(() => editor.setLocked(false));
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.type('RESUMED');
    assert.equal((await snapshot(page)).content, '# Alpha\n\nAlpha paragraph.RESUMED\n',
      'an explicit unlock must restore editing after New rejection');
    assert.deepEqual(session.errors, []);
    console.log('PASS: a rejected New preserves A and the persistent user Lock, which stays independent of transition protection.');
  } finally { await session.close(); }
}

async function homeRejectionPreservesDocumentAndLock() {
  const session = await openEditor(A);
  const { page } = session;
  try {
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.evaluate(() => editor.setLocked(true));
    const before = await snapshot(page);

    await session.holdNewDocument('SIMULATED_NEW_DOCUMENT_FAILURE');
    await page.evaluate(() => { void goHome(); });
    await waitForPendingNewDocument(page);
    await page.evaluate(() => editor.setLocked(false));
    assert.equal(await page.evaluate(() => editor.isLocked()), true,
      'an unlock attempt during a Home transition must not clear the persistent user Lock');
    await page.keyboard.type('BLOCKED');
    await assertPendingReplacementRejected(page, before, 'Typing while Home is pending and user-locked');

    await session.rejectNewDocument('SIMULATED_NEW_DOCUMENT_FAILURE');
    await page.waitForFunction(() => !busy);
    const after = await snapshot(page);
    assert.deepEqual({ path: after.path, content: after.content, text: after.text, dirty: after.dirty }, {
      path: before.path, content: before.content, text: before.text, dirty: before.dirty
    }, 'a rejected Home must leave A path/content/dirty intact');
    assert.equal(await page.evaluate(() => $('document-view').hidden), false, 'a rejected Home must keep the document view');
    assert.equal(await page.evaluate(() => editor.isLocked()), true, 'Home rejection cleanup must retain the user Lock');
    assert.match(await page.locator('#toast').textContent(), /SIMULATED_NEW_DOCUMENT_FAILURE/, 'the rejected Home must be reported');

    await page.evaluate(() => editor.setLocked(false));
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.type('RESUMED');
    assert.equal((await snapshot(page)).content, '# Alpha\n\nAlpha paragraph.RESUMED\n',
      'an explicit unlock must restore editing after Home rejection');
    assert.deepEqual(session.errors, []);
    console.log('PASS: a rejected Home preserves A and the persistent user Lock, which stays independent of transition protection.');
  } finally { await session.close(); }
}

const tests = {
  presentationToggle, richPendingOpen, sourcePendingOpen, folderPendingOpen, folderRejectedOpenPreservesLock,
  rejectedOpenCleanup, rejectionPreservesUserLock, richStoredMarkRejection, transitionEditorDomConsistency,
  transitionTaskAndRichPaste, sourceTransitionPaste, homePendingRejectsRichEdits, newPendingRejectsSourceEdits,
  newRejectionPreservesDocumentAndLock, homeRejectionPreservesDocumentAndLock
};
(async () => {
  const only = process.argv[2];
  if (only && !tests[only]) throw new Error(`Unknown test ${only}; choose ${Object.keys(tests).join(', ')}`);
  for (const [name, test] of Object.entries(tests)) if (!only || name === only) await test();
})().catch(error => { console.error(error); process.exitCode = 1; });
