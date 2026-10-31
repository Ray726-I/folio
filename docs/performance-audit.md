# Folio performance audit

Branch: `perf/faster-startup-smoother-editing` (from `main` @ `6fe4fd7`)
Status: Phases 0–5 implemented as **uncommitted working-tree changes** on
`perf/faster-startup-smoother-editing`. The branch tip is still `main` @ `6fe4fd7`
— nothing has been committed, at the user's request. The audit itself is complete.

Scope: perceived **open time** and **interaction smoothness** (typing, scrolling,
mode switching). Correctness and security are out of scope; the existing test
suites own those.

Method: static reading of the Rust and UI sources with call-site tracing, plus
measurement where it was cheap and safe — stage-level timing of the render
pipeline from a `/tmp` harness on a release build, node-level timing of the real
editor modules without a DOM, and a frame-anchored capture of the existing
release binary under Xvfb. Every finding cites the code it comes from. None of
these numbers come from the user's Wayland/GPU session; each section ends with
the profiling run that would confirm or refute it locally.

## Phase 0 — baseline (2026-11-01)

Recorded on `main` @ `6fe4fd7`, before any fix:

- `cargo test --locked` — 82 passed, 0 failed.
- `cargo clippy --locked --all-targets -- -D warnings` — clean.
- `npm run check:editor-bundle` — bundle matches pinned sources.
- `tests/editor-model.cjs`, `tests/editor-parse-budget.cjs` — pass.
- `tests/lazy-assets.cjs` — pass (KaTeX/Mermaid stay lazy).

Measured baselines carried into this work:

| Interaction | Baseline |
|---|---|
| Cold start to window mapped | 179–190 ms (Xvfb) |
| Blank white surface | 229 → 329 ms |
| Saved theme settled | ~396 ms |
| Open, 1 MB prose | 55–68 ms native render (HTML discarded) |
| Open, 276 KB code | 730–797 ms |
| Open, 20 images | 122–142 ms, no reuse between renders |
| Keystroke, 26 KB | 19.3 ms |
| Keystroke, 105 KB | 253 ms |

Budgets this work aimed at: **open a 100 KB document in under 100 ms** and
**under 8 ms per keystroke at 100 KB**. The typing budget is still not asserted,
because the dominant typing cost (E1) is unimplemented — asserting it now would
only pin a known failure into the suite.

## Results (implemented, uncommitted)

| Phase | Area | What changed |
|---|---|---|
| 1 | Startup | Window starts hidden and shows on `ready` (2 s native fallback). `prefs.js` paints the saved theme and reading font before first paint. Listeners start in parallel. Editor bundle prefetched at idle behind an "Opening…" skeleton. |
| 1 | Open | `preview_check` (preflight + parse + node budget) replaces the discarded full render; `blocks` are no longer built or serialized for the UI. |
| 2 | Render | Bounded syntect cache (256 entries / 8 MiB, 64 KiB per-fence cap); process-wide encoded-image cache (128 / 64 MiB, keyed path + mtime + length); render pipeline on `spawn_blocking`; `highlight_code` highlights one fence instead of rendering a document. |
| 3 | Typing | Ledger block association O(blocks × tokenBlocks) → bucketed `Map`; owner lookups by `Map`. Outline skips work while hidden, uses a lazy line index, and debounces at 500 ms. `set_title` coalesced to state changes. Allocation-free word count. Math, code and raw node views skip re-render when markup and text are unchanged. |
| 4 | Scroll/chrome | Outline active state paints only the two changed entries and pauses while hidden. `scroll-behavior:smooth` removed from the scroller. Scroll anchor uses O(1) hit tests instead of scanning every block. Sidebar drag measures once, applies one rAF per frame, persists on release. `bootstrap` runs async; theme poll 2 s → 10 s. |
| 5 | Polish | First-paint fonts preloaded. File tree rebuilt only when the listing changes; opening a file only moves the selection. |

### The ACL regression (found in review, fixed)

Tauri 2 gates every custom command behind a capability permission. Phase 1 added
`preview_check`, `highlight_code` and `ready` to `generate_handler!` but not to
`build.rs`'s command manifest or `capabilities/main.json`, so all three were
denied at runtime:

- the `preview_check` rejection was caught as "over limit" → **every document
  opened in source fallback** with the "Rich formatting is paused" banner;
- the `ready` rejection → the window only appeared through the 2 s fallback;
- the `highlight_code` rejection → code blocks lost highlighting.

No test caught it: every browser suite stubs `window.__TAURI__.core.invoke`, so
the native ACL is never exercised. Fixed by listing the commands in `build.rs`
and granting `allow-preview-check`, `allow-highlight-code` and `allow-ready`.
Verified by launching the built app on a real document (formatted view, no
banner). A guard test comparing `generate_handler!`, `build.rs` and the
capability file would prevent recurrence; it does not exist yet.

### Decisions, with the evidence behind them

**R2 (sanitize only author HTML) — rejected.** `comrak::escape_href` only
percent-encodes; it does not filter `javascript:` URLs
(`comrak-0.56.0/src/html.rs`). Whole-output ammonia cleaning is the only thing
removing dangerous link schemes, so skipping it would trade XSS safety for about
39 ms on a path Phase 1 had already taken off the open route. A regression test
now pins this (`render_still_sanitizes_raw_html_and_blocks_javascript_links`).

**R7 native cancellation — deferred; only `spawn_blocking` landed.** The frontend
already discards superseded renders through `renderGeneration`. Native
cancellation would need a stale-result contract (what should a superseded open
return, when the extension cache consumes the same command?) for no user-visible
gain.

**F1 changes the limit-detection semantics on purpose.** `preview_check` covers
source bytes, line count, nesting depth and AST node count — everything a parse
can see — but it does not predict the HTML-byte or image-byte limits. That is
documented on the function itself. The rich editor already caps at 2 MB, and
extension previews still render natively and fail closed to source, so the
tradeoff is bounded.

**Image cache budget interaction.** A cached entry is only served when the file
length is within the current call's per-file budget; otherwise the placeholder is
returned and nothing is cached. Without that, a cache filled under a larger
budget could answer a stricter call.

