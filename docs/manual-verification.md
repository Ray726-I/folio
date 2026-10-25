# Manual verification

The Playwright suite runs the UI over `file://` with a mocked Tauri IPC layer. This
checklist covers the parts it cannot exercise: the real webview, Tauri CSP, native
dialogs, filesystem permissions, and platform file-open integrations. Run it after
changes to `src/main.rs`, `tauri.conf.json`, the CSP, or the UI modules.

## Build and launch

1. Run `cargo fmt --all -- --check`, `cargo test --locked`, and
   `cargo clippy --locked --all-targets -- -D warnings`.
2. Run `cargo build --locked --release` and launch `./target/release/folio`.
3. Confirm the window opens at 1120×800, is resizable down to 600×440, and has
   normal decorations.
4. Open the webview inspector and confirm there are no CSP violations or console
   errors on startup, and that no requests are made before a document is opened.

## Preview and navigation

1. Open a document containing several heading levels, a table, task list, footnote,
   inline math, display math, a Mermaid diagram, and a local image.
2. Confirm math, the diagram, syntax highlighting, and the local image render.
3. Confirm the header shows icon-only eye and pencil controls with "Preview" /
   "Edit" tooltips, and that the selected mode is clear.
4. Open the contents sidebar and scroll the document; confirm the active section
   follows the reading position and arrow keys move between outline entries.
5. Run **Use sans-serif reading text** and **Use serif reading text** from the
   command window; confirm the document face changes, the interface does not, and
   the choice survives a restart.
6. Switch themes several times; confirm diagrams re-render with matching colours
   and the document does not jump.
7. Ctrl/Command-click a `#heading` link and confirm it scrolls.
8. Left-click an `https://` link; confirm it opens in the default browser and the
   Folio window stays on the document.
9. Middle-click the same link and drag it toward the window; confirm Folio does
   **not** navigate away. This verifies both the `auxclick`/`dragstart` guards and
   the `on_navigation` allowlist in `src/main.rs`.
10. Try a relative link inside the document folder (opens), a `../` escape (error),
   and a `data:text/html...` link (not clickable).

## Remote-image privacy

1. Open a document with `![x](https://example.com/pixel.png)`. Confirm the local
   "Remote image blocked" placeholder appears and the network panel shows no
   request to `example.com`.
2. Open the command window and run **Load remote images**. Confirm the image is
   requested, the response request has no referrer, and the setting survives a
   restart.
3. Add raw HTML `<img src="https://example.com/raw.png">`; confirm it follows the
   same setting.
4. Run **Block remote images** and confirm the placeholder returns.

## Files, folders, and permissions

1. Open a folder with a nested unreadable subdirectory. Confirm the folder opens,
   the readable Markdown files are listed, and a "Folder opened with limits"
   toast reports the skip.
2. Trigger a folder-open failure (for example, remove the folder between choosing
   it and opening it). Confirm the previously open document remains editable and
   saving still targets its path.
3. Save a new document. On Linux/macOS run `stat -c '%a %n' <file>` (or
   `stat -f '%Lp %N'` on macOS) and confirm the mode follows the umask, typically
   `644`, rather than `600`.
4. `chmod 640` an existing document, save it, and confirm the mode remains `640`.
5. Change a file externally while it is open; confirm the disk banner appears and
   saving offers Reload / Overwrite / Cancel.
6. Attempt to save a directory path or a read-only file; confirm a readable error
   and no partial file is left behind.

## Platform file opening

### Linux

1. Run `./scripts/install-local.sh` and confirm the desktop entry appears under
   "Open With".
2. Open a `.md` file from the file manager and confirm Folio opens it.
3. Launch a second instance with a file; confirm the existing window focuses and
   opens it.

### macOS

1. Build the `.app` bundle and confirm the `md`/`markdown`/`mdown`/`mdtxt`
   associations appear in Finder's "Open With".
2. Open a file from Finder while Folio is closed, then while it is running.
   The first uses argv or the open event; the second must use
   `RunEvent::Opened` and reuse the existing window.
3. Confirm Command-based shortcuts work and the window close button prompts to
   save when dirty.

### Windows

1. Confirm the open dialog starts in the user profile, not a drive root, when
   `HOME` is unset.
2. Open a file through Explorer's "Open With" and from a second instance.
3. Confirm paths with mixed separators display and compare correctly in the file
   tree.

## Close, recover, and accessibility

1. Close with unsaved changes from the window button, Ctrl/Command+W, and the
   command window's close path; each should prompt once and Cancel should keep the
   window open.
2. Reload the webview while a document is open (development only) and confirm the
   app does not replay stale paths.
3. Tab through the header, tree, command window, and open dialog; confirm focus
   remains visible and Escape closes modal surfaces.
4. Confirm the status bar shows word count, reading time, and LF/CRLF for the open
   document.
