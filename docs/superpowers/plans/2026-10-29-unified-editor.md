# Unified Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Folio's preview/edit islands with one continuous, formatted editor: clean by default, local syntax reveal through Show Markdown, independent Lock, and an exact read-only source snapshot.

**Architecture:** Keep Markdown as the canonical buffer and maintain one persistent editor instance. Evaluate CodeMirror 6 with Markdown/GFM parsing and source-range decorations first; accept it only if the real editable-table, math, selection, history and source-fidelity gates below pass. Keep the Rust file layer, sanitizer, renderer isolation and shell; replace the editing subsystem, not the app.

**Tech Stack:** Existing Tauri/Rust/Comrak, local JavaScript, Playwright, KaTeX and isolated Mermaid. Proposed new dependencies: pinned CodeMirror 6, Lezer Markdown and a reproducible local bundler; installation requires approval to execute the feasibility phase.

---

## Status and authorization

Product planning only. The user accepted the prototype direction and requested a design and implementation plan, not a product implementation. No dependencies have been added to Folio and no product code has changed for this work.

Update: the user subsequently authorized **Task 0 and one bounded follow-up** correcting selection semantics and testing genuine table layout/navigation. Dependencies were installed in isolated scratch `/tmp/opencode/folio-editor-spike/`, not in Folio. Both are complete; the reconciled result remains **PARTIAL / NOT PASSED** because rich-cell geometry and programmatic caret mapping fail focused diagnostics despite 69/69 suite assertions passing. See `2026-10-29-editor-feasibility.md`. Further experiments and product integration remain unauthorized; reassess the table architecture before execution of Tasks 1–7.

Design: `docs/superpowers/specs/2026-10-29-unified-editor-design.md`.

Reference prototype: `.superpowers/brainstorm/295911-1793288089/content/core-markdown-math.html`. Its contenteditable, static markers, approximate snapshot and MathML are interaction illustrations, not production implementations or engine evidence.

**Execution is gated.** Task 0 is a real feasibility experiment. Later tasks describe the intended delivery sequence and contracts; they must not be executed on the assumption that a table widget automatically supplies continuous editing. If Task 0 fails, stop, retain evidence, compare alternatives and obtain approval for a revised design/plan. Do not silently replace direct table editing with a raw-pipe source editor.

## Fixed behavior and proposed defaults

- B is the default: formatted content remains directly editable, including tasks and table cells.
- Show Markdown toggles A: exact syntax appears locally around the active/hovered construct. It is not a full-document raw mode and never creates another editor.
- Lock changes edit permission, not presentation. It blocks typing, formatting, tasks, link/source edits, structural operations, undo and redo that mutate text. It permits selection/copy, navigation, source inspection and explicit image loading. Saving an existing dirty buffer remains possible; lock does not silently discard or save it.
- Source snapshot is read-only, copyable and exact for the current unsaved buffer. It is not regenerated from HTML. Existing backend BOM/CRLF handling remains authoritative; this view shows normalized in-memory text, not raw disk bytes.
- Proposed defaults: Show Markdown off and Lock off on each new/open document; state lasts for that document session. No persistence migration in this project.
- Proposed table keys: Tab/Shift-Tab move between cells; at the last cell, Tab exits the table rather than unexpectedly creating a row. Enter moves to the same column in the next existing row; Shift-Enter is not advertised as multiline cell editing. Visible context controls add/delete rows/columns. Unsupported multiline syntax stays exact and source-accessible. These are builder defaults, not separately requested user decisions.
- Image permission: preserve the existing explicitly enabled global remote-image preference. With it off, Load grants consent only for that destination in the current document session. No persistent host allowlist in this project. Reloading widgets does not silently broaden consent.
- Keep source text outside the edited ranges unchanged. Preserve delimiter styles as typed; only an edited table can normalize its own pipe layout. Never serialize the whole document from rich DOM.

## Current implementation evidence

