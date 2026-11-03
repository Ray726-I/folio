# Folio Performance Recovery Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task by task. Steps use checkbox syntax for tracking. Execution is recorded at the end of this document; the work is now committed to `main` and this plan is retained as a historical implementation record.

**Goal:** Remove measured interaction stalls while preserving exact Markdown, immediate editing feedback, navigation, accessibility, and the existing visual character.

**Architecture:** Keep the synchronous canonical editing model and ProseMirror view. Reduce repeated parsing and allocation, derive secondary UI from existing model data, and bound geometry work to relevant visible elements. Use native measurements to guide changes to layout and painting.

**Tech Stack:** Tauri/Rust, JavaScript, ProseMirror, markdown-it, Lezer, Playwright, existing Node correctness suites.

## Evidence and limits

Branch at the time of writing: `codex/experiment`. No application fixes had been applied when the investigation began.

- Existing browser keystroke benchmark: 10 KB median/worst 9.4/25.6 ms; 50 KB 31.7/54.2 ms; 100 KB 56.9/94.1 ms. These measure keydown to canonical source publication, not input-to-paint.
- A readable browser CPU profile at roughly 100 KB contains parsing, buildLedger, token allocation, equality checks, and garbage collection. It confirms the parse/ledger pipeline is hot, but does not assign precise percentages to each component.
- Ten synchronous outline refreshes averaged 17.8 ms each on large prose with one heading. Header sizing averaged 0.07 ms and unchanged active-heading tracking 0.01 ms in the same diagnostic run. These averages are indicative, not p95 results.
- Mixed movement/scroll test: 1,590 rectangle reads for 150 tables, versus 58 for prose. This is a workload comparison, not a controlled equal-size document comparison.
- A synthetic worst-case hover probe outside all table bounds produced 3,000 rectangle reads for 20 updates with 150 tables and 10,000 with 500. This proves linear scanning; its coordinates were deliberately out of bounds and are not a reproduction of ordinary user movement.
- `syncOutlineContext()` writes every entry's tabIndex after active-section changes. `refreshEditorOutline()` tokenizes the document and rebuilds the entire outline after typing pauses.
- Native WebKit/GPU frame pacing and real window resizing remain unmeasured. No evidence yet justifies blaming CSS transitions or removing them.

## UX requirements

- Every accepted edit updates canonical source synchronously. Saving, undo, find, copy, and mode switching always see the latest text.
- Preserve untouched Markdown bytes, CRLF, escapes, entities, references, extensions, and unsupported blocks. Ambiguous edits retain the validated fallback.
- Preserve selection direction, composition/IME, stored marks, source bookmarks, undo grouping, scroll position, and typing into code/math/table cells.
- Outline labels and offsets stay correct after edits. Collapsed sections, keyboard focus, and active-ancestor highlighting survive updates. Any delayed result must be revision checked.
- Table edge controls remain discoverable from gutters and keyboard accessible. Dragged/focused controls stay pinned; stale controls disappear after deletion or document replacement.
- Keep existing layout, typography, useful motion, and reduced-motion support. Do not hide latency with longer debounces, disable spellcheck globally, or remove functionality.

## Targets and baseline method

Targets are provisional acceptance goals, not promises about unknown hardware. Record hardware, WebView/browser version, refresh rate, build mode, and document size with every report. Compare before/after on the same machine and build.

- 100 KB ordinary typing: p95 canonical publication <=16 ms, median <=8 ms; instrument input-to-next-paint separately. Report punctuation, deletion, Unicode, marked text, run edges, and structural edits independently.
- No recurring >50 ms main-thread task during normal typing, scrolling, hover, or sidebar dragging in the fixture set.
- At 60 Hz, p95 interaction frame interval <=20 ms after warmup; at higher refresh rates report missed refresh opportunities rather than applying the 60 Hz threshold blindly.
- Steady scroll and hover callbacks should normally fit within 2 ms per frame on baseline hardware. Geometry reads should scale with visible candidates rather than total table count.
- Outline work must not cause >16 ms synchronous pauses at 100 KB. An outline result should ordinarily appear within the existing 500 ms debounce plus one frame; hidden outlines do no rebuilding.
- Open/switch time and retained memory must not regress materially. Measure repeated open/edit/close cycles; check for retained observers, nodes, timers, and caches.

