# Performance measurements — final implementation

Measured on 2026-11-03 (Asia/Kolkata), on `codex/experiment`; changes are uncommitted. This report supersedes the first implementation comparison: that iteration still rejected independent edits whenever an unrelated block had a partial mapping. The final comparison includes the owner-local eligibility, validated boundary affinity, and narrow plain-paragraph proof.

## Outcome

| 100 KB scenario | Baseline source p95 (ms) | Final source p95 (ms) |
|---|---:|---:|
| interior | 85.6 | 13.8 |
| boundary | 121.1 | 11.9 |
| punctuation | 70.1 | 17.8 |
| backspace | 69.9 | 15.9 |
| marked | 67.1 | 15.8 |
| unicode | 62.8 | 18.8 |
| composition | 63.3 | 16.4 |

Ordinary 100 KB typing median/p95 is 11.0/13.8 ms, against provisional goals of 8/16 ms. This is canonical source publication, not presentation latency. Small samples and host scheduling limit precision; some cases and the 250 KB stress workload still exceed the goals.

| Interaction work | Baseline | Final |
|---|---:|---:|
| tables150: diagnostic rectangle reads | 2772 | 277 |
| tables500: diagnostic rectangle reads | 8721 | 274 |
| headings300: outline refresh p95, ms | 6.9 | 1.8 |
| headings1000: outline refresh p95, ms | 24.4 | 4.0 |

Mixed scroll/drag/resize workloads still contain long tasks and missed headless frames. These changes do not establish that native resizing or GPU scrolling is resolved. No animation, typography, or containment changes were justified by the available native evidence.

## Environment and method

Environment: 13th Gen Intel(R) Core(TM) i5-13500H; linux 7.2.14-1-omarchy; Node v26.13.0; Chromium 151.0.7922.34. Production editor bundle, file-based shell, mocked Tauri bridge and real Rust fixture renderer; viewport 1180×900. Physical refresh rate is unknown.

Run `npm run bench:keystrokes` and `node scripts/bench-interactions.cjs` separately, after building the editor bundle. Both emit JSON to stdout and progress to stderr. Chromium required sandbox escalation in this environment. Fixture/native export: `node scripts/bench-interactions.cjs --write-fixtures /tmp/folio-native-fixtures`. Corrected lifecycle-only diagnostics use `node scripts/bench-interactions.cjs --lifecycle-only`. An individual interaction fixture can be selected with `--fixtures tables150,tables500`. A separate bounded typing stress run uses `node scripts/bench-keystrokes.cjs --sizes 250 --chars 8 --warmup 2`.

Typing uses three warmups followed by 12 accepted edits for each scenario at each size. Stress uses two warmups and eight accepted edits. Each size starts a fresh browser; scenarios run in the reported order against that document. Plain and marked interiors, the end of a plain text run, alternating space/period, Backspace, Unicode insertText and synthetic composition are reported separately. Editing is near the beginning of the document. These fixtures do not model every syntax boundary.

Canonical publication is measured in-page with a minimal `current.content` setter hook; it includes that hook but no geometry/trace instrumentation. Keyboard scenarios report keydown→source and beforeinput→source. Unicode and composition insertText have no keydown, so that column is empty. Synthetic compositionstart/end wrap browser insertText: this is a composition-path probe, **not an OS IME measurement**. Candidate windows, composition updates and native language input remain untested.

Beforeinput→double-rAF is only a frame approximation: rAF executes before paint. It is not input-to-paint, EventTiming presentation data, GPU presentation, or native frame latency. The finalized harness also records supported EventTiming durations with a 16 ms threshold. These browser-rounded event→next-render estimates include warmup events, are not necessarily one entry per edit, and do not provide native presentation timestamps. Native presentation measurement remains open. Median below is the upper middle sample, p95 uses nearest rank, and worst is the maximum. Small samples give indicative distributions, not robust hardware-independent latency guarantees.

