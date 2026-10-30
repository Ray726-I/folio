# Unified editor: repair status and follow-up

This is a functional development build, not a production-readiness claim.

**Repair pass (2026-10-30):** the source-loss, selection, typing, undo and table
failures found after the rushed handoff now have targeted regressions. The full
suite and real WebKit keyboard/save checks have been run after integration.
This is a substantially repaired development build, not a claim that the entire
original one-root editing design or every platform/input path is complete. Use
copies for the first walkthrough. Detailed evidence and boundaries are in
`superpowers/plans/2026-10-30-unified-editor-repair.md`.

## Run now

```sh
./run.sh
# or open a disposable Markdown file:
./run.sh /absolute/path/to/test.md
# debug build instead:
./run-dev.sh /absolute/path/to/test.md
```

Use a copy of important files for this first manual test. `run.sh` now rebuilds when the UI or sources change, so it cannot silently launch an older embedded editor. `run-dev.sh` builds the debug binary instead. The offline editor bundle is included, so launching does not require an npm install.

## Implemented

- Clean, continuously editable rich text by default; a single **Show Markdown** toggle opens the source-backed, locally revealed presentation.
- Shared Markdown buffer and undo/redo across both presentations. Unchanged top-level source blocks are retained verbatim; opening, toggling and snapshots do not rewrite files.
- Independent **Lock** and read-only, copyable **Source snapshot** of unsaved Markdown.
- Direct tasks, genuine HTML/ProseMirror tables with row/column controls, formatting, links, images and editable inline/display math.
- Explicit per-image Load, including under Lock; blocked images do not fetch on view/hover/focus. Existing global remote-image preference retained.
- Native file/save/conflict/CRLF/BOM handling and isolated Mermaid rendering retained. Unknown Markdown extensions have native-sanitized projections with source access rather than being discarded.
- Explicit complete-source fallback for native complexity limits or documents over the development rich-editor threshold.

## Architecture decision

The failed margin-based table experiment is **not** in the app. Rich editing uses established ProseMirror/table machinery. The Markdown presentation uses CodeMirror. They are persistent projections of one canonical source buffer with shared history, not independent copies of a file. A verified plain-text edit patches its exact source range; selected-interval edits use the canonical source splice. Structural/formatting edits may serialize the affected construct. Exact inter-block gaps and retained reference definitions are tracked independently rather than attached to rich nodes.

## Check manually first

1. Edit several paragraphs, toggle Markdown twice, and undo/redo.
2. Edit bold/code/math and long text in table cells; Tab across cells; add a row and undo.
3. Tick a task without switching presentation; Lock and confirm it cannot change.
4. Edit a formula and link, then view the source snapshot.
5. Hover a blocked image (no load), then deliberately Load it.
6. Save a disposable file, reopen it, and check its contents.

## TODO before production/release

- [x] Run the entire updated UI/security/native suite together: `cargo test --locked` 82/82, Clippy clean, bundle check, 12 path tests, editor unit/browser regressions and all six UI/security suites pass; native IPC/renderer/editor probe passes.
- [x] Reproduce and repair dropped reference definitions, equal-node source ownership errors, block-boundary caret jumps, immediate-toggle focus/caret loss, disconnected typing undo groups, empty-task parsing, empty-paragraph caret association and table hard-break serialization.
- [x] Verify source-origin bookmarks, forward/backward cross-cell/prose interval replacement, Delete/Backspace/Enter/plain-text paste/cut/Select All, Lock rejection, and failure-atomic canonical commits. Clipboard write failure leaves the document untouched.
- [x] Add an isolated OS-keyboard Tauri/WebKit walkthrough for typing, toggling, undo and exact saved bytes, in addition to the native debug security/editor probe.
- [ ] Complete the original **one persistent editor root** / locally editable source-reveal contract. The current app still uses two persistent view projections; exact logical bookmarks do not make a hidden syntax position visually representable in rich text.
- [ ] Replace the existing formula/link action dialogs with the agreed in-document source editing. Do not describe those dialogs as a completed same-root interaction.
- [ ] Native WebKit/Tauri IME, composition, clipboard, keyboard-only, touch and Windows/macOS regression testing. Chromium browser tests do not establish those platform claims.
- [ ] Profile large documents (including statistics/dirty tracking), incremental decoration updates and memory. Tune/document the 2 MiB rich-editor threshold instead of treating it as a measured universal limit.
- [ ] Audit projection caret/selection and scroll mapping for repeated text, nested lists, atoms, unusual whitespace and backward/cross-table selections. Mapping is source-aware but not yet proven exact for every dialect construct.
- [ ] Extend exact source-first selected-interval coverage to HTML-rich clipboard payloads, browser replacement/autocorrect, drag/drop and native composition. The new paste guarantee covers plain-text payloads, not every browser input path.
- [ ] Broaden round-trip fixtures for Comrak extensions, inline HTML, footnotes, definition lists and nested structures. Editing a rich block can canonicalize that block's syntax; this is not whole-file byte-preserving editing.
- [ ] Harden math delimiter/currency parsing. Math is editable and rendered in the clean presentation and stays as readable source in the Markdown presentation.
- [ ] Rich code syntax highlighting and more polished extension/footnote navigation. Source remains available and Mermaid stays isolated.
- [ ] More image lifetime/cache/budget and native relative-path/save-as tests, including duplicate images and cancellation.
- [ ] Accessibility review of contextual actions and heading levels; richer table selection/Enter behavior documentation and narrow-screen toolbar refinement.
- [ ] Review all new code and bundled dependency licenses; verify reproducible assets and build/sign release packages. Do not distribute the old release binary as this update.

## Fast-handoff verification

Passed during this implementation: source-ledger and source-edit unit tests; real-editor browser regressions for selection, spelling/reference preservation, focus, history, typing, tasks, empty paragraphs, table navigation/newlines, canonical rejection and clipboard failure; the existing shell/theme/tree/save-conflict, lazy assets, picker, complexity and Mermaid security/bridge suites; and the deterministic editor-bundle check. The debug application builds successfully. The native IPC/editor/security roundtrip reports `FOLIO_NATIVE_PROBE_PASS`; the independent XTest walkthrough verifies actual WebKit input and exact file saves without mocked IPC.

The complete suite passed after integration; the subsequent clipboard-safety correction was verified with its failure regression and the selected-interval suite. Release packaging/signing and native IME testing remain deferred. XTest is synthetic OS input, not physical hardware or an IME/composition claim.

## Developer checks

```sh
npm ci
npm run build:editor
npm run check:editor-bundle
cargo build --locked --example editor-fixture
npm run test:editor
npm run test:ui
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
npm run test:native-editor # Linux, isolated Xvfb/D-Bus
```
