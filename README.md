# Folio

A small cross-platform Markdown reader and editor built with Rust and Tauri. It uses the system webview on each platform: WebKitGTK on Linux, WKWebView on macOS, and WebView2 on Windows. The Markdown parser, syntax highlighter, and file operations are Rust. The UI is plain HTML/CSS with a little JavaScript; no frontend build step is required.

Folio is an early prototype. Native build configurations and CI checks target Linux, Windows, and macOS; Windows and macOS still need hands-on validation, including Finder/Explorer “Open With” behaviour. Published release packages are currently Linux-only.

## Run

```sh
cargo run --release
cargo run --release -- /path/to/document.md
```

After building, run `./target/release/folio [FILE]` directly on Linux/macOS, or the generated executable on Windows. `./run.sh [FILE]` is a Linux helper that uses the release binary if available, otherwise builds it. All fonts, styles, scripts, and parsers are local; reading and editing work offline. Web links require a connection. Remote images are blocked by default and require a connection only when enabled from the command window.

For native prerequisites, follow Tauri's [Linux](https://v2.tauri.app/start/prerequisites/#linux), [macOS](https://v2.tauri.app/start/prerequisites/#macos), or [Windows](https://v2.tauri.app/start/prerequisites/#windows) instructions. Linux builds need GTK 3, WebKitGTK 4.1, libsoup 3, OpenSSL, and librsvg. On Arch/Omarchy, install `webkit2gtk-4.1` from the distribution repositories. No Node runtime is needed to run or build Folio with Cargo.

## Controls

| Action | Shortcut |
| --- | --- |
| Command window (also the header search button) | Ctrl+Shift+P (Command+Shift+P on macOS) |
| Open a Markdown file or folder | Ctrl+O |
| Show or hide the file tree | Ctrl+B |
| New document | Ctrl+N |
| Switch between Preview and Edit | Header mode buttons |
| Toggle Preview / Edit | Ctrl+E |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y |
| Save / Save as | Ctrl+S / Ctrl+Shift+S |
| Zoom the whole app in / out | Ctrl+= / Ctrl+- |
| Reset app zoom | Ctrl+0 |
| Increase / decrease document text size | Ctrl+Shift+= / Ctrl+Shift+- |
| Reset document text size | Ctrl+Shift+0 |
| Find in document | Ctrl+F |
| Load or block remote images | Command window |
| Focus mode | F11; Escape exits |
| Close | Ctrl+W |

On macOS, use Command in place of Ctrl for the listed shortcuts. The command window supports typing to filter, arrow keys, Enter, and Escape. Search for a theme by name, or select **Change theme…**. There are System, Adwaita Light, Adwaita Dark, Nord, Catppuccin Mocha, Rosé Pine, and Solarized Light themes. Theme, remote-image, and text-size preferences persist locally. Recent files store paths, not document contents; they can be cleared from the command window. **Load remote images** / **Block remote images** toggles whether documents may contact image hosts; blocked images appear as a local placeholder.

## Omarchy

On Linux, Folio adds a theme named **Omarchy** when it finds a valid current palette. When selected, it reads the active palette's background, foreground, accent, selection, and syntax colors. It checks for changes every two seconds and reapplies them while the app is open. Other selected themes are left alone. If the palette disappears, Omarchy selection falls back to the system appearance until a palette returns. Omarchy palette detection is not available on Windows or macOS.

Detection respects XDG_STATE_HOME and XDG_CONFIG_HOME, checking:

- `$XDG_STATE_HOME/omarchy/current/theme/colors.toml` (default `~/.local/state/omarchy/current/theme/colors.toml`)
- The older `$XDG_CONFIG_HOME/omarchy/current/theme/colors.toml` location (default `~/.config/omarchy/current/theme/colors.toml`)

Only the app's own preferences are written. Desktop theme files are read without modifying them.

## Markdown and files

