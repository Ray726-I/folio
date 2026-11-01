# Folio: single Formatted editor migration

Branch: `feat/single-formatted-editor` (from `main` @ `3192542`)
Status: Stages 1–2 complete (single editor live, suites green). Stage 3
(performance) is next.

## Intent

One editing experience. ProseMirror becomes the only editing engine, Markdown
stays the canonical storage format, and the second editor, the mode switch and
all cross-engine synchronisation disappear.

Success is correctness and measurable improvement, not the amount of code
deleted. Every capability in today's Formatted mode survives; capabilities that
exist only because Markdown mode exists get an in-place equivalent or are
documented as a deliberate change.

## What exists today

`ui/editor/entry.js` owns one `content` string and two engines: `rich.js`
(ProseMirror) and `source.js` (CodeMirror). `showMarkdown` and `forceSource`
select which is mounted. History entries record `fallback` so undo can re-enter
source mode (`entry.js:109,279`). Selection is mapped between engines via
`sourceSelection` and the source ledger.

Features that depend on source mode, from the investigation:

| Feature | Evidence | Verdict |
|---|---|---|
| Formatted / Markdown switch, Ctrl+E | `index.html:86-89`, `app.js:902` | Removed |
| Over-limit fallback ("Rich formatting is paused…") | `editor.js:155-159`, `entry.js:8,82`, `index.html:218` | Replaced (see D2) |
| Reveal source for links, images, raw blocks | `editor.js:46-58`, `rich.js:385-430` | Replaced by in-place atom editing (D1) |
| Exact-byte editing of raw/extension blocks | `rich.js:1281-1451` | Replaced by in-place atom editing (D1) |
| Source decorations (table widgets, delimiter hiding) | `source.js:144-175` | Dropped with the engine |
| Ctrl+B bold only inside the source pane | `app.js:898` | Retargeted to the editor |

Source Snapshot (View menu) is already a read-only plain-text dialog reading the
live buffer (`editor.js:59-65`); it survives unchanged.

## Target architecture

- One `EditorView`. No mode state: `showMarkdown`, `forceSource`,
  `presentation()`, `setPresentation()`, engine hand-off, and the
  source↔rich scroll/selection restore loops are removed.
- `content` remains the canonical Markdown string, produced by the rich
  serializer for structural edits and by exact source splices for in-place atom
  edits (the pattern the math editor already uses).
- The source ledger and `source-edits.js` stay: they are the source-preserving
  edit machinery for the rich editor, not CodeMirror.
- `source.js` is deleted, along with every `@codemirror/*` import. `@lezer/markdown`
  stays: `source-ledger.js` parses with it, and that ledger is not CodeMirror.
  Bundle impact: CodeMirror/Lezer is ~501 KB of the 1.09 MB editor bundle (46%);
  deleting `source.js` removes ~465 KB of that, since the Lezer markdown parser
  remains for the ledger. The five `@codemirror/*` packages can leave
  `package.json`; `@lezer/markdown` cannot, until the ledger is rewritten.

## Decisions that change behaviour

**D1 — Raw and extension blocks get an in-place source editor.** Clicking "Edit
source" on a raw block (author HTML, front matter, unknown extensions) opens a
textarea inside the block, exactly like the math editor, and commits through the
existing exact source splice. This removes the last genuine need for a
source-text presentation.

**D2 — Over-limit documents become read-only plain text.** Today an over-limit
or over-complex document falls back to a complete, editable Markdown view. Since
ProseMirror is what the limits refuse to parse, "complete Markdown remains
editable" cannot survive a single-engine design. The replacement: the document
opens in a read-only plain-text view with an explicit notice, Save still writes
`content`, and the document remains openable. This is a real capability
reduction and is documented as such; an external editor is the escape hatch.

**D3 — Ctrl+B is retargeted.** It currently bolds only when focus is inside the
source pane, and otherwise toggles the file tree. With one editor it bolds when
focus is in the editor and keeps the file-tree behaviour elsewhere.