## Task 1: Make the measurements reproducible

**Files:** extend `scripts/bench-keystrokes.cjs`; create `scripts/bench-interactions.cjs`; reuse `tests/editor-browser.cjs`; document results in `docs/performance-results.md`.

- [ ] Add keystroke scenarios for plain run interiors, run boundaries, spaces/punctuation, backspace, marked text, Unicode, and IME. Exercise 10/50/100 KB and a larger stress fixture separately.
- [ ] Report median/p95/worst, warmup count, sample count, and keydown-to-source versus input-to-paint. Use event timing/presentation traces where supported: rAF runs before paint, so double-rAF is only a frame approximation and must be labeled as such. Measure native presentation separately. Keep diagnostic instrumentation out of timed production samples.
- [ ] Add deterministic interaction fixtures: prose; 300 headings with collapsed branches; 150/500 tables separated by prose; code/math/images. Move the real pointer through cells, prose, and gutters; scroll the reader and nested panes; drag the divider; resize the viewport.
- [ ] Collect frame intervals, long tasks, callback duration, layout/recalculation time, and geometry reads in separate passes. Never treat synthetic event throughput as user frame latency.
- [ ] Profile the release Tauri app on the user's native session with the same fixtures. Capture active editing, scrolling, window resizing, and sidebar dragging. Record CPU versus layout/paint/compositor costs.
- [ ] Run `npm run bench:keystrokes` and `node scripts/bench-interactions.cjs`; save the baseline before implementation.

## Task 2: Make ordinary typing local and reduce ledger rebuilding

**Files:** `ui/editor/source-edits.js`, `ui/editor/source-ledger.js`, `ui/editor/model.js`, `ui/editor/rich.js`; existing `tests/editor-source-edits.cjs`, `tests/editor-source-edits-fuzz.cjs`, `tests/editor-parse-budget.cjs`.

- [ ] Add differential cases before extending optimization: compare each incremental result to a fresh `parseSource(result.source)`, including document equality and bidirectional source mappings. Cover edge syntax, spaces, marks, escapes/entities elsewhere in the file, CRLF, reference links, lists, and Unicode.
- [ ] Count full parses and ledger builds per edit. Distinguish fast-path rejection reasons so the optimization addresses actual benchmark fallbacks.
- [ ] Extend the safe single-text-edit path incrementally. Validate the changed owner and its syntax boundaries, retain exact untouched mappings, and use explicit eligibility checks for syntax that can affect other blocks. Do not merely widen the allowed-character regex.
- [ ] Only after safe typing changes and ledger lookup/allocation improvements have separate review checkpoints and measurements, and only if targets remain unmet: for rejected text edits, prototype reparsing the smallest proven independent top-level block with its required context. Require an equivalent document-level reference environment and surrounding parser context, even when reference definitions were not edited; exclude dependent blocks when equivalence is uncertain. Differential checks must verify mappings outside the edited block too. Compare the candidate with the intended ProseMirror subtree; preserve the existing full-document fallback for reference-definition changes, block-boundary changes, unsupported syntax, and any uncertain dependency.
- [ ] Avoid repeated `intendedDoc.nodeAt()` searches for every owner: traverse the intended tree once to associate positions/nodes. Reuse unchanged objects where safe; rebase changed offsets without constructing duplicate source strings. Measure these changes separately from parse reduction.
- [ ] Cache revision-scoped eligibility facts instead of scanning every mapping on every key. Invalidate them on every structural or source replacement. Keep derived state owned by the model revision rather than mutable global state.
- [ ] Run `npm run test:editor:unit`, source-edit fuzz cases, and the browser typing/history/roundtrip/composition/stored-mark suites. Rebuild using `npm run build:editor`, then run `npm run check:editor-bundle` and the keystroke benchmark.
- [ ] Accept each optimization only when exact-source checks pass and the relevant scenario improves. If block-local parsing cannot meet correctness requirements, retain full parsing there and report that scenario separately.

## Task 3: Stop reparsing and rebuilding the outline after ordinary typing

**Files:** `ui/editor/entry.js`, `ui/editor/rich.js`, `ui/editor.js`, `ui/outline.js`, `ui/preview.js`; tests `tests/outline-follow.cjs`, `tests/outline-controls.cjs`, `tests/editor-extension-outline.cjs`.

