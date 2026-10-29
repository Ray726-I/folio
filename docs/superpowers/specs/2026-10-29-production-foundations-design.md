# Production foundations and picker choice

Status: approved by the user. Branch: `feat/production-foundations`.

## Intent and scope

Prepare Folio for broad Windows, macOS, and Linux use, starting with privacy,
editing integrity, bounded resource use, and build portability. Add the user's
requested choice between the Folio picker and the operating system picker.
Keep Rust/Tauri, the plain-JavaScript UI, offline rendering, and existing saves.

User decisions: foundations first; offer both pickers; use a new feature branch.
Defaults and numerical budgets below are proposed engineering decisions, not
requirements supplied by the user.

Not in this batch: release publishing, signing, notarization, automatic updates,
new OS/architecture promises, full accessibility redesign, macOS quit recovery,
external-change banner redesign, or metadata-fidelity changes to atomic saves.
No promise of zero edge cases or safety against forced process termination.

## 1. Remote-image privacy

Opening untrusted Markdown with remote images blocked must issue zero external
image requests, including during Mermaid rendering and theme refresh.
`mermaid.render` can request images before returning SVG; post-render cleanup
and source-string heuristics are not adequate primary boundaries.

Use a separately labelled, app-owned renderer webview with a restrictive CSP
that disallows external network requests, including images, fonts, styles, and
connections. The renderer loads only bundled code. It exchanges bounded render
requests/results with the main UI through a narrow transport using validated
native caller identity and request IDs.
Do not allow Markdown-supplied scripts, navigation, or arbitrary messages to
become commands. A same-origin iframe is not an isolation boundary and is not
the proposed solution: it can reach its parent's bridge, and Windows may inject
native initialization scripts into subframes.

Add explicit application-command permissions or native-side caller checks for
every existing file/document/window command: only the main webview may invoke
them. Local custom commands are not protected merely by omitting a capability.
Replace window-wide grants with main-webview-specific grants where appropriate;
a second webview in the same window must not inherit main-window permissions.
The renderer may have a narrow render-result transport, but no document/file,
dialog, opener, or general-purpose native command access. Any transport endpoint
must validate its caller, outstanding request, payload shape, and size. Hiding
`__TAURI__` or blocking CSP fetch alone does not establish IPC isolation.

Before inserting the returned SVG into the parent, remove network-bearing
image attributes and CSS URL references using a structured sanitizer, not
regex alone. Protect both initial rendering and theme refresh, including cache
reuse. Preserve ordinary local Mermaid diagrams and theme colors.

For this first cut, Mermaid images requiring external resources are unsupported
even when document remote images are enabled. Keep the existing source fallback
and a clear explanation when the diagram cannot render without them. The remote
image preference continues to control Markdown/raw-HTML document images.
This narrower Mermaid contract is a proposed trade-off for a reliable offline
boundary, not a claim that all Mermaid features remain supported.

Ordinary document image sanitization, no-referrer behavior, KaTeX trust policy,
and local-file boundaries must not regress. Normalize backslash/mixed-separator
remote URL variants as defense in depth.

## 2. Task and source-map integrity

Only parser-generated source markers may drive editing/task toggles. Replace
the raw-HTML whitespace-sensitive marker stripper with parser-based handling.
Strip author-controlled editing attributes, including `data-sourcepos`, task
indices, and edit indices, before generated markers are attached. Preserve the
safe HTML subset and real task behavior. Raw inputs must not acquire generated
task indices; non-checkbox input types are removed from document HTML.

Required regressions: mixed-case, slash-separated and newline-separated
attributes, forged list/div markers, a real task sharing a forged location,
and normal Unicode/list/block editing. Real tasks toggle only their own source.

## 3. Bounded rendering and filesystem enumeration

Build a line-start index once per parse. Source position lookups must not
rescan preceding lines per node. Preserve existing source-map/public fixture
interfaces and Unicode behavior. Move task parsing off the native main thread.

Proposed budgets, centralized and documented:

| Resource | Budget |
| --- | --- |
| Document input | Existing 20 MiB |
| Lines | 200,000 |
| Blockquote nesting | 128, checked before expensive parsing |
| AST nodes | 200,000 |
| Generated HTML | 64 MiB, enforced while writing |
| Local image | Existing 10 MiB per file |
| Embedded image occurrences | 200 per render |
| Total embedded image bytes | 32 MiB encoded output, counting repeats |
| Folder output | Existing 5,000 entries / 12 levels |
| Directory enumeration | 10,000 inspected entries per directory |
| Folio picker output | 5,000 entries |

Check cheap input/depth limits before parsing; post-parse caps alone do not
prevent pathological parser work. Include list/blockquote combinations in
adversarial fixtures. Structural limits must apply to task parsing as well.
Bounded HTML writing does not by itself bound parser/highlighter intermediates;
benchmark those paths and retain explicit input/complexity limits.