## Stage plan

### Stage 1 — investigation (done)

Dependency map, feature inventory, test classification, and a measured baseline.
Baseline (`parseSource`, median of 5, node, warm):

| Document | Time |
|---|---|
| 3 KB | 8.4 ms |
| 10 KB | 8.0 ms |
| 26 KB | 18.8 ms |
| 52 KB | 41.6 ms |
| 105 KB | 104.2 ms |

Test impact across 38 in-scope tests: **A 17** (fundamentally about source mode),
**B 7** (source used as a convenient edit route), **C 2** (fallback), **D 12**
(incidental selectors), plus 22 untouched.

### Stage 2 — single editor

1. In-place source editor for raw blocks and inline HTML (`rich.js`), modelled
   on `mathView`, committing through `replaceLogicalSelection`.
2. Replace the over-limit fallback: read-only plain-text view plus notice; drop
   `forceSource` from history entries and undo.
3. Remove the mode switch, Ctrl+E, `editorPresentation` mode labels,
   `setPresentation`, `switchPresentation`, and mode-specific CSS.
4. Delete `source.js` and its imports; strip cross-engine synchronisation,
   source↔rich scroll restore, and the dual-engine branches from `entry.js`.
5. Rewrite class-A tests for the single editor, migrate class-B/C tests, and
   drop `test:editor:unit` entries that test deleted modules.

Acceptance: every feature in the inventory table works with no mode switch;
`grep -r "@codemirror\|@lezer" ui/` returns nothing; the editor bundle shrinks
by the CodeMirror contribution.

### Stage 3 — performance

1. Incremental text edits: stop reparsing the whole document for ordinary text
   changes; keep the full parse as the fallback when a transaction is
   structural or the splice is ambiguous. Target: ≤8 ms per keystroke at 100 KB.
2. Remove full-document allocations: track document size from transactions,
   avoid repeated `TextEncoder` over the whole buffer.
3. Decorations: with `source.js` gone, confirm no whole-document decoration
   traversal remains on the keystroke path.
4. Batch image resolution only if profiling shows repeated per-image native
   calls are material.

### Stage 4 — UX and correctness

1. Document-width scroll anchoring: replace the placeholder
   `previewBlockAtViewportTop()` / `previewElementForBlock()` with
   `readerScrollAnchor()`.
2. Formula discoverability: a contextual "Edit formula" action when a formula
   is selected, keeping the double-click and Enter paths.
3. Accessibility pass: keyboard-only navigation, labels, heading hierarchy,
   focus indicators, dialogs, tables.
4. Native input validation under WebKitGTK: IME, paste, undo, focus.
5. Toolbar cleanup: remove the mode switch grouping, keep the remaining
   controls coherent.

### Stage 5 — verification

All JS suites, Rust tests, clippy, `check:editor-bundle`, benchmarks before and
after in the same environment, dead code and dependency removal, documentation.

## Benchmark harness

A separate benchmark script measures keystroke latency, parse, and serialization
at 3 KB / 10 KB / 50 KB / 100 KB / 500 KB / near-limit sizes. It is kept out of
the correctness suites so it can be run deliberately.

## Known risks

- **Raw-block editing (D1)** is the highest-risk item: the source splice must be
  byte-exact. The math editor pattern is proven, but raw blocks have different
  owners and can be multi-block.
- **Over-limit docs (D2)** lose in-app editing; if that proves unacceptable, the
  alternative is keeping a minimal plain-text editing surface, which reintroduces
  a second engine — decide before Stage 2.4.
- **Test rewrite** touches 17 class-A files; that is where a real regression
  could hide, so each rewritten test must keep asserting user-visible behaviour,
  not just the new DOM.


## Progress log

### Stage 2 — single editor (code complete)

- `ui/editor/source.js` deleted; `@codemirror/*` removed from `package.json` and
  `package-lock.json`. `@lezer/markdown` retained for the source ledger.