| Responsibility | Existing evidence | Migration rule |
| --- | --- | --- |
| Editing islands | `ui/editor.js:189–253` | Replace textarea insertion/commit; no row hit-testing in new editor |
| Source/history | `ui/editor.js:3–38` | Replace app string stacks with one editor transaction history |
| HTML projection | `ui/preview.js:80–128` | Do not call whole-preview replacement during editor transactions |
| Mode/events | `ui/app.js:114–127,557–600` | Replace mode branches with view state and document actions |
| Save/dirty | `ui/app.js:21,163–170,355–377` | Keep conflict and save-snapshot semantics; no blur commit requirement |
| File fidelity | `src/document.rs:84–114,145–176` | Preserve LF-buffer, CRLF/BOM save, fingerprint and atomic-write behavior |
| Existing extensions | `src/markdown.rs:50–72` | Test core parity; unsupported extensions stay safe and editable as source |
| Images | `src/markdown/images.rs`, `src/markdown/limits.rs` | Reuse path validation and aggregate budgets, not arbitrary file reads |
| Offline shell | `tauri.conf.json:6–12`, `ui/index.html` | Local bundle, no CDN/eval/CSP widening |
| Existing UI CI | `.github/workflows/checks.yml:40–54` | Migrate obsolete assertions without deleting shell/security coverage |

Line numbers describe the planning baseline; locate symbols again before editing.

## File and module boundaries

Proposed new source modules, bundled for the existing local-script shell:

- `ui/editor/controller.js`: persistent editor lifecycle, document transactions, selection/history, read-only guards and shell notifications. Single source of editing truth.
- `ui/editor/presentation.js`: Show Markdown state, syntax-aware decorations, local reveal and unsupported-source presentation. No file I/O.
- `ui/editor/actions.js`: source-range task/link/format/structure commands, shared by pointer, keyboard and palette. No separate action history.
- `ui/editor/tables.js`: table model/range mapping, direct cell interaction and row/column commands. Same controller; no nested editors.
- `ui/editor/math.js`: exact math ranges, parser extension and KaTeX decoration lifecycle; errors retain editable source.
- `ui/editor/media.js`: image permissions/cache/budgets and isolated Mermaid widget lifecycle.
- `ui/editor/entry.js`: local bundled entry, exposing only the controller factory to existing scripts.
- `ui/source-snapshot.js`: accessible read-only dialog, exact buffer capture/copy and focus restoration.
- `scripts/build-editor.cjs`: deterministic pinned IIFE generation/check mode.
- `ui/vendor/editor/`: generated runtime bundle and provenance/license manifest. Do not hand-edit generated files.
- `tests/editor-harness.cjs`: shared test loader/fixture bridge, selected-document controls and state observations. Tests load the real bundle, not a second editor implementation.
- `tests/fixtures/unified-editor.md`: small core/extension/Unicode/source-fidelity corpus.
- `tests/editor-contract.cjs`, `tests/editor-presentation.cjs`, `tests/editor-tables-math.cjs`, `tests/editor-security.cjs`: focused behavior suites.
- `scripts/benchmark-editor.cjs`: repeatable editing latency/long-task evidence, separate from Rust rendering benchmarks.

Modify `ui/editor.js`, `ui/app.js`, `ui/preview.js`, `ui/index.html` and existing styles to integrate and remove islands. UI layout/theme/control decisions remain designer-owned. Modify `package.json`/lockfile, notices and CI only as required for reproducible local packaging and test execution.

Native image integration may require a new narrow command in `src/main.rs`, shared helpers in `src/markdown/images.rs`, entries in `build.rs`/`capabilities/main.json`, and probe-denial coverage. Do not change the native file-save contract to accommodate an editor library.

## Task 0 — Prove the editing substrate before selecting it

**Owner:** implementation specialist for the bounded spike, designer for interaction evaluation; parent reconciles. Architecture advisor only if a gate fails or competing engines require a trade-off.

