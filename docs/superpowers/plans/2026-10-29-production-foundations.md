# Production Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce offline Mermaid privacy and editing integrity, bound expensive work, restore portable builds, and offer a persistent system/Folio picker choice.

**Architecture:** Preserve Rust/Tauri and plain JavaScript. Give a separately labelled offline Mermaid webview a minimal transport and deny it existing native commands; centralize parser/resource budgets in Rust. Add picker routing through the current open/protection flows.

**Tech Stack:** Rust, Tauri 2, Comrak, Ammonia, JavaScript, Playwright, native system webviews.

**Approved specification:** `docs/superpowers/specs/2026-10-29-production-foundations-design.md`.

**Execution outcome:** implemented and locally validated on Linux. See
`2026-10-29-production-foundations-validation.md` for the integrated baseline,
review-driven corrections, targeted reruns, and outstanding platform validation.
Changes are retained on the feature branch; no release was published.

## File ownership and order

Three passes avoid concurrent writers sharing files:

1. Parser lane: `src/markdown.rs`, new `src/markdown/` helpers if needed, a dedicated benchmark script. Native lane in parallel: `src/main.rs`, `src/document.rs`, new `src/renderer.rs`, `build.rs`, application permissions, `capabilities/main.json`, `tauri*.conf.json`. No parser edits in native lane.
2. Designer owns app UI integration: `ui/app.js`, `ui/core.js`, `ui/preview.js`, `ui/theme.js`, `ui/index.html`, optional helper scripts, `ui/styles.css`, picker UI tests. Renderer specialist separately owns `ui/mermaid-renderer.html`, renderer-only JS, and a dedicated renderer security test. Both use the agreed transport established in pass 1.
3. Reconcile, targeted corrections, documentation from content owners, then parent runs one full validation pass. No release, signing, or updater work.

If parser-lane changes alter the render return type, retain compatibility wrappers until native/UI consumers are updated sequentially. No silent source truncation.

## Task 1: Source-map and task integrity (parser lane)

Files: `src/markdown.rs`, optional focused `src/markdown/*.rs` helpers; tests colocated with existing Markdown tests.

- [ ] Add a regression using the proven bypass, with an actual task sharing its forged location:

```rust
let source = "<ul>\n<li/data-sourcepos=\"6:1-6:15\"><input type=\"checkbox\" disabled></li>\n</ul>\n\n\n- [x] Real task\n";
```

Assert the raw checkbox has no generated task index, the real task has index zero, and task toggling changes only the real Markdown task. Include slash/newline/mixed-case variants and non-checkbox inputs.
- [ ] Run `cargo test markdown::tests -- --nocapture`; establish the new spoof regression fails on current code.
- [ ] Parse/normalize author HTML attributes before removing all editing markers; attach generated markers only afterward. Restrict document inputs to checkbox type.
- [ ] Build one source line-start index and pass it into node/source-range construction. For one-based positions, use checked `starts.get(line - 1) + column - 1`; validate UTF-8 boundaries before slicing.
- [ ] Add tests for empty input, last line without newline, Unicode bytes, CRLF-normalized content, front matter, and nested list ranges.
- [ ] Rerun only Markdown tests; record before/after evidence. Do not run the full suite.

## Task 2: Resource budgets (parser lane)

Files: `src/markdown.rs`, optional budget helpers, `scripts/benchmark-render.cjs`.

- [ ] Introduce centrally defined limits matching the specification: 200,000 lines/nodes, blockquote depth 128, HTML 64 MiB, 200 local image occurrences, total encoded local images 32 MiB. Retain 20 MiB document and 10 MiB per-image limits.
- [ ] Add tests with small injectable limits for lines, nesting before parse, AST work, HTML writer capacity, image count/output bytes, repeated images, and files that grow after metadata checks.
- [ ] Establish failures before adding implementation with `cargo test markdown::tests`.
- [ ] Add linear preflight checks, bounded output writer, bounded file reads, and canonical-path image caching. Count repeat output bytes, not just unique cached bytes. Apply complexity checks to task parsing too.
- [ ] Preserve the render API where feasible; expose readable preview-limit diagnostics without losing source. If an API change is unavoidable, publish exact shapes to the native/UI lanes before they edit consumers.
- [ ] Run focused tests and build the fixture. Benchmark release fixture input with 500/1k/2k/4k/8k/16k short paragraphs and 10k/20k/40k nested blockquotes. The latter must fail cheaply with a complexity message; record scaling rather than imposing millisecond CI thresholds.

## Task 3: Native boundaries, picker, directory limits, and build hygiene (native lane)

Files: `src/main.rs`, `src/document.rs`, new `src/renderer.rs`, `build.rs`, optional `permissions/*.toml`, `capabilities/main.json`, `tauri.conf.json`, `tauri.macos.conf.json`.

- [ ] Define and test picker serialization:

```rust
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum PickerKind { File, Folder }
#[derive(serde::Serialize)]
struct PickedTarget { path: String, kind: PickerKind }
```