- [ ] Add regression coverage for editing prose between headings, renaming/inserting/removing headings, changing levels, collapsed ancestors, focused outline rows, and raw extension headings.
- [ ] Expose revision-scoped heading metadata through the editor facade, using the existing parsed document/source model. Preserve raw extension heading behavior; use the existing heading parser as a fallback only where metadata cannot prove equivalence.
- [ ] Separate heading identity/text/level changes from offset-only shifts. Update offsets from the current source model without rebuilding rows; patch changed labels and reconcile structural changes with stable identities.
- [ ] Preserve collapse state, focused row, and outline scroll position across reconciliation. Do not use mutable offsets as persistent heading identity. Match unchanged heading nodes through transaction mappings; assign a per-document identity to inserted headings. Duplicate labels never establish identity. On split retain the original identity on the mapped original start; on merge retain the surviving start identity. Restore identities through undo metadata where available; otherwise discard stale collapse state rather than attach it to an uncertain match. Reset identities on document replacement, and move focus to the nearest surviving visible row if its heading is deleted.
- [ ] In `syncOutlineContext`, change tabIndex only for the previous and next tab stop, including active hidden descendants and their visible ancestors. Reinitialize on tree replacement; clear references on document changes.
- [ ] Keep the existing hidden-outline early exit and 500 ms scheduling initially. Revision-check asynchronous work. Re-measure before changing scheduling or moving any work to a worker.
- [ ] Run the listed outline suites plus `tests/editor-find-after-edit.cjs`; benchmark refresh and scrolling at 300 and 1,000 headings. Verify keyboard focus, collapse, active state, and source navigation manually.

## Task 4: Bound table hover and chrome work

**Files:** `ui/editor/rich.js`; tests `tests/editor-table-hover.cjs`, `tests/editor-table-actions.cjs`, `tests/editor-table-keyboard.cjs`, `tests/editor-table-operations.cjs`.

- [ ] Add coverage for approaching each edge from prose/gutters, offscreen tables, document replacement, table deletion, zoom, sidebar resizing, nested scroll, keyboard focus, and pointer capture.
- [ ] Track mounted table wrappers and visible candidates using node-view lifecycle plus IntersectionObserver, with an expanded margin for edge discovery. Use the direct ancestor path for events within a table; scan only nearby visible candidates for gutter discovery. Populate candidates at mount; because observer delivery is asynchronous, synchronously probe the current pointer neighborhood on an empty/stale candidate set before hiding controls. Bound this fallback to the visible neighborhood rather than scanning the whole document.
- [ ] Read candidate rectangles at most once per frame. Invalidate geometry after document/layout changes, scrolling, zoom, resize, fonts loading, images decoding, and extension rendering; do not retain stale rectangles across those events.
- [ ] Coalesce scroll/resize chrome positioning to one animation-frame callback. Skip geometry work when controls are inactive and no focused/hovered/dragged table requires them. Filter unrelated nested scrolling where it cannot move the active table.
- [ ] Keep handle nodes stable when their identity is unchanged. Separate rectangle reads from style writes and preserve focused controls while repositioning.
- [ ] Cancel pending frames and disconnect observers on teardown. Run all listed table suites and compare real gutter/pointer/scroll workloads at 150/500 tables.

## Task 5: Address native resize, scroll, and motion only where traces justify changes

**Files:** potentially `ui/core.js`, `ui/app.js`, `ui/styles.css`, `ui/diagram-viewer.js`, `ui/editor/rich.js`. Select changes from Task 1 traces.

- [ ] Compare idle scrolling with table chrome and outline activity enabled/disabled in the diagnostic harness. Compare reader resize against plain browser layout to separate JS from document reflow and WebView painting.
- [ ] If resize JS contributes materially, coalesce geometry work per frame and avoid writing unchanged header/style values. Keep compact-header thresholds and title centering behavior intact.
- [ ] If large-document reflow/paint dominates, prototype containment on isolated noneditable previews first. Adopt it only after checking scroll anchoring, selection, find, accessibility, print, and table/formula sizing. Do not virtualize the editable document as an initial fix.
- [ ] If a specific transition causes repeated expensive painting, adjust only that transition/property. Preserve useful motion and reduced-motion handling. Avoid blanket `will-change`, global transition removal, or layer promotion for every block.
- [ ] Check diagram fit resize for observer feedback and unnecessary resets. If reproduced, avoid unchanged size writes and preserve fit/manual zoom semantics.
- [ ] Review native traces again after each change. If this phase finds no material defect, document the negative result rather than changing cheap handlers for cosmetic performance claims.

