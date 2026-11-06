# Reliable workspaces for Folio — proposed design and delivery plan

Status: approved by the user on 2026-11-06. Implementation is tracked in the companion workspace implementation plan.

## Intent

Make Folio safe to write in and comfortable to use across several files, while keeping its quiet, document-centered interface. Deliver useful increments rather than coupling crash recovery to a large workspace rewrite.

Recommended order: recovery → document sessions and tabs → explorer operations → split reading → additional windows. Each phase must remain releasable on its own.

## What the existing app establishes

- `ui/app.js` owns one `current` buffer, one saved baseline, one save status, and a serialized action queue. Opening another file asks to discard the old one.
- `ui/editor.js` mounts a single editor into `#preview` and destroys it when the current document changes. Callbacks already guard against an outgoing document identity.
- `ui/editor/entry.js` owns source, history, selection, and editing modes. Retaining only Markdown during tab switches would lose undo and caret state.
- `src/main.rs` holds one `Mutex<Option<OpenDocument>>`; save commands infer their target from that global state. This must change before concurrent documents become possible.
- `src/document.rs` already provides fingerprint conflict checks, BOM/line-ending preservation, and atomic saves. Build on these guarantees.
- The explorer is rendered by `renderFolderEntries()` in `ui/app.js`; current-file rename and duplicate exist in both the shell and native commands.
- Main-window commands and close handling assume the label `main`. The hidden Mermaid renderer has a separate restricted capability. Additional windows require an authorization and routing change, not just a new window button.

## Product rules

### Recovery and saving

**Automatic recovery is on by default. Automatic writes to the source file are an optional preference, off by default.** A recovery copy protects an unfinished thought without unexpectedly changing a file another tool uses.

- Capture the canonical Markdown buffer, never rendered HTML or a reconstructed DOM.
- Include unnamed documents, source mode, pending in-place source edits, and any buffer that differs from its disk baseline.
- Proposed schedule: snapshot after 1 second of quiet, with a 5-second maximum wait during continuous edits. Flush on document/window transitions when possible. Acknowledge durability only after the native write finishes.
- Keep snapshot work out of the typing task. Use one in-flight snapshot per document, coalesce queued updates to the newest revision, and discard stale acknowledgments.
- A hard kill can lose edits since the last durable snapshot; do not promise recovery of every keystroke or immunity to storage failure.
- Preserve the latest valid snapshot and one previous valid generation using native atomic replacement and checksums. Never replace a good generation with a partial file.
- Store locally in the platform app-data directory, outside the opened folder. Use restrictive permissions where supported. No document content in settings storage or logs.
- On relaunch, if recoverable work exists, show a compact review dialog: “Recover unfinished work?” with filename, location, and snapshot time. Actions: Recover selected, Not now, and explicit Discard selected with confirmation. Not now retains the copies and exposes “Recover documents…” in File and the command window.
- Recovery loads the draft as an edited buffer; it does not overwrite the source file. If the disk baseline changed, open the recovered text as a separate unnamed recovery document with the original location recorded, and offer the disk file separately. If the file disappeared, recover as unnamed.
- A successful save removes recovery data only through the revision actually saved. If typing continued while the save was pending, retain/rewrite the newer draft. A failed or canceled save never removes it.
- Explicit discard removes the matching draft only after a durable discard record; stop/drain the snapshot writer so a late completion cannot resurrect it. Undoing back to the baseline clears a redundant draft safely.
- No automatic expiration of unsaved recoverable documents. Budget recovery storage; prune redundant saved snapshots first, and surface a persistent recoverability error if a dirty draft cannot be persisted. Do not silently evict work to meet a quota.
- Preserve named/unnamed identity, document revision, baseline fingerprint, encoding metadata, timestamps, schema version, checksum and original location. Damaged or unsupported records are isolated and left available for manual export rather than blocking startup.
- Separate session layout metadata from draft content: a broken tab manifest must not make otherwise valid drafts undiscoverable.

Optional “Save files automatically” ships after recovery is dependable. Debounced saves apply only to writable named files, honor user Lock and active composition, and use the existing external-change checks. A conflict pauses automatic writes for that file and offers review. Never automatically force overwrite or open Save As dialogs for unnamed documents.

### Tabs