**Files:** isolated `/tmp/opencode/folio-editor-spike/` harness and evidence; commit only a conclusion in `docs/superpowers/plans/2026-10-29-editor-feasibility.md` after execution is authorized. No product routing change.

- [ ] Create a minimal source-backed editor harness using pinned candidate packages and record resolved versions/build bytes. Do not use the mockup's contenteditable as an engine substitute.
- [ ] Before adding presentation features, write failing browser assertions against the exact fixture below. The harness observes the real editor buffer, selection offsets, history and transaction count; the observations are test-only, not a permanent diagnostic API.

```markdown
---
title: Keep this frontmatter
---
# Heading

Text **bold** and *italic*, `code`, [route](https://example.com).

- [ ] Pack stove
- Parent
  - Child

| Route | Distance |
| :---- | -------: |
| Ridge | 14 km |
| Lake | 9 km |

| Untouched  |  Exact spacing |
|:----------|---------------:|
|  Keep me  |    12          |

Inline $t = d/v$.

$$
c = \sqrt{a^2 + b^2}
$$

<!-- preserve exactly: spaces  and syntax -->
After table: café 😀 é.
```

- [ ] Implement clean formatted core content and local source reveal in one editor. CodeMirror block/multiline replacement decorations must come from a direct state-field decoration set, not a viewport-dependent decoration callback.
- [ ] Implement a minimal **direct cell edit** in the small rendered table. Clicking a visible character maps to that cell's underlying source position. Typing changes its value without requiring raw pipe editing or another editable root.
- [ ] Prove selection with endpoints **inside** table cells: cell to cell, cell to preceding/following prose, and prose to cell, in both directions using pointer drag and Shift+arrows. Assert visible selection, source selection offsets, replacement/deletion and undo agree. Also test prose through the whole table, but selecting around an atomic widget alone cannot pass. Test entering/leaving first/last cells, empty cells, escaped pipes, inline formatting in a cell and non-ASCII content. The table stays formatted during ordinary typing and IME, not raw pipes on focus.
- [ ] Prove inline/display math source editing through the same buffer, valid KaTeX output and invalid-TeX source fallback. Static MathML or delimiter labels do not satisfy this gate.
- [ ] Toggle presentation mid-caret and mid-selection, including backward selection; verify same editor instance, identical document text and history, same source offsets, no lost keystrokes and stable viewport anchor.
- [ ] Prove Enter split, Backspace join, paste/copy and undo/redo across formatted constructs and table edits. Use real keyboard/pointer input; synthetic dispatch-only tests are insufficient.
- [ ] Run a composition smoke check and a manual native-webview IME scenario. Playwright composition events alone do not establish real platform IME behavior.
- [ ] Edit a table cell and then ordinary text; assert untouched frontmatter/comment/table-adjacent source and the unusually spaced second table are identical. Only the edited table may normalize its own syntax.
- [ ] Measure 1/100/1,000-table fixtures and an 8,000-paragraph fixture, record machine/runtime, startup, incremental edit latency, long tasks and memory. Include the proposed shell notification, dirty checks and debounced statistics path, not just a bare editor. Avoid requiring full-buffer string conversion per keystroke; measure change/revision notifications with on-demand string materialization too. Probe the 20 MiB file boundary separately; the proposed clearly announced same-editor source fallback needs explicit design approval before shipping and cannot rescue a failed small-table gate.
- [ ] Record pass/fail per gate, exact commands, screenshots and remaining limitations. Stop if source-only tables, nested editor islands, broken cross-table selection, lost history or dropped source are necessary workarounds.

**Decision:** adopt CodeMirror only if the combined gate passes. Test line-preserving approaches with editor-owned cell text as well as opaque widgets. If private view patches or a substantial custom input/selection engine are required, report the maintenance cost as an architecture decision rather than routine table code. Otherwise compare a source-mapped document editor or rich-text engine against the same fixture, particularly Markdown fidelity, before proposing a new design. A narrower demo is not a passing implementation of the approved experience.

## Task 1 — Package the accepted engine offline and reproducibly