### Deliberately not done

- **E1 — incremental source/ledger fast path.** This is the dominant typing cost
  (~0.7 ms/KB; 19 ms at 26 KB, 253 ms at 105 KB). Removing it means remapping
  ledger owners and runs by delta with a fallback to a full parse — a designed
  change with its own tests. It was not attempted under time pressure: a subtle
  mapping bug corrupts the canonical source buffer, which is the user's data.
- **E4 — visible-range source decorations.** The decorations are a `StateField`,
  which has no access to `view.visibleRanges`; doing this properly means
  converting it to a `ViewPlugin`. Deferred as a refactor.
- **E3 — dual-engine mode switch.** Both engines are still built lazily per
  switch, so the first toggle still reparses; deferred.
- **E9 — bundle trim (~160 KB).** Dropping the `lang-html` / `lang-css` /
  `lang-javascript` / `autocomplete` chain that `lang-markdown` imports risks HTML
  code-block highlighting; deferred.
- **R8/R9 — string copies in `document.rs` and the HTML post-passes.** Low value
  against the risk; deferred.

### Verification (final tree)

- `cargo test --locked` — 88 passed, 0 failed.
- `cargo clippy --locked --all-targets -- -D warnings` — clean.
- `npm run check:editor-bundle` — matches pinned sources.
- `npm run test:editor` — unit plus all browser regressions, exit 0.
- `npm run test:ui` — 15 suites, exit 0.
- Built debug app launched under Xvfb on a 926-line showcase document: renders in
  formatted view with no fallback banner.

Not verified: **speed**. No release-build timing pass was run on this branch, so
the Phase 0 baselines have not been re-measured.

Severity scale refers to user-perceived cost, not code smell:

- **High** — visible on a normal document (tens of milliseconds or a visible
  blank/flicker).
- **Medium** — noticeable on a large document or a hot interaction.
- **Low** — worth fixing opportunistically.

## Summary: where the time goes

Four independent audits, one finding repeated at every layer: **Folio does the
expensive work eagerly and then discards it.** Opening a document renders the
whole file natively to learn one boolean, parses the same Markdown again in JS to
build the editor, and walks the document several more times to build a ledger and
an outline nobody is looking at. Typing repeats the full parse-and-ledger cycle on
every character.

| Symptom | Evidence | Root cause | Fix cost |
|---|---|---|---|
| Blank white window at launch | white surface 229 → 329 ms | window shown before first paint (S1) | Low |
| Theme flash / colour shift | painted 329 ms, theme settled ~396 ms | theme applied after 4 IPC awaits (S2/F4) | Low |
| Blank pane on first open | 1.1 MB bundle parsed on the main thread | awaited after clearing the pane, no prefetch (F2) | Low |
| Slow open, prose | 55–68 ms at 1 MB, HTML discarded | full native render kept only for a regex (F1/R1) | Low |
| Slow open, code-heavy | **730–797 ms at 276 KB** | syntect 526 ms + whole-output sanitize 191 ms (R3/R2) | Medium |
| Slow open, image-heavy | 122–142 ms, zero reuse across renders | per-render image cache (R5) | Medium |
| Typing lag | **19 ms/keystroke at 26 KB, 253 ms at 105 KB** | full reparse + re-ledger per keystroke (E1/E2) | Medium-High |
| Scroll jank | ~300 attribute writes per scroll tick (100 headings) | outline rewrites every entry (F8) | Low |
| Sticky zoom / mis-anchored scroll | forced full-document reflow | F12, F11 | Low |
| Mode-switch hitch | synchronous entire reparse + tree rebuild | E3 | Medium-High |

Two scaling cliffs matter more than any other item:

1. **Keystroke cost is ~0.7 ms/KB** because nothing is incremental. A 26 KB note
   already misses the 16.7 ms frame; the 2 MB `MAX_RICH_LENGTH` ceiling would be
   seconds per character. This is the biggest risk to the "smooth" goal.
2. **Open cost is dominated by syntect and ammonia**, both of which redo work
   that can be cached or skipped. A 276 KB Rust document takes 730–797 ms to
   open while a 1 MB prose document takes 55–68 ms. The cliff is code, not size.

Everything in the Low and Medium rows is fixable without architectural change.
The High typing items need a fast path for text edits that the code already has
in `updateSource` — it is simply not on the path that runs.

## Architecture in one paragraph

Tauri 2 app. Rust (`src/`) owns the filesystem, a comrak-based Markdown
renderer, sanitization, and a separate Mermaid webview. The frontend (`ui/`) is
unbundled vanilla JS; the editor is a ProseMirror + CodeMirror bundle built by
esbuild into `ui/vendor/editor/editor.js` (1.1 MB). Mermaid (3.5 MB) and KaTeX
are already lazy (commit `bceba82`) and Mermaid executes in a separate webview,
never in the reader page. First-load shell payload is 204 KB unminified plus
260 KB of local variable woff2 fonts.

## Area 1 — UI shell (verified)

Files: `ui/index.html`, `ui/app.js`, `ui/preview.js`, `ui/theme.js`, `ui/core.js`,
`ui/styles.css`.

CSS verdict: 623 rules / 3364 lines, no data URIs, no filters, no keyframes,
7 transitions, 3 `:has()` rules, 21 media queries, reduced-motion honored.
Selector matching is not a bottleneck, though the file is unminified and has
append-only duplication (`#file-browser` declared 4×, `.markdown h1` 4×).

### High

**F1. A full-document native render happens on every open and is thrown away.**
`ui/editor.js:145-147` awaits `render_markdown` over the entire document, uses
the HTML only for a `/data-preview-limit=/` regex test, and assigns
`previewBlocks = result.blocks || []`. `previewBlocks` is written in five
places and read nowhere; `previewBlockAtViewportTop()` is hard-coded
`return 0` (`ui/editor.js:20`). On a large document this serializes and
JSON-parses a multi-megabyte string on the main thread to learn one bit.
Fix: return the limit flag from `open_document` (Rust already knows it —
`src/markdown.rs:422`), or add a summary command. Low risk.

