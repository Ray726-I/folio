# Foundations validation

Branch: `feat/production-foundations`. Local platform: Linux x86_64.

Status: integrated baseline passed. Security review subsequently found a
quoted-CSS URL bypass and renderer lifecycle races; the reported cases were
corrected, with targeted checks and the real Linux probe independently rerun.
The original baseline alone did not cover these cases. All known review blockers
within the approved scope are resolved; cross-platform evidence remains pending.

## Integrated automated checks

All commands below returned zero after writer reconciliation:

- `cargo fmt --all -- --check`
- `cargo test --locked`: 77 tests passed.
- `cargo clippy --locked --all-targets -- -D warnings`
- `npm run test:paths`: 12 tests passed.
- `npm run test:ui`: lazy assets, UI smoke, picker, preview limits, offline
  renderer security, and main-page renderer bridge passed.
- `cargo build --locked --example editor-fixture`
- `node tests/live-editor.cjs`: real-parser editing/history/save checks passed.
- `cargo build --locked`
- `cargo check --locked --release`
- `git diff --check`

After the final native corrections, targeted revalidation also returned zero:
21 renderer tests, three lifecycle/concurrency tests, all-target Clippy, formatting,
browser renderer-security and bridge tests, debug build, the actual Linux native
probe, release-mode compilation, and diff whitespace checking. The quoted URL
regression inserts actual native-sanitized output under main-equivalent CSP.
Unaffected parser, picker, and source-editor evidence from the integrated pass
remains applicable; the final native changes did not modify those modules.
The last lifecycle regression ensures a stale missing-window observation cannot
reset an already-ready replacement and cause `NotDispatched`. Its correction was
checked independently with all three lifecycle tests, 21 renderer tests,
all-target Clippy, formatting, release compilation, a fresh debug build, and
another successful real native probe.

## Privacy and native boundaries

Browser security tests intercepted and aborted external requests:

- Offline renderer: zero external requests.
- Trusted-sanitized SVG inserted under main-equivalent CSP: zero requests.
- Unsanitized adversarial control: one intercepted request, proving sensitivity.
- Permissive renderer control: two intercepted requests.

The real Linux Tauri/WebKitGTK probe ran under isolated D-Bus and Xvfb:

```sh
timeout 180s dbus-run-session -- xvfb-run -a env \
  GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  TMPDIR=/tmp/opencode FOLIO_NATIVE_PROBE=1 ./target/debug/folio
```

Exit zero, `FOLIO_NATIVE_PROBE_PASS`. Renderer attempts at protected commands were
denied by actual application ACL; main and other fixture files remained unchanged.
Flow, sequence, pie, and class diagrams completed sanitized round trips. An active
hung renderer was cancelled; immediate retry received a restarting error, then
succeeded after recreation. The isolated session emitted desktop-portal,
accessibility-bus, and software-rendering warnings; the probe itself passed.

## Performance evidence

Release parser benchmark from the final parser lane: 500 through 16,000 short
paragraphs scaled approximately 1.7–2.1x per doubling; 16,000 took approximately
383 ms on the local machine. Nested blockquotes at 10k/20k/40k were rejected in
approximately 5–14 ms. Parent independently checked container-escape rejection,
valid list-fenced code, unclosed top-level fences, and preserved inline HTML.
These timings are local measurements, not cross-machine service guarantees.

## Remaining evidence and scope limits

- Windows/macOS CI, real native dialogs/webviews, installers, and file associations
  still require validation on those platforms.
- Xvfb/X11 results do not establish Wayland behavior or accessibility quality.
- Native picker UI behavior is covered by mocked browser tests and Rust helper
  tests; hands-on system-dialog validation remains in the manual checklist.
- macOS application Quit, automatic recovery after forced termination, extended
  save metadata, signing, release publishing, updates, and broad accessibility
  remediation were not part of this implementation.
- Preview structural checks intentionally prefer a source-preserving diagnostic
  over accepting ambiguous extreme indentation/container combinations.

Do not describe this foundations pass as an all-platform production release.