## Task 6: Acceptance and regression review

- [ ] Rebuild the editor bundle and run `npm run check:editor-bundle`, `npm run test:editor`, and `npm run test:ui` after the respective subsystem changes. Run Rust checks only if native code changes.
- [ ] Repeat the baseline benchmarks with the same fixtures and environment. Include slow scenarios and regressions in the report; do not average them away.
- [ ] Manually verify the release native app: type/paste/IME, undo/redo, save/reopen exact source, find, code/formula/table editing, collapsed outline navigation, zoom, resize, scrolling, and reduced motion.
- [ ] Compare before/after recordings and traces. Check retained memory after repeated document replacement and confirm no pending work updates a closed/replaced editor.
- [ ] Deliver changes in independently reviewable groups: instrumentation; typing/model; outline; table interactions; evidence-based native/layout fixes. Do not commit, merge, or publish without the user's instruction.

## Execution order and stopping rules

Baseline first. Then typing/model, outline, table interactions, native/layout, and final acceptance. Each phase produces a functioning app and its own before/after evidence. Revert a change that worsens correctness, focus, anchoring, or performance; investigate the cause before adding another workaround. A successful Chromium result does not substitute for native acceptance. If native tracing cannot run, deliver verified browser improvements and explicitly leave native resizing/scrolling symptoms unverified; do not declare those symptoms resolved.

This plan covers known defects and investigation of the reported native symptoms. It cannot guarantee eliminating every possible performance issue without measuring the remaining paths.

## Execution record (2026-11-03)

- Tasks 1 and 6: reproducible keyboard, interaction, outline-refresh, and bounded replacement/heap diagnostics implemented. Final before/after results and raw reports are recorded in [performance-results.md](../../performance-results.md). Timing instrumentation and geometry diagnostics run in separate passes.
- Task 2: local validated paragraph/heading parsing now serves both rich transactions and source-first commits. A narrow parser-free proof preserves fast typing for letter-leading plain paragraphs without trailing whitespace; numeric list triggers and ambiguous punctuation retain parser validation. Left/right boundary affinity is accepted only when parsing proves agreement with the intended rich document. Ledger queries use binary search; owner association uses one document traversal. Untouched source slices and later character maps are preserved. Complex, reference-dependent, multiline, and uncertain edited-owner cases retain the full parser; exact independent owners can optimize even when unrelated blocks have partial mappings. Unit tests count tokenizations/parse sizes to distinguish local parsing from fallback; a production rejection-counter subsystem was not added.
- Task 3: model-derived heading metadata, source/transaction identity tracking, row reconciliation, and constant-sized tab-stop updates implemented. Partial/unproven metadata falls back to the existing outline parser. Undo resets identities rather than transferring uncertain collapse state.
- Task 4: visible-table candidates and bounded point probes replace document-wide gutter scans. Scroll/resize overlays coalesce per frame; handle nodes retain focus. A review-discovered scroll-away/return regression was reproduced with a failing test and fixed before acceptance.
- Task 5: no animation, typography, header, or containment changes were justified by the available traces. Native CPU sampling was attempted with Sysprof without changing system permissions; perf-event streams were denied and graphics-info utilities were unavailable. Native Wayland/GPU frame pacing and real window resize acceptance remain unverified.
- Verification: full editor browser and UI suites passed; unit suites include 4,000 rich-text fuzz attempts and 2,000 source-first attempts, with accepted edits compared against fresh source/document/mappings. New heading and table regressions passed. The isolated native WebKit keyboard smoke passed exact save/undo/reopen checks for both debug and final release builds. Final bundle and build checks are recorded in the measurement report.
- Independent reviews checked spec compliance and implementation quality. The remaining acceptance limits are explicit in the results report; browser timing is not treated as native presentation timing.