**Files:** `package.json`, `package-lock.json`, `scripts/build-editor.cjs`, `ui/editor/entry.js`, `ui/vendor/editor/`, `THIRD_PARTY_NOTICES.md`, `.github/workflows/checks.yml`; release workflow only if generated assets are not committed.

- [ ] Write an asset test that fails when the bundle is absent, loaded more than once or requests a nonlocal script. Preserve welcome-screen laziness and KaTeX/Mermaid isolation checks.
- [ ] Add the accepted exact dependency versions and a build script producing a local IIFE plus license/provenance metadata. Commit the generated bundle so Tauri's static `ui` distribution does not depend on an unrun release-time bundler.
- [ ] Add `npm run build:editor` and `npm run check:editor-bundle`; check mode rebuilds into a temporary directory and compares generated bytes/manifests. Builds must not embed local paths or timestamps.
- [ ] Run the reproducibility and focused lazy-asset checks. Document any intentional size change. Keep the existing CSP unchanged unless separately reviewed.
- [ ] Commit only this packaging unit once checks pass. Do not switch the app's default editor yet.

**Expected commands:** `npm ci && npm run build:editor && npm run check:editor-bundle`; `npm run test:lazy`. Expected: deterministic bundle, no unexpected network, no main-page Mermaid execution.

## Task 2 — Establish the continuous controller and one history

**Files:** `ui/editor/controller.js`, `ui/editor/entry.js`, `ui/editor.js`, `ui/app.js`, `tests/editor-harness.cjs`, `tests/editor-contract.cjs`.

Controller boundary to implement and test (UTF-16 offsets throughout the JS editor):

```javascript
// Factory exported by the bundled entry:
// createFolioEditor({ parent, content, onChange }) => controller
// onChange({ changes, revision, origin }) runs for text changes.
// changes are source-range edits; revision is an opaque document-change token.
// Do not require complete-source string materialization in this notification.
// origin is 'typing', 'action', 'undo', 'redo', or 'document-load'.
// controller methods:
// getText() => string
// getSelection() => { anchor: number, head: number }
// setSelection({ anchor, head })
// replaceRange({ from, to, insert, origin: 'action' }) => boolean
// setPresentation({ showMarkdown: boolean })
// setLocked(boolean)
// loadDocument({ content })       // new document state/history, not an undo edit
// undo() => boolean; redo() => boolean
// focus(); destroy()
```

- [ ] Write red tests for ordinary typing, selection across blocks, empty document, Unicode positions, task transaction/history, load/reset and Lock rejecting API-driven edits.
- [ ] Implement one persistent controller with editor-managed history. The controller is authoritative; adapt the shell's `current.content` mirror/readers to materialize exact text at save/snapshot/discard decisions and other explicit boundaries rather than requiring a full string on each keystroke. Notifications carry range changes/revisions. Dirty tracking must never report clean after an unsaved edit; undo back to saved text must become clean, using exact comparison when required. Debounce statistics and avoid redundant scans. Include these paths in performance checks, without triggering full `renderPreview`.
- [ ] Route pointer commands and shortcuts through the same transaction system. Remove the old full-string undo/redo stacks from the new path; prevent shell Ctrl/Cmd+Z handling from causing a second undo.
- [ ] Model Lock as a document-change guard as well as editor read-only/editable configuration. Reject undo/redo and all user actions while locked; explicitly trusted open/reload creates a new document session rather than bypassing a user-edit guard.
- [ ] Keep the old UI routing until integration tests are ready, but do not ship two independently authoritative editors. Validate save captures the buffer at invocation and later typing remains dirty after an asynchronous save resolves.
- [ ] Run `node tests/editor-contract.cjs` and commit the passing unit.

**Representative assertions:**

```javascript
assert.equal(editor.getText(), expectedSource);
const before = editor.getText();
editor.setLocked(true);
assert.equal(editor.replaceRange({ from: 0, to: 0, insert: 'X', origin: 'action' }), false);
assert.equal(editor.getText(), before);
editor.setLocked(false);
```