Interactions use actual browser pointer moves, wheels, pointer capture on the contents divider, and browser viewport resizing, paced by rAF. Each fixture runs one warmup workload and one measured workload; frame sample counts are reported. Work includes cells/prose/gutters, preview scrolling, outline nested scrolling, sidebar dragging, viewport changes and a nested code pane wheel when mounted. The 300/1,000-heading fixtures collapse their top branch before the workloads. The 150/500-table fixtures have identical table/prose repetition. The media fixture includes long code, math and a blocked remote image; it does not measure image downloads/decoding.

A fresh browser runs a separate diagnostic pass with geometry instrumentation and a DevTools timeline trace. Rectangle counts include the harness's few setup reads. FunctionCall and EventDispatch durations are diagnostic samples, not isolated application handler costs or CPU percentages; trace events may nest. Layout and style recalculation distributions are recorded separately. Do not sum nested durations. Timed frame samples include no geometry wrapper or tracing. Long tasks use the browser >50 ms observer definition. A separate fresh-browser lifecycle pass runs 10 prose document replacements and five tables150 replacements, with 550 ms settling, forced Chromium GC, JS heap/DOM/listener counters and overlay counts. These bounded diagnostics include bridge/harness retention and do not prove the absence of leaks. Browser close/reopen retention, native resident memory and clean app-open latency are unmeasured.

## Capture provenance

Baseline uses an untouched UI snapshot captured before implementation. Final after reports were run sequentially with builds/tests paused, after the last application change. Baseline and after use identical fixtures and harness timing methods. Native performance is not inferred from these browser results.

| Phase | Typing start UTC | Interaction start UTC | Bundle SHA256 |
|---|---|---|---|
| Baseline | 2026-11-02T20:55:01.134Z | 2026-11-02T20:58:27.925Z | 62110256ebb5d89dcbdf58be6470c5d75943bc27c3c4a395a7f171c103a41b2d |
| Final | 2026-11-02T21:17:16.601Z | 2026-11-02T21:17:37.903Z | bf5c2a0bb074578ee894e67d387998176b3a7e67fc6745bfa01cfed2f5694abe |

## Typing comparison

All times are median/p95/worst in milliseconds. Normal rows have 3 warmups + 12 timed samples; 250 KB rows have 2 + 8. Synthetic composition is not OS IME. EventTiming thresholded/rounded distributions and sample counts are preserved in the raw JSON; double-rAF remains a frame approximation.