- `ui/editor/entry.js` rewritten single-engine: no `showMarkdown`, `forceSource`,
  `presentation()`, `setPresentation()`, `sourceCommand`, or cross-engine scroll
  restore. One history, one `EditorView`.
- Mode switch removed from `index.html`, `ui/editor.js` and `ui/app.js` (Ctrl+E
  and the command-palette entry included). Ctrl+B now bolds while focus is in
  the editor (decision D3).
- Over-limit documents open as complete read-only Markdown; Save writes exact
  bytes; the snapshot works without an editor (decision D2).
- Raw/extension blocks edit in place (`.extension-source-editor`); link and
  image destinations edit through `#editor-action-dialog`. No feature requires
  a second presentation any more.
- Editor bundle: **1,093,630 → 639,052 bytes (−454 KB, −41%)**.

Tests: source-mode-only files retired (10 files plus `editor-selection-regressions`);
the remaining 21 mixed/peripheral files were migrated to single-editor
assertions. Suite sizes now: 6 unit, 37 browser regressions, 14 UI suites.
`npm run test:editor`, `npm run test:ui`, `cargo test --locked` (88), clippy and
`check:editor-bundle` all pass.

Two regressions were found and fixed during migration, both worth remembering:

1. The mode switch had been the only thing that focused the editor after a
   document opened. Without it, a native drag that crosses into a rendered
   block collapsed on mouse-up. `refreshEditorSurface()` now focuses the
   editor, restoring the original behaviour.
2. Rich mount failure had no second engine to retry into; it now falls back to
   the same read-only Markdown surface as over-limit documents.

### Stage 3 — profiling and the first fix

The dominant per-keystroke cost was **not** the Markdown parse. At 100 KB:
tokenize 21.6 ms + ProseMirror parse 21.4 ms, while `parseSource` totalled
187.6 ms — `buildLedger` was ~131 ms (70%). A CPU profile of that ledger build
showed the hot spot was not the per-character maps but:

```text
268 ms  addGap        (rescanned every hint for every gap → O(n²))
234 ms  hintAt        (same scan, again per gap segment)
```

Gaps are emitted in non-decreasing source order, so one advancing cursor over
the sorted hints does the same work. After the fix (100 KB, block-dense):

| Document | before | after |
|---|---:|---:|
| 100 KB | 204.5 ms | **101.7 ms** |
| 500 KB | 2715 ms | 1988 ms |
| 1 MB | 12083 ms | 10958 ms |

Profiling the block-dense corpus then found two more quadratic scans, both now
fixed:

- `topLevel.indexOf(fallback)` inside the per-block Lezer pairing, and the
  blockquote child scan that sliced then searched the candidate array.
- `aggregate(owner)` filtered **every** owner for every container owner. Owners
  are only ever appended, so a container's descendants are the slice added
  after it; recording that index removes the scan.

After all fixes (same node harness, median):

| Document | baseline | after |
|---|---:|---:|
| 3 KB | 5.0 ms | 4.1 ms |
| 10 KB | 8.2 ms | 7.9 ms |
| 50 KB | 61.4 ms | 29.0 ms |
| 100 KB | 204.5 ms | **55.3 ms** |
| 500 KB | 2715.5 ms | **342.1 ms** |
| 1 MB | 12082.8 ms | **910.6 ms** |

Scaling is now roughly linear. `updateSource` (the structural fallback) and
serialization remain expensive at 1 MB (3.3 s / 4.9 s) and are the next
targets.

Still outstanding for Stage 3: the full reparse on every text edit (the actual
requirement), size tracking without re-encoding, and image-batch evaluation.

### Measured baseline for Stage 3

`scripts/bench-editor.cjs` (node, no DOM, median), block-dense document:

| Document | parseSource | updateSource | serialize |
|---|---:|---:|---:|
| 3 KB | 5.0 ms | 0.0 ms | 0.4 ms |
| 10 KB | 8.2 ms | 0.5 ms | 0.7 ms |
| 50 KB | 61.4 ms | 2.5 ms | 6.5 ms |
| 100 KB | 204.5 ms | 9.5 ms | 20.5 ms |
| 500 KB | 2715.5 ms | 856.4 ms | 972.0 ms |
| 1 MB | 12082.8 ms | 3466.1 ms | 6060.8 ms |

The full parse on every text edit is the target of Stage 3.


### Stage 4 — UX (in progress)

**4.1 Document-width anchoring — done.** `setDocumentWidth` used two
placeholders: `previewBlockAtViewportTop()` returned `0` and
`previewElementForBlock()` returned the first heading/paragraph. It now uses
`readerScrollAnchor()`, the same O(1) hit test the zoom path uses.

Guarded by `tests/editor-width-anchor.cjs`, with a measured red-green check:
restoring the placeholder makes it fail ("the same block stays at the top of the
viewport after widening"); with the fix it passes in both directions. The
fixture matters — the first version used short paragraphs that fit on one line
at both widths, so the page never reflowed and *both* implementations reported
zero drift. Long wrapping paragraphs are required for this test to mean
anything.

**4.2 Formula discoverability — done.** A formula previously required a
double-click or Enter. Each formula now exposes a labelled `Edit formula` button
(`.math-edit`, disabled under Lock, focusable) that opens the same in-place
editor; double-click and Enter still work. Verified: clicking the button opens
the textarea with the exact TeX and Cancel closes it.

Remaining in Stage 4: accessibility audit, native WebKit input validation,
toolbar review.


## Deliverables status (2026-11-01)

1. **Architectural summary** — above. One `EditorView`, one history, Markdown
   canonical, atom-level in-place editors for raw blocks and link/image
   destinations, read-only Markdown for over-limit documents.
2. **Removed** — `ui/editor/source.js`; `@codemirror/commands`,
   `@codemirror/lang-markdown`, `@codemirror/language`, `@codemirror/state`,
   `@codemirror/view` from `package.json`/`package-lock.json`; the mode switch,
   Ctrl+E, the command-palette entry, `presentation()`/`setPresentation()`,
   `sourceCommand`, controller-mode CSS and the dead `#source-editor` markup.
   `@lezer/markdown` retained (the ledger parses with it).
3. **Retained features** — headings, paragraphs, inline marks, links, lists,
   nested lists, blockquotes, code blocks with highlighting, tables, images
   (with consent and resize-free policy), math (double-click, Enter, and now an
   explicit button), Mermaid, selection/copy/cut/paste, undo/redo, keyboard
   navigation, open/save/autosave, Markdown round-trip, large-document
   handling (read-only over the limits).
4. **Performance work** — three quadratic scans removed from `buildLedger`
   (`addGap`/`hintAt`, the Lezer pairing `indexOf`, `aggregate`'s full-owner
   filter), plus eager per-character map allocation removed for linear leaves.
5. **Benchmarks** — node harness, median, block-dense corpus: 100 KB
   204.5 → 55.3 ms, 500 KB 2715 → 342 ms, 1 MB 12083 → 911 ms (see tables).
6. **Tests** — 6 unit, 37 browser editor regressions, 14 UI suites: all pass.
   `cargo test` 88 pass, clippy clean, `check:editor-bundle` passes.
7. **Known limitations** — below.
8. **Files changed** — `git status` on the branch.

## Known limitations / not done

- **Incremental parsing is not implemented.** Every ordinary text edit still
  full-parses the document (`parseSource`): ~55 ms at 100 KB against the 8 ms
  target. The quadratic waste is gone, but the algorithmic shape is unchanged.
  A safe design needs an incremental ledger remap (owners, runs, segments moved
  by the step mapping) with a strict fallback to the full parse; a mis-mapped
  edit would corrupt the canonical buffer, so it should not be improvised.
- `updateSource` (structural fallback) and serialization remain expensive at
  1 MB (≈3.3 s / 4.9 s).
- Batched image resolution was **not** implemented; it was gated on profiling
  and the profiling work was spent on the ledger.
- Native WebKit input: the embedded native probe and the XTest keyboard
  walkthrough both pass after migration (see below), but IME/composition and
  platform clipboard edge cases are still unverified.
- Accessibility was reviewed only for the surfaces this migration touched
  (labels on in-place editors, dialog focus, the read-only region); the full
  interface audit the brief asks for has not been done.
- The toolbar was not redesigned beyond removing the mode switch.


### Native verification (Stage 4.4 / 5)

Two native checks were migrated and now pass against the single editor:

- **Embedded WebKit probe** (`FOLIO_NATIVE_PROBE=1 xvfb-run … ./target/debug/folio`):
  opens a document, edits with `execCommand`, saves, locks/unlocks, takes a
  snapshot, and exercises the Mermaid transport, ACL denials and renderer
  recycling. Result: `FOLIO_NATIVE_PROBE_PASS` (`editorPass: true`,
  `savedExact: true`). Its selection section previously asserted the
  Markdown ⇄ formatted round trip; it now asserts caret/range round-trips
  inside the one editor.
- **XTest keyboard walkthrough** (`npm run test:native-editor`): real OS key
  events through WebKit, exact bytes on disk. Result: PASS after removing the
  Ctrl+E source-pane steps. Its second case typed raw Markdown into the source
  pane; that scenario no longer exists, so it was removed rather than faked.


### Residual large-document cost (not ordinary typing)

At 1 MB, `updateSource` takes ≈2.5 s and full serialization ≈5.1 s. Profiling
puts both inside `prosemirror-markdown`'s serializer: `atBlank()` indexes
`this.out[this.out.length - 1]` on a string built with repeated `+=`, which
forces V8 to flatten the rope on every text node — quadratic in document size.
It is library-internal, it only affects the structural-edit fallback and
save-time serialization (not ordinary keystrokes), and fixing it means either
patching the dependency or replacing the serializer. Both are out of scope for
this migration; recorded so the next change starts from evidence.


### Image resolution batching — evaluated, not implemented

Measured: a 20-image document issues **20** `render_markdown` calls (one per
image) and mounts 20 widgets. Each call renders a single-image Markdown stub
through the native pipeline; the encoded result is now cached process-wide by
the Phase-2 image cache, so the marginal cost is one IPC round trip plus a tiny
parse. Batching would replace 20 round trips with one but would not remove the
per-image file read/encode, which dominates for real images.

The brief says to avoid complexity without measurable benefit, so batching is
**not** implemented. Revisit only if a real-profile trace shows image-heavy
document open time dominated by call count rather than image bytes.

### Toolbar review — done

After removing the mode switch, the header is: open menu · file tree · title ·
lock · view menu (formatting toggle, width, theme, source snapshot) · save state
· save · outline · search, with the formatting toolbar below. Every
`data-editor-command` button resolves in the ProseMirror command surface
(`bold`, `italic`, `code`, `heading`, `bullet`, `numbered`, `quote`, `link`,
`image`, `math`, `table`); no control is dead. No redesign was warranted beyond
removing the switch itself, which is what the brief asked (preserve the visual
identity, do not redesign wholesale).


### Per-keystroke chrome churn (Stage 3.2 — fewer allocations/rerenders)

`updateTitle()` runs from the editor's `onChange` on every keystroke and wrote
~12 DOM properties (name, location, dirty dot, save button class/label/title,
save-state text/state/title/aria-label) even when nothing had changed. During a
typing burst the name and save-state are constant, so those writes were pure
churn, each one invalidating style.

It now computes a signature of everything the render depends on (name, path,
active, dirty, save-state text/state, save error) and returns before touching
the DOM when the signature is unchanged.

Measured A/B with a MutationObserver on the header chrome, 10 typed characters:

| | DOM mutation records |
|---|---:|
| before guard | **92** |
| after guard | **11** |

The remaining 11 are the single genuine update (dirty flips false→true and the
save state becomes "Edited"). Verified: `ui-smoke`, `save-state-stability`,
`unified-editor`, `live-editor` all pass.


### Accessibility audit of the touched surfaces (Stage 4.3 — partial)

Checked with real keyboard/DOM probes rather than a visual review:

| Surface | Finding |
|---|---|
| Destination dialog (`#editor-action-dialog`) | opens with focus in the input; Apply and Cancel both return focus to the editor |
| Formula editor | reachable via its labelled button; Cancel returns focus to the formula; Escape closes |
| Block source editor (`.extension-edit`) | focusable by Tab and reaches `opacity:1` when focused (the 0.15 s transition had to be allowed for in the probe, initially a false alarm) |
| Images | rendered `alt` text preserved (`alt text`) |
| Over-limit surface | labelled `region`, focusable, notice has `role="status"` |
| Formatting toolbar | every `data-editor-command` resolves; no dead controls |

Locked in by a new regression test, `tests/editor-a11y-focus.cjs`, added to
`test:editor:browser`.

Colour contrast was measured per theme (link colour is `--read-accent`, derived
from the palette by `applyTheme`):

| Theme | Link colour | Background | Ratio |
|---|---|---|---:|
| system / light | #2e72c6 | #fafafa | 4.64 (AA pass) |
| graphite | #8cbaf0 | #242424 | 7.69 |
| nord | #9ac9d7 | #2e3440 | 6.96 |
| catppuccin | #d3b3f8 | #1e1e2e | 9.04 |
| rose-pine | #cdb4eb | #191724 | 9.52 |

Two false alarms in this audit are worth recording because both were my
measurement errors, not product bugs: (1) the first contrast probe reported the
raw `--accent` (3.61:1) as the link colour, but links use `--read-accent`; (2)
switching themes by writing `data-theme` does not recompute the derived
inline palette — `applyTheme()` must be called. With those corrected, the
reading palette meets AA for text and the UI accent meets the 3:1 component
threshold.

Not covered: IME/composition input and a formal focus-indicator audit.


### Dead code removed (Stage 5 cleanup)

Confirmed unused after the single-engine migration and removed:

- `ui/editor.js`: `resetHistory`, `commitInlineEdit`, `syncPreviewEditing`,
  `syncSourceFallback` (all no-ops left over from the two-engine shell).
- `ui/app.js`: the calls to those no-ops and the never-read
  `previewLimitedKind` resets.
- `ui/preview.js`: `previewLimitedKind` (only ever assigned `null`, never read).
- `ui/editor/entry.js`: the compatibility stubs `setPresentation`, `setFallback`
  and `isFallback`, which nothing called once the fallback path was removed.
  `isSource()` is deliberately kept: it returns `false` and several tests assert
  that no source presentation exists.

Verified after removal: `npm run test:editor` exit 0 (68 passing test lines),
`npm run test:ui` exit 0 (13 suites), and the native WebKit probe still reports
`FOLIO_NATIVE_PROBE_PASS`.


### End-to-end keystroke latency (browser)

`scripts/bench-keystrokes.cjs` (`npm run bench:keystrokes`) opens a document in a
real browser, types into it and waits for the canonical Markdown to reflect each
keypress — the number a user actually feels.

| Document | median ms/key | max ms/key |
|---|---:|---:|
| 10 KB | 8.8 | 18.1 |
| 50 KB | 26.6 | 53.0 |
| 100 KB | 55.7 | 82.6 |

(An earlier version of this benchmark used `page.waitForFunction`, whose rAF
polling added a frame or more per sample and reported 17.1 / 35.3 / 66.0 ms.
The corrected figures instrument the page itself: keydown timestamp plus a
setter on `current.content`, so the sample starts at the key event and ends when
the canonical Markdown is written.)

The corrected numbers line up with the node-level parse almost exactly (7.9 /
29 / 55 ms), which is the clearest possible evidence that the keystroke cost is
the parse. A 10 KB note fits in a frame; 50 KB and 100 KB do not. The 8 ms
target at 100 KB therefore requires incremental parsing, not further
micro-optimisation.


### Stale bundle caught by patch round-trip (fixed)

Exporting the whole migration as a patch and applying it to a clean `main`
worktree caught a defect nothing else had: the vendored
`ui/vendor/editor/editor.js` was **stale**. It had last been rebuilt when the
formula button was added; the later dead-code removal in `entry.js` changed
bundled sources without a rebuild. No test noticed, because tests load the
bundle — only `check:editor-bundle` compares it to a fresh build, and that gate
had not been run after the cleanup.

Fixed by rebuilding; the bundle is now 639,404 bytes and
`npm run check:editor-bundle` passes.

Verification-artifact note: `check:editor-bundle` cannot be validated in a
worktree whose `node_modules` is a symlink — esbuild then reports absolute input
paths, the license scan finds no `node_modules/` entries and writes an empty
`NOTICE.txt`. That is a property of the verification setup, not of the project;
in a real checkout with installed dependencies the check passes.


### Restored 2 MiB rich-editor ceiling (regression fixed)

The `entry.js` rewrite dropped `MAX_RICH_LENGTH`. The two-engine build refused
to project documents over 2 MiB into ProseMirror and kept them in the source
pane; with that gone, a 2 MB+ document (well under the 20 MiB file limit) was
parsed by ProseMirror in the browser with nothing stopping it.

The single-editor shell now treats a document over 2 MiB like an over-limit
document: complete Markdown, read-only, exact Save. Red-green verified — with
the ceiling disabled, `preview-limits.cjs` times out because the editor never
finishes mounting; with it, the read-only surface appears and the full source is
shown.

### Flaky test hardened

`editor-stored-mark-roundtrip.cjs` intermittently timed out at its first wait.
It asserted `!editor.isSource()` without waiting for the editor to exist, and
its `Ctrl+B` only bolds while focus is inside the document (otherwise it toggles
the file tree). It now waits for the editor, waits for `.ProseMirror`, and
clicks into the document first. Three consecutive isolated runs and a full-suite
run pass.


### Oversized-document open path

The 2 MiB size check now runs *before* the native probe, so a document that can
never be formatted does not pay a native render probe first. The read-only
surface was also exercised against the shell shortcuts it now lives without:
Ctrl+F (find opens, typing and Enter are harmless), Ctrl+= / Ctrl+Shift+= /
Ctrl+0 (zoom), Ctrl+A / Ctrl+C on the text, Escape — no page errors.


### Bundle staleness is now a test failure

The round-21 stale bundle passed every browser test because the tests load
`ui/vendor/editor/editor.js`; only `check:editor-bundle` compares it to a fresh
build, and that gate was not in the suite people run. `test:editor` is now:

```
npm run check:editor-bundle && npm run test:editor:unit && npm run test:editor:browser
```

Verified to have teeth: changing a bundled string literal reports "Editor
bundle is stale"; restoring and rebuilding passes. (Two earlier probes — adding
a comment, then `void 'x'` — did *not* trip it, because esbuild strips comments
and eliminates no-op expressions. A probe must change something observable.)