## Task 3 — Implement clean B, local A and exact snapshot

**Files:** `ui/editor/presentation.js`, `ui/editor/actions.js`, `ui/source-snapshot.js`, `ui/index.html`, existing UI styles, `tests/editor-presentation.cjs`.

- [ ] Write failing fixtures for heading levels, bold/italic/strikethrough, inline/fenced code, nested lists/numbering, tasks, blockquotes, links and dividers. Assert real clean rendering, not gray syntax left visible everywhere.
- [ ] Hide source delimiters with syntax-aware decorations; style actual content. A reveals the exact local construct; B still permits necessary source access via explicit Edit source actions for complex/unsupported constructs, in the same buffer. No nested editor sessions.
- [ ] Define source ranges from the accepted parser, not visual rows or regex over rendered HTML. Handle escapes, nested constructs and selections intersecting hidden syntax; do not rebuild decorations mid-composition in a way that disrupts IME.
- [ ] Add one Show Markdown button with `aria-pressed`, B initially off. Pointer activation retains editor selection. Keyboard activation remains operable without a focus trap or surprising forced focus transfer; restoring the last logical editor selection must not make controls unreachable.
- [ ] Implement the snapshot dialog from a captured `editor.getText()` string at opening. Copy copies exactly that string; it is not HTML serialization or disk content. Pause neither editing state nor save scheduling. Restore logical focus/selection on close. Reopening captures the newer buffer; the open dialog is a clearly labeled snapshot, not a second live editor.
- [ ] Test toggling with forward/backward selections, source offsets, scroll anchor and history preserved. Copy assertions compare exact strings including final newline; opening/closing/copying produces zero document-change transactions.
- [ ] Run `node tests/editor-presentation.cjs` and commit.

## Task 4 — Promote real tables and math from the accepted spike

**Files:** `ui/editor/tables.js`, `ui/editor/math.js`, `ui/editor/presentation.js`, `ui/editor/actions.js`, `tests/editor-tables-math.cjs`, `tests/fixtures/unified-editor.md`.

- [ ] Port the passing table/selection tests before porting code. Add cell typing, empty cells, alignment preservation, escaped pipes, row/column add/delete, undo and locked-action rejection.
- [ ] Promote direct-cell source mapping and structural commands. All changes dispatch source-range transactions, including row/column actions. Preserve untouched tables; canonicalize only the edited table. Context controls must have pointer and keyboard paths.
- [ ] Add math parsing tests for escaped dollars, currency-like text, inline/display/fenced math, code fences, list/blockquote context and malformed delimiters. Compare intended syntax with Comrak fixtures rather than assuming built-in GFM includes math.
- [ ] Implement the accepted exact math-range parser and KaTeX rendering using existing local assets, loaded only when needed. Source edits occur in the same controller; invalid formulas retain source and an accessible error message. Do not execute TeX trust commands or introduce remote resources.
- [ ] Use direct state-field decoration sets for multiline/block replacements. Handle asynchronous height changes through the editor measurement API and discard stale render results after document/revision changes.
- [ ] Run `node tests/editor-tables-math.cjs`; repeat the table crossing/undo gate after integration, not merely the isolated spike. Commit only after passing.

## Task 5 — Direct actions, image trust and retained extensions

**Files:** `ui/editor/actions.js`, `ui/editor/media.js`, `ui/preview.js`, `src/markdown/images.rs`, `src/main.rs`, `build.rs`, `capabilities/main.json`, relevant native probe tests, `tests/editor-security.cjs`, existing renderer tests.

