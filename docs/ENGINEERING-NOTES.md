# Engineering notes

Durable notes for future work on Folio. Unlike the historical plans under
`docs/superpowers/`, this file describes the architecture and constraints that
should outlive any one feature pass. Current performance numbers live in
[performance-results.md](performance-results.md); still-open work lives in
[ROADMAP.md](ROADMAP.md).

## Editor model

- Markdown is the canonical buffer. Rich editing and source editing are
  projections of that one buffer; opening, toggling and snapshots must not
  rewrite unchanged bytes.
- There is one ProseMirror `EditorView`. The editor bundle in
  `ui/vendor/editor/` is generated from `ui/editor/` by
  `npm run build:editor`; `npm run check:editor-bundle` must match the pinned
  sources and dependencies.
- Ordinary text edits patch the exact source range and shift the source ledger.
  Structural or ambiguous edits fall back to a validated parse. The
  source-first path must fail closed rather than guess when the mapping is not
  exact.
- The Source snapshot is the exact live buffer, including unsaved changes, and
  works even when no rich editor is mounted.
- Rich editing is capped at 2 MiB (`MAX_RICH_LENGTH` in `ui/editor.js`). Larger
  documents keep their complete Markdown available read-only; the source buffer
  itself is capped at 20 MiB.
- Lock, undo/redo, selection and copy all operate on the canonical document,
  not on a second editor copy.
- Paste prefers the clipboard's `text/plain` payload, even when `text/html` is
  also offered. HTML round-tripping through the rich schema loses fenced-code
  info strings and rewrites list/TeX bytes; HTML remains a fallback only when no
  text is available.
- A native drag that crosses a rendered atom stays out of editor state while the
  pointer is down. Before a keyboard edit, map that guarded range back through
  the source-aware clipboard endpoints; otherwise Delete/Backspace act on a
  stale caret. Focusable rendered atoms (formulas) must let document-wide
  `Ctrl/Cmd+A` and a standing selection's Delete/Backspace reach the editor.
- The custom selection mirror registers one range per source line, not per text
  node. WebKitGTK fills a range's bounding box, so a fenced code block (one text
  node containing many newlines) otherwise paints as a solid rectangle. Code
  selection also hides the syntax overlay and takes the selection ink so glyphs
  stay readable on the wash.
- Blank mirror fragments (line breaks alone, whitespace, stray zero-width
  characters) are never registered. A selection with no paintable text still
  keeps `folio-paint`, because removing it would fall back to the engine's
  full-width block paint for that same line break.
- Pointer-up and blur reconcile the mirror even when the selection guard was
  already off. WebKitGTK does not reliably emit `selectionchange` when a range
  is cleared by clicking chrome, and a stale mirror would otherwise keep the old
  wash on screen.
- The ProseMirror surface fills the reader and carries the gutters as horizontal
  padding; the text column is centered inside it. This keeps the configured
  reading width while letting a pointer drag start in the empty side margin and
  still select from the nearest text position. `document-over-limit` re-adds
  its own gutters because it is not inside ProseMirror.

## Native WebKit and Linux pitfalls

- An off-screen theme probe can return `rgba(0, 0, 0, 0)` or see root custom
  properties missing before WebKitGTK's first layout. Do not treat transparent
  as black, do not build contrast values from invalid inputs, and keep ordinary
  CSS foreground fallbacks until valid colours arrive. Palette generation may
  retry on animation frames with a bounded retry count.
- Diagram colours must be refreshed when a valid palette resolves; duplicate
  refreshes are wasted work.
- Body text uses the full theme foreground, adjusted only when needed for 7:1
  contrast. Reading accent colours keep their original saturation unless
  contrast requires adjustment; do not add font-weight, text-shadow or glow to
  compensate for a palette bug.
- WebKitGTK needs the prefixed `-webkit-user-select: none` alongside
  `user-select`. Without it, GTK's inactive selection can paint black rectangles
  behind the document title/path. The WebKit snapshot API can hide that paint;
  native surface captures are the reliable check.
- `npm run test:native-palette` exercises the real frontend in native WebKit at
  100% and 120% zoom. `tests/palette-startup.cjs` guards the transparent-probe
  and missing-token failure paths.