Full chain after the change: exit 0, 70 passing lines.


### Focus-indicator audit (Stage 4.3)

Programmatic audit of every rendered interactive element in a document view:
focus each, read `outline`/`box-shadow` on the focused element.

- **27 focusable elements, 0 without a visible focus ring.**
- 6 elements are not focusable at all: links inside the contenteditable
  document. That is correct — a contenteditable region deliberately keeps its
  links out of the tab order.
- One real gap found and fixed: `.markdown a` had no `:focus-visible` style at
  all, so a link could take focus (via find or programmatic selection) with no
  indicator. It now has the same 2 px accent ring as every other control.

IME composition remains the one unvalidated input path. `fcitx5` 5.1.23 with
mozc and chewing is installed on this machine, so it can be tested, but it needs
its own harness: a D-Bus session, fcitx5 started, the app launched with
`GTK_IM_MODULE=fcitx`, and XTest key events driven through the IME with
candidate selection, then save-and-diff like `native-editor-keyboard.py`.


#### IME harness: environment findings (not yet built)

Investigated the ingredients rather than guessing:

- `fcitx5` **5.1.23** is installed with `mozc` (Japanese) and `chewing`
  (Zhuyin) engines under `/usr/lib/fcitx5/`, plus `fcitx5-remote`.
- `python-xlib` is **not** installed. The existing
  `tests/native-editor-keyboard.py` drives XTest through `ctypes` +
  `libXtst`, so an IME test must reuse that harness rather than importing Xlib.