- [ ] Test task toggles, edit/open link, remote-image placeholder/Load, local-image validation and Lock. Test that hover, focus, opening a document and snapshot inspection produce no remote request when permission is off.
- [ ] Implement source-range task and link edits as ordinary undoable transactions. Treat link navigation and image permission as non-document actions. Both must remain available without finding a palette command.
- [ ] Extract/reuse the existing local-image validation. If adding a native resolver, bind it to the current native document rather than accepting an arbitrary base/path. Reject traversal, absolute paths, unsupported types and symlink escapes. Preserve 10 MiB per-file, 200-occurrence and 32 MiB aggregate encoded-image budgets across all editor widgets, not per request alone.
- [ ] Add any new command to all main-only allowlists and assert the isolated renderer cannot invoke it. Invalidate cached results on document changes; image authorization/replies must not leak across open files.
- [ ] Keep Load explicit and session-scoped with the existing global preference honored. Do not prefetch, auto-fetch link titles or issue URL requests from hover/focus. Loading under Lock must not dirty the document.
- [ ] Reuse the existing isolated Mermaid request/cancel/result bridge and sanitized SVG contract. Cancel obsolete work and ignore stale results; never load Mermaid code in the main webview. Retain existing source/SVG budgets.
- [ ] Add safe same-buffer source presentation for frontmatter, HTML, footnotes, wikilinks, alerts and other unsupported Comrak extensions. Raw HTML is never installed as unsanitized editor DOM. Merely opening a document changes no source.
- [ ] Run focused editor-security, Rust image/path tests and the existing renderer bridge/security checks; record native-denial evidence. Commit the unit.

## Task 6 — Switch shell routing and retire islands

**Files:** `ui/app.js`, `ui/editor.js`, `ui/preview.js`, `ui/index.html`, existing styles, `tests/ui-smoke.cjs`, `tests/live-editor.cjs`, `tests/preview-limits.cjs`, `tests/lazy-assets.cjs`.

- [ ] Write failing shell integration assertions for opening/new documents in B, save/Save As, dirty/discard/conflict flow, close protection, outline navigation, find and shortcuts. Retain unrelated picker/tree/theme/zoom coverage.
- [ ] Mount the persistent editor and replace Preview/Edit controls with Show Markdown, Lock and Source snapshot. Lock uses the same editor, not a separate Rust HTML projection. Delete mode-dependent commit/blur routing and `.live-editor` textarea creation after all new paths pass.
- [ ] Route find and outline to source ranges/editor viewport rather than mutating or searching a second rendered DOM. Retain accessible announcements and current navigation behavior.
- [ ] Save from the exact buffer immediately; preserve existing async snapshot, conflict, atomic-write, CRLF/BOM and size-limit behavior. Trusted open/reload resets history and view defaults; history must not undo into a different file.
- [ ] After approval of the spec's exceptional large-document fallback, adapt preview-limit tests to explicit rich-decoration degradation in the same source-backed editor, with a clear explanation. Without that approval, stop before shipping the exception. It is only for measured complexity limits, never ordinary table feasibility failure. No source truncation, no hidden full-document replacement and no read-only snapshot presented as the only editing escape hatch.
- [ ] Replace visual-line/island assertions in `tests/live-editor.cjs`; keep its real Rust fixture, Unicode, save, task-history and Mermaid reuse intent. Do not keep the old “only one wrapped visual line” contract.
- [ ] Run the changed editor and shell checks once, then commit the integrated switch. Preserve `render_markdown` for existing safe projection/fixtures; do not remove security code merely because editing no longer uses its HTML as truth.

## Task 7 — Release gate: accessibility, native behavior, performance and packaging

**Files:** focused editor tests, `scripts/benchmark-editor.cjs`, `package.json`, `.github/workflows/checks.yml`, notices and the feasibility/conclusion record.

