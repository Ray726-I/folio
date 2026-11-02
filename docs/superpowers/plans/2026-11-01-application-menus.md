# Application menus and document controls implementation plan

**Goal:** Apply the user's two-level Folio header and reference, retaining existing editor, navigation, theme, picker and file-safety features.

**Architecture:** Keep the Tauri/plain JavaScript shell and existing ProseMirror buffer/history. Add a focused chrome controller for application menus, document modes, preferences and auxiliary actions. Native file actions remain restricted to the main webview and active document/folder.

**Tech stack:** Rust/Tauri, plain HTML/CSS/JavaScript, Playwright.

- [x] Add behavioral browser coverage for default Reading, mode round trips/history, read-only permissions, menu keyboard navigation, replace, preferences and file actions. Run red.
- [x] Add native permissions metadata, restricted rename/duplicate/reveal/export/fullscreen/search commands and focused filesystem tests.
- [x] Add application menu bar and document mode/preferences/actions controls, retaining existing actions and command palette features.
- [x] Wire source changes into existing buffer and undo history; keep user read-only independent of mode and filesystem permissions. Retain exact snapshot.
- [x] Wire conventional shortcuts, find/replace, history and document actions. Add preferences backed by existing theme/font settings.
- [x] Check layout in dark/light and narrow windows; verify keyboard navigation, menu closing and no clipping.
- [x] Run Rust checks, UI/editor regressions, bundle verification and document any native-platform verification limits.

User-provided design is the implementation specification. Reading is default on open; New starts in Edit. Source and rich edits share undo. Export PDF uses the platform print dialog's PDF destination. Existing app/theme preferences remain available through the command palette.


Verification completed:

- `npm run test:ui`: passed, including the new application/menu/mode regressions.
- `npm run test:editor`: passed (bundle, unit and browser checks).
- `npm run test:paths`: passed.
- `cargo test`: 92 tests passed.
- `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings`: passed.
- `cargo build --locked`: passed.
- `npm run test:native-editor`: passed in isolated Linux Xvfb/D-Bus with real WebKit and OS-dispatched XTest keyboard input.
- Reviewed dark/light themes and narrow layouts. Review findings for delayed clipboard ownership, preference keyboard controls and Source navigation were corrected.

Native Windows/macOS dialogs and the printer/PDF destination require hands-on platform validation. HTML export renders sanitized Markdown with local images; math and Mermaid keep their source representation in the standalone file. Presentation preferences continue to persist across documents.