**F2. First open pays the 1.1 MB editor bundle after blanking the pane.**
`ui/editor.js:139-141` clears `#preview` and only then awaits
`loadAsset('vendor/editor/editor.js')` + the editor stylesheet, which parse and
evaluate synchronously on the main thread. No `<link rel="prefetch">` exists
anywhere; `ui/index.html:8-13` loads only the six shell scripts. The user
stares at an empty pane for fetch + parse.
Fix: prefetch the bundle/CSS at idle after first paint (or on first interaction
with Open), and paint a skeleton before the await. Low risk; costs one extra
request when a file is never opened.

**F7. The outline is rebuilt 180 ms after every typing pause, even when hidden.**
`onChange` (`ui/editor.js:156`) calls `scheduleEditorOutline()`; the timer
(`ui/editor.js:67`) calls `refreshEditorOutline` (`ui/editor.js:75-118`), which
has no visibility guard and performs: a char-by-char scan of the whole document
to build `lineStarts`, `window.FolioEditor.headings(current.content)`, a
`querySelectorAll('h1…h6')` over the preview, `replaceChildren()`, and one new
`<button>` per heading. On a 1 MB document that is two full-document passes plus
a full-preview query for output the user cannot see. It is also re-armed on
every extension mount (`ui/editor.js:202`).
Fix: return early when `$('outline').hidden`; build `lineStarts` only when an
extension heading is present; reuse buttons instead of rebuilding. Low risk.

**F8. Each scroll frame rewrites attributes on every outline entry.**
`ui/preview.js:70` listens for scroll (passive, rAF-throttled — good) and
`updateActiveOutline` (`:46-65`) runs even when the outline is hidden;
`setActiveOutline` (`:38-44`) then does `classList.toggle`, `tabIndex` and
`aria-current` add/remove for every entry. A 100-heading document issues ~300
DOM attribute writes per scroll increment, each invalidating style.
Fix: early-return when hidden; touch only the previous and next indexes. Low risk.

### Medium

**F3. The whole file tree is rebuilt on every document open.** `showDocument()`
calls `renderFolderEntries()` (`ui/app.js:109`), whose body (`ui/app.js:405-446`)
replaces every entry with a fresh `<button>` plus one or two `createElementNS`
SVG nodes. A 500-entry folder creates ~1,500 nodes per file click.
Fix: build once per listing, then toggle `selected`/`aria-current`. Medium risk
(focus restore and `--depth` state).

**F4. The persisted theme applies only after three await-ed IPC round-trips.**
`ui/app.js:871-877` awaits three `listen()` calls in sequence, then
`invoke('bootstrap')`, then `applyTheme`. Because `index.html:2` ships
`data-theme="system"`, a graphite/nord user gets a light first paint followed by
a full-document restyle. `ui/theme.js:3` already reads the preference at parse
time.
Fix: set the theme dataset in `theme.js` before first paint; keep `bootstrap`
only for the Omarchy case; `Promise.all` the listeners. Low risk.

**F5. Open issues one `render_markdown` IPC per code block and per image.**
`ui/editor.js:218` (per fenced block), `:241` (per image, returning a base64
result over IPC), `:167` (a full snapshot render parsed with `DOMParser`).
A document with 30 fences and 10 images produces 40+ serial round-trips before
it is fully painted.
Fix: batch into one Rust command taking arrays, or fold into F1's render.
Medium risk — the native sanitizer must stay the only authority.

**F9. `set_title` and ~15 DOM writes fire on every keystroke.**
`onChange` → `updateTitle()` (`ui/app.js:66-89`) ends with
`invoke('set_title', …)`, which calls `window.set_title` (`src/main.rs:541-553`).
No debounce or change detection anywhere.
Fix: send only when name/dirty actually change; coalesce on a ~120 ms timer.
Low risk.

**F10. Full-document word count on every typing pause.**
`ui/app.js:91` does `current.content.trim().split(/\s+/)`, allocating one string
per word, every 180 ms while typing.
Fix: count whitespace transitions without allocating, and skip above a size
threshold. Low risk.

**F11. `scroll-behavior:smooth` captures programmatic scroll writes.**
`ui/styles.css:656` sets it on `.reader-scroll`, the only scroller. The author
already had to disable it in edit mode (`ui/styles.css:143`), and
`tests/text-zoom-anchor.cjs:8` must force `scrollBehavior = 'auto'` before
writing `scrollTop`. Consequence: zoom anchor compensation (`ui/app.js:207`),
the open reset (`ui/app.js:276`), outline jumps and folder focus restore all
animate instead of landing.
Fix: drop it from the scroller and use `scrollIntoView({behavior:'smooth'})`
only for explicit outline jumps, honoring reduced-motion. Verify in WebKitGTK.

**F12. Zoom and width toggle force a synchronous reflow of the article.**
`ui/app.js:197-208`: reads the anchor rect, writes `--text-size` (invalidating
layout), then reads the same rect again — a forced full-document layout per
Ctrl+Shift+=. `setDocumentWidth` (`ui/app.js:673-686`) repeats the pattern, and
`readerScrollAnchor` (`ui/app.js:190-195`) allocates and rect-reads every
top-level block until the viewport top.
Fix: capture the offset before the style write; batch in one rAF; memoise the
block list. Medium risk (zoom anchoring has a regression test).

**F13. Sidebar drag persists to `localStorage` on every pointermove.**
`ui/app.js:169-170` → `setWidth` (`:163-167`): `getBoundingClientRect`,
a body-scoped CSS variable write that re-lays out the reader, and a synchronous
`preferences.set`, per pointermove.
Fix: apply in one rAF, persist on `pointerup`. Low risk.

### Low

- `ui/core.js:16` measures header widths at module top level, and
  `ui/core.js:21` adds a `resize` listener duplicating the `ResizeObserver`.
- `:has()` on `.document-view` (`ui/styles.css:1262`, `:2043`, `:2428`; `:1262`
  and `:2428` duplicate the same rule) puts `:has()` re-matching in the
  invalidation path of every editor mutation. An attribute toggled in
  `setFolderVisible` would do.