- The native tests use Xvfb/X11. They do not establish real Wayland/GPU
  compositing, shader-cache or first-paint behaviour.

## Command palette

- The palette is a floating surface in the same family as the slash block
  picker: one accent wash for the active row, a quiet accent underline on the
  focused search field, themed thin scrollbars, and row heights that only
  ever show whole commands.
- Search filters built rows instead of rebuilding labels, icons and swatches
  on every keystroke (`tests/command-palette.cjs` holds the node-reuse
  contract). Rebuilding the list was measurable under WebKit.
- Theme entries are in-place `scope` links. Opening Appearance must not close
  and reopen the modal; that re-entered the top layer and flashed.
- Expensive commands (theme changes) run one task after the dismissal paints
  (`requestAnimationFrame` then `setTimeout`, with a timed fallback for
  throttled frames). Applying a theme synchronously after `dialog.close()`
  held the closing palette on screen through the whole document restyle.
- `applyTheme` clears only the inline tokens it owns. Removing the whole
  `style` attribute also dropped `--text-size` and the reader's spacing
  preferences, forcing a full reflow with the wrong metrics. Derived
  `--read-*`/`--diagram-*` tokens are cleared so an unresolved palette cannot
  keep the previous theme's ink.
- Diagram refreshes after a theme change are coalesced (160 ms). Rapid theme
  switches pay for one Mermaid re-render, not one per switch.

## Performance guardrails

### Tauri ACLs

Every custom Tauri command must be registered in three places:

1. `generate_handler!` in `src/main.rs`
2. the command manifest in `build.rs`
3. an `allow-*` permission in `capabilities/main.json`

A missing entry denies the command at runtime. In the past this made every
document open in fallback (`preview_check`), delayed the window (`ready`) and
silently removed code highlighting (`highlight_code`). Browser tests cannot
catch this because they stub the IPC layer. **A guard test comparing the three
lists is still missing and is the cheapest high-value test to add.**

### Caches and budgets

- An image-cache entry may only be served when the file length is within the
  current call's per-file budget. Otherwise return the placeholder and do not
  cache it; a cache filled under a larger budget must not answer a stricter
  call.
- Parse/limit budgets are not latency budgets. `preview_check` covers source
  bytes, line count, nesting depth and AST node count, but not final HTML or
  image bytes. Keep limit checks and performance measurements separate.
- Do not add unbounded per-document or per-render caches. Existing caches are
  bounded deliberately (syntect, encoded images, code highlighting).

### Already optimized — measure before redoing

Startup shows on `ready`, preferences paint before first paint, the editor
bundle is prefetched at idle, and bootstrap runs asynchronously. Render work is
bounded and runs off the UI thread where possible. Ledger owner lookups use
maps, outline work pauses while hidden and is debounced, word count avoids
allocation, node views skip unchanged re-renders, scroll anchoring uses O(1)
hit tests, sidebar dragging uses one rAF per frame, the theme poll is slow, and
the file tree rebuilds only when the listing changes. Re-benchmark before
undoing any of this.

### Open profiling questions

- Real Wayland/GPU first-paint timings and WebKitGTK spawn/shader-cache shares
  still need on-machine measurement (`strace`, `perf stat`, `LD_DEBUG`,
  `performance.getEntriesByType('paint')`).
- Native cancellation of superseded renders needs a stale-result contract; the
  current frontend already discards superseded results.
- Visible-range source decorations require moving the `StateField` to a
  `ViewPlugin`; this is a refactor, not a quick fix.
- Bundle trimming must not remove HTML/CSS/JavaScript highlighting that
  `lang-markdown` imports.

## Known limitations

- `prosemirror-markdown` serialization is quadratic at large sizes; structural
  edits and save-time serialization can be expensive on very large documents.
- Platform-specific clipboard, autocorrect/replacement, drag/drop and native IME
  paths are not all covered by the default browser suite.
- A formal focus-indicator audit across the whole interface is still missing;
  accessibility coverage has focused on surfaces touched by recent work.
- Real Wayland/GPU rendering and native IME behaviour cannot be proven by the
  mocked Chromium suite alone.
