const assert = require('node:assert/strict');
const { openEditor } = require('./editor-browser.cjs');

// Shell scope: Formatted/Markdown segmented control, readable save state,
// quiet chrome. Fails before the shell improvement, passes after.
(async () => {
  const session = await openEditor('# Title\n\nA paragraph.\n');
  const { page } = session;
  try {
    // 1. Segmented control exists with clear text labels.
    assert.equal(await page.locator('#view-switch').count(), 1, 'header needs a #view-switch segmented control');
    assert.equal(await page.locator('#view-switch').getAttribute('role'), 'group');
    assert.match(await page.locator('#view-switch').getAttribute('aria-label'), /formatted|markdown/i);
    assert.equal((await page.locator('#view-formatted').textContent()).trim(), 'Formatted');
    assert.equal((await page.locator('#show-markdown').textContent()).trim(), 'Markdown');
    // Initial state: formatted active.
    assert.equal(await page.locator('#view-formatted').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#show-markdown').getAttribute('aria-pressed'), 'false');

    // 2. Clicking Markdown switches presentation and focuses source.
    await page.locator('#show-markdown').click();
    await page.waitForFunction(() => !busy && mode === 'edit');
    assert.equal(await page.locator('#view-formatted').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#show-markdown').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#source-editor .cm-content').evaluate(n => n.contains(document.activeElement)), true);

    // 3. Predictable segmented behavior: clicking the already-active
    // Markdown segment is a quiet no-op — it must not switch away.
    const contentBefore = await page.evaluate(() => current.content);
    await page.locator('#show-markdown').click();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => mode), 'edit', 're-clicking active Markdown must stay in the Markdown view');
    assert.equal(await page.evaluate(() => current.content), contentBefore);
    assert.equal(await page.locator('#view-formatted').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#show-markdown').getAttribute('aria-pressed'), 'true');
    // The Formatted button is explicit too: it switches to read…
    await page.locator('#view-formatted').click();
    await page.waitForFunction(() => !busy && mode === 'read');
    // …and re-clicking it while active is also a quiet no-op.
    await page.locator('#view-formatted').click();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => mode), 'read', 're-clicking active Formatted must stay in the formatted view');
    assert.equal(await page.evaluate(() => current.content), contentBefore);
    // Return to Markdown for the next step.
    await page.locator('#show-markdown').click();
    await page.waitForFunction(() => !busy && mode === 'edit');

    // 4. Clicking Formatted switches back and focuses rich text.
    await page.locator('#view-formatted').click();
    await page.waitForFunction(() => !busy && mode === 'read');
    assert.equal(await page.locator('#view-formatted').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#show-markdown').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#preview .ProseMirror').evaluate(n => n.contains(document.activeElement)), true);

    // 5. Keyboard: Ctrl+E still toggles both ways with typing continuity.
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() => !busy && mode === 'edit');
    await page.keyboard.type('SRC');
    assert.match(await page.evaluate(() => current.content), /SRC/);
    await page.keyboard.press('Control+e');
    await page.waitForFunction(() => !busy && mode === 'read');
    await page.keyboard.type('RCH');
    assert.match(await page.evaluate(() => current.content), /SRC.*RCH|RCH/);

    // 6. Arrow keys move between segments.
    await page.locator('#view-formatted').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'show-markdown', 'ArrowRight moves to Markdown segment');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'view-formatted', 'ArrowLeft moves back to Formatted segment');

    // 7. Visible save state at a glance: Saved / Edited /
    // Saving… / Save failed, mirrored to assistive technology.
    assert.equal(await page.locator('#save-state').getAttribute('role'), 'status', '#save-state must be a live status');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => current.content === current.saved && !busy);
    assert.equal(await page.locator('#save-state').textContent(), 'Saved');
    assert.equal(await page.locator('#save-state').getAttribute('data-state'), 'saved');
    const cleanLabel = await page.locator('#save').getAttribute('aria-label');
    assert.match(cleanLabel, /saved|up to date|no.*unsaved/i, `clean save label must read as saved, got: ${cleanLabel}`);
    assert.equal(await page.locator('#save').evaluate(n => n.classList.contains('is-dirty')), false);
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' DIRTY');
    await page.waitForFunction(() => current.content !== current.saved);
    assert.equal(await page.locator('#save-state').isHidden(), false, 'save state must stay visible while dirty');
    assert.equal(await page.locator('#save-state').textContent(), 'Edited');
    assert.equal(await page.locator('#save-state').getAttribute('data-state'), 'dirty');
    assert.match(await page.locator('#save-state').getAttribute('aria-label'), /unsaved changes/i, 'dirty accessible name must carry the full "unsaved changes" meaning');
    assert.match(await page.locator('#save-state').evaluate(node => node.title), /unsaved changes/i, 'dirty tooltip must carry the full "unsaved changes" meaning');
    const dirtyLabel = await page.locator('#save').getAttribute('aria-label');
    assert.match(dirtyLabel, /unsaved/i, `dirty save label must announce unsaved changes, got: ${dirtyLabel}`);
    assert.equal(await page.locator('#save').evaluate(n => n.classList.contains('is-dirty')), true);
    assert.equal(await page.locator('#dirty-dot').isHidden(), false);
    // Saving… is observable while the native save is held.
    await page.evaluate(() => {
      const core = window.__TAURI__.core;
      if (!window.__folioOrigInvoke) window.__folioOrigInvoke = core.invoke.bind(core);
      window.__folioSaveGate = new Promise(resolve => { window.__folioReleaseSave = resolve; });
      core.invoke = async (command, args) => {
        if (command === 'save_document' && window.__folioSaveGate) await window.__folioSaveGate;
        return window.__folioOrigInvoke(command, args);
      };
    });
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.getElementById('save-state')?.textContent === 'Saving…');
    assert.equal(await page.locator('#save-state').getAttribute('data-state'), 'saving');
    await page.evaluate(() => { window.__folioReleaseSave(); window.__folioSaveGate = null; });
    await page.waitForFunction(() => current.content === current.saved && !busy);
    assert.equal(await page.locator('#save-state').textContent(), 'Saved');
    // A rejected save surfaces a visible, persistent Save failed state.
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.type('X');
    await page.waitForFunction(() => current.content !== current.saved);
    await page.evaluate(() => {
      const core = window.__TAURI__.core;
      window.__folioFailNextSave = true;
      core.invoke = async (command, args) => {
        if (command === 'save_document' && window.__folioFailNextSave) {
          window.__folioFailNextSave = false;
          throw new Error('SIMULATED_SAVE_FAILURE');
        }
        if (command === 'save_document' && window.__folioSaveGate) await window.__folioSaveGate;
        return window.__folioOrigInvoke(command, args);
      };
    });
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !busy && document.getElementById('save-state')?.textContent === 'Save failed');
    assert.equal(await page.locator('#save-state').getAttribute('data-state'), 'error');
    assert.equal(await page.locator('#save-state').isHidden(), false, 'save failure must stay visible, not transient');
    assert.match(await page.locator('#toast').textContent(), /SIMULATED_SAVE_FAILURE/, 'the failed save must also be reported');
    await page.evaluate(() => { window.__TAURI__.core.invoke = window.__folioOrigInvoke; });
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => current.content === current.saved && !busy);
    const afterSaveLabel = await page.locator('#save').getAttribute('aria-label');
    assert.equal(await page.locator('#save-state').textContent(), 'Saved');
    assert.match(afterSaveLabel, /saved|up to date|no.*unsaved/i, `post-save label must read as saved, got: ${afterSaveLabel}`);

    // 8. Lock stays quiet but functional: toggles, disables formatting, shows note.
    await page.locator('#lock-document').click();
    assert.equal(await page.locator('#lock-document').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#editor-lock-note').isHidden(), false);
    assert.equal(await page.locator('#format-tools [data-editor-command="bold"]').isDisabled(), true);
    await page.locator('#lock-document').click();
    assert.equal(await page.locator('#lock-document').getAttribute('aria-pressed'), 'false');

    // 9. saveStatus resets across document switches/close, and file-changed
    // conflicts never read as Saved.
    await page.evaluate(() => {
      const core = window.__TAURI__.core;
      if (!window.__folioOrigInvoke) window.__folioOrigInvoke = core.invoke.bind(core);
      core.invoke = async (command, args) => {
        if (command === 'save_document' && window.__folioFailNextSave) {
          window.__folioFailNextSave = false;
          throw new Error('SIMULATED_SWITCH_FAILURE');
        }
        if (command === 'save_document' && window.__folioConflictNextSave) {
          window.__folioConflictNextSave = false;
          throw { code: 'file_changed', message: 'Another app changed this file.' };
        }
        return window.__folioOrigInvoke(command, args);
      };
    });
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' SWITCH');
    await page.evaluate(() => { window.__folioFailNextSave = true; });
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !busy && document.getElementById('save-state')?.textContent === 'Save failed');
    // Switching documents clears the stale failure: the new document is clean.
    await page.evaluate(() => openPath('/tmp/other.md', true));
    await page.waitForFunction(() => !busy && current.path === '/tmp/other.md');
    assert.equal(await page.locator('#save-state').textContent(), 'Saved', 'a stale save failure must not leak into the newly opened document');
    assert.equal(await page.locator('#save-state').getAttribute('data-state'), 'saved');
    // A file-changed conflict is Edited (unsaved changes), never Saved or Save failed.
    await page.locator('#preview p').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' CONFLICT');
    await page.waitForFunction(() => current.content !== current.saved);
    await page.evaluate(() => { window.__folioConflictNextSave = true; });
    await page.keyboard.press('Control+s');
    await page.locator('#confirm-dialog').waitFor();
    assert.match(await page.locator('#confirm-message').textContent(), /changed this file/, 'the disk-conflict dialog must appear');
    assert.equal(await page.locator('#save-state').textContent(), 'Edited', 'an unresolved conflict must read as unsaved, not saved');
    assert.equal(await page.locator('#save-state').getAttribute('data-state'), 'dirty');
    assert.match(await page.locator('#save-state').getAttribute('aria-label'), /unsaved changes/i, 'conflict accessible name must carry the full "unsaved changes" meaning');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForFunction(() => !busy);
    assert.equal(await page.locator('#save-state').textContent(), 'Edited', 'cancelling the conflict must leave unsaved state, not saved or failed');
    // Narrow headers keep the save state visible (compact), never hidden.
    await page.setViewportSize({ width: 600, height: 800 });
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#save-state').isHidden(), false, 'narrow widths must keep the save state visible, not hide it');
    assert.equal(await page.locator('#save-state').textContent(), 'Edited');
    assert.match(await page.locator('#save-state').getAttribute('aria-label'), /unsaved changes/i, 'narrow dirty accessible name must carry the full "unsaved changes" meaning');
    await page.setViewportSize({ width: 1180, height: 900 });
    // Closing to welcome hides the indicator entirely.
    await page.evaluate(() => { window.__TAURI__.core.invoke = window.__folioOrigInvoke; void goHome(); });
    await page.locator('#confirm-dialog').waitFor();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('welcome').hidden && !busy);
    assert.equal(await page.locator('#save-state').isHidden(), true, 'no document means no save state');

    assert.deepEqual(session.errors, []);
    console.log('PASS: Formatted/Markdown segments switch without losing focus, Ctrl+E still toggles, save state reads clean/dirty, lock stays quiet.');
  } finally { await session.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