- `ui/app.js:868` calls `zoomWindow(0)` at startup, issuing `set_window_zoom`
  even when the persisted zoom is 1.
- `ui/app.js:883-887` polls `document_changed` every 3 s forever (guarded by
  `document.hidden`).
- Nine synchronous `localStorage` reads before first paint
  (`ui/app.js:5-13`, `ui/theme.js:3`); one JSON blob would do.
- No font preload; all five faces are `font-display:swap`, so the UI paints in
  fallback and reflows. Preload the Inter and Source Serif 4 latin variable
  files (~100 KB of the 260 KB) or use `optional` for the reading face.
- Dead shell renderers in `ui/preview.js:109-247` (`renderMath`,
  `renderDiagrams`, `setupTables`) on the rich path.

### Already well optimized

- Mermaid and KaTeX are lazy; Mermaid renders in a separate webview over an
  id-routed bridge, keeping 3.5 MB off the reader's main thread.
- The editor bundle is memoised through `assetLoads` (`ui/preview.js:5-17`);
  `renderGeneration` (`ui/editor.js:137-149`) discards stale renders.
- Scroll listener is passive and rAF-throttled; `ResizeObserver` replaced
  polling; listeners are wired once at module top level; `ask()` removes its
  cancel handler.
- Variable fonts: 12+ used weights map to 2 files per family, 5 files total.

### Profiling run that confirms this section

Record DevTools Performance on Linux WebKitGTK for: (1) cold start → open a
≥500 KB doc with headings, 5 fences, 2 images, 1 math block (F1/F2/F4/F5);
(2) type 20 characters in it (F7/F9/F10); (3) scroll three screens with the
outline closed, then open (F8); (4) drag the folder divider 300 px (F13).
Watch for long tasks > 50 ms at open, the Scripting vs Recalculate Style split,
forced-layout warnings after `--text-size`/sidebar writes, and `invoke` entries
per keystroke. For F11, set `scroller.scrollTop = 1000` in the console and read
it back: if it lags, smooth scrolling is intercepting programmatic writes. Read
mode vs edit mode is a free A/B, since edit mode already disables smooth scroll.

## Area 2 — Editor (measured)

Files: `ui/editor/*.js` and the esbuild bundle `ui/vendor/editor/editor.js`
(1.09 MB minified, 2.94 MB of inputs, 129 files; `check:editor-bundle` passes,
so the bundle matches source).

These are node-level measurements of the real modules with no DOM, so they are a
lower bound on what the WebView pays — the engine cost is included, layout and
paint are not. Warm run, median of repeated trials:

| Document | Open (`parseSource`) | One keystroke (`tryTextEdits`) |
|---|---|---|
| 3 KB | 2.2 ms | 3.6 ms |
| 10 KB | 4.8 ms | 7.3 ms |
| 26 KB | 16 ms | 19.3 ms |
| 52 KB | 93 ms | 82 ms |
| 105 KB | 214 ms | 253 ms |

Cost split at 105 KB: markdown-it tokenize 24 ms, ProseMirror
`parser.parse` 33 ms, `buildLedger` 148 ms. Per-keystroke cost tracks parse cost
at roughly 0.7 ms/KB. A frame is 16.7 ms, so typing is already over budget at
~26 KB and unusable at 105 KB. `MAX_RICH_LENGTH` is 2 MB
(`ui/editor/entry.js:12`), which would be seconds per character.

### High

**E1. Every keystroke re-parses and re-ledgers the entire document.**
`ui/editor/rich.js:1714` runs
`tryTextEdits(model, result.transactions, result.state.doc) || updateSource(...)`.
The first branch is a plain text edit, and it goes through
`ui/editor/source-edits.js:132`: `parsed = parseSource(patched.source)`, which
re-tokenizes with markdown-it, re-parses with `prosemirror-markdown`
(`ui/editor/model.js:283`) and rebuilds the ledger (`buildLedger`). Nothing is
incremental. The result is then discarded unless it happens to equal
`applied.doc`, which it must by construction.
Fix: on a text-only step, splice the source interval and adopt `applied.doc`
(cheaply verified) without reparsing; mark the ledger stale and rebuild it
lazily on the next positional use (mode switch, click, command), not per
character. `updateSource` — the identity-anchored block splice, measured at
0.9–12 ms — is roughly 20× cheaper and is already the fallback. The fast path is
currently the slowest option.

**E2. `buildLedger` is the hot core, and it is super-linear in block count.**
Three separate costs inside `ui/editor/source-ledger.js`:
- `:194` `lezerParser.parse(source)` — an extra full Lezer parse per revision,
  on top of the markdown-it and ProseMirror parses.
- `:242` `options.tokens || tokenizer.parse(source, {})` — callers that omit
  `tokens` (`rich.js:304`, `:1331`, `source-edits.js:101`, `:158`) pay yet
  another full markdown-it pass.
- `:285-302` block association is O(blocks × tokenBlocks): for each segment it
  scans every candidate token block. 4,000 blocks means 16 M iterations.
  Measured: 118 KB/120 blocks = 16.8 ms versus 186 KB/6,000 blocks = 234 ms.

Fix: key the association with a `Map` on `type\0sourceFrom`, add an
`ownerId → owner` map, and reuse the ledger across revisions by node identity.

**E3. A mode switch is a synchronous full reparse plus full tree rebuild.**
`ui/editor/entry.js:189` `presentation()` → `richEditor.setDocument(...)` →
`ui/editor/rich.js:1873` `model = parseSource(content)` →
`stateFor(model.doc, selection)` → `view.updateState(state)`, a whole-document
state replacement that reconstructs every node view (KaTeX per math node, image
resolution, code highlight, table views). The first switch to source also
constructs CodeMirror (`ui/editor/source.js:265`); every later switch does a
full-document replace (`:302`, `{from: 0, to: doc.length, insert: content}`).
`presentation()` then runs `coordsAtPos`/`posAtCoords`/`getBoundingClientRect`
and a rAF restore loop of up to 12 frames plus 150/400 ms timers, all on the main
thread inside `enqueue`.
Fix: keep both engines mounted but hidden; short-circuit `setDocument` when the
content is unchanged; drop the scroll-restore loop when nothing moved.

