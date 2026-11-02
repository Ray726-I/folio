# Folio

[View the interactive presentation](https://ray726-i.github.io/folio/) · [Download a Linux release](https://github.com/Ray726-I/folio/releases)

A small cross-platform Markdown reader and editor built with Rust and Tauri. It uses the system webview on each platform: WebKitGTK on Linux, WKWebView on macOS, and WebView2 on Windows. The Markdown parser, syntax highlighter, and file operations are Rust. The UI is plain HTML/CSS with JavaScript; the editing engine is prebuilt into `ui/vendor/editor/`, so no frontend build step is required to run or build Folio.

Folio is an early prototype. Native build configurations and CI checks target Linux, Windows, and macOS; Windows and macOS still need hands-on validation, including Finder/Explorer “Open With” behaviour. Published release packages are currently Linux-only.

## Run

```sh
cargo run --release
cargo run --release -- /path/to/document.md
```

After building, run `./target/release/folio [FILE]` directly on Linux/macOS, or the generated executable on Windows. `./run.sh [FILE]` is a Linux helper that rebuilds the release binary when needed and then launches it. The UI, reading, and code fonts (Inter, Source Serif 4, and JetBrains Mono) are bundled with the app; reading and editing work offline. Web links require a connection. Remote images are blocked by default and require a connection only when enabled from the command window.

For native prerequisites, follow Tauri's [Linux](https://v2.tauri.app/start/prerequisites/#linux), [macOS](https://v2.tauri.app/start/prerequisites/#macos), or [Windows](https://v2.tauri.app/start/prerequisites/#windows) instructions. Linux builds need GTK 3, WebKitGTK 4.1, libsoup 3, OpenSSL, and librsvg. On Arch/Omarchy, install `webkit2gtk-4.1` from the distribution repositories. No Node runtime is needed to run or build Folio with Cargo.

## Controls

| Action | Shortcut |
| --- | --- |
| Command window (commands, themes, files) | Ctrl+Shift+P (Command+Shift+P on macOS) |
| Open File / Open Folder | Ctrl+O / Ctrl+Shift+O |
| Show or hide the file tree | Ctrl+B |
| New document | Ctrl+N |
| Reading / Edit / Source mode | Document mode dropdown (Edit is default) |
| Protect a document in every mode | **Open as read-only** in the mode dropdown |
| Exact source snapshot | Document preferences → **Inspect exact Markdown** |
| Navigate table cells | Tab / Shift+Tab |
| Line break in a table cell; new row at the last cell's end | Enter |
| Leave a table forward / backward | Ctrl+Enter / Ctrl+Shift+Enter |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y |
| Save / Save as | Ctrl+S / Ctrl+Shift+S |
| Zoom the whole app in / out | Ctrl+= / Ctrl+- |
| Reset app zoom | Ctrl+0 |
| Increase / decrease document text size | Ctrl+Shift+= / Ctrl+Shift+- |
| Reset document text size | Ctrl+Shift+0 |
| Find / Find and Replace (current document) | Ctrl+F / Ctrl+H |
| Search folder contents (document Find without a folder) | Ctrl+Shift+F |
| Load or block remote images | Command window |
| Switch serif / sans reading text | Command window |
| Focus mode | View → Toggle Focus Mode; Escape exits |
| Fullscreen | F11 |
| Close File / Quit | Ctrl+W / Ctrl+Q |

On macOS, use Command in place of Ctrl for the listed shortcuts. The command window supports typing to filter, arrow keys, Enter, and Escape. Search for a theme by name, or select **Change theme…**. There are System, Adwaita Light, Adwaita Dark, Nord, Catppuccin Mocha, Rosé Pine, and Solarized Light themes. Theme, remote-image, reading-font, and text-size preferences persist locally. Recent files store paths, not document contents; they can be cleared from the command window. **Load remote images** / **Block remote images** toggles whether documents may contact image hosts; blocked images appear as a local placeholder. **Use serif reading text** / **Use sans-serif reading text** switches the document face without touching the interface.

The outline supports collapsible sections and keyboard navigation: use Left/Right to collapse, expand, or move between parents and children, and Up/Down to move through headings. **Wrap** switches between compact and two-line titles. As you read, the outline keeps the current section away from its edges. Hover or keyboard-focus a rendered diagram to reveal **Expand**, then use Fit or zoom controls to inspect it; Escape closes the viewer.

### Choose a file picker

Folio uses its built-in file/folder picker by default. In the command window,
choose **Use system file picker** to use your operating system's dialogs, or
**Use Folio file picker** to switch back. This choice persists locally.
With the system picker selected, Open opens a Markdown file; use **Open folder…**
in the command window for a folder. Save and Save As always use the system dialog.
Cancelling a picker leaves the current document untouched. After selecting a
destination, any unsaved changes still require Save, Discard, or Cancel.

## Omarchy

On Linux, Folio adds a theme named **Omarchy** when it finds a valid current palette. When selected, it reads the active palette's background, foreground, accent, selection, and syntax colors. It checks for changes every two seconds and reapplies them while the app is open. Other selected themes are left alone. If the palette disappears, Omarchy selection falls back to the system appearance until a palette returns. Omarchy palette detection is not available on Windows or macOS.

Detection respects XDG_STATE_HOME and XDG_CONFIG_HOME, checking:

- `$XDG_STATE_HOME/omarchy/current/theme/colors.toml` (default `~/.local/state/omarchy/current/theme/colors.toml`)
- The older `$XDG_CONFIG_HOME/omarchy/current/theme/colors.toml` location (default `~/.config/omarchy/current/theme/colors.toml`)

Only the app's own preferences are written. Desktop theme files are read without modifying them.

## Markdown and files

The preview supports CommonMark, GFM tables, task lists, strikethrough, footnotes (including inline `^[notes]`), GitHub-style note/tip/important/warning/caution callouts, fenced code with syntax highlighting, heading navigation, definition lists, superscript/subscript, `==highlights==`, `++insertions++`, underlines, Obsidian-style `[[wikilinks|labels]]`, emoji `:shortcodes:`, and hidden YAML front matter. Math is rendered locally with KaTeX: inline `$x^2$`, display `$$x^2$$`, and ` ```math ` blocks. Fenced ```` ```mermaid ```` blocks are rendered locally in the preview as diagrams (flowcharts, sequence, class, state, entity-relationship, gantt, pie, timeline, git graph, mindmap, and more). Markdown HTML is sanitized before display; a safe subset only. Remote images in Markdown or raw HTML are blocked by default and replaced with a local placeholder so opening a document cannot silently contact a tracking host. When enabled, images are requested with `referrerpolicy="no-referrer"`. Relative Markdown links within the document's folder or its descendants open files after any unsaved-change prompt; links resolving outside that boundary are rejected. Web links open in the default browser; `data:` links are removed.

Reading text uses Inter by default, with Source Serif 4 available in document preferences, while the interface uses Inter and code uses JetBrains Mono; all three are bundled in `ui/fonts/` and fall back to system fonts. A command-window toggle switches the document between serif and sans. The outline tracks the section you are reading and supports arrow-key navigation.

LaTeX and Mermaid use vendored files in `ui/vendor/` — no CDN or rendering service is used — and load on demand. Mermaid runs in a separate offline renderer with restricted native permissions; its SVG output is sanitized before display. Diagrams are re-rendered when the theme changes so their colors match Folio (including the live Omarchy palette). Mermaid diagrams that require external images are unsupported, even when remote document images are enabled; a source fallback explains the failure. Invalid Mermaid sources also show their source with an error note. KaTeX uses `throwOnError: false` and restrictive trust settings, and Mermaid uses its strict security level.

Relative Markdown images in the document's directory or its descendants are loaded locally (including PNG, JPEG, GIF, WebP, and SVG). Images outside that directory are not embedded automatically. Local images are limited to 10 MB each. Documents must be UTF-8 and are currently limited to 20 MB. Uniform CRLF endings and a UTF-8 BOM are preserved on save. Existing files keep their permissions; newly created files follow the process umask rather than being forced to owner-only.

Preview work is bounded independently of file size: 200,000 lines and AST nodes,
128 levels of blockquote nesting, 64 MiB of generated HTML, 200 image occurrences,
and 32 MiB of embedded image data URLs, counting repeated references. Local image
reads are bounded and cached per render. If preview limits are exceeded, Folio
shows a diagnostic instead of truncating the document. Edit provides the full
source so it can still be changed and saved. Structural checks are conservative
for unusual indentation. Mermaid has a separate 256 KiB source and 8 MiB SVG limit.
Folder and built-in picker listings may be incomplete when enumeration limits
are reached; a notice identifies limited results rather than implying all
matching files were found. These limits do not control the OS-native picker.

Saves write a temporary sibling file and rename it atomically. Content fingerprints detect external changes before saving; the app presents Reload, Overwrite, and Cancel choices. It also shows a disk-change banner while the document is open. Folio opens one document at a time. Opening a folder shows a collapsible file tree; unreadable entries are skipped and reported, and very large trees are capped at 5,000 entries and 12 levels. Click a folder to expand it, select a Markdown file to open it, and use the close button or Ctrl+B to hide or show the tree without closing the document. Drag the tree's edge to resize it.

The application menu bar contains **File, Edit, View, Go, Help**. The document toolbar below it shows the filename, full path, mode, preferences, save state and additional document actions. Documents open in **Edit mode** without automatically placing a text caret; click the document to begin editing. The opening mode is independent of the previous document’s mode or read-only toggle. Uncheck **Open documents in Edit mode** in document preferences to open in Reading mode instead. **Edit mode** enables the existing formatted Markdown editor; **Source mode** edits the exact raw Markdown in the same buffer and undo history. New blank documents start in Edit mode. Switching modes preserves unsaved changes and does not rewrite the file. Untouched rich-editor blocks keep their original source text, while edited blocks serialize canonically.

**Open as read-only** protects the document independently of its presentation. Filesystem permissions appear separately and prevent entering Edit mode; Source remains inspectable, and Save As can create a writable copy. Selection, copying, heading navigation, exact source snapshots and explicitly loading images remain available. Documents above the rich-editor complexity threshold retain the existing complete, read-only source fallback.

The sliders control font family, font size, line height, content width, paragraph spacing, appearance and Markdown styling. Existing themes, full-width layout, formatting toolbar and exact snapshots remain available. These presentation preferences persist locally across documents. The three-dot menu provides path copying, reveal, rename, duplicate, PDF printing, HTML export and close. PDF export uses the operating system print dialog's PDF destination. HTML export uses Folio's sanitized native renderer and blocks remote images; math and Mermaid retain their source representation in the standalone HTML.

The dock provides Search, Outline and Files. With a folder open, Search occupies its own sidebar in place of Files or Outline and searches saved Markdown file contents. Results are grouped by file, show matching lines and line numbers, and open the selected match in the document. Ctrl+F always searches only the current document; Ctrl+Shift+F opens folder search, falling back to document Find when no folder is open. Folder content search is bounded to 100 matching lines, 2 MiB per file and 16 MiB read per query, and reports limited results. The command window retains theme selection, remote-image controls, picker choice, reading fonts, text zoom and other existing commands. Remote images never load on hover or focus. Obsidian plugins, PlantUML, and diagram languages besides Mermaid are not implemented.

## Optional Linux desktop installation

```sh
cargo build --release
./scripts/install-local.sh
```

The script installs under your user directory and registers Folio as an available Markdown application. It does not change the default app automatically. You can select Folio using the file manager's **Open With** menu, launch it from your app menu, or run `~/.local/bin/folio [FILE]`.

## Download a release

Linux releases are published on [GitHub Releases](https://github.com/Ray726-I/folio/releases) as an AppImage and a Debian package. The AppImage is convenient for a portable user install. The Debian package integrates with the system package manager.

Both Linux packages use the system's GTK and WebKitGTK runtime, so the Linux prerequisites described above still apply. On Debian or Ubuntu, install the matching WebKitGTK 4.1 runtime before launching Folio. On Arch or Omarchy, install `webkit2gtk-4.1` from the distribution repositories. Windows and macOS installers are not currently published by the release workflow.

To publish a new release, update the version in `Cargo.toml` and `tauri.conf.json`, commit the change, then push a matching tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions builds the bundles and attaches them to the release automatically.

## Development checks

```sh
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
```

The Rust tests cover external-edit conflicts, metadata-based change detection, atomic save behavior, CRLF/BOM/permission preservation, new-file umask handling, HTML sanitization (including mixed-case `data-sourcepos` spoofing), remote-image privacy, syntax-highlighted Markdown, math and Mermaid source markers, wikilinks, emoji, extension elements, document anchor identifiers, edit-block source mapping, task toggling, tolerant folder scanning, local image boundaries, and theme validation. An optional UI smoke test checks keyboard controls, the command window, conditional/live Omarchy themes, theme isolation, remote-image toggling, reading-font toggling, the unified editor controls, outline navigation, unsaved-change prompts, structured save conflicts, close protection, find, on-demand vendored KaTeX/Mermaid loading, the collapsible file tree, and direct editing. Separate real-editor checks cover rich tables, tasks, math, links, images, Lock, exact source snapshots, shared undo and the complexity fallback. It mocks the native IPC layer; native filesystem and rendering behavior are covered separately by the Rust tests.

```sh
npm ci
npx playwright install chromium
npm run test:ui
```

`test:ui` includes picker-choice and preview-limit recovery regressions. Run
`npm run test:picker` or `npm run test:limits` for those checks individually.
`npm run test:renderer` checks the offline renderer and main-page bridge with
intercepted network requests and mocked transport where needed. These browser
checks do not substitute for real Tauri IPC validation.
For reproducible release-build parser scaling measurements:

```sh
cargo build --release --example editor-fixture
node scripts/benchmark-render.cjs
```

For real-webview, CSP, and cross-platform checks that the mocked UI tests cannot cover, follow [docs/manual-verification.md](docs/manual-verification.md).

## Project structure

- `src/document.rs`: file reading, fingerprints, atomic saves, umask-aware permissions.
- `src/markdown.rs`: parsing (Comrak), syntax highlighting, sanitization, remote-image policy, edit mapping.
- `src/theme.rs`: XDG-aware Omarchy palette detection.
- `src/main.rs`: desktop lifecycle, window/navigation policy, native dialogs, commands, file launching.
- `ui/core.js`: shared DOM, IPC, path, and preference helpers.
- `ui/theme.js`: theme definitions, contrast/palette derivation, Mermaid colours.
- `ui/preview.js`: preview rendering, lazy KaTeX/Mermaid loading, diagram lifecycle.
- `ui/editor.js`: editor shell, document lifecycle, outline and dialogs.
- `ui/editor/`: source model, rich and Markdown presentations, shared history; bundled into `ui/vendor/editor/` by `npm run build:editor`.
- `ui/app.js`: documents, folders, command window, event wiring.
- `ui/fonts/`: bundled Inter, Source Serif 4, and JetBrains Mono variable fonts.
- `ui/vendor/`: vendored preview dependencies; licenses are listed in `THIRD_PARTY_NOTICES.md`.
- `tests/` and `docs/manual-verification.md`: automated and manual verification.


For real-parser editor regression checks:

```sh
npm ci
npm run build:editor
cargo build --example editor-fixture
npm run test:editor
```

The editor bundle is generated from `ui/editor/` and pinned dependencies. Run `npm run build:editor` after changing those sources; `npm run check:editor-bundle` verifies the committed bundle is current.

On Linux, verify the actual Tauri/WebKit keyboard and save path in an isolated
Xvfb/D-Bus session (requires `xvfb-run`, `dbus-run-session`, libX11 and libXtst):

```sh
cargo build --locked
npm run test:native-editor
```

This uses OS-dispatched XTest input and disposable files, not mocked IPC or
JavaScript input events. It does not establish physical-keyboard or IME coverage.

The GitHub Actions workflow runs Rust formatting, tests, Clippy, and UI checks on Linux, Windows, and macOS, and builds native bundles on each platform. Node.js is needed only for these UI checks and bundle verification.

## License

Folio is licensed under [MIT](LICENSE). Bundled preview libraries and fonts retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).


For native Linux palette startup checks (system Python with PyGObject and GTK 3 /
WebKit2 4.1 typelibs, plus Xvfb and D-Bus):

```sh
npm run test:native-palette
```

This loads the real UI in isolated WebKit views at 100% and 120% zoom and checks
that first-layout timing cannot freeze transparent/invalid theme samples into
gray document text. Reading text uses full foreground contrast in light and dark
appearances; accent colors retain their saturation without text shadows or glow.