Use a per-render local-image cache keyed by canonical path; enforce the output
budget for every occurrence even on cache hits. Read image bytes with a bound,
not only a metadata check. Missing/over-budget images use a safe placeholder.

Directory limits apply before collecting/sorting all children, counting skipped
or non-Markdown entries as enumeration work. Preserve current symlink/dot-file
policy. Report truncated listings in both Folio picker and tree; do not claim
the truncated results are the alphabetically first entries of the whole folder.
OS-native dialog enumeration is owned by the OS, not this Rust enumeration cap.

Limit failure must not replace the current document with partial content or
leave backend/frontend document state divergent. If a readable file exceeds
preview complexity limits, keep its source available for edit/save and display
an explicit preview-unavailable state rather than a stale previous preview.
Never truncate source data to satisfy a rendering budget.

## 4. Picker preference

Reuse existing command-palette layout; no new settings screen or toolbar chrome.
Persist `folio.filePicker` with `folio` or `native`; missing/invalid values use
`folio`. Save/Save As remains OS-native and is unaffected by this preference.

Always-visible palette commands:
- `Use system file picker` when Folio is selected.
- `Use Folio file picker` when the system picker is selected.
- `Open folder…`, honoring the selected picker.

Use concise searchable detail text for picker/system/dialog/folder terms and
existing status feedback when switching. Preserve palette auto-close behavior.

Toolbar Open, welcome Open, palette `Open file…`, and Ctrl/Cmd+O share routing.
Folio mode retains its combined file/folder chooser. Native Open uses the OS
file dialog; native `Open folder…` uses the OS folder dialog, because these are
separate platform APIs. Native file filters cover md/markdown/mdown/mdtxt.
Folio `Open folder…` opens the existing chooser at the current folder; it still
allows file selection rather than inventing a second custom dialog.

Implement one Rust-side async `pick_open_target(kind, start)` command returning
`null` on cancel or `{ path, kind }`. Validate kind through a Rust enum; use the
existing dialog plugin and fall back gracefully if the starting directory is
missing. No document mutex is held while the native modal is open. Do not add
frontend dialog/filesystem capabilities or a new dependency for this feature.

Selection comes before the existing unsaved-change prompt in both modes.
Picker cancellation never prompts, saves, discards, or updates recents. After
selection, open through existing protection; cancelling the unsaved prompt
keeps the current document. Native selection/open is serialized once through
the action queue, without nested enqueue calls. Guard duplicate picker launches
and re-entrant open requests while the native modal is active. Rust picker calls
run off the UI thread. Existing CLI/drop/recent opens remain unchanged.

Fix stale Folio picker selection when its path input is edited as part of the
same routing work; the currently typed destination must not lose to an old row.

## 5. Platform build hygiene

Retain `assets/icon.icns` and include `assets/icon.png` in the macOS bundle icon
list so Tauri codegen has a runtime PNG. Resolve `src/document.rs`'s Unix-only
builder mutation without warnings on Windows. Do not regenerate unrelated
branding or claim native validation based only on Linux checks.

## Verification and acceptance

Each implementation lane owns focused regressions; reconcile all writers before
one final full baseline run: formatting, Rust tests, Clippy, path tests, UI/lazy
tests, parser fixture build, and real-parser live-editor tests.

- Browser network tests intercept external traffic without sending it: Mermaid
  image-node/HTML-label cases, theme refresh, repeat renders, and preference
  toggles. Assert zero external requests from the offline renderer and no
  request after SVG insertion. Test messaging and native IPC isolation: attempted
  renderer calls must not execute protected Rust command bodies, even if the
  renderer has access to a native bridge object. Check all platform transports,
  including Windows IPC fallback; object absence or rejected promises alone
  are not sufficient evidence.
- Rust tests cover marker spoofing, actual task edits, line-index boundaries,
  complexity/image budgets, bounded file reads and directory iteration with
  injected small limits. Preserve all current integrity/security tests.
- Use release-build benchmarks for short-paragraph scaling and nested input;
  report machine/context and compare ratios, not flaky tight CI wall times.
  Double line count must not retain the previous approximately 4x scaling.
- UI tests cover picker defaults, persistence, each Open entry point, file and
  folder results, cancellations, dirty prompts, duplicate launch prevention,
  stale path selection, and actionable limit/failure states.
- CI must pass Windows/macOS/Linux checks and native builds. Real OS dialogs,
  native webviews/CSP, and installed-package behavior require recorded manual
  validation; this Linux session cannot establish those results.

Builder discretion: exact internal module split, structured HTML/SVG sanitizer
choice, renderer transport mechanics, fixture organization, and budget helper
interfaces. Dependencies, if needed for structured sanitization, must be narrow,
pinned/locked, and justified. Any budget that proves too restrictive may be
adjusted with benchmark evidence and recorded rationale, not silently removed.