### Medium-High

**E4. Source mode recomputes decorations over the whole document on every
keystroke and every caret move.** `ui/editor/source.js:270` returns
`decorate(tr.state)` whenever `tr.docChanged || tr.selection`, and `:151`
iterates `syntaxTree(state)` with no visible-range restriction — one mark per
emphasis/inline-code/link/strikethrough, one line decoration per code/quote
line, one `TablePreview` per unrevealed table, then `Decoration.set(ranges, true)`
sorts the whole set. `:283` also copies the whole buffer per keystroke
(`update.state.doc.toString()`).
Fix: compute decorations for `view.visibleRanges` only (CodeMirror's standard
recipe) and carry the source string incrementally.

### Medium

**E5. A second full parse per typing pause, on the shell side.**
`onChange` (`ui/editor.js:156`) → 180 ms timer → `refreshEditorOutline` →
`window.FolioEditor.headings(current.content)` → `ui/editor/entry.js:35`
`tokenizer.parse(content, {})`, an independent whole-document markdown-it pass
(24 ms at 105 KB) plus a full outline DOM rebuild. The same keystroke also runs
`updateTitle()` with `invoke('set_title', …)` — one IPC round-trip per character
— and `scheduleStats()` (F9/F10).
Fix: reuse the editor's last tokenization, or debounce the outline to ≥500 ms
idle.

**E6. Duplicate full-document traversals per keystroke.**
`rich.js:1695` `result.state.doc.eq(view.state.doc)`, then `source-edits.js`
`:109/:133/:141/:143/:146` `doc.eq`, `:149-154` per-block `node.eq`, `:84-88`
`rebaseLedger` (`doc.nodeAt` + `node.eq` per owner), `rich.js:297-301`
`attachModel` repeating that loop, and `rich.js:315`
`replaceWith(0, size, candidate.doc.content)` — a whole-document step. `doc.eq`
alone measures 1.15 ms at 43 KB and 2.2 ms at 88 KB, and there are about seven
traversals, so 10–15 ms at 100 KB on top of the parse.
Fix: drop the redundant equality checks (the parse already proves it), splice
only the changed range, and rebase by index rather than `nodeAt` + `eq`.

**E7. Ledger lookups are linear and run 6–8× per keystroke.**
`ui/editor/source-ledger.js:1059` filters all runs per position and `:1125`
does `owners.find(owner => owner.id === run.ownerId)`; these fire from
`sourceSelection`, `verifiedSourceRange` and `exactEndpoint`.
Fix: binary search over runs (as `findRunSource` already does) and an
`id → owner` map.

**E8. Node views re-render on their own edits without short-circuits.**
`rich.js:785` (code), `:605` (math) and `:1430` (raw) all set `node = next;
render()` with only a type check; `:638` (image) does have an `eq` guard.
Typing inside a fence therefore rebuilds both layers and schedules
`options.highlightCode` → `ui/editor.js:218 invoke('render_markdown', …)` every
~60 ms, plus `DOMParser` per result. `mathView` re-runs `katex.render` on every
update.
Fix: guard on text/attr equality and cache KaTeX output by `tex`.

### Low-Medium

**E9. The bundle carries ~160 KB that is never used.**
`node_modules/@codemirror/lang-markdown/dist/index.js:6` imports
`@codemirror/lang-html`, which pulls `lang-html`, `lang-css`, `lang-javascript`,
`@lezer/html`, `@lezer/css`, `@lezer/javascript` and
`@codemirror/autocomplete` — yet only `markdown, markdownLanguage` is used
(`ui/editor/source.js:4`). That is ~160 KB of source and ~90 KB of autocomplete
in a 1.09 MB bundle.
Fix: import the language without the HTML dependency, or vendor a trimmed
`lang-markdown` copy. Parse/compile measured 28 ms in node with a warm isolate
cache; expect 50–150 ms once per first open in the WebView.

### The "parse budget" is not a latency budget

`tests/editor-parse-budget.cjs` asserts only `parses === 1` per source revision
— it blesses one full tokenization per revision, and passes today. It cannot
catch E1 or E2 because it measures neither wall-clock time nor scaling.
Fix: assert zero full parses for a text-only keystroke (or that only the changed
block is reparsed) and add a time ceiling for a 100 KB document.

### Already well optimized

- One engine: `richParent: $('preview')` means the preview *is* the ProseMirror
  view — there is no second render per keystroke.
- Outline, stats and word-count are 180 ms-debounced; Mermaid 120 ms with the
  previous SVG retained; code highlighting 60 ms-debounced.
- Images are cached per path with byte leases; source decorations bail out above
  2 MiB (`ui/editor/source.js:146`); rendering is capped at 2 MB rich.
- Ledger anchoring uses node identity rather than text equality, so the
  corruption-prone fallback is gone.
- No KaTeX in the bundle (lazy).

### Profiling run that confirms this section

In WebKitGTK, record InputEvent→paint for 26 KB and 52 KB notes, then the same
while typing inside a fenced block, a Mermaid block and a table cell. Count
KaTeX renders and `invoke` calls per second, measure the `set_title` round-trip,
and check `view.updateState` cost after `commitCandidate`'s whole-document
replace. Also collect the real document-size distribution: 10 KB is already at
7 ms and 26 KB at 19 ms, so the fix threshold depends on what users actually
open.

## Area 3 — Rust render / open pipeline (measured)

Scope correction: `src/renderer.rs` is **not** the Markdown path. It is the
sandboxed Mermaid transport, CSP and native probe (`renderer.rs:141, 187-296`),
and it is already well bounded: 32 outstanding requests, 60 s timeout, real
cancel and webview recycling. The actual path is
`src/main.rs:491-511` (`render_markdown`) → `src/markdown.rs:352-407`
(`render_with_blocks_checked`) → `src/markdown/{images,author_html,limits}.rs`.
That path has none of the transport's budget or cancellation machinery.

Measurements are release-build, from a `/tmp` harness mirroring
`render_with_blocks_checked` stage by stage, excluding Tauri IPC, JSON parsing
in JS, and DOM construction (median of three):