- `fcitx5 -d` starts, but `fcitx5-remote` reported "No session bus: Connection
  reset by peer" when started in the same `dbus-run-session` shell — the IM must
  be started *after* the session bus is up and with an isolated
  `XDG_CONFIG_HOME` (otherwise it would edit the user's real fcitx profile).
- A usable test therefore needs: `dbus-run-session` → `Xvfb` → `fcitx5 -d`
  (isolated config, mozc selected) → app launched with `GTK_IM_MODULE=fcitx`
  and `XMODIFIERS=@im=fcitx` → XTest romaji input + candidate selection →
  Ctrl+S → byte-compare, mirroring `native-editor-keyboard.py`.

Recommendation: build it as a separate `tests/native-editor-ime.sh` that is
**not** part of `npm run test:editor`, because it depends on a machine with
fcitx5 and an engine installed; the ordinary native keyboard test stays the
default gate.

Meanwhile the editor's composition **contract** is covered by
`tests/editor-composition.cjs`: with a composition session active, Enter and
Mod-B must not edit the document (the input method owns those keys). The test
has a control case — the same synthetic Enter outside a composition does split
the paragraph — so it cannot pass vacuously, and removing `compositionstart`
from it fails as expected. That is a guard test, not an IME-engine test.


### Two test flakes traced to races (fixed)

Both intermittent failures were in the tests, not the editor — worth recording
because each looked like a product bug at first:

1. **`editor-stored-mark-roundtrip`** failed ~10–20% of runs. Capturing the
   document showed the typed character landing at the end of "Hello" instead of
   between "l" and "o": `ArrowLeft` after `selectRange` raced the following
   action, so the caret never moved. It now selects the exact position through
   the API and drives the bold command directly. 12/12 runs pass.
2. **`editor-composition`** (new) is a guard test: while a composition session is
   active, Enter and Mod-B must not edit the document. It has a control case
   (the same synthetic Enter outside a composition *does* split the paragraph),
   and dropping `compositionstart` from it fails as expected. This is not an
   IME-engine test; the fcitx5 harness remains to be built.


### IME composition — verified (Stage 4.4 complete)

`tests/native-editor-ime.sh` (`npm run test:native-ime`) builds the harness the
earlier notes spec'd:

- private D-Bus session + private Xvfb (via `dbus-run-session -- xvfb-run`)
- fcitx5 started with an **isolated `XDG_CONFIG_HOME`** whose profile selects
  mozc, so the user's real fcitx profile is never touched
- the app launched with `GTK_IM_MODULE=fcitx` and `XMODIFIERS=@im=fcitx`
- XTest romaji input (`nihon`), space to convert, Return to commit
- Ctrl+S, then a byte comparison of the file on disk

Result: **PASS — "fcitx5/mozc composition reached the editor and saved as
UTF-8"** (日本 in the saved file).

Negative control: with fcitx5 not running, the same test fails and reports the
literal `nihon` in the file — so the assertion measures composition, not typing.
(Disabling only `GTK_IM_MODULE` still passes, because fcitx5's XIM frontend is
also active via `XMODIFIERS`; that is why the control removes the IM entirely.)

It is registered as `test:native-ime` and deliberately **not** part of
`test:editor`, because it needs fcitx5 with an engine installed.
