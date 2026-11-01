# Folio: single-editor migration report

> **Review correction:** The incremental editing fast path described in the
> historical results below is disabled. Review found that it could change
> Markdown semantics and leave character maps stale. Edits now use the
> full-parse validation path; the reported fast-path keystroke timings are no
> longer representative. Inline link and image destination editing fails
> closed for syntax it cannot identify safely, including reference-style links
> and images. The previously exported patch predates these corrections.

Branch `feat/single-formatted-editor`, from `main` @ `3192542`. Nothing is
committed; every change below is in the working tree. The design rationale and
in-progress notes live in
`docs/superpowers/plans/2026-11-01-single-formatted-editor.md`.

## 1. Architectural change

Folio previously ran two editing engines over one Markdown buffer: ProseMirror
for the Formatted view and CodeMirror for a Markdown view, with a mode switch,
bidirectional selection/scroll restoration, and a `fallback` flag carried in
undo history so an over-limit document could re-enter source mode.

It now runs one `EditorView`:

- Markdown remains the canonical stored format; `content` is still the exact
  source buffer.
- `ui/editor/entry.js` owns one editor, one history, one selection model. The
  presentation machinery (`showMarkdown`, `forceSource`, `presentation()`,
  `setPresentation()`, `sourceCommand`, cross-engine viewport anchoring) is
  gone.
- Atomic source editing moved **into** the document instead of into a second
  presentation: raw/extension blocks edit in a panel inside the block, links
  and image destinations edit through the existing action dialog, formulas use
  their in-place panel (now with an explicit button).
- Over-limit documents no longer fall back to a source editor (ProseMirror is
  exactly what the limits refuse); they open as complete, read-only Markdown
  with Save still writing exact bytes.

## 2. Removed CodeMirror surface

| Removed | Detail |
|---|---|
| `ui/editor/source.js` | the whole engine (315 lines) |
| Dependencies | `@codemirror/commands`, `@codemirror/lang-markdown`, `@codemirror/language`, `@codemirror/state`, `@codemirror/view` — from `package.json` and `package-lock.json` |
| Shell | mode switch (`#view-switch`, `#show-markdown`, `#view-formatted`), Ctrl+E, command-palette entry, `setMode`/`requestMode`, `editorPresentation` mode labels, `switchPresentation`, `revealSourceForEdit`, `#source-editor` pane |
| CSS | all `#source-editor`/`.cm-*` rules, source decoration classes, `#view-switch` rules and its media queries, the source selection highlight |
| Dead shell helpers | `resetHistory`, `commitInlineEdit`, `syncPreviewEditing`, `syncSourceFallback`, `previewLimitedKind`, entry stubs `setPresentation`/`setFallback`/`isFallback` |

`@lezer/markdown` is **retained**: `source-ledger.js` parses with it and that
ledger is not CodeMirror.

Editor bundle: **1,093,630 → 639,458 bytes (−454 KB, −41%)**.

## 3. Retained and migrated features

Headings, paragraphs, bold/italic/strike, links, ordered/unordered/nested
lists, blockquotes, code blocks with syntax highlighting, tables, images with
per-image consent and sanitization, formulas (double-click, Enter, explicit
button), Mermaid, selection/copy/cut/paste, undo/redo, keyboard navigation,
open/save/autosave, exact Markdown round-trip, and large-document handling
(read-only above the limits).

Source Snapshot still shows the exact live buffer — and now works even when no
editor is mounted.

## 4. Performance work

- **Incremental text editing** (`source-edits.js`): a single plain-text step
  inside one linear, unmarked run splices the Markdown and shifts the ledger
  instead of re-parsing the document. Marked, boundary and empty-run edits fall
  back to the full parse, so exactness is unchanged.

- **Ledger quadratics removed** (the dominant per-keystroke cost): `addGap`/
  `hintAt` rescanned every hint per gap; the Lezer pairing called
  `topLevel.indexOf` per block; `aggregate()` filtered every owner per
  container. All three replaced with linear scans or tracked indices.
- **Eager per-character maps removed** for text runs whose mapping is linear by
  construction, and for inline code whose normalised text equals the source.
- **Per-keystroke chrome writes removed**: `updateTitle()` now returns early
  when name, path, dirty and save-state are unchanged.
- Image resolution batching was evaluated and **rejected**: a 20-image document
  issues 20 calls, but each renders a single-image stub and encoded results are
  cached process-wide, so batching would not remove the dominant per-image cost.
