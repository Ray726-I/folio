# Async Open Data-Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent accepted edits to the current Markdown document from being lost or misdirected while a different file is opening.

**Architecture:** Keep the existing Save / Discard / Cancel check at the queued open boundary. After permission is granted and before invoking native `open_document`, apply a temporary editor-transition lock distinct from the user’s persistent Lock. Enforce it in the editor controller and both rich/source mutation engines, hold it through replacement and new-editor mounting, and release it on every exit.

**Tech Stack:** Tauri app shell in JavaScript, ProseMirror, CodeMirror, Playwright browser tests, Rust native open command (unchanged).

---

## File map

- `ui/app.js`: activate transition protection around `openPath()` only after queued discard approval and before native open; clear in `finally` after mount or failure.
- `ui/editor.js`: pass transition state to newly created editor controllers and keep Lock UI state distinct from transition protection.
- `ui/editor/entry.js`: own user-lock and transition-lock separately; compute effective lock for history, controller mutations, and child editors.
- `ui/editor/source.js`: make CodeMirror read-only while either lock is active.
- `ui/editor/rich.js`: reject document-changing ProseMirror transactions and editing commands while either lock is active.
- `tests/editor-browser.cjs`: add a deterministic deferred `open_document` gate to the browser IPC mock.
- `tests/editor-shell-regressions.cjs`: assert rich/source edits and commands are rejected during open, then verify cleanup and lock preservation.
- `docs/superpowers/specs/2026-10-30-async-open-data-safety-design.md`: source of scope and acceptance criteria; do not expand the implementation into editor-mount recovery.

## Task 1: Add a deterministic async-open regression

**Files:**
- Modify: `tests/editor-browser.cjs`
- Modify: `tests/editor-shell-regressions.cjs`

- [ ] Add a path-keyed deferred gate to the test IPC mock for `open_document`. Leave the default behavior immediate so all existing tests keep their current setup.
- [ ] Add a browser regression that starts a clean document A, defers opening B, waits until the `open_document` IPC call is recorded, attempts to type, paste, toggle a task, apply formatting, and invoke Undo/Redo in the rich editor, and asserts the shell, controller, and visible editor buffer remain consistent.
- [ ] Add a second regression that switches A to Markdown presentation before opening B, then asserts CodeMirror typing/paste and Undo/Redo cannot mutate the document while the native call is pending.
- [ ] In a rejected-open regression, press Ctrl+B at the rich caret while protected, reject B, then type into restored A and assert that the new text is not bold; this catches mark-only ProseMirror transactions that do not set `docChanged`.
- [ ] Release the deferred IPC response; assert B becomes current and editing is enabled after the transition completes.
- [ ] Run the focused test before implementation and confirm it fails because input currently changes A while `open_document` is pending.

Run: `node tests/editor-shell-regressions.cjs`

Expected before implementation: FAIL on the assertion that pending-open input leaves A unchanged. A Playwright/setup error is not an acceptable RED result.

## Task 2: Implement transition protection independently of user Lock

**Files:**
- Modify: `ui/editor/entry.js`
- Modify: `ui/editor/source.js`
- Modify: `ui/editor/rich.js`
- Modify: `ui/editor.js`
- Modify: `ui/app.js`

- [ ] In `ui/editor/entry.js`, add `transitionLocked` initialized from the editor options. Define one effective-lock predicate `locked || transitionLocked`; use it for `record()`, `undo()`, `command()`, child-editor `isLocked`, and editor state callbacks. Add `setTransitionLocked(next)` that refreshes existing rich/source editors without changing the saved user-lock bit.
- [ ] In `ui/editor/source.js`, retain the existing CodeMirror `setLocked` mechanism and pass it the effective lock state whenever either lock changes; ensure the transaction filter rejects document changes while protected.
- [ ] In `ui/editor/rich.js`, keep the ProseMirror transaction filter and `editable` callback based on the shared effective-lock predicate so typing, task widgets, input rules, and commands cannot mutate the document during transition protection.
- [ ] In `ui/editor.js`, pass the app’s transition state into newly created editor controllers. Keep the user Lock button and persistent `locked` presentation independent; transition protection must not make an attempted Unlock clear the transition flag.
- [ ] In `ui/app.js`, after `allowDiscard()` resolves true in queued `openPath()`, set transition protection before `invoke('open_document')`. Keep it set while adopting the returned document and mounting its editor, then clear it in `finally`. If native open rejects, retain A and release the temporary lock. Do not ask a post-open discard prompt or save A after the native command begins.
- [ ] Run the focused rich/source regression and confirm both now pass.

Run: `node tests/editor-shell-regressions.cjs`

Expected: PASS, with no page errors and no document/history mutation during the deferred open.

## Task 3: Pin failure and compatibility behavior

**Files:**
- Modify: `tests/editor-shell-regressions.cjs`

- [ ] Seed A with undo and redo history, save it clean, and add a deferred native-open rejection case; verify A’s path, content, dirty state, actual editor state, history, and previous user-lock state remain intact and editing/Undo/Redo resume after rejection.
- [ ] Repeat the rejection while A is user-locked; verify transition cleanup does not unlock it, then explicitly unlock and verify normal editing resumes.
- [ ] Verify an already-dirty A still follows Save / Discard / Cancel before `open_document` is called, Save precedes the native open, and a cancelled or failed save never invokes B’s open.
- [ ] Verify a confirmed reload also protects the outgoing editor and that a second queued open protects the document current when its action executes without changing FIFO order.
- [ ] Run focused checks: `node tests/editor-shell-regressions.cjs` and `npm run test:picker`.
- [ ] Run the full repository test suite once after all tasks are reconciled; report any environment-limited or pre-existing failures separately.

## Self-review

- Scope coverage: dirty/save/discard prompts, both editor presentations, task/format/undo mutation paths, Lock independence, native-open failure cleanup, queue behavior, and new-editor editability are covered above.
- Explicit exclusion: editor-mount failure after native success is documented in the spec as separate recovery work because backend state has already switched.
- No net-new product features, queue-policy changes, or UI redesign are included.
