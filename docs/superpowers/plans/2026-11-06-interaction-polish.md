# Interaction polish implementation plan

**Goal:** Implement the supplied editor audit and prevent dragging from selecting side-pane text.
**Architecture:** Keep document ownership, recovery, source ledger and save paths intact. Extend existing shell functions and add focused document affordances outside the editable DOM.
**Tech stack:** Vanilla JavaScript/CSS, ProseMirror, Rust/Tauri; Playwright using the real renderer.

- [x] Reproduce tab overflow, missing split borders, path visibility, keyboard tab menu and cross-pane drag selection in `tests/interaction-polish.cjs`; run `node tests/interaction-polish.cjs` and confirm failure.
- [x] Fix shell styling and drag lifecycle in `ui/styles.css`, `ui/workspace.js`, `ui/panes.js`, `ui/app.js`. Keep tabs at least 120px, expose scrolling controls, keyboard menus, middle close and tab-to-pane drops.
- [x] Add folder fuzzy quick open to the existing command dialog, mode/pane shortcuts and grouped shortcut help in `ui/app.js` and `ui/chrome.js`.
- [x] Extend find with case/word/regex options and folder search path filters without changing default substring semantics or literal replacement behavior.
- [x] Add selection formatting, code copying and reading progress outside document content; ensure protected/reading/source modes do not expose editing actions.
- [x] Apply naming, tree-menu, table/list, empty-outline and empty-folder polish.
- [x] Run the regression, workspace, chrome, editor unit and relevant editor/browser suites; review the final diff and record limitations.


Validation: workspace and chrome suites, editor unit suite, targeted source/selection checks, and native Rust tests. Browser regressions use Chromium with the real renderer and stubbed IPC. Desktop and narrow screenshots inspected. Native WebKitGTK gestures and packaged release bundles were not exercised.
