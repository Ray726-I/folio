# Incremental parsing: design

Status: **implemented** in `ui/editor/source-edits.js` (`tryIncremental`,
`shiftModel`). Measured below; the guards listed under "Preconditions" are the
ones the fuzzer and suites forced. Companion to
`docs/superpowers/plans/2026-11-01-single-formatted-editor.md` (Stage 3.1) and
`docs/editor-migration-report.md` (known limitation 1).

## Why

Measured in the browser, from keydown to canonical Markdown write
(`npm run bench:keystrokes`):

| Document | median ms/key |
|---|---:|
| 10 KB | 8.8 |
| 50 KB | 26.6 |
| 100 KB | 55.7 |

Node-level `parseSource` at the same sizes is 7.9 / 29 / 55 ms, so the keystroke
cost *is* the parse. At 100 KB the breakdown is roughly: markdown-it tokenize
21 ms, ProseMirror parse 21 ms, `buildLedger` 13 ms. The ledger's quadratic
scans were removed separately; what remains is inherent to re-deriving the whole
document from the whole source on every character.

Target: ≤ 8 ms at 100 KB for ordinary text edits, with no loss of exactness.

## Current flow (the part that must change)

`ui/editor/source-edits.js#tryTextEdits`, per step:

1. `sourcePatchFor(ledger, step)` → exact source interval + owner.
2. `applySourcePatches(ledger, …)` → new source, validating the exact bytes it
   replaces (`expected`).
3. `parseSource(patched.source)` → **the expensive step**; produces `doc`,
   `segments`, `gaps`, `ledger`.
4. `parsed.doc.eq(applied.doc)` → the verification that source and document
   agree.
5. `rebaseLedger` → owner nodes re-bound to the intended doc.

The parse does two distinct jobs: it builds the derived structures (3) and it
*verifies* the splice (4). An incremental path must keep (4)'s guarantee while
skipping (3)'s full cost.

## Fast path

Applies only when all of the following hold; otherwise fall through to the
existing full parse (unchanged behaviour):

- exactly one step, `stepType === 'replace'`, no `structure`, text-only slice;
- the patch maps to a single owner whose type is in `TEXTBLOCK_TYPES`;
- the edit lies entirely within one **linear** run of that owner
  (`run.linear === true`, no charMap), so positions map by offset;
- the inserted text contains no character that can change block structure at
  that position: no newline, and none of `# > - + * _ \` | ~ [ ] ( ) < & !`
  unless the position is strictly inside a run (not at a line start);
- the source interval replaced is not at a block boundary.

When it holds, build the model without parsing:

```
doc      = applied.doc                       // ProseMirror already has it
source   = patched.source                    // splice validated by step 2
segments = shiftSegments(previous.segments, patch, deltaSource, doc)
gaps     = previous.gaps                     // inter-block text is untouched
prefix   = previous.prefix
ledger   = shiftLedger(previous.ledger, patch, deltaSource, deltaPm, doc)
```

`shiftLedger` must, for every owner, run, and ledger gap:

- positions entirely after the edit shift by `deltaPm` / `deltaSource`;
- positions entirely before are unchanged;
- the edited run's `pmTo`/`sourceTo` shift, and `text` gains the inserted slice
  (its `charMap` stays `null` because linearity is preserved);
- owner nodes are re-bound with `doc.nodeAt(owner.pmFrom)`;
- any structure whose invariants cannot be re-established returns `null`, which
  sends the caller down the full-parse path.

Expected cost: two O(runs) passes with no tokenizer, no ProseMirror parse.
At 100 KB that is single-digit milliseconds.

## Why this is safe enough to attempt

Two properties bound the damage:

1. **The splice is still byte-validated.** `applySourcePatches` rejects a patch
   whose `expected` slice does not match. A stale or wrong ledger therefore
   *fails*, it does not write into the wrong place.
2. **The fast path is opt-in per edit.** Any doubt (structural step, non-linear
   run, boundary edit, ambiguous owner) falls back to today's exact path.

