# Async Open Data-Safety Design

## Intent

Prevent an asynchronous file open from silently replacing edits made to the currently open document while the file read is pending.

## Why

`openPath()` currently asks whether the existing document may be discarded, then awaits `open_document`, then replaces `current`. The editor remains writable during that wait. If the document was clean when the prompt check ran but becomes dirty before the read completes, the new document replaces it without another decision from the user.

## Goals

- Never lose edits made to the current document while an open/reload operation is pending.
- Preserve the existing Save / Discard / Cancel decision flow and its current behavior when no edits occur during the read.
- Keep edits accepted before the open's protection boundary subject to the existing Save / Discard / Cancel flow.
- Prevent any accepted editor mutation after the open is approved and before the active document is replaced.
- If the user cancels the pre-open departure prompt, keep the original path, content, selection/editor state, and user edits.
- On Save or Discard, proceed with the pending open only after the existing decision flow permits replacement.
- Keep temporary transition protection separate from the user's persistent Lock setting.
- Prevent formatting-only editor state (for example, a stored bold mark at the caret) from surviving a rejected or completed transition and unexpectedly formatting the next edit.
- Cover the timing window with a deterministic regression test in the existing picker/app-shell harness.

## Non-goals

- Do not redesign busy-state presentation or change the user's persistent Lock preference.
- Do not change the file picker, open queue, or native IPC contract beyond what this guard requires.
- Do not address other audited defects or add proposed editing features in this slice.
- Do not add recovery for editor-mount failures after native open succeeds. Native open/read rejection is in scope; post-open mount recovery is a separate issue because the backend has already switched active document by then.

## Proposed behavior

Keep the existing discard check when the queued open executes, so edits made while an action waited in the queue participate in Save / Discard / Cancel. Once departure is approved, activate a temporary editor-transition guard immediately before calling `open_document`; keep it active through successful document replacement and mounting of the new editor, and release it on every exit. The guard must reject document-changing input at the editor/controller boundary in both rich and source presentations, not merely ignore change notifications or gray out toolbar buttons. Existing Lock remains independent: attempts to unlock cannot disable transition protection, a failed/cancelled open restores the prior user-lock state, and a successfully opened document follows current lock-default behavior.

Do not prompt or save the outgoing document after `open_document` has begun. The native command makes the returned document active in backend state before its promise resolves (`src/main.rs:295–305`); a post-read Cancel could leave the UI showing A while the backend targets B, and saving A at that point could write to the wrong file. The safe boundary is therefore to make the approved outgoing editor immutable before the native open starts. This also covers confirmed reloads: confirmation bypasses the discard prompt, not transition protection.

## Acceptance scenarios

1. **Clean open:** while B's `open_document` is pending, typing, paste, task toggles, formatting commands, and undo cannot mutate A in either rich or source presentation; underlying editor state stays consistent with the controller; B opens and is editable after the transition ends.
2. **Dirty before open, then Cancel:** A remains current with its original edits and history; the open command is never invoked.
3. **Dirty before open, then Discard:** B becomes current only after explicit approval.
4. **Dirty before open, then Save:** A is saved before `open_document` is invoked; a cancelled or failed save prevents B from opening.
5. **Native open/read failure:** before native success changes backend state, A's content, dirty state, history, and previous user-lock state remain intact; editing and ordinary Undo/Redo work again.
6. **Formatting-only action during a rejected open:** a shortcut such as Ctrl+B at the caret cannot leave a stored mark that formats the next edit after A is restored.
7. **Confirmed reload:** the outgoing editor is protected during reload even though the existing confirmation bypasses the ordinary discard prompt.
8. **Repeated or queued opens:** each open protects the document current at its execution; queue order is unchanged and protection is released after each failure or successful replacement.

## Likely touch points

- `ui/app.js`: `allowDiscard()`, `openPath()`, and guaranteed activation/release of transition protection around awaited file I/O and document replacement.
- `ui/editor.js`, `ui/editor/entry.js`, `ui/editor/source.js`, `ui/editor/rich.js`: expose and enforce transition protection independently of user Lock at controller and underlying mutation boundaries.
- `tests/editor-shell-regressions.cjs` (with `tests/editor-browser.cjs`): add deferred-IPC coverage using real rich/source editors; assert the document buffer and editor history do not change while protected. Include task/format/undo and failure cleanup cases.

## Explicitly deferred risk

If native `open_document` succeeds but mounting the new editor fails, the backend has already switched to B and the current open flow may have destroyed A's editor before the failure. Restoring A safely requires a separate recovery design that coordinates backend active-document state and editor-controller/history lifetime. This is not part of the pending-edit data-loss fix.

## Verification

- Add deterministic deferred-IPC regression tests first and observe them fail against the current behavior.
- Run the focused editor-shell regression and `npm run test:picker` for the open queue and existing picker behavior.
- After implementation, run the repository's full prescribed test suite once; report any environment-limited or pre-existing failures separately.

## Builder discretion

Use the smallest implementation that preserves the acceptance scenarios and the existing open queue. Do not broaden this change into other UX audit items.