- Serialization at 1 MB is quadratic inside `prosemirror-markdown`
  (`atBlank()` flattening a rope on every text node). Documented, not patched.

## 5. Benchmarks (same environment throughout)

`parseSource`, node harness, median, block-dense corpus:

| Document | Baseline | After |
|---|---:|---:|
| 3 KB | 5.0 ms | 4.1 ms |
| 10 KB | 8.2 ms | 7.9 ms |
| 50 KB | 61.4 ms | 29.0 ms |
| 100 KB | 204.5 ms | **55.3 ms** |
| 500 KB | 2,715 ms | **342 ms** |
| 1 MB | 12,083 ms | **911 ms** |

End-to-end keystroke latency, measured in the browser from keydown to the
canonical Markdown update:

| Document | before | after |
|---|---:|---:|
| 10 KB | 8.8 ms | **1.9 ms** |
| 50 KB | 26.6 ms | **5.5 ms** |
| 100 KB | 55.7 ms | **9.6 ms** |

These track the parse cost almost exactly, which is the evidence that the
keystroke cost *is* the full parse.

## 6. Test results

| Suite | Result |
|---|---|
| `cargo test --locked` | 88 passed, 0 failed |
| `cargo clippy --all-targets -D warnings` | clean |
| `npm run check:editor-bundle` | passes |
| `npm run test:editor` | bundle gate + 7 unit + 38 browser files, exit 0 |
| `npm run test:ui` | 14 suites, exit 0 |
| Native WebKit probe | `FOLIO_NATIVE_PROBE_PASS` |
| Native XTest keyboard | PASS (real OS input, exact bytes on disk) |
| Native IME composition (`npm run test:native-ime`) | PASS — fcitx5/mozc composition typed, converted, committed and saved as UTF-8 |

Test suite changes: 11 files retired because their subject was the removed
mode (`editor-source-smoothness`, `editor-source-heading-click`,
`source-custom-highlight`, `source-table-preview`, `source-table-blockquote`,
`source-table-wrapped-click`, `editor-markdown-scrolling`, `editor-mode-viewport`,
`ui-view-switch`, `editor-fallback-command`, `editor-selection-regressions`);
29 modified (26 browser tests plus the native probe and keyboard walkthrough) to single-editor assertions; one added (`editor-a11y-focus`).
No failures remain.

## 7. Known limitations

- **Incremental parsing is implemented but conservative.** Plain text in an
  unmarked context skips the parse (100 KB: 55.7 → 9.6 ms/key); edits involving
  marks, run boundaries or empty paragraphs still re-parse (≈55 ms at 100 KB).
  So typing near formatting can still feel slower than typing in prose.
- Serializer quadratic at large sizes (third-party), affecting structural edits
  and save-time serialization.
- IME composition is verified end to end with fcitx5/mozc (`native-editor-ime.sh`,
  outside the default gate because it needs an engine installed). Platform
  clipboard edge cases remain unverified.
- Accessibility covered the surfaces this migration touched (labels, focus
  return, keyboard reachability, contrast per theme). A formal focus-indicator
  audit across the whole interface has not been done.

## 8. Files changed

- Runtime: `ui/editor/entry.js` (rewritten), `ui/editor/rich.js`,
  `ui/editor/source-ledger.js`, `ui/editor.js`, `ui/app.js`, `ui/preview.js`,
  `ui/index.html`, `ui/styles.css`, `ui/vendor/editor/{editor.js,NOTICE.txt}`;
  `ui/editor/source.js` deleted.
- Build/config: `package.json`, `package-lock.json`.
- Tests: 29 modified (including the native probe and keyboard walkthrough),
  11 deleted, 1 added.
- Tooling/docs: `scripts/bench-editor.cjs`, `scripts/bench-keystrokes.cjs`,
  this report and the plan.


## Portable artifact

`~/Downloads/folio-single-editor-migration.patch` contains the whole migration
(61 changed paths) as one patch against `main` @ `3192542`. Verified by round
trip: it applies cleanly to a fresh `main` worktree and representative tests
pass there (`preview-limits` including the oversized-document guard,
`editor-width-anchor`, `editor-a11y-focus`).

Known verification caveat: `check:editor-bundle` cannot be validated inside a
worktree whose `node_modules` is a symlink — esbuild reports absolute input
paths, the licence scan finds no packages and writes an empty `NOTICE.txt`. In
a checkout with installed dependencies it passes.