The residual risk is a *shift that passes validation but is subtly wrong* — for
example with repeated text, where a wrong range can still contain the expected
bytes. That is what the test plan below is for; it must be adversarial.

## Test plan (gate for shipping)

1. **Differential fuzzing (the core gate).** Already seeded:
   `tests/editor-source-edits-fuzz.cjs` runs 400 deterministic random cases over
   ten adversarial documents. For every accepted edit it asserts two things:

   - the produced source re-parses to the produced document (327 accepted, 73
     fallback), and
   - the returned ledger's runs, owners and segments agree **position for
     position** with a fresh parse of that source.

   The second assertion is the one an incremental path would break: source
   correct, mapping stale. Both were proven to have teeth by mutation — a
   corrupted source and a single one-position ledger shift each fail on
   iteration 0.

   The full harness generates random
   documents (repeated paragraphs, repeated inline syntax, nested lists,
   tables, escapes, entities, CRLF, Unicode) and random edits (insert/delete at
   random offsets, including boundaries). For each edit it computes the model
   twice — once through the fast path, once through the full parse — and asserts
   deep equality of `source`, `doc`, `segments`, `gaps` and the ledger's
   `owners`/`runs` positions. Any divergence fails with the seed and document.
2. **Exactness**: the existing `editor-source-edits.cjs` suite must pass
   unchanged; it already covers escapes, entities, repeated occurrences,
   delimiter spelling and multi-step transactions.
3. **Round-trip**: `editor-roundtrip-regressions.cjs` and
   `editor-stored-mark-roundtrip.cjs` unchanged.
4. **Benchmark**: `bench:keystrokes` must show ≤ 8 ms median at 100 KB and no
   regression at 10 KB; `bench:editor` must not regress.
5. **Native**: `FOLIO_NATIVE_PROBE` and the XTest keyboard walkthrough.

## Rollout

Land behind a constant (`INCREMENTAL_EDITS = true` in `source-edits.js`) so it
can be switched off in one place if the fuzzer finds a counterexample in the
field. Remove the switch only after the differential fuzzer has run clean over a
large seed corpus in CI.

## Effort

Roughly a day of focused work: `shiftLedger`/`shiftSegments` (~120 lines), the
differential fuzzer (~150 lines), and the iteration needed to make the fuzzer
pass on adversarial documents. The fuzzer is the bulk of the value — it is what
turns "probably correct" into evidence.


## What the implementation actually guards (all found by testing)

The first version was too optimistic. Each of these was a real failure caught by
the differential fuzzer or the browser suite, and each is now a fallback
condition:

| Failure | Guard |
|---|---|
| Insertion at a run start treated as "after the edit" | the edited run is chosen by the **verified source offset**, not by position alone |
| Space typed at a list item's text edge swallowed by marker padding | whitespace at a run edge falls back |
| Typing after `**bold**` carried a stored mark | any **marked insert** falls back |
| Typing inside bold with bold off needs `**H**X**ello**` | any **marked neighbour** falls back |
| Typing into a zero-length paragraph run | empty runs fall back |

The result is deliberately conservative: **plain text in an unmarked context**
takes the fast path; anything involving marks, block edges or empty runs parses
fully. That is the common typing case, and correctness is never traded for it.

## Measured result

`npm run bench:keystrokes` (browser, keydown → canonical Markdown write):

| Document | before | after |
|---|---:|---:|
| 10 KB | 8.8 ms | **1.9 ms** |
| 50 KB | 26.6 ms | **5.5 ms** |
| 100 KB | 55.7 ms | **9.6 ms** |

`npm run bench:editor` (node `parseSource`) is unchanged, as expected: the fast
path avoids the parse rather than making it cheaper.

Gates: full editor chain exit 0 (bundle check + 7 unit incl. the 400-case fuzz +
38 browser files), UI suites exit 0, native WebKit probe PASS, native XTest
keyboard PASS.