Command `pick_open_target(kind, start)` is an off-main-thread command returning `Result<Option<PickedTarget>, String>`. Reuse Rust dialog plugin; no JS dialog/fs capabilities. File extension filter is md/markdown/mdown/mdtxt. Invalid/missing initial directories fall back; `None` means no state mutation.
- [ ] Define renderer transport before UI writers start: main-only request command submits `{id, source, theme}` with length/type checks; renderer-only result command accepts only an outstanding ID, bounded SVG or structured failure. Native dispatch routes events only to the intended webview. Publish exact command/event names and payloads in the plan execution notes.
- [ ] Protect every existing application command using an explicit ACL or native caller-label gate. Main webview label is `main`; renderer label is distinct. No main-window-wide grants may leak to renderer. The renderer gets only its result transport, not file/document/dialog/opener commands.
- [ ] Add native tests for allowed/denied caller identities, request ownership, unknown IDs, oversized results, duplicate/stale results, and cleanup. A denied request must fail before protected command work or filesystem mutation.
- [ ] Configure a renderer-only CSP with external images/connections/fonts/styles blocked and bundled scripts allowed. Avoid granting global Tauri privileges for convenience. Keep main-document remote image behavior unchanged.
- [ ] Bound directory `read_dir` iteration before sorting/filtering, with injectable per-directory limits. Add `truncated` to Folio browser listing, preserve folder listing fields, and count non-Markdown/skipped entries toward work.
- [ ] Add macOS PNG alongside ICNS; fix Unix-only mutable builder warning without suppressing unrelated warnings. Mark task parsing off-main-thread, coordinating signature changes with parser lane.
- [ ] Run focused directory/native/permission tests plus format checks for owned files. Validate configuration and permissions using Tauri's build tooling. Cross-OS checks remain a CI/manual requirement, not a Linux claim.

## Task 4: Offline renderer and security regression harness (renderer lane, after task 3)

Files: new `ui/mermaid-renderer.html`, new renderer script, new `tests/mermaid-security.cjs`. Native follow-ups to `src/renderer.rs` only after the native lane is terminal.

- [ ] Create a deterministic browser harness with mock transport and intercepted/aborted external requests. Use the actual vendored Mermaid, not a replacement renderer.
- [ ] Assert no network requests for `flowchart TD\n A[\"<img src='https://example.com/label.png'>\"]` and image-node metadata, including refresh/repeat requests. Confirm the regression fails against the existing in-main renderer.
- [ ] Load Mermaid only in the separately labelled renderer document. Apply strict offline CSP before any Mermaid code executes. Return bounded SVG or structured error by task 3 transport; enforce request serialization/cancellation.
- [ ] Add structured SVG sanitization before parent insertion: remove external image href/src and network-bearing CSS references, event handlers, scripts, foreign navigation, and unsafe URL schemes. Do not rely on string patterns as the network boundary.
- [ ] Test payload validation, stale IDs, malformed SVG, fallback, repeated rendering, and ordinary math/diagram compatibility. Renderer attempts to invoke file/native commands must be denied before native bodies run; document which tests require real Tauri rather than browser mocks.
- [ ] Run `node tests/mermaid-security.cjs` and owned focused tests. Record browser/CSP limits; do not report mocked IPC as real native proof.

## Task 5: Picker and preview UI integration (designer, after tasks 1–3)

Files: `ui/app.js`, `ui/core.js`, `ui/preview.js`, `ui/theme.js`, `ui/index.html`, `ui/styles.css` only where necessary; `tests/ui-smoke.cjs`, `tests/lazy-assets.cjs`, dedicated picker test if clearer.

- [ ] Add failing mocked tests for missing/invalid preference, persistence, all Open entry points, native file/folder/null results, dirty prompt cancellation, and repeated native launches.
- [ ] Normalize `preferences.get('filePicker', 'folio')` to `folio` or `native`. Add dynamic `Use system file picker` / `Use Folio file picker` and always-visible `Open folder…` palette entries using current visuals.
- [ ] Route toolbar/welcome/palette/Ctrl-Cmd+O consistently. Native mode uses file dialog for Open and folder dialog for Open folder. Save dialogs do not change. Serialize native picker/open once, with no nested enqueue and no document mutex across the modal.
- [ ] Keep selection-first unsaved semantics. On `null`, return without recents/doc/open mutations. After selection, call existing protected open functions with `confirmed=false`. Clear stale Folio row selection when typing a path; add the regression.
- [ ] Consume truncated listing flags and preview complexity diagnostics with existing feedback styles. Display source-retaining preview-unavailable state rather than stale preview; normal edits/saves remain available.
- [ ] Replace main-page Mermaid execution with the task 3 transport, keeping lazy loading, cache generation checks, theme refresh, source fallback, and bounded results. Load renderer lazily; no renderer startup on plain documents. Use sanitized SVG handoff from task 4.
- [ ] Run owned picker/UI/lazy checks, not the full suite. Give parent exact changed files, test results, and remaining native limitations.

## Task 6: Reconcile and final verification (parent)

- [ ] Read all diffs; reject unrelated extras and check each approved spec section against artifacts. Correct shared-file issues only after owners finish.
- [ ] Add dedicated new tests to package scripts and CI once their filenames are final. Keep main/renderer permissions and event names consistent.
- [ ] Update README and manual verification with budgets, picker choice, offline Mermaid limitations, native IPC denial checks, and platform caveats. Reuse authors holding the relevant context.
- [ ] Run once after reconciliation:

```sh
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
npm run test:paths
npm run test:ui
cargo build --locked --example editor-fixture
node tests/live-editor.cjs
node tests/mermaid-security.cjs
```

- [ ] Perform the available real Tauri renderer/IPC test path on Linux; if display/runtime prevents it, report the exact unmet check and do not claim native isolation verified. Keep Windows/macOS matrix validation explicitly pending until run there.
- [ ] Check `git diff --check` and branch/status; leave changes on `feat/production-foundations`. Do not publish releases or push without instruction. Group any commits by independently verified pass, not before its focused tests pass.

## Evidence ownership and stopping rule

Parser lane establishes source/task integrity and bounded algorithms. Native lane establishes caller gates, off-main-thread APIs, bounded enumeration, and build config correctness. Renderer lane establishes browser network behavior and transport policy; designer establishes picker/preview usability. Parent establishes integrated regression results and reports untested native platforms. Mocked browser tests cannot establish Wry IPC isolation. Stop once the approved scope is met; move release/accessibility backlog items to later work.