| KB | Scenario | Baseline beforeinput→source | Final beforeinput→source | Final beforeinput→double-rAF |
|---:|---|---:|---:|---:|
| 10 | interior | 12.7/20.8/20.8 | 4.3/5.0/5.0 | 26.1/28.7/28.7 |
| 10 | boundary | 15.4/26.0/26.0 | 4.1/4.8/4.8 | 26.7/27.8/27.8 |
| 10 | punctuation | 14.3/18.5/18.5 | 3.7/4.0/4.0 | 27.1/28.1/28.1 |
| 10 | backspace | 13.2/17.9/17.9 | 3.7/4.9/4.9 | 26.8/27.5/27.5 |
| 10 | marked | 13.1/19.6/19.6 | 3.8/4.5/4.5 | 27.2/27.5/27.5 |
| 10 | unicode | 12.3/17.5/17.5 | 4.2/5.0/5.0 | 27.6/28.9/28.9 |
| 10 | composition | 11.4/14.5/14.5 | 4.1/5.0/5.0 | 26.8/29.3/29.3 |
| 50 | interior | 29.4/39.7/39.7 | 9.0/12.2/12.2 | 27.6/28.7/28.7 |
| 50 | boundary | 42.9/56.5/56.5 | 9.1/9.9/9.9 | 27.8/30.1/30.1 |
| 50 | punctuation | 25.2/29.9/29.9 | 8.9/9.3/9.3 | 27.4/28.0/28.0 |
| 50 | backspace | 26.4/33.6/33.6 | 8.9/9.2/9.2 | 27.1/30.5/30.5 |
| 50 | marked | 26.6/36.6/36.6 | 9.0/9.3/9.3 | 27.5/27.9/27.9 |
| 50 | unicode | 25.3/41.0/41.0 | 10.5/11.1/11.1 | 27.9/30.2/30.2 |
| 50 | composition | 30.2/42.8/42.8 | 10.5/11.9/11.9 | 27.2/30.3/30.3 |
| 100 | interior | 63.3/85.6/85.6 | 11.0/13.8/13.8 | 28.9/30.8/30.8 |
| 100 | boundary | 88.2/121.1/121.1 | 10.9/11.9/11.9 | 28.7/29.8/29.8 |
| 100 | punctuation | 53.6/70.1/70.1 | 11.6/17.8/17.8 | 29.4/30.4/30.4 |
| 100 | backspace | 57.0/69.9/69.9 | 12.4/15.9/15.9 | 29.1/30.2/30.2 |
| 100 | marked | 54.8/67.1/67.1 | 12.5/15.8/15.8 | 29.3/30.8/30.8 |
| 100 | unicode | 50.8/62.8/62.8 | 12.8/18.8/18.8 | 29.3/30.5/30.5 |
| 100 | composition | 56.2/63.3/63.3 | 12.5/16.4/16.4 | 29.4/30.4/30.4 |
| 250 | interior | 142.0/176.4/176.4 | 18.8/26.1/26.1 | 30.2/37.4/37.4 |
| 250 | boundary | 323.0/415.4/415.4 | 19.8/20.7/20.7 | 32.0/41.5/41.5 |
| 250 | punctuation | 125.2/130.9/130.9 | 18.6/25.8/25.8 | 29.9/38.5/38.5 |
| 250 | backspace | 131.4/188.4/188.4 | 16.4/16.8/16.8 | 28.0/31.4/31.4 |
| 250 | marked | 140.4/177.6/177.6 | 16.4/16.6/16.6 | 30.7/31.4/31.4 |
| 250 | unicode | 181.6/218.8/218.8 | 21.0/26.0/26.0 | 32.0/38.6/38.6 |
| 250 | composition | 237.2/444.7/444.7 | 21.1/21.6/21.6 | 31.9/32.4/32.4 |

## Interaction comparison

One warmup and one timed real-input workload per fixture. Geometry/trace instrumentation runs separately. Values below are baseline → final. Trace callback samples can nest and are not CPU percentages.

| Fixture | Frame interval p95, ms | Long tasks count / worst ms | Rectangle reads | Layout p95, ms | Style recalculation p95, ms |
|---|---:|---|---:|---:|---:|
| prose | 33.4 → 33.3 | 10/108.0 → 8/63.0 | 49 → 49 | 10.1 → 8.1 | 38.9 → 34.6 |
| headings300 | 16.7 → 16.7 | 0/— → 0/— | 187 → 187 | 4.5 → 4.0 | 21.2 → 17.0 |
| headings1000 | 50.0 → 33.4 | 9/70.0 → 5/56.0 | 220 → 220 | 18.5 → 16.9 | 32.3 → 28.1 |
| tables150 | 16.8 → 33.3 | 1/56.0 → 2/62.0 | 2772 → 277 | 6.3 → 4.6 | 23.6 → 19.6 |
| tables500 | 50.0 → 50.0 | 15/77.0 → 15/73.0 | 8721 → 274 | 16.1 → 13.8 | 37.6 → 35.9 |
| media | 49.9 → 33.3 | 9/64.0 → 1/51.0 | 51 → 51 | 10.1 → 8.4 | 31.3 → 30.7 |


