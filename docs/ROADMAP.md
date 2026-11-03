# Roadmap

Known future work, extracted from the historical editor handoff and the
performance audit. This is a working list, not a release commitment. See
[ENGINEERING-NOTES.md](ENGINEERING-NOTES.md) for the architecture and
[performance-results.md](performance-results.md) for current measurements.

## Correctness and data safety

- [ ] Add an ACL-manifest guard test that compares the command lists in
  `src/main.rs` (`generate_handler!`), `build.rs` and `capabilities/main.json`.
  This is the highest-value missing test: browser suites stub IPC and cannot
  catch a denied native command.
- [ ] Audit source/caret/scroll mapping for repeated text, nested lists, atoms,
  unusual whitespace and backward or cross-table selections. The ledger is
  source-aware, but exactness is not proven for every dialect construct.
- [ ] Extend exact source-first coverage beyond plain-text clipboard payloads:
  HTML-rich clipboard writes, browser replacement/autocorrect, drag/drop and
  native composition.
- [ ] Keep round-trip fixtures expanding with Comrak extensions, inline HTML,
  footnotes, definition lists and nested structures. Editing a rich block may
  canonicalize that block's syntax; whole-file byte preservation is not implied.

## Platforms and input

- [ ] Native WebKit/Tauri testing for IME composition, clipboard, keyboard-only
  use, touch and Windows/macOS behaviour. Chromium browser tests do not establish
  those platform claims.
- [ ] Keep the optional native IME check (`npm run test:native-ime`, fcitx5/mozc)
  separate from the default gate because it needs a configured engine.
- [ ] Re-check the real-Wayland/GPU first-paint and theme paths with on-machine
  profiling; the available native tests run under Xvfb/X11.

## Large documents

- [ ] Profile large-document memory, statistics/dirty tracking and incremental
  decoration updates. Tune or document the 2 MiB rich-editor threshold rather
  than treating it as a measured universal limit.
- [ ] Address the third-party quadratic serializer cost for structural edits and
  save-time serialization on very large documents.
- [ ] Revisit visible-range source decorations only as a deliberate
  `ViewPlugin` refactor; a `StateField` cannot see `view.visibleRanges`.

## Markdown coverage

- [ ] Harden math delimiter and currency parsing.
- [ ] Review rich code-block highlighting and extension/footnote navigation.
- [ ] Broaden extension coverage for footnotes, definition lists and other
  Comrak constructs that currently fall back to source projections.

## Media

- [ ] Extend image lifetime/cache/budget tests, including duplicate images,
  cancellation and failed loads under stricter per-call limits.
- [ ] Keep remote-image consent and native sanitization boundaries covered when
  touching preview rendering.

## Accessibility

- [ ] Do a formal focus-indicator audit across the whole interface, including
  contextual table controls, dialogs and generated overlays.
- [ ] Document richer table selection/Enter behaviour and check narrow-screen
  toolbar layout.

## Release engineering

- [ ] Review bundled dependency licenses, reproducible assets, packaging and
  signing before distribution.
- [ ] Ensure release bundles do not include test output, local screenshots or
  development-only artifacts.
- [ ] Keep `npm run check:editor-bundle`, Rust formatting/tests/Clippy and the UI
  suites in the release gate; browser tests alone are not native acceptance.

## Performance follow-ups

- [ ] Only pursue bundle trimming if HTML/CSS/JavaScript code highlighting is
  preserved and measured.
- [ ] Add native cancellation only with a defined stale-result contract; the
  frontend already discards superseded renders.
- [ ] Re-benchmark already-optimized startup, cache, outline and scroll paths
  before changing them.