- Opening another file creates or activates its tab. New creates a numbered unnamed document. Opening the same canonical file activates its existing document instead of creating independent buffers.
- Save As rejects a destination already owned by another document session before writing, and offers to activate that document. It must never overwrite another open buffer's disk file through a different session.
- Start with ordinary persistent tabs. A preview-tab convention adds replacement rules and dirty-state surprises; leave it out of the first release.
- A compact tab strip sits below the existing top chrome, aligned to the content area. Theme colors, familiar filename icons, a subtle active accent, and the existing edited dot are sufficient decoration.
- Show close controls on hover and keyboard focus; give touch users a persistent accessible close action. Do not require dragging for any action.
- Truncate long names and distinguish duplicates with parent-folder labels. Full paths stay in tooltips and accessible names.
- Horizontal overflow scrolls within the strip. An always-visible “All documents” button with its own tab/search glyph opens the same searchable list (also `Ctrl+Shift+A`). Focus mode can hide the strip while keyboard switching still works.
- Preserve undo/redo, source/edit/read mode, user Lock, selection, find state, scroll anchor and outline state per document. Tab switches must not clear history or flush another tab's pending edits into the active document.
- Closing an edited tab asks Save / Discard / Cancel. Closing a window with several edited files uses one review sheet with per-file choices; never a cascade of dialogs. Cancel leaves all tabs intact. Successfully completed saves remain saved if a later operation fails.
- Reopen closed tab and restore last session are separate actions from crash recovery. Restore layout and clean files quietly if enabled; present recovered dirty buffers for review. Handle missing files without losing drafts.
- Proposed shortcuts: platform modifier+T new, modifier+W close tab, Ctrl+Tab / Ctrl+Shift+Tab cycle, modifier+Shift+T reopen closed. Verify existing Folio and platform bindings before assigning them.
- Switching between files inside the open workspace preserves the explorer. Opening an outside file should not silently replace the folder being browsed.

### Explorer file operations

- Folder header gets a small New action menu. Row context menus expose New file/folder, Rename, Duplicate, Move to…, Move to Trash, Copy path and Reveal in file manager as applicable.
- Use the existing menu treatment. Inline new/rename fields use normal focus styling, preselect the stem, retain the extension, commit with Enter, cancel with Escape, and show errors next to the field. No special border around ordinary menu actions.
- Operate on the context-menu target, even when it is not the active document. Keyboard commands operate on the focused tree item.
- Create empty files/folders with exclusive creation. On collision keep the edit field open; never overwrite. Duplicate proposes an available “name copy.md” and still creates exclusively.
- Define duplication explicitly: Duplicate copies the file on disk; when that file has an edited open buffer, offer “Duplicate current edits” as a distinct action. The latter writes the captured buffer to a new file without marking the original saved.
- Rename/move of an open document preserves its buffer, history and recovery identity. A directory operation updates every open descendant using path-component mapping, including references to its old disk baseline.
- Move to Trash uses the operating system trash, including nonempty directories, with a confirmation naming the target and affected open documents. If trash is unavailable, report the failure; never fall back silently to permanent deletion.
- An edited open file must resolve Save / Keep as unnamed / Cancel before trashing. Keeping as unnamed retains edits and recovery but removes its disk target. Resolve all affected descendants before trashing a directory.
- Commit path detachment and tab closure only after trash succeeds: close clean affected sessions (including those just saved during review), and retain “Keep as unnamed” buffers without their old paths. If trash fails, keep the original session paths and buffers; completed saves stay saved. A later Save must not accidentally recreate a trashed file.
- Ship Move to… first. Add tree drag/drop later with an explicit landing highlight, auto-expand, cancellation, and the same validation path. Do not repeat the table drag stutter by mutating the tree on every pointer movement.
- Restrict explorer mutations to the authorized workspace root. Validate path components and filesystem identity natively; frontend `isWithin()` is presentation logic, not authorization. Define symlink/reparse-point behavior and test race handling; do not follow a directory link outside the root for mutation.
- First release supports moves within one workspace/filesystem. Report cross-device moves clearly; copy/delete fallback requires a separately designed failure recovery path.
- Preserve tree focus, expansion and scroll after operations. Update the affected subtree and open-session paths, not the entire editor surface.
- Relative Markdown links are not rewritten automatically on move. Explain the new media base when relevant; link repair is a later feature.

### Split reading