The 150-table single-workload frame-p95 result was repeated because it was worse despite lower geometry work. A separate sequential baseline/final run with three workload repetitions measured 16.8 → 16.8 ms p95 and 8327 → 834 diagnostic rectangle reads. Thus the one-workload frame regression did not reproduce in that check; neither run establishes native smoothness. Inter-repetition resets/settling are included in the repeated workload's frame distribution, so compare these two repeated captures with each other rather than with the single-workload rows.

## Outline and replacement diagnostics

Outline refresh: 10 warmups + 30 unchanged-document samples, no geometry wrapper/trace active; frame waits occur outside the measured call.

| Headings | Baseline median/p95/worst ms | Final median/p95/worst ms |
|---:|---:|---:|
| headings300 | 4.9/6.9/7.6 | 1.5/1.8/1.9 |
| headings1000 | 14.9/24.4/31.2 | 3.6/4.0/4.1 |

Lifecycle diagnostics use fresh sessions, a boolean wait predicate, 550 ms settling, and forced Chromium GC. Earlier diagnostics accidentally retained the editor through Playwright JSHandles; baseline interaction-file lifecycle blocks are superseded by standalone lifecycle reports. Only the corrected standalone runs below support retention comparisons. Bounded cycles are not proof of no leaks and do not measure native RSS.

| Phase / fixture | Replacements | Heap MiB first → last | DOM nodes first → last | Listeners first → last | Table overlay layers first → last |
|---|---:|---:|---:|---:|---:|
| Baseline prose | 10 | 8.62 → 9.25 | 19176 → 19219 | 257 → 265 | 1 → 1 |
| Baseline tables150 | 5 | 4.31 → 4.65 | 4566 → 4609 | 257 → 265 | 1 → 1 |
| Final prose | 10 | 8.62 → 9.29 | 19176 → 19219 | 257 → 265 | 1 → 1 |
| Final tables150 | 5 | 4.33 → 4.67 | 4566 → 4609 | 257 → 265 | 1 → 1 |

## Correctness and native acceptance

- Complete editor unit/fuzz and browser suites passed after the source edits; UI suite and new outline/table regressions passed. Accepted fuzz edits are compared to fresh document/ledger/mapping results. Numeric list triggers and newly trailing whitespace explicitly retain parser validation.
- `npm run check:editor-bundle` verifies generated assets match sources. `cargo build --locked --offline --release` rebuilt the final native binary.
- Debug and final release isolated WebKit keyboard smokes passed real XTest typing, exact saves, undo and reopen checks. XTest is synthetic OS input; this is not an OS IME or physical input test.
- Sysprof CPU capture was attempted without changing system permissions. All perf-event sampling streams were denied; eglinfo/glxinfo were unavailable. No usable native CPU/GPU presentation trace was obtained. Native Wayland scrolling, physical refresh pacing, real window resize, and OS IME acceptance remain unverified.
- Complex/multiline/reference-dependent edits, uncertain edited owners, and large formatted paragraphs can still need full parsing. Synchronous ledger rebasing still scales with document size. Browser distributions and headless frame results must not be advertised as universal or native frame guarantees.
- No commits, merge, push, or publication were performed.

## Raw reports

- [keystrokes-baseline.json](performance-data/2026-11-03/keystrokes-baseline.json)
- [keystrokes-after.json](performance-data/2026-11-03/keystrokes-after.json)
- [stress-baseline.json](performance-data/2026-11-03/stress-baseline.json)
- [stress-after.json](performance-data/2026-11-03/stress-after.json)
- [interactions-baseline.json](performance-data/2026-11-03/interactions-baseline.json)
- [interactions-after.json](performance-data/2026-11-03/interactions-after.json)
- [lifecycle-baseline.json](performance-data/2026-11-03/lifecycle-baseline.json)
- [lifecycle-after.json](performance-data/2026-11-03/lifecycle-after.json)

- [tables150-repeat-baseline.json](performance-data/2026-11-03/tables150-repeat-baseline.json)
- [tables150-repeat-after.json](performance-data/2026-11-03/tables150-repeat-after.json)
