# Unified Editor — Design (Folio)

Status: accepted UX direction; implementation subsequently authorized by the user. The rushed implementation is under repair; this document remains the intended contract, not a claim that every scenario currently passes. See `../plans/2026-10-30-unified-editor-repair.md`.
Prototype lane (throwaway, not an engine proof): `.superpowers/brainstorm/295911-1793288089/content/`.

## 1. Approved experience

- **One document, B-clean by default.** Formatted text is directly editable. No preview/edit split, no per-block editors.
- **One `Show Markdown` toggle.** Off = clean (B). On = A: formatting marks revealed locally around cursor/hover/focus only. Global syntax dump is explicitly out.
- **One continuous document.** Cross-block selection, typing, Enter split, and Backspace join behave as ordinary continuous text editing. Editor-managed selection and undo are acceptable; browser-owned contenteditable history is not required.
- **Presentation toggle is non-destructive.** Content, caret/selection, scroll, and text undo are stable across toggling. The persistent editor instance and buffer are not replaced; incremental decoration/DOM updates are allowed.
- **Separate Lock.** Lock stops all document writes. It does not alter dirty state or autosave semantics by itself.
- **Source snapshot.** Read-only view of the exact underlying Markdown, including the current unsaved buffer. Copy for inspection; it never saves the file.

## 2. Scope: core Markdown + retained extensions

Core (must feel first-class): headings, bold/italic, inline + fenced code, bulleted/numbered lists + nesting, task lists, links, images, small editable tables, blockquotes, divider, inline + display math.

Retained without silent regression: Mermaid, inline/block HTML, frontmatter, and existing extensions (KaTeX/Typora-style highlight etc. per current parser). Rule for anything without a rich representation: it stays **editable as source and reachable** — never rendered away, never dropped from the snapshot.

## 3. Interaction contract

- Pointer: click to place caret; checkbox and Load affordances are always visible and directly actionable; link click edits (with explicit open action), never surprise-navigates.
- Keyboard: full parity — toggle via button without focus trap (focus/caret returns to the last editor position); checkboxes operable; links editable; lists indent/outdent; tables navigable cell to cell.
- Touch: 44px targets; no hover-dependent meaning; long-press mirrors right-click menus.
- Images: blocked remote content shows domain + reason + explicit Load. **No fetch on hover or focus — ever.** Loading is viewing consent, not a document write, so Lock still permits it. Image allow-state (per-doc/per-host persistence) is tentative (see §7).

## 4. Source fidelity (production, unlike the mockup)

- The editor is source-backed: the file's Markdown is the truth; rendering is decoration.
- Snapshot shows the **exact** current buffer, unsaved changes included. Read-only, copyable, never writes.
- “Exact buffer” follows Folio's existing load contract: CRLF is normalized to LF and the UTF-8 BOM is tracked separately by the native file layer (`src/document.rs`). Snapshot is not a raw disk-byte dump; saving retains the existing CRLF/BOM behavior.
- Unsupported/exotic constructs: remain editable in place (source-accessible) and round-trip byte-stable. No silent normalization.
- Serialization choices (fence styles, list markers, emphasis chars, trailing newline) are tentative — propose stable defaults, parent/builder to confirm. Do not claim user approval here.

## 5. Lock semantics

- Lock blocks: typing, formatting, task toggles, link edits, structural changes.
- Lock allows: selection, copying, navigation, image Load (viewing consent, not a write).
- Lock changes nothing about dirty tracking or autosave on its own; unlocking resumes normal semantics.
- Lock persistence across restarts/tabs is tentative (default: session-only, clearly indicated).

## 6. Production requirements (mockup fakes these — production must not)

- **Tables:** real rows/columns/cells editable in place; Tab/Shift-Tab across cells; Enter behavior defined (newline vs new row — tentative: Enter=new row at row end, else newline; builder to confirm). Only an edited table may regenerate its own pipe syntax; untouched tables and surrounding source retain their original text. No pipe hand-editing required.
- **Complex-content source access:** math, code, unsupported extensions, and an optional table-source action reveal ranges inside the same persistent editor/buffer, not nested textareas or independent editor sessions. A source-only table is not a substitute for the direct cell-editing requirement.
- **Large-document exception (proposal, not approved):** measured complexity limits may disable rich decorations for the whole document, visibly explaining why and retaining editable, exact source in the same editor. This is a safety fallback only, not the normal experience or a workaround for failing ordinary table editing. Confirm this exception before shipping.
- **Math:** inline `$…$` and display `$$…$$` backed by real TeX source; edit-as-source affordance plus typeset rendering; errors show source affordably, never blank.

## 7. User decisions vs proposed defaults

Explicit user preferences: B default; a single toggle to A; retain Lock and source snapshot; demonstrate tables, core Markdown and math. The user liked the continuous-document prototype and approved writing this design and plan, not product implementation.
Assistant recommendations carried into this draft: continuous source-backed editing; exact read-only live snapshot with copy; explicit consent-gated images; no hover/focus fetching. These are design proposals, not separately stated user requirements.
Proposed defaults (tentative, do not over-ask): Enter splits / Backspace joins; click-to-edit links with Cmd/Ctrl+click to open; image allow per-document session-only; lock session-only; emphasis/list serialization preserved as-typed.
Explicitly unapproved detail: exact source syntax normalization, snapshot copy format extras, lock/autosave persistence. Builder-check to finalize.

## 8. Acceptance scenarios

1. Type mid-paragraph with toggle on and off — same result, caret and scroll stable, Ctrl+Z undoes text.
2. Select across heading + paragraph + list, replace by typing — one continuous operation.
3. Toggle Show Markdown mid-selection — selection, caret, scroll unchanged.
4. Tick tasks, Load image, edit link URL while unlocked; all three blocked (except Load) while locked; image Load works in both.
5. Snapshot open with unsaved edits shows them; Copy matches buffer; closing snapshot writes nothing.
6. Table cell edit + row add; snapshot pipes match; reload stable.
7. Inline/display math TeX edits re-render; broken TeX keeps editable source visible.
8. Keyboard-only: toggle, task, link edit, list indent, table move — no trap, no pointer needed.
9. Blocked image never fetches until Load (verify no request on hover/focus/open).
10. Mermaid/HTML/frontmatter doc opens, edits elsewhere, snapshot preserves those regions byte-identical.

## 9. Anti-goals

No split preview/edit. No per-block source islands. No whole-document raw mode as the editing story. No silent Markdown normalization. No hover/fetch of remote content. No focus trap on toggle. No image-allow conflated with document writes. No claiming mockup interactions prove engine feasibility.

## 10. Staged scope (concept, not an implementation plan)

0. Gate engine choice on a real source-backed spike including a directly editable table, selections starting/ending inside cells and extending across cells/into prose in both directions, inline/display math, presentation-toggle stability, editor-managed undo, and untouched-source preservation. The table remains formatted during ordinary typing and composition; selecting around an atomic table is not sufficient. Static mockups do not satisfy this gate.

1. Continuous source-backed root + toggle + lock + snapshot + core inline/blocks (no tables/math editing).
2. Tasks/links/images consent + tables + fenced code fidelity.
3. Math source editing + retained extensions hardening + keyboard/touch parity pass.

Technical approach (recommended, parent to validate): source-based editor with decorations — not the mockup's static spans. Prototype proves feel only.