| Corpus | Total | Stage split |
|---|---|---|
| 1 MB prose | 55–68 ms | parse 8, blocks 8.9, format_html 4.1, **sanitize 39** |
| 100 KB prose | 5–10 ms | sanitize 3.4 |
| 276 KB, 40 Rust fences | **730–797 ms** | **syntect 526**, sanitize 191, 6.4 MB HTML |
| 137 KB, one fence | 340–418 ms | syntect 299, sanitize 93, 3.2 MB HTML |
| 20 × 200 KB local images | 122–142 ms | sanitize 88, image accounting 16, 5.3 MB HTML |

IPC adds 36 ms serde plus a 6.6 MB JSON string for the 1 MB prose case.

### High

**R1. Open always pays a full render whose HTML is discarded.** Same root cause
as F1 (`ui/editor.js:145`), confirmed from the native side: the editor is built
from `current.content` and never receives `html`. A 1 MB prose document spends
55–68 ms, a 276 KB code document 730–797 ms, to compute one boolean. Documents
containing raw HTML pay a **second** full render, because `extensionCache` starts
`null` (`ui/editor.js:150`) and the first `renderExtension` re-invokes the whole
pipeline (`:164-167`).
Fix: a `preview_check` command that runs only preflight plus the parse budget
(~0.5–2 ms) for the limit gate; pass the native HTML into `FolioEditor` instead
of re-parsing; seed `extensionCache` from the mount result.

**R2. Ammonia re-sanitizes the entire generated HTML on every render.**
`src/markdown.rs:399` sanitizes `writer.output` wholesale, and `:478-482` builds
a fresh `ammonia::Builder` per call. Measured at 70% of the 1 MB prose render
(39 of 55 ms), 191 ms for the 276 KB code document and 88 ms for the image
document. The "writer output" is machine-generated except for author HTML,
which is already tokenized at `markdown.rs:383` via `author_html.rs:19-40`.
Fix: sanitize the author literals only, keeping whole-output cleaning behind a
debug flag; hoist the `Builder` into two `LazyLock` statics (remote images on and
off). Security tests assert `script`/`onerror` stripping — sanitizing author
nodes preserves that, since whole-output cleaning is defense in depth, not
detection.

**R3. Syntect highlighting dominates technical documents, with no per-fence
cache and no size cap.** `markdown.rs:215` correctly loads syntax sets once via
`LazyLock`, but comrak highlights every fence on every render: 526 ms for 200 KB
of code (~0.4 MB/s) and 299 ms for a single 137 KB fence that produces 3.2 MB of
spans. The frontend also routes each fence through the *full* `render_markdown`
(`ui/editor.js:218`) just to extract tokens, paying parse + sanitize + image
accounting on top.
Fix: a bounded LRU keyed on `(lang, sha256(code))`, a highlighted-byte cap
(e.g. 64 KB, falling back to plain), and a `highlight_code` command that skips
sanitize and the image pass.

### Medium-High

**R4. `blocks` is computed and serialized on every render but never read.**
`src/markdown.rs:385` builds them unconditionally; `ui/editor.js:147` assigns
`previewBlocks`, which nothing reads. On a 1 MB document that is 5,934 blocks:
the IPC payload grows from 2.1 MB of HTML to 6.6 MB of JSON, adding 36 ms of
serde plus a `JSON.parse` in the WebView. `EditBlock.source` is already
`#[serde(skip_serializing)]` but is still cloned per block at `:132`.
Fix: make blocks opt-in and drop the per-block `source` clone.

### Medium

**R5. Nothing is cached across renders.** The image cache is per render
(`markdown.rs:363`, `Arc::new(Mutex::new(ImageCache::new()))` per call); repeat
renders measured 142 / 141 / 122 ms with zero reuse — files re-read, base64
re-encoded, 5.3 MB of data URLs re-sanitized and re-sent. There is no
content-hash render cache anywhere; `sha2` is used only for save-conflict
fingerprints (`document.rs:64-65`).
Fix: a process-wide LRU for encoded images keyed on
`(canonical path, mtime, len)`, and optionally an HTML cache keyed on
`(content hash, base, allow_remote)`.

**R6. Five full AST traversals and two line indexes per render.**
`markdown.rs:382` `check_node_budget` (`descendants().count()`), `:383`
`strip_author_markers`, `:385` `blocks_from_root`, `:386-392` another
`descendants()` for task indices, then `:394` `format_html`. About 11 ms of the
1 MB render. Fix: merge node-count/task/block collection into one pass, and skip
blocks entirely per R4.

**R7. No cancellation and no generation counter; CPU work is not
`spawn_blocking`.** `main.rs:491` declares the command `async` but runs the
synchronous pipeline on an async-runtime worker (contrast `main.rs:353`, which
does use `spawn_blocking`). Only the JS discards stale results
(`ui/preview.js:3`), so a running 300–700 ms render is never aborted; code
highlighting re-arms a 60 ms timer (`ui/editor/rich.js:682-705`) but cannot stop
work already in flight.
Fix: an `AtomicU64` generation in `AppState`, a `cancelled` check after parse
and before sanitize, and `spawn_blocking`.

### Low

**R8. `open()` copies the document three times.** `document.rs:90`
`String::from_utf8(bytes.clone())`, `:93` `text.replace("\r\n", "")` purely to
detect CRLF, `:101` `text.replace("\r\n", "\n")`.
Fix: detect CRLF during the byte scan and use `Cow`.

**R9. Two extra full-HTML copies per render.** `markdown.rs:474-476`
(`harden_images`, `html.replace("<img ", …)`) and `patch_task_items`
(`:293-327`, always `String::with_capacity(html.len())`) — about 0.7 ms per
2 MB. Fix: fold `referrerpolicy` and task indices into the sanitizer's attribute
filter.

### Already well optimized

- `SYNTAXES` loads once via `LazyLock` (`markdown.rs:215`); one parse is shared
  by HTML and edit blocks (`:355`); `BoundedWriter` caps HTML while generating.
- Preflight is linear and runs before the parse (`limits.rs:98-172`); per-image
  budgets are hard (`read_bounded`, `images.rs:145`).
