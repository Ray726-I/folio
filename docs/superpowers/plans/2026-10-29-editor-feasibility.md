# Unified editor — Task 0 feasibility result

Date: 2026-10-29. Scope: isolated experiment only, no product integration.

## Decision: PARTIAL / NOT PASSED

CodeMirror 6 remains a promising candidate, not an adopted engine. The same-source input, presentation and history mechanisms are supported by evidence. The table experience and ordinary selection semantics do not yet satisfy the design. Keep product integration paused.

Implementation scratch: `/tmp/opencode/folio-editor-spike/`. This path is temporary; it is not part of Folio's shipping UI. Reproduction: `npm ci`, install the pinned Chromium if absent, then `npm test` from that directory. Source, lockfile, harness, tests, screenshots and raw results are retained there for a bounded follow-up. No Folio product package, lockfile, routing or tracked product code changed.

## What was actually verified

The parent reran `npm test`: **38/38 assertions passed across seven suites**, with no reported page errors or external runtime requests. This establishes the assertions in those tests, not a complete feasibility pass.

Supported observations:

- Real source-backed, editor-owned cell text; no nested contenteditable cell editors or raw-pipe-on-focus substitute.
- Pointer/keyboard selection can start inside cells, extend across cells and into surrounding prose, including backward selections.
- The same editor/history survives presentation toggles and ordinary typing/task edits.
- Inline/display TeX renders through local KaTeX and can be edited in the same source buffer; invalid TeX retains visible source.
- Exact snapshot reads the unsaved buffer; Lock blocks the exercised typing/API/keyboard/task paths.
- Editing a single cell leaves the second unusually spaced table, frontmatter and comment source untouched.

These do not establish production parser parity, all programmatic history guards, correct saved/dirty-state restoration, native-webview behavior or final table UX.

## Why the gate did not pass

### 1. Incorrect ordinary selection replacement

`src/editor.js` implements a structural transaction filter that preserves table pipes, alignment rows and surrounding newlines even when they lie inside an ordinary selected range. As a result, replacing prose through selected tables leaves table shells rather than replacing the complete selected interval. Select All/Delete must be able to empty the document.

The test named “replacement across cells is one contiguous source change” does not assert the exact expected replacement string. The implementation emits multiple changes around protected positions. The suite deliberately checks that table separator counts survive a whole-table selection, which tests a different behavior from the agreed continuous-document contract.

“Preserve untouched tables” does not protect selected tables. A separately exposed cell-range clear command could preserve structure; ordinary text selection must not silently act as that command. A/B is presentation, not a change in edit semantics. Invalidated Markdown should remain visible/editable rather than silently rejecting part of an edit.

### 2. Table geometry and navigation remain unproven

The designer inspected the harness and independently typed/selected in it. Direct cell input and continuous selection are real, but column boundaries are not aligned between rows. Long content wraps as a prose continuation, and End can move outside the last visible cell. Proper cell-aware movement and table wrap geometry are not demonstrated.

This is not merely branding or polish. A readable, editable table must scan and behave as a table. The harness is a useful line-preserving substrate, not yet that experience.

### 3. Performance evidence misses the proposed release target

Fresh parent run, Linux x86_64, Node 26.11.1, Chromium 151.0.7922.34, 16 CPUs / approximately 15 GiB RAM:

| Fixture | Measured result | Interpretation |
| --- | --- | --- |
| 8,000 paragraphs, approximately 686 KB | 359.7 ms startup; **149.2 ms keydown-to-paint p95**; 22 long tasks; 187,536,492 bytes JS heap | Misses proposed 100 ms typing target; full-decoration rebuild and scanning require investigation |
| 20 MiB source | Approximately 2.4 s mount in rich-disabled mode | Only demonstrates the spike's proposed safety fallback; not rich editing at this size |

The earlier implementer run reported approximately 92 ms p95; run-to-run variance is material. The test's performance PASS does not enforce the proposed release target. Do not substitute the much smaller transaction-listener-to-paint measurement for keydown-to-paint latency.

The fixed **2 MiB rich-decoration cutoff** is an experimental default, not an approved shipping policy. Large-document source fallback remains an explicit unapproved design exception.

### 4. Platform and fidelity limits

- Native Tauri/WebKit IME, touch and supported-platform clipboard behavior remain unverified. Synthetic Chromium composition plus insertion is only a smoke check.
- Math uses a bounded scanner, not a production Markdown math parser. It still materializes the complete buffer on edits in documents containing math.
- Dirty tracking in the spike is sticky after the first edit, not a proof that undo back to saved text becomes clean. Its lightweight shell does not establish production statistics/dirty integration cost.
- Fenced code and unsupported extension presentation remain incomplete; the spike is not full product parity.

## Recommended next experiment — requires approval

Update: the user authorized this single bounded follow-up after receiving the initial result. It is now complete in the same isolated scratch workspace; no product integration is authorized. The initial findings above are historical; the reconciled follow-up result follows below.

