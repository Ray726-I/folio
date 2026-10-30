# Unified editor repair

Status: investigation in progress. The previous passing mock-based suites did
not establish the accepted editing contract or production readiness.

## Confirmed baseline failures

- Ctrl+E hides the focused editor without focusing its replacement. Typing
  immediately afterward does nothing (`tests/editor-shell-regressions.cjs`).
- Pointer/native caret movement can reach the DOM before ProseMirror's
  selection observer. Toggling immediately captures the old model caret.
  In the regression, paragraph-end typing lands in the heading instead.
- Architectural review: flattened `diffChars` position mapping is ambiguous
  for repeated text, Markdown delimiters, entities and structural boundaries.
  Equivalent rich nodes are not proof of equivalent source slices.
- A one-character edit to the last paragraph drops trailing reference
  definitions, breaking links in untouched paragraphs. Equally rendered blocks
  can also steal one another's attached definitions. Adjacent headings gain
  blank lines even during a no-op model round trip.
- Typing bold syntax can be consumed as italic before the second closing
  marker is entered. Basic typed links/images and dividers are escaped.
- Rapid typing at two different caret positions is merged into one undo event
  solely because both edits occur within 650 ms. The first failing history
  regression returned the pre-edit document instead of retaining the first edit.

## Evidence gathered during repair

- `tests/editor-shell-regressions.cjs`: immediate toggle/typing target.
- `tests/editor-history-regressions.cjs`: caret-discontinuous undo/redo.
- `tests/native-tauri-probe.js` now includes `main-editor`, using the actual
  WebKit view and real native IPC; parent reran it and observed
  `editorPass:true`, exact saved bytes, and `FOLIO_NATIVE_PROBE_PASS`.
  Its interior-range mapping assertion does not establish block-edge mapping.
- Native probe input is explicitly programmatic, not proof of physical keyboard
  handling or IME. Existing green tests do not waive the remaining repair gates.

## Constraints

Keep the approved unified-document experience, explicit image consent, Lock,
exact unsaved snapshot and native file/security behavior. Keep the established
ProseMirror table geometry/commands rather than reopening the failed custom
column-layout experiment. Do not use more passing happy-path tests as a
substitute for reproducing the failures.

## Repair gates

1. Record concrete source-corruption, selection and history reproductions.
   Turn each into an independently expected failing regression.
2. Establish a source ledger with explicit token/range identity, including
   whitespace. Preserve source outside the intended transaction. Do not match
   source blocks solely by rich-node equality or ordinal index.
3. Use typed selection bookmarks with source endpoint affinity. Capture live
   text selection before focus transfer; retain node/cell selection semantics.
   Source and rich positions are not bijective, so retain latent source offsets
   instead of repeatedly converting them through flattened text.
4. Validate source, projection, selection and history together. Group history
   by actual adjacent editing intent/composition, not a wall-clock window alone.
5. Prove one fixture containing repeated text, mixed emphasis, escapes/entities,
   nested lists, differently spaced tables, math and retained raw extensions.
   Include backward selections, cross-cell/prose replacement and immediate
   toggles after native caret movement. No protective table shells after a
   legitimate exact source deletion.
6. Make local syntax reveal a projection of the persistent editor, not a
   separate editing session. Keep unsupported source reachable and editable;
   defer projection changes while composition is active.
7. Run a real Tauri/WebKit editor phase, separately from existing native ACL
   and Mermaid transport probes. Programmatic native smoke is not an IME test.
8. Reconcile all changes, inspect artifacts, run the full suite once, rebuild
   the desktop app, then perform the focused native walkthrough on disposable
   files. Report remaining limitations rather than asserting completeness.

## Work boundaries

- Parent: shell lifecycle/focus, regression orchestration, reconciliation.
- Read-only engine investigation: empirical corruption and mapping failures.
- Architecture review: source ledger/selection trade-offs.
- Native verification: debug probe and its driver only.
- UX investigation: read-only pointer/keyboard contract audit.

No reset of existing uncommitted work, user documents, or running unsaved
sessions is permitted as part of testing.

## Reconciled progress

- Added explicit source runs, owner intervals and raw gaps; removed flattened
  text-diff caret guessing and rich-node equality matching for source ownership.
- Verified plain-text transactions now patch their exact source interval and
  reparse before accepting it. A real browser regression preserves `__bold__`,
  `&amp;`, escaped literals, reference-link spelling and trailing definitions.
  Structural/formatting transactions still use a scoped serializer; this is not
  a claim of byte-preserving behavior for every operation.
- Immediate Ctrl+E now captures live DOM text selection using public editor
  APIs before focus transfer. It does not call private DOM observer internals.
- Undo grouping now requires caret continuity, rather than time proximity alone.
- Added typing regressions for bold, italic, code, links, images, dividers and
  tasks. The underlying image consent path remains in use.
- Empty task markers are parsed as tasks, including after Enter at an item's
  start/end. Empty paragraphs need separate projection anchors because Markdown
  itself has no semantic empty-paragraph node; that gate is still under repair.
- Reduced redundant parsing: public Markdown-it token capture lets the semantic
  parser and source ledger share one tokenization per source revision. The text
  patch path retains its already validated parse/ledger instead of repeating it.

### Performance observation (Chromium, development machine)

Eight single-character inputs per fixture, measured from Playwright keyboard
submission through two animation frames (includes automation overhead; not a
native IME latency claim):

| Fixture | Before parse reuse | After parse reuse |
| --- | --- | --- |
| 100 paragraphs / 7.5 KB | 49–73 ms | 33–40 ms |
| 1,000 paragraphs / 76 KB | 116–169 ms | 66–118 ms |

The first large-fixture sample remains above the proposed 100 ms target. Larger
documents and native typing still need profiling; these samples are not a
universal performance guarantee.

## Integration verification

Parent ran the combined validation after reconciling all writer lanes:

- `git diff --check`, deterministic editor bundle check, Rust formatting.
- `cargo test --locked`: 82 passed; Clippy with `-D warnings` clean.
- Path helpers: 12 passed.
- All editor unit and browser regression commands plus all six existing
  UI/security suites passed.
- Debug native `main-editor`/ACL/Mermaid probe: exact saved bytes and
  `FOLIO_NATIVE_PROBE_PASS`.
- Isolated XTest keyboard walkthrough on the real debug app: exact typing,
  source/rich toggles, undo, task/table source replacement and saved bytes.

Final clipboard review added one more data-safety regression: a thrown clipboard
write deleted the selected source. Parent observed that failure, moved clipboard
preparation before deletion, then reran the cut failure and complete selected-
interval regression suite successfully. Bundle reproducibility and diff checks
were rerun.

The final release binary was rebuilt and independently passed the isolated native
keyboard/save walkthrough (`tests/native-editor-keyboard.sh --binary
./target/release/folio`). No important user file was used; no commit was created.

### Deliberately unclaimed

This pass repairs the demonstrated source-loss and ordinary editing failures.
It does not complete the original single-root/source-reveal architecture, replace
formula/link dialogs with in-document editing, establish IME correctness, or
prove every browser clipboard/autocorrect/drag path. Exact logical bookmarks
retain source offsets that do not have an exact visible rich caret; that is not
the same as displaying their source inline. These remain explicit follow-up
gates in `docs/UNIFIED_EDITOR_TODO.md`, rather than hidden behind passing tests.