- Mode switches and saves reuse the previous render (asserted by
  `tests/ui-smoke.cjs:122`); extension blocks share one native parse per
  revision (`tests/editor-extension-open-cost.cjs`).
- The Mermaid transport has cancellation, timeouts and webview recycling.

### Cache and budget assessment

There is no content-hash render cache. The budgets in `limits.rs:28-40`
(20 MiB source, 200k lines, depth 128, 200k AST nodes, 64 MiB HTML, 200 images,
32 MiB encoded, 10 MiB per image) are safety ceilings, not latency budgets:
documents far below every limit still take 730 ms–1 s. Failure is all-or-nothing
(`markdown.rs:341-350` → `preview_limit_html`, editor falls back to source), so
it is not a per-keystroke concern except at extreme sizes. Add a time budget and
a per-fence byte budget.

### Profiling run that confirms this section

The harness excluded Tauri IPC, `JSON.parse`, DOM construction and cold file I/O.
To confirm the ranking on-machine: (a) `perf record -g -p $(pgrep -x folio) --
sleep 10` while opening a 1 MB code-heavy document, then
`perf report --stdio | grep -E "syntect|ammonia|comrak"`; (b) a WebView
Performance trace around one open with `performance.mark` before and after the
`openPath` invoke, to split native vs JSON vs ProseMirror build; (c) an
image-heavy open after `drop_caches` to separate image read cost from in-page
caching; (d) repeat the stage-by-stage harness over 10 KB / 100 KB / 1 MB
corpora.

## Area 4 — Cold start (measured)

Measured on the existing release binary (`target/release/folio`, 16.5 MB) under
Xvfb 1400×900 with 60 fps x11grab, frames anchored to process spawn, isolated
`XDG_*` dirs, `--version` as the process baseline. Xvfb is software-rendered
with no GLX, so absolute numbers are indicative rather than the user's
Wayland/GPU numbers.

| Instant | Time after spawn |
|---|---|
| `true` / baseline | 1.0 ms |
| `--version` (process start + 144 shared libs) | 41.4 ms |
| Window mapped | 179–190 ms |
| **Blank white surface** | **229 → 329 ms** |
| Dark UI painted | ~329 ms |
| Saved theme settled | ~396 ms (repeat: 389 → 573 ms) |

Second-instance handshake measured 41 ms, i.e. free. Startup transfers ~327 KB:
20.7 KB HTML, 68.1 KB CSS, 98 KB deferred JS, 41 KB injected Tauri API, ~99 KB of
woff2 — not 4.7 MB, because the editor, KaTeX and Mermaid are all lazy.

The ~40 ms baseline is process start and dynamic linking; ~140 ms is WebKitGTK
bring-up before the first frame. Neither is app code.

### High

**S1. The window is shown before any content exists, so WebKit paints a blank
white surface for ~100 ms.** `src/main.rs:1459-1469` builds the window with the
default `visible(true)`, no `.background_color()`, and no show-on-ready; the
frontend then loads CSS and six `defer` scripts (`ui/index.html:7-13`).
Measured white surface (root-normalised mean ≈236) from 229 ms to 329 ms. In a
dark-themed app this is the dominant perceived cold-start artifact, and because
it happens before app code runs, no JS change can remove it.
Fix: `.visible(false)` plus a `show()` when the frontend signals ready (a `ready`
command at the end of `start()`), with a 1.5–2 s fallback `show()` in `setup` so
a frontend error cannot leave an invisible window. Cheaper alternative:
`.background_color()` matching the theme plus a critical inline
`<style>html{background:#…}</style>` — the CSP permits inline styles
(`style-src 'self' 'unsafe-inline'`) but not inline scripts. Low risk.

### Medium

**S2. The saved theme is applied after three `listen` awaits plus `bootstrap`.**
`ui/index.html:2` hardcodes `data-theme="system"`; `ui/app.js:871-875` awaits
`request-close`, `open-files` and `system-theme` listeners in sequence, then
`invoke('bootstrap')`, and only at `:877` calls `applyTheme`. A user on a
non-system theme therefore always gets the system palette first, then a
full restyle — measured content at 329 ms but settled palette at ~396 ms
(573 ms on the repeat). Same root cause as F4.
Fix: a small non-deferred `ui/prefs.js` loaded **before** `styles.css` that sets
`data-theme`, `data-reading-font` and root font size from localStorage; move
`applyTheme()` above the awaits in `start()`. Low risk.

### Low

**S3. `bootstrap` is a synchronous command doing filesystem IO on the main
thread.** `src/main.rs:272-283` calls `theme::current()`, which reads up to four
files (`src/theme.rs:38-56`). Measured at ~15 µs, so the cost is negligible, but
it is on the critical path to theme application and unlike the neighbouring
handlers is not `(async)`. Fix: mark it `(async)` or compute it once in `setup`.

**S4. The theme watcher re-reads and re-parses TOML every 2 seconds forever.**
`src/main.rs:1430-1440` loops `sleep(2s)` then `theme::current()`, which is two
file reads plus a `toml::Table` parse and `BTreeMap` build, for an idle window.
CPU cost is noise; the concern is constant wakeups and IO for a static file.
Fix: watch the theme directory, or poll every 15–30 s. It sleeps before working,
so it does not delay first paint — leave that part alone.

**S5. Fonts are not preloaded and use `swap`, so text reflows at startup.**
All five faces are `font-display:swap` (`ui/styles.css:1-38`) with no
`<link rel="preload" as="font">`; the initial view needs Inter (48 KB) and very
likely Source Serif 4 (51 KB). Fallback text paints, then swaps.
Fix: preload those two woff2 files. Same item as the UI-shell Low list.

**S6. `withGlobalTauri` injects a 41 KB JS bundle before page scripts.**
`tauri.conf.json:8`; the only fix is moving to the ESM API with an import map,
which is a larger refactor. Not worth it now.

**S7. The release profile omits `panic = "abort"`.** `Cargo.toml:32-35` already
has `lto = "thin"`, `codegen-units = 1` and `strip = true`; adding `panic`
would trim unwind tables for a marginal gain. Verify the full suite before
keeping it, and do not touch the three settings that are already right.