One bounded follow-up on the same source controller is justified, without product integration:

1. Replace blanket structural protection with ordinary interval replacement semantics. Add failing tests with exact expected source for cell-to-cell, cell-to-prose, prose-through-table, Select All/Delete and undo, in both A/B. Retain source after malformed structural edits rather than protecting it invisibly.
2. Demonstrate aligned columns and one explicit wrapped-cell strategy with editor-owned text. Validate pointer mapping, End/Home/Tab behavior and the same cross-cell/prose selection under that layout. Do not introduce nested editors, private view patches or a substantial custom selection engine without reporting that architectural cost.
3. Repeat the combined small-fixture gate and measure the real edit-to-paint path again. If geometry requires a workaround stack or selection semantics cannot be retained, stop and compare an alternative architecture.
4. Keep native IME and large-document policy explicitly unresolved. Do not call the whole gate passed while those claims are unverified.

Independent review: designer UX verdict PARTIAL; architecture review PARTIAL / NOT PASSED. No recommendation to adopt or reject CodeMirror solely on this first experiment.

## Bounded follow-up — final result: PARTIAL / NOT PASSED

The parent ran the integrated `npm test` once after writers froze their source: **69/69 assertions across 10 suites**, zero reported page errors or external runtime requests. `reports/results.json` records that run (finished `2026-10-29T18:41:52.331Z`). This count does not override the additional failures below.

### Improvements established

- Ordinary nonempty selection replacement now equals `before.slice(0, from) + insert + before.slice(to)` in both A and B. Select All/Delete empties the buffer. Undo restores exact source; selected table shells are no longer silently preserved.
- Malformed tables after legitimate source edits remain visible and editable.
- Home/End and Tab/Shift-Tab use ordinary editor selection transactions to traverse cell boundaries without a separate input owner.
- Plain small-table fixtures align through inline cell marks and computed margins. Long cell text uses an explicit horizontal-scroll strategy rather than wrapping as prose. No private editor-view patches or nested editors were introduced.

### Findings that prevent full acceptance

The independent architecture reviewer found rich-cell geometry and change-selection mapping failures. The parent independently reproduced these in focused browser diagnostics, without another suite run. Raw measurements are saved at `/tmp/opencode/folio-editor-spike/reports/parent-followup-diagnostics.json` (measured `2026-10-29T18:51:50.849Z`).

**Rich-cell geometry:** B mode, 1180×900 viewport, caret outside the table:

```markdown
Before.

| First | Second |
| --- | --- |
| CELL | target |
| plain | value |

After.
```

Corresponding separators should align within the suite's 2 px tolerance:

| CELL value | Maximum separator drift | Result |
| --- | ---: | --- |
| `one` | 0 px | Supported plain case |
| `**one**` | 38.375 px | Fails |
| Inline-code `one` (backticks included in source) | 21.59375 px | Fails |
| `$\frac{1}{2}$` | 109.984375 px | Fails |
| JavaScript `"word ".repeat(35)` | 1314.21875 px | Fails |

Cause: the layout measures source characters rather than rendered typography/widgets, clamps column widths while allowing unbounded cell content, then applies remaining width as margins (`src/editor.js:311–369,795–818`). Simple screenshots and first-column-start assertions did not prove downstream column alignment. Rich content and long content are core cases, not optional visual polish.

**Caret mapping:** the B-mode literal-pipe escape filter sets a new collapsed caret using an old-document offset (`src/editor.js:942–977`), rather than correctly preserving/mapping the caller's selection:

- Two changes—insert `PREFIX\n` at 0 and `|` at 198 with the caller's post-change selection—should map the escaped insertion caret to 207; actual caret is 200.
- With an existing caret at 1, changes-only API insertion of `|` at 198 should retain caret 1; actual caret jumps to 200.
- Ordinary keyboard typing `a|b` works; this narrower success does not establish multi-change/programmatic transaction correctness. The defect is in the spike filter, not evidence that CodeMirror's selection model itself fails.

**Performance:** the follow-up's 8,000-paragraph keydown-to-paint p95 is **105.9 ms**, still above the proposed 100 ms target, with 22 long tasks. The 1,000-table fixture measured 35.9 ms p95. Native IME, production math parsing, saved/dirty/statistics integration, supported-platform behavior and the unapproved rich/source cutoff remain open.

### Final recommendation and authorization boundary

Keep the accepted user experience. Stop extending the current margin-based rich-table approach: it has not established robust rich-cell geometry despite passing its current fixtures. CodeMirror remains a plausible source-backed foundation, but neither this table strategy nor the full engine gate is accepted.

Before another implementation phase, reassess a principled table layout/input mapping against an established table-capable document editor, including the exact-source-preservation trade-off. Do not continue a workaround stack or silently downgrade tables to source-only editing. A new experiment or controlled integration phase requires separate authorization. No product integration, shipping fallback policy or dependency addition to Folio has been authorized.