- First split feature: “Open beside” another document, or “Show reading view beside editor” for the same document. Two panes maximum initially.
- A pane references a document session; it never owns a second copy of the buffer. Initially allow one writable view per document and a read-only companion, avoiding unsynchronized editor histories.
- Use a thin resize divider with a generous invisible hit area and visible keyboard focus. The focused pane determines the title, outline, find, save and formatting targets. Make focus legible without framing the entire document in a colored border.
- Reading companion reflects the latest buffer after a debounce, with stale render results rejected by document ID and revision. Preserve its scroll anchor. Scroll coupling is optional and off by default; when enabled map source/block anchors rather than raw scroll percentages.
- Reuse sanitized rendering, image consent, offline Mermaid transport and render budgets. Do not create an editable offscreen editor for the companion.
- Collapse to the focused pane when the window cannot support two readable panes. Preserve the split arrangement for restoration when there is room again; choose the threshold from actual layout testing.

### Additional windows

- Add “Open in new window” after window-scoped document ownership is proven. In one app process, a document has one writable owner; another window gets a read-only view or an explicit ownership transfer.
- Native window registry supplies trusted identities. Validate document/window ownership on every mutating command. Reject arbitrary label strings and keep the Mermaid webview outside application-document privileges.
- Transfer only after the destination has loaded successfully, retaining source ownership and recovery on failure. Workspace manifest and recovery writes are coordinated by one native service.
- Distinguish window close from application quit. Background windows and their edited buffers must not be discarded by closing the first window.
- Prevent competing independent app processes from writing the same recovery store; route subsequent launches to the owning process or use isolated stores and explicit read-only conflict handling.

## Architecture to introduce

Keep the existing editor and native save primitives. Extract ownership boundaries around them instead of rewriting the editor.

| Proposed unit | Responsibility |
| --- | --- |
| `src/recovery.rs` | Versioned durable snapshots, generation checks, discovery and explicit discard |
| `src/workspace.rs` | Document IDs, canonical path registry, revisions, window ownership and serialized per-document mutations |
| `src/file_operations.rs` | Root-scoped create, rename, duplicate, move and trash; structured operation results |
| `ui/workspace.js` | Document sessions, active document/pane, revision routing and close decisions |
| `ui/recovery.js` | Snapshot scheduling, acknowledgment state and recovery review UI |
| `ui/tabs.js` | Accessible tab strip, overflow, switching and reopen |
| `ui/file-tree.js` | Extract tree rendering and targeted updates from `ui/app.js`; share operations with current-file menus |
| `ui/panes.js` | Pane focus, split layout, resize and companion rendering |
| `src/main.rs`, `build.rs`, `capabilities/main.json` | Thin command integration, explicit permissions and window routing |
| `ui/editor.js`, `ui/editor/entry.js`, `ui/editor/rich.js` | Session lifecycle, source/history capture and view mounting; retain editing behavior |
| `ui/index.html`, `ui/styles.css` | Theme-aware tabs, recovery review, inline tree fields and split layout |

Identity contract: immutable DocumentId; monotonic content revision; separate saved revision/baseline; path as mutable metadata. View state belongs to a pane. Edits, save acknowledgments, snapshots, external changes and renderer results all carry document ID and revision. Frontend ownership is not a substitute for native validation.

Do not serialize every tab through the existing global queue. Keep window-level UI transitions ordered, and serialize mutations per document. Capture save target and content before awaiting IPC; completion updates that document even if the user switched tabs.

Recovery can land before the workspace refactor: assign an ID to the existing single buffer and carry that ID into the later registry. Avoid a temporary recovery format keyed only by path.

Editor lifecycle requires a measured prototype: retain each open document's editor session and history while detaching inactive views, suspending observers and pending rendering. If current implementation cannot detach safely, add explicit capture/restore of session state, including history; do not remount from text alone. Inactive documents must not keep parsing/rendering or running DOM observers. Establish memory accounting and avoid silently evicting live undo histories.

## Delivery plan and release gates

### 1. Durable recovery for today's single document

1. Specify snapshot schema, IDs, revision ordering, generation replacement and discard tombstones in `src/recovery.rs`.
2. Wire canonical buffer updates in `ui/editor.js` to the coalescing scheduler in `ui/recovery.js`, including source-mode input and composition completion.
3. Add startup discovery and recover/defer/discard review using existing dialog/button styling. Keep recovery data until a durable save or explicit discard.
4. Exercise real native process termination and restart, interrupted writes, disk-full/permission failures, conflicting disk edits, unnamed documents, CRLF/BOM, stale save/snapshot completions and corrupt manifests.
5. Release when recoverable work survives forced termination and no recovery operation can silently overwrite the source file. Document the maximum snapshot gap.