The preview supports CommonMark, GFM tables, task lists, strikethrough, footnotes (including inline `^[notes]`), GitHub-style note/tip/important/warning/caution callouts, fenced code with syntax highlighting, heading navigation, definition lists, superscript/subscript, `==highlights==`, `++insertions++`, underlines, Obsidian-style `[[wikilinks|labels]]`, emoji `:shortcodes:`, and hidden YAML front matter. Math is rendered locally with KaTeX: inline `$x^2$`, display `$$x^2$$`, and ` ```math ` blocks. Fenced ```` ```mermaid ```` blocks are rendered locally in the preview as diagrams (flowcharts, sequence, class, state, entity-relationship, gantt, pie, timeline, git graph, mindmap, and more). Markdown HTML is sanitized before display; a safe subset only. Remote images in Markdown or raw HTML are blocked by default and replaced with a local placeholder so opening a document cannot silently contact a tracking host. When enabled, images are requested with `referrerpolicy="no-referrer"`. Relative Markdown links within the document's folder or its descendants open files after any unsaved-change prompt; links resolving outside that boundary are rejected. Web links open in the default browser; `data:` links are removed.

LaTeX and Mermaid run from vendored files in `ui/vendor/` — no CDN or rendering service is used — and are loaded on demand the first time a document contains math or a diagram. Diagrams are re-rendered when the theme changes so their colors always match Folio (including the live Omarchy palette). Invalid Mermaid sources show the diagram source with an error note instead of failing silently. KaTeX uses `throwOnError: false` and restrictive trust settings, and Mermaid uses its strict security level.

Relative Markdown images in the document's directory or its descendants are loaded locally (including PNG, JPEG, GIF, WebP, and SVG). Images outside that directory are not embedded automatically. Local images are limited to 10 MB each. Documents must be UTF-8 and are currently limited to 20 MB. Uniform CRLF endings and a UTF-8 BOM are preserved on save. Existing files keep their permissions; newly created files follow the process umask rather than being forced to owner-only.

Saves write a temporary sibling file and rename it atomically. Content fingerprints detect external changes before saving; the app presents Reload, Overwrite, and Cancel choices. It also shows a disk-change banner while the document is open. Folio opens one document at a time. Opening a folder shows a collapsible file tree; unreadable entries are skipped and reported, and very large trees are capped at 5,000 entries and 12 levels. Click a folder to expand it, select a Markdown file to open it, and use the close button or Ctrl+B to hide or show the tree without closing the document. Drag the tree's edge to resize it. In **Edit**, click a rendered text line to reveal its Markdown in place. Other lines stay rendered, including other lines in the same wrapped paragraph. Code, Mermaid, math blocks, and tables reveal their whole source block. Changes apply in memory when you leave the line or press Ctrl+Enter; Ctrl+S saves to disk. Task boxes can be ticked directly. Undo and redo cover text, blocks, and task boxes across mode changes. **Preview** is read-only. Obsidian plugins, PlantUML, and other diagram languages besides Mermaid are not implemented.

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

The Rust tests cover external-edit conflicts, metadata-based change detection, atomic save behavior, CRLF/BOM/permission preservation, new-file umask handling, HTML sanitization (including mixed-case `data-sourcepos` spoofing), remote-image privacy, syntax-highlighted Markdown, math and Mermaid source markers, wikilinks, emoji, extension elements, document anchor identifiers, edit-block source mapping, task toggling, tolerant folder scanning, local image boundaries, and theme validation. An optional UI smoke test checks keyboard controls, the command window, conditional/live Omarchy themes, theme isolation, remote-image toggling, unsaved-change prompts, structured save conflicts, close protection, find, on-demand vendored KaTeX/Mermaid loading, the collapsible file tree, and live editing. It mocks the native IPC layer; native filesystem and rendering behavior are covered separately by the Rust tests.

```sh
npm ci
npx playwright install chromium
npm run test:ui
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
- `ui/editor.js`: in-place editing, source mapping, undo/redo.
- `ui/app.js`: documents, folders, command window, event wiring.
- `ui/vendor/`: vendored preview dependencies; licenses are listed in `THIRD_PARTY_NOTICES.md`.
- `tests/` and `docs/manual-verification.md`: automated and manual verification.


For real-parser live editing regression checks:

```sh
cargo build --example editor-fixture
node tests/live-editor.cjs
```

The GitHub Actions workflow runs Rust formatting, tests, Clippy, and UI checks on Linux, Windows, and macOS, and builds native bundles on each platform. Node.js is needed only for these UI checks and bundle verification.

## License

Folio is licensed under [MIT](LICENSE). Bundled preview libraries and fonts retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