### Already well optimized — do not redo

- The editor (1.1 MB) loads on demand, KaTeX (268 KB) on first math, and Mermaid
  exists only in a hidden webview created lazily — startup fetches ~327 KB.
- No folder scan or tree build at launch; startup touches argv only and reads no
  document.
- The native probe is debug-only and env-gated; the single-instance handshake is
  effectively free; both background threads sleep before working; all assets are
  embedded, so there is no network; the CSP is tight.

### Could not determine without on-machine profiling

Real Wayland/GPU timings (Xvfb is software-rendered, and dconf was read-only so
a dark GTK session could not be reproduced — the white flash is WebKit-internal
and likely universal, but its duration is not). To split WebKitGTK spawn,
shader-cache and disk IO: `strace -f -tt -e trace=execve,connect` and
`perf stat -e task-clock,page-faults`. To measure the dynamic-link share:
`LD_DEBUG=statistics ./target/release/folio --version 2>&1 | tail -20`. To get
true first-paint and theme-apply instants, build with the `devtools` feature and
read `performance.getEntriesByType('paint')` plus a `PerformanceObserver` for
`font` and `largest-contentful-paint` — that is the right way to confirm S1, S2
and S5 before changing code.

## Suggested fix order

Ordered by perceived improvement per unit of risk, not by finding number.

### Phase 0 — establish a baseline before changing anything

Capture the four traces described in "Needs on-machine profiling" and write two
budgets into the repo: **open a 100 KB document in < 100 ms** and **under 8 ms per
keystroke at 100 KB**. Turn `tests/editor-parse-budget.cjs` into a latency test so
E1/E2 cannot regress silently later.

### Phase 1 — perceived open time (done)

1. **S1** show the window on ready, or give it a themed background — removes the
   ~100 ms white flash. This is the first thing a user sees.
2. **S2/F4** apply the persisted theme before first paint.
3. **F2** prefetch the editor bundle at idle and paint a skeleton before the
   await — removes the blank pane.
4. **F1/R1** replace the discarded full render with a `preview_check` limit probe,
   and seed `extensionCache` from the mount so raw-HTML documents stop rendering
   twice.
5. **R4** make `blocks` opt-in — removes 36 ms of serde and a multi-megabyte JSON
   payload on large documents.

After this phase, opening a 1 MB prose document should lose its dominant native
cost and the launch should no longer flash white or repaint a second palette.

### Phase 2 — render cost on real documents (done, minus R2 and R7 cancellation — see decisions above)

6. **R2** sanitize author literals only, hoisting the ammonia `Builder` into
   `LazyLock` statics.
7. **R3** per-fence syntect LRU with a byte cap, plus a `highlight_code` command
   that skips sanitize and the image pass. This is the 526 ms item.
8. **R5** process-wide image cache keyed on path, mtime and length.
9. **R7** generation counter plus `spawn_blocking`, so a stale 700 ms render can
   be abandoned instead of blocking a worker.

Security constraint: R2 changes a security-relevant boundary (whole-output
sanitize → author-literal sanitize). The existing security tests assert
`script`/`onerror` stripping and must keep passing unchanged; do not weaken them
to make the change fit.

### Phase 3 — typing smoothness (the hard part)

10. **E1** put the text-edit fast path on the hot route: splice the source
    interval, adopt `applied.doc`, mark the ledger stale.
11. **E2** replace the O(blocks × tokenBlocks) association with a `Map`, and
    rebuild the ledger lazily on positional use rather than per character.
12. **E4** decorations for `view.visibleRanges` only, and stop copying the whole
    buffer per keystroke.
13. **E5/F9/F10** reuse the editor's tokenization for the outline, coalesce
    `set_title`, and count words without allocating.
14. **E8** equality guards in the code, math and raw node views.
15. **E6** drop the redundant `doc.eq` passes and splice only the changed range.

Target: 26 KB keystrokes from ~19 ms to under 5 ms; 100 KB from ~253 ms to the
low tens. Treat the source-ledger and round-trip regression suites as the safety
net — they already cover the failure modes this rewrite can introduce.

### Phase 4 — chrome and scroll polish (cheap, visible)

16. **F8** update only the changed outline entries, and skip when hidden.
17. **F11** remove `scroll-behavior:smooth` from the scroller; use explicit smooth
    scrolling only for outline jumps.
18. **F12** capture the anchor offset before the style write; one reflow instead
    of two.
19. **F3** rebuild the file tree on open only.
20. **F13** coalesce sidebar drags into one rAF and persist on pointer up.
21. **S3/S4** make `bootstrap` async and slow the theme poll.

### Phase 5 — structural

22. **E3** keep both editor engines mounted (hidden) or chunk the mode-switch
    parse; short-circuit `setDocument` when content is unchanged.
23. **E9** drop the unused `lang-html`/`css`/`javascript`/`autocomplete` chain
    pulled in by `lang-markdown` (~160 KB of source).
24. **R6, R8, R9** merge the AST walks and remove the redundant string copies.
25. **S5, S7** preload the two latin variable fonts; consider `panic = "abort"`.

### Explicitly not worth doing

- Release profile: `lto = "thin"`, `codegen-units = 1` and `strip = true` are
  already the right settings. Do not re-tune them.
- Lazy loading of the editor, KaTeX and Mermaid is done correctly; startup
  transfers ~327 KB and there is nothing to gain there.
- There is no folder scan at launch, no document read at launch, and no polled
  layout measurement. The Mermaid transport already has timeouts, cancellation
  and webview recycling.
- The CSS is not a bottleneck (no data URIs, no filters, 7 transitions). It is
  only unminified and duplicated, which is a cleanliness issue, not a speed one.
- Variable fonts are already economical: 12+ weights map to 5 files.

### Verification after each phase

```sh
npm run check:editor-bundle
npm run test:editor
npm run test:ui
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

Then re-run the same DevTools trace and the same corpus through the `/tmp`
harness. A phase is done when its budget is met and the traces show no new long
task, not when the diff is in.
