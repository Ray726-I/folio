#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod document;
mod markdown;
mod theme;

use document::{Document, OpenDocument};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
struct AppState {
    document: Mutex<Option<OpenDocument>>,
    folder: Mutex<Option<PathBuf>>,
    pending: Mutex<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderEntry {
    path: String,
    name: String,
    depth: usize,
    directory: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderListing {
    path: String,
    name: String,
    entries: Vec<FolderEntry>,
    truncated: bool,
    skipped: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserListing {
    path: String,
    parent: Option<String>,
    entries: Vec<FolderEntry>,
}

#[tauri::command(async)]
fn browse_directory(path: Option<String>, app: tauri::AppHandle) -> Result<BrowserListing, String> {
    let requested = path
        .map(PathBuf::from)
        .or_else(|| app.path().home_dir().ok())
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("/"));
    let path = requested
        .canonicalize()
        .map_err(|error| format!("Could not open folder: {error}"))?;
    if !path.is_dir() {
        return Err("This path is not a folder.".into());
    }
    let mut entries = fs::read_dir(&path)
        .map_err(|error| format!("Could not read folder: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let child = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                return None;
            }
            let directory = child.is_dir();
            (directory || (child.is_file() && is_markdown(&child))).then_some(FolderEntry {
                path: child.to_string_lossy().into(),
                name,
                depth: 0,
                directory,
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(BrowserListing {
        path: path.to_string_lossy().into(),
        parent: path
            .parent()
            .filter(|parent| *parent != path)
            .map(|parent| parent.to_string_lossy().into()),
        entries,
    })
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "mdown" | "mdtxt"
            )
        })
}

fn scan_folder(root: &Path) -> Result<(Vec<FolderEntry>, bool, usize), String> {
    fn visit(
        root: &Path,
        directory: &Path,
        depth: usize,
        entries: &mut Vec<FolderEntry>,
        truncated: &mut bool,
        skipped: &mut usize,
    ) -> Result<(), String> {
        if entries.len() >= 5000 {
            *truncated = true;
            return Ok(());
        }
        let mut children = match fs::read_dir(directory) {
            Ok(children) => children.filter_map(Result::ok).collect::<Vec<_>>(),
            Err(error) if depth == 0 => {
                return Err(format!("Could not read folder: {error}"));
            }
            Err(_) => {
                *skipped += 1;
                return Ok(());
            }
        };
        children.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
        for child in children {
            if entries.len() >= 5000 {
                *truncated = true;
                break;
            }
            let path = child.path();
            let name = child.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    *skipped += 1;
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                entries.push(FolderEntry {
                    path: path.to_string_lossy().into(),
                    name,
                    depth,
                    directory: true,
                });
                if depth < 12 {
                    visit(root, &path, depth + 1, entries, truncated, skipped)?;
                } else {
                    *truncated = true;
                }
            } else if metadata.is_file() && is_markdown(&path) && path.starts_with(root) {
                entries.push(FolderEntry {
                    path: path.to_string_lossy().into(),
                    name,
                    depth,
                    directory: false,
                });
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    let mut skipped = 0;
    visit(root, root, 0, &mut entries, &mut truncated, &mut skipped)?;
    Ok((entries, truncated, skipped))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    paths: Vec<String>,
    theme: Option<theme::Theme>,
    platform: &'static str,
}

#[tauri::command]
fn bootstrap(state: tauri::State<'_, Arc<AppState>>) -> Bootstrap {
    Bootstrap {
        paths: std::mem::take(&mut *state.pending.lock().unwrap()),
        theme: theme::current(),
        platform: std::env::consts::OS,
    }
}

#[tauri::command(async)]
fn open_document(path: String, state: tauri::State<'_, Arc<AppState>>) -> Result<Document, String> {
    let (document, data) = document::load(Path::new(&path))?;
    let mut folder = state.folder.lock().unwrap();
    if folder
        .as_ref()
        .is_some_and(|root| !document.path.starts_with(root))
    {
        *folder = None;
    }
    drop(folder);
    *state.document.lock().unwrap() = Some(document);
    Ok(data)
}

#[tauri::command(async)]
fn open_folder(
    path: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<FolderListing, String> {
    let path = Path::new(&path)
        .canonicalize()
        .map_err(|error| format!("Could not open folder: {error}"))?;
    if !path.is_dir() {
        return Err("Choose a folder to open.".into());
    }
    let (entries, truncated, skipped) = scan_folder(&path)?;
    *state.folder.lock().unwrap() = Some(path.clone());
    Ok(FolderListing {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        path: path.to_string_lossy().into(),
        entries,
        truncated,
        skipped,
    })
}

#[tauri::command]
fn path_is_directory(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
fn set_task_checked(content: String, task_index: usize, checked: bool) -> String {
    markdown::set_task_checked(&content, task_index, checked)
}

#[cfg(test)]
mod source_edit_tests {
    use super::*;

    #[test]
    fn checking_one_box_keeps_all_list_text() {
        let original = "# Tasks\n\n- [x] Tables, task lists, and footnotes\n- [x] Code with syntax highlighting\n- [ ] Your next idea\n";
        let updated = set_task_checked(original.into(), 2, true);
        assert_eq!(
            updated,
            original.replace("- [ ] Your next idea", "- [x] Your next idea")
        );
    }
}

#[tauri::command]
fn new_document(state: tauri::State<'_, Arc<AppState>>) {
    *state.document.lock().unwrap() = None;
}

#[derive(Serialize)]
struct Saved {
    path: String,
    name: String,
}

#[derive(Serialize)]
struct CommandError {
    code: &'static str,
    message: String,
}

impl From<String> for CommandError {
    fn from(message: String) -> Self {
        CommandError {
            code: "error",
            message,
        }
    }
}

impl From<&str> for CommandError {
    fn from(message: &str) -> Self {
        CommandError {
            code: "error",
            message: message.into(),
        }
    }
}

impl From<document::SaveError> for CommandError {
    fn from(error: document::SaveError) -> Self {
        CommandError {
            code: error.code(),
            message: error.message().into(),
        }
    }
}

#[tauri::command(async)]
fn save_document(
    content: String,
    save_as: bool,
    force: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<Saved>, CommandError> {
    let original = state.document.lock().unwrap().clone();
    let current_path = original.as_ref().map(|document| document.path.clone());
    let path = match (save_as, current_path.as_ref()) {
        (false, Some(path)) => path.clone(),
        (_, current_path) => {
            let mut dialog = app
                .dialog()
                .file()
                .add_filter("Markdown", &["md", "markdown"]);
            if let Some(path) = current_path {
                dialog = dialog
                    .set_directory(path.parent().unwrap_or(Path::new(".")))
                    .set_file_name(path.file_name().unwrap_or_default().to_string_lossy());
            } else {
                dialog = dialog.set_file_name("Untitled.md");
            }
            match dialog.blocking_save_file() {
                Some(file) => file.into_path().map_err(|e| e.to_string())?,
                None => return Ok(None),
            }
        }
    };
    let mut current = state.document.lock().unwrap();
    if current
        .as_ref()
        .map(|document| (&document.path, &document.fingerprint))
        != original
            .as_ref()
            .map(|document| (&document.path, &document.fingerprint))
    {
        return Err("The open document changed while saving. Try again.".into());
    }
    let saved =
        document::save(&path, &content, current.as_ref(), force).map_err(CommandError::from)?;
    let payload = Saved {
        path: saved.path.to_string_lossy().into(),
        name: saved
            .path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
    };
    *current = Some(saved);
    Ok(Some(payload))
}

#[derive(Serialize)]
struct RenderedMarkdown {
    html: String,
    blocks: Vec<markdown::EditBlock>,
}

#[tauri::command(async)]
fn render_markdown(
    content: String,
    remote_images: bool,
    state: tauri::State<'_, Arc<AppState>>,
) -> RenderedMarkdown {
    let path = state
        .document
        .lock()
        .unwrap()
        .as_ref()
        .map(|document| document.path.clone());
    let (html, blocks) = markdown::render_with_blocks(
        &content,
        path.as_deref().and_then(Path::parent),
        remote_images,
    );
    RenderedMarkdown { html, blocks }
}

#[tauri::command]
fn set_window_zoom(scale: f64, window: tauri::WebviewWindow) -> Result<(), String> {
    if !scale.is_finite() || !(0.6..=2.0).contains(&scale) {
        return Err("Unsupported zoom level.".into());
    }
    window.set_zoom(scale).map_err(|error| error.to_string())
}

#[tauri::command(async)]
fn document_changed(state: tauri::State<'_, Arc<AppState>>) -> bool {
    state
        .document
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(document::changed)
}

#[tauri::command]
fn set_title(name: String, dirty: bool, window: tauri::WebviewWindow) {
    let title = if name.is_empty() {
        "Folio".to_string()
    } else {
        format!("{}{} — Folio", if dirty { "● " } else { "" }, name)
    };
    let _ = window.set_title(&title);
}

#[tauri::command]
fn close_window(window: tauri::WebviewWindow) {
    let _ = window.destroy();
}

#[tauri::command]
fn open_link(url: String, app: tauri::AppHandle) -> Result<(), String> {
    let scheme = url.to_ascii_lowercase();
    if !(scheme.starts_with("https://")
        || scheme.starts_with("http://")
        || scheme.starts_with("mailto:"))
    {
        return Err("Only web and email links can open externally.".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn resolve_document_link(
    link: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let current = state.document.lock().unwrap();
    let base = current
        .as_ref()
        .and_then(|document| document.path.parent())
        .ok_or("Save this document before opening relative links.")?;
    let path = resolve_link_path(base, &link)?;
    Ok(path.to_string_lossy().into())
}

fn resolve_link_path(base: &Path, link: &str) -> Result<PathBuf, String> {
    if link.contains(':') || Path::new(link).is_absolute() {
        return Err("Unsupported file link.".into());
    }
    let decoded = percent_encoding::percent_decode_str(link.split('#').next().unwrap_or(""))
        .decode_utf8()
        .map_err(|e| e.to_string())?;
    let base = base.canonicalize().map_err(|e| e.to_string())?;
    let path = base
        .join(decoded.as_ref())
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(&base) {
        return Err("This link points outside the document folder.".into());
    }
    if !path.is_file() {
        return Err("This link does not point to a file.".into());
    }
    Ok(path)
}

#[cfg(all(test, unix))]
mod folder_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn unreadable_subdirectories_are_skipped_instead_of_failing_the_folder() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("visible.md"), "# Visible").unwrap();
        let locked = directory.path().join("locked");
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("hidden.md"), "# Hidden").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        let result = scan_folder(directory.path());
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        let (entries, _, skipped) = result.unwrap();

        assert!(entries.iter().any(|entry| entry.name == "visible.md"));
        assert_eq!(skipped, 1);
    }
}

#[cfg(test)]
mod navigation_tests {
    use super::*;

    fn url(value: &str) -> tauri::Url {
        value.parse().unwrap()
    }

    #[test]
    fn only_the_app_origin_is_allowed_as_a_page() {
        assert!(is_app_navigation(&url("tauri://localhost/index.html")));
        assert!(is_app_navigation(&url("ipc://localhost/index.html")));
        assert!(is_app_navigation(&url("http://tauri.localhost/index.html")));
        assert!(is_app_navigation(&url("about:blank")));
        assert!(!is_app_navigation(&url("tauri://evil.test/index.html")));
        assert!(!is_app_navigation(&url("ipc://evil.test/index.html")));
        assert!(!is_app_navigation(&url(
            "http://tauri.localhost:8080/index.html"
        )));
        assert!(!is_app_navigation(&url("http://ipc.localhost/index.html")));
        assert!(!is_app_navigation(&url("about:srcdoc")));
        assert!(!is_app_navigation(&url("https://example.com/")));
        assert!(!is_app_navigation(&url("data:text/html,boom")));
        assert!(!is_app_navigation(&url("file:///tmp/note.md")));
        if cfg!(dev) {
            assert!(is_app_navigation(&url("http://127.0.0.1:1430/index.html")));
            assert!(is_app_navigation(&url("http://localhost:1430/index.html")));
            assert!(!is_app_navigation(&url("http://127.0.0.2:1430/index.html")));
        }
    }
}

#[cfg(test)]
mod link_tests {
    use super::*;

    #[test]
    fn relative_links_cannot_escape_the_document_folder() {
        let directory = tempfile::tempdir().unwrap();
        let notes = directory.path().join("notes");
        fs::create_dir(&notes).unwrap();
        fs::write(notes.join("inside.md"), "inside").unwrap();
        fs::write(directory.path().join("outside.md"), "outside").unwrap();

        assert!(resolve_link_path(&notes, "inside.md#section").is_ok());
        assert!(resolve_link_path(&notes, "../outside.md").is_err());
        assert!(resolve_link_path(&notes, "%2e%2e/outside.md").is_err());
    }
}

fn paths_from_arguments(arguments: &[String], cwd: &Path) -> Vec<String> {
    arguments
        .iter()
        .skip(1)
        .filter(|argument| !argument.starts_with('-'))
        .map(|argument| {
            let path = PathBuf::from(argument);
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
            .to_string_lossy()
            .into_owned()
        })
        .collect()
}

fn queue_paths(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let state = app.state::<Arc<AppState>>();
    state.pending.lock().unwrap().extend(paths.iter().cloned());
    let _ = app.emit("open-files", paths);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Only the app's own origin may become a top-level page. External links go
/// through the opener plugin, and middle-click/drag on a preview link must not
/// replace the UI with a remote document.
fn is_loopback_host(url: &tauri::Url) -> bool {
    matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1")
    )
}

fn is_app_navigation(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "ipc" => url.host_str() == Some("localhost"),
        "about" => url.path() == "blank",
        "http" | "https" => {
            // The dev server can bind to 127.0.0.1 (Tauri's default) or localhost.
            // Production pages only ever load from the app's own origin.
            (url.host_str() == Some("tauri.localhost") && url.port().is_none())
                || (cfg!(dev) && is_loopback_host(url))
        }
        _ => false,
    }
}

#[cfg(target_os = "macos")]
fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    if let tauri::RunEvent::Opened { urls } = event {
        let paths = urls
            .iter()
            .filter_map(|url| url.to_file_path().ok())
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        queue_paths(app, paths);
    }
}

#[cfg(not(target_os = "macos"))]
fn handle_run_event(_app: &tauri::AppHandle, _event: tauri::RunEvent) {}

fn main() {
    let arguments: Vec<_> = std::env::args().collect();
    if arguments
        .iter()
        .any(|argument| argument == "--help" || argument == "-h")
    {
        println!("Folio — a Markdown reader and editor\n\nUsage: folio [FILE|FOLDER]\n\nOpen a Markdown file or folder directly, or launch without a path to use the picker.\nCtrl+O open · Ctrl+S save · Ctrl+E read/edit · Ctrl+= / Ctrl+- window zoom");
        return;
    }
    if arguments.iter().any(|argument| argument == "--version") {
        println!("Folio {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let state = Arc::new(AppState::default());
    *state.pending.lock().unwrap() =
        paths_from_arguments(&arguments, &std::env::current_dir().unwrap_or_default());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            move |app, arguments, cwd| {
                queue_paths(app, paths_from_arguments(&arguments, Path::new(&cwd)));
            },
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut previous = theme::current();
                loop {
                    std::thread::sleep(Duration::from_secs(2));
                    let current = theme::current();
                    if current != previous {
                        let _ = handle.emit("system-theme", &current);
                        previous = current;
                    }
                }
            });
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Folio")
            .inner_size(1120.0, 800.0)
            .min_inner_size(600.0, 440.0)
            .decorations(true)
            .on_navigation(is_app_navigation)
            .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("request-close", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            open_document,
            open_folder,
            browse_directory,
            path_is_directory,
            set_task_checked,
            new_document,
            save_document,
            render_markdown,
            set_window_zoom,
            document_changed,
            set_title,
            close_window,
            open_link,
            resolve_document_link
        ])
        .build(tauri::generate_context!())
        .expect("Folio could not start");
    app.run(handle_run_event);
}
