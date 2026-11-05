# Reliable Workspace Implementation Plan

> **For agentic workers:** Use subagent-driven-development for implementation and separate spec/quality reviews. Track completion below.

**Goal:** Implement the approved recovery, multi-document, explorer, split, and window design.

**Architecture:** Preserve the canonical Markdown editor and native atomic save implementation. Introduce stable document identities and durable recovery first, then route UI sessions and filesystem operations through those identities. Keep renderer privileges separate from workspace windows.

**Tech Stack:** Rust, Tauri 2, vanilla JavaScript/CSS, ProseMirror, existing Playwright and Cargo test harnesses.

## Native document and recovery foundation
- [ ] Add native document registry and explicit document-ID context to open/new/save/render/media/change/rename/duplicate paths; retain backwards-compatible single-document commands for existing callers.
- [ ] Implement app-data recovery storage with checksums, current/previous generations, monotonic revisions, durable discard, strict size validation and discovery independent of a manifest.
- [ ] Add recovery IPC and explicit ACL registrations; test stale writes, corruption fallback, save-after-edit, conflict baseline, and discard ordering.
- [ ] Run `cargo test --locked`, formatting and Clippy; review spec then quality.

## Frontend sessions, recovery and tabs
- [ ] Add per-document sessions and preserve editor history/selection/modes across activation; prove capture/restore through a unit/browser regression before changing navigation.
- [ ] Add coalescing 1-second/5-second recovery scheduling from canonical updates and startup recovery/defer/discard review with persistent failure notice.
- [ ] Add tabs with native session IDs, canonical deduplication, overflow, close/reopen and keyboard navigation; apply asynchronous results to captured sessions.
- [ ] Add session layout persistence and multi-document close review. Keep unsaved recovery independent of layout metadata.
- [ ] Verify named/unnamed recovery, concurrent save/switch, close cancellation, undo after switching, source mode and native ACLs; review spec then quality.

## Explorer operations
- [ ] Implement native workspace-scoped exclusive create/duplicate, rename/move and OS trash. Return path changes for all affected sessions; reject symlink escapes and collisions.
- [ ] Add themed tree header/context actions and inline create/rename fields; preserve tree focus/scroll and expose Move to….
- [ ] Resolve edited descendant buffers before trash; commit detachment/closure after successful native operation only.
- [ ] Verify collisions, permissions, case-only rename, directory descendants and path safety; review spec then quality.

## Split reading
- [ ] Add two-pane layout with focused-pane routing, accessible divider, open-beside and same-document reading companion.
- [ ] Render from shared sessions with document/revision guards, sanitized output, image consent and scroll anchors; preserve narrow layout state.
- [ ] Verify stale render rejection, focus, resize and editing under expensive previews; review spec then quality.

## Additional windows and optional file autosave
- [ ] Introduce trusted workspace-window registry; scope native command access, renderer jobs and close handling by window.
- [ ] Add one-writer ownership and explicit transfer only after destination readiness; preserve source/recovery on failure.
- [ ] Add opt-in named-file automatic saves on the proven conflict-aware save path; pause for composition/Lock/conflicts.
- [ ] Verify window transfer, multi-window shutdown, single-instance launch routing and capability isolation; review spec then quality.

## Final acceptance
- [ ] Run relevant Rust/editor/UI suites, bundle verification and native lifecycle checks. Record tested platforms and any remaining limits honestly.
- [ ] Review the combined change against the approved design and resolve findings before integration.