### 2. Document sessions and tabs

1. Replace the backend singleton with an ID registry while keeping the current single-document interface working through adapters.
2. Migrate open/save/rename/duplicate/disk-change/media commands to explicit session context. Extend ACL registration and guard tests.
3. Add frontend session state; verify edit A → edit B → save A, delayed save while switching, same-path deduplication, Save As collisions, and failure during activation.
4. Prototype session detachment/history retention before implementing the tab strip. Test undo and selection across mode and tab switches.
5. Add tabs, keyboard navigation, overflow, close review and reopen. Persist session metadata independently of draft content.
6. Release when no async result can mutate another document, switching retains undo/caret/scroll, and inactive tabs perform no continuous rendering work.

### 3. Explorer operations

1. Extract the tree into `ui/file-tree.js` without changing behavior; establish native operation contracts and root authorization.
2. Implement create and inline rename, then duplicate and Move to…; update open-session identities atomically with native operation results.
3. Integrate system trash and the edited-document review flow; share commands with the existing document menu.
4. Verify collisions, permissions, concurrent external changes, case-only rename, folder descendants, Unicode names, symlink/reparse-point escapes, disk-full failure, and no-overwrite behavior on Linux/macOS/Windows.
5. Release when failures leave buffers recoverable and tree/session metadata consistent with disk. Add pointer drag/drop as a later small increment using these proven operations.

### 4. Reading companion and two-document split

1. Introduce pane IDs and route all contextual actions by focused pane/document.
2. Add a second read surface using existing safe rendering, revision cancellation and shared buffer subscriptions.
3. Add resizing, keyboard access, narrow-window collapse and optional anchor-based scroll coupling.
4. Verify typing latency with expensive diagrams, rapid edits with delayed render results, scrolling, image privacy, source mode, focus/selection and resize at varied zoom levels.
5. Release when a preview cannot steal typing focus, write content, or display a stale document's result.

### 5. Additional windows and optional automatic file saves

1. Generalize the native main-window authorization to a trusted workspace-window registry, including renderer result routing and close/quit behavior.
2. Implement one-owner document transfers and process-level recovery coordination before exposing the window action.
3. Add opt-in named-file autosave on the existing save path; pause on conflicts, composition and read-only/Lock state, and keep recovery independent.
4. Verify two-window ownership, failed transfer, quit with several dirty documents, subsequent process launch, external file edits and platform save-dialog behavior.
5. Release only after native checks on Linux, macOS and Windows; browser mocks cannot prove window capabilities, filesystem replacement, trash or shutdown behavior.

## Visual and performance acceptance

- Reuse Folio's current fonts, spacing, icon family, menu surfaces, dialogs and accent tokens. Add no permanent recovery status bar; show a quiet failure notice only when protection is degraded.
- Keep single-document reading as calm as today: compact tabs, minimal active treatment, no extra nested cards. Prototype with one tab, many long duplicate names, an unsaved recovery, an expanded tree and a narrow split.
- Hover actions also appear on focus and remain reachable without hover. Use semantic tabs, keyboard tree navigation, announced errors, reduced-motion behavior and platform-native shortcut labels.
- Measure typing-to-paint, snapshot serialization/IPC/write cost, startup, tab-switch latency and memory with 1/10/50 documents. Use the existing benchmark baselines; no document-wide parsing solely to persist recovery.
- Retain current rich/source size limits. Under pressure defer preview work and report storage failures; never truncate drafts or silently discard history.
- Existing Rust/UI/editor regression suites and ACL checks must remain green. Add native lifecycle/filesystem coverage for each release phase; require all configured cross-OS CI jobs before publishing.

## Scope and decisions

This is several releases of work. Recovery is the smallest independent first delivery; tabs are a substantial state-management change. Full split editing and additional windows increase that scope further. No calendar estimate is justified before the session-lifecycle prototype.

Proposed defaults to review: recovery on; original-file autosave off; regular tabs without preview replacement; one writable view per document; two panes initially; Move to… before tree drag/drop; system trash instead of permanent delete; no automatic link rewriting.

Next step after design agreement: turn each phase into its own detailed implementation checklist with concrete API/schema definitions, tests and small commits. Do not implement all phases as one branch-sized change.