- [ ] Add focused suites to a single `test:editor` command and CI; avoid running the same expensive suite twice through both legacy and new scripts. Keep the existing `test:ui` shell/security intent.
- [ ] Check keyboard-only operations and screen-reader labels for toggle/lock/snapshot/tasks/context controls. Test narrow-window/touch target behavior with no hover-only control. Manually exercise native webview composition and clipboard on supported target platforms.
- [ ] Run repeatable performance fixtures, record p50/p95 incremental transaction-to-paint latency, startup and long tasks. Proposed release budget for the recorded Linux reference machine: p95 ordinary typing under 100 ms on the 8,000-paragraph fixture and no synchronous edit task over 250 ms. Treat these as explicit proposed UX budgets, not measurements already achieved; investigate rather than weakening them silently.
- [ ] For 1,000-table and near-20-MiB fixtures, verify bounded behavior. If the explicit large-document exception has been approved, verify its responsive, clearly labeled same-editor source fallback. Set the rich-decoration cutoff from Task 0 evidence; do not change the native 20 MiB file limit to hide a performance failure or treat this exception as approval to weaken ordinary tables.
- [ ] Run the full repository verification set below once after reconciling all writer scopes. A failed gate is a reported failure, not a reason to delete the invariant.
- [ ] Update the implementation record with actual commands/results and remaining manual-platform limitations. Request approval to integrate; do not auto-merge or auto-release.

## Verification ownership and evidence

| Claim | Primary evidence | Owner |
| --- | --- | --- |
| One continuous editor, real direct table editing | Real browser pointer/keyboard cross-table selection/edit/undo; native-webview confirmation | Controller/table implementer |
| B/A is presentation only | Exact source + selections/history/instance + viewport anchor before/after; screenshots for formatting | Presentation implementer + designer visual review |
| Lock and snapshot safe | Rejected DOM/API/actions/undo; exact buffer copy; zero text transactions for inspection/permission | Controller implementer |
| Tables/math are real | Cell and TeX edits change exact source, render correctly, undo correctly; malformed inputs preserve source | Table/math implementer |
| Save and source preservation | Rust file tests + real fixture shell tests + async-save race checks | Integration implementer |
| Privacy/isolation | Request interception + native path/budget and command-denial tests + existing Mermaid security suites | Media/native implementer |
| Shipping is offline/reproducible | Rebuild check, local bundle/CSP/lazy tests and native package build | Packaging implementer |
| Final combined behavior | One reconciled complete run; focused evidence reused only while relevant code remains unchanged | Parent orchestrator |

### Final runnable verification

Run from repository root. `npm ci` and browser/system dependency setup are preparation steps, not evidence of feature correctness.

```sh
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked --example editor-fixture
npm run check:editor-bundle
npm run test:paths
npm run test:editor
npm run test:ui
```

`test:editor` is added by Task 7 and includes the migrated `tests/live-editor.cjs`; do not also rerun it separately. Existing CI runs that file explicitly today and must be updated coherently.

Linux native evidence (requires installed GUI/native build dependencies):

```sh
cargo build --locked
timeout 180s dbus-run-session -- xvfb-run -a env \
  GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  FOLIO_NATIVE_PROBE=1 ./target/debug/folio
```

Expected: exit zero and `FOLIO_NATIVE_PROBE_PASS`, including rejection of new main-only commands from the renderer where applicable.

Packaging and performance:

```sh
node scripts/benchmark-editor.cjs
cargo build --release --example editor-fixture
node scripts/benchmark-render.cjs
npx tauri build --ci --no-sign
npm run check:bundles
```

Record actual outputs, artifact sizes and machine/runtime. Browser mocks cannot establish native IPC permissions, file save correctness, real IME or installed-package offline behavior by themselves.

## Handoff and stop conditions

1. Approve the written design and the bounded Task 0 experiment first.
2. Execute Task 0 in an isolated lane; report its evidence before selecting an engine or starting product integration.
3. On pass, confirm measured limits/dependency versions and sharpen the engine-specific task code against that proven substrate. Assign non-overlapping writer scopes; do not parallelize controller and shell writers over `ui/app.js`.
4. On failure, preserve the failed case and propose an alternate engine/design. Source-only table editing, nested editors and source loss are not accepted shortcuts.
5. After delivery, remove throwaway implementation assets from the shipping UI. The brainstorming prototype remains separate; `.superpowers/` should be ignored locally or in the repository rather than bundled or committed accidentally.
