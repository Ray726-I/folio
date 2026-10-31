#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod document;
mod markdown;
mod renderer;
mod theme;

use document::{Document, OpenDocument};
use renderer::{AcceptOutcome, CancelRequest, PickerKind, RenderRequest, RenderResult, Transport};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mdtxt"];
const DEFAULT_INSPECTED_LIMIT: usize = 10_000;
const DEFAULT_OUTPUT_LIMIT: usize = 5_000;
const DEFAULT_DEPTH_LIMIT: usize = 12;

#[derive(Default)]
struct AppState {
    document: Mutex<Option<OpenDocument>>,
    folder: Mutex<Option<PathBuf>>,
    pending: Mutex<Vec<String>>,
    picker_active: Mutex<bool>,
    renderer: Mutex<Transport>,
    renderer_creation: Mutex<()>,
    renderer_recycling: Mutex<bool>,
    renderer_handoff: Mutex<()>,
    /// Set once the main window has been shown, either by the frontend calling
    /// `ready` or by the startup fallback. Test-and-set keeps `ready`
    /// idempotent and the fallback from re-showing a visible window.
    shown: AtomicBool,
}

#[derive(Clone, Copy, Debug)]
struct EnumerationLimits {
    inspected: usize,
    output: usize,
    depth: usize,
}

impl Default for EnumerationLimits {
    fn default() -> Self {
        EnumerationLimits {
            inspected: DEFAULT_INSPECTED_LIMIT,
            output: DEFAULT_OUTPUT_LIMIT,
            depth: DEFAULT_DEPTH_LIMIT,
        }
    }
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
    truncated: bool,
}

#[tauri::command(async)]
fn browse_directory(
    path: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<BrowserListing, String> {
    renderer::ensure_main(webview.label())?;
    let requested = path
        .map(PathBuf::from)
        .or_else(|| app.path().home_dir().ok())
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("/"));
    browse_directory_with_limits(&requested, EnumerationLimits::default())
}

fn browse_directory_with_limits(
    requested: &Path,
    limits: EnumerationLimits,
) -> Result<BrowserListing, String> {
    let path = requested
        .canonicalize()
        .map_err(|error| format!("Could not open folder: {error}"))?;
    if !path.is_dir() {
        return Err("This path is not a folder.".into());
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    let children =
        fs::read_dir(&path).map_err(|error| format!("Could not read folder: {error}"))?;
    for (inspected, child) in children.enumerate() {
        if inspected >= limits.inspected {
            truncated = true;
            break;
        }
        let Ok(child) = child else {
            continue;
        };
        let child_path = child.path();
        let name = child.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let directory = child_path.is_dir();
        if directory || (child_path.is_file() && is_markdown(&child_path)) {
            if entries.len() >= limits.output {
                truncated = true;
                break;
            }
            entries.push(FolderEntry {
                path: child_path.to_string_lossy().into(),
                name,
                depth: 0,
                directory,
            });
        }
    }
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
        truncated,
    })
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            MARKDOWN_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn scan_folder(root: &Path) -> Result<(Vec<FolderEntry>, bool, usize), String> {
    scan_folder_with_limits(root, EnumerationLimits::default())
}

fn scan_folder_with_limits(
    root: &Path,
    limits: EnumerationLimits,
) -> Result<(Vec<FolderEntry>, bool, usize), String> {
    fn visit(
        root: &Path,
        directory: &Path,
        depth: usize,
        entries: &mut Vec<FolderEntry>,
        truncated: &mut bool,
        skipped: &mut usize,
        limits: EnumerationLimits,
    ) -> Result<(), String> {
        if entries.len() >= limits.output {
            *truncated = true;
            return Ok(());
        }
        let mut children = Vec::new();
        let read_dir = match fs::read_dir(directory) {
            Ok(children) => children,
            Err(error) if depth == 0 => {
                return Err(format!("Could not read folder: {error}"));
            }
            Err(_) => {
                *skipped += 1;
                return Ok(());
            }
        };
        for (inspected, child) in read_dir.enumerate() {
            if inspected >= limits.inspected {
                *truncated = true;
                break;
            }
            match child {
                Ok(child) => children.push(child),
                Err(_) => *skipped += 1,
            }
        }
        children.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
        for child in children {
            if entries.len() >= limits.output {
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
                if depth < limits.depth {
                    visit(root, &path, depth + 1, entries, truncated, skipped, limits)?;
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
    visit(
        root,
        root,
        0,
        &mut entries,
        &mut truncated,
        &mut skipped,
        limits,
    )?;
    Ok((entries, truncated, skipped))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    paths: Vec<String>,
    theme: Option<theme::Theme>,
    platform: &'static str,
}

#[tauri::command(async)]
fn bootstrap(
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Bootstrap, String> {
    renderer::ensure_main(webview.label())?;
    Ok(Bootstrap {
        paths: std::mem::take(&mut *state.pending.lock().unwrap()),
        theme: theme::current(),
        platform: std::env::consts::OS,
    })
}

#[tauri::command(async)]
fn open_document(
    path: String,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Document, String> {
    renderer::ensure_main(webview.label())?;
    if *state.picker_active.lock().unwrap() {
        return Err("Finish choosing a file or folder first.".into());
    }
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
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<FolderListing, String> {
    renderer::ensure_main(webview.label())?;
    if *state.picker_active.lock().unwrap() {
        return Err("Finish choosing a file or folder first.".into());
    }
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
fn path_is_directory(path: String, webview: tauri::Webview) -> Result<bool, String> {
    renderer::ensure_main(webview.label())?;
    Ok(Path::new(&path).is_dir())
}

#[tauri::command]
async fn set_task_checked(
    content: String,
    task_index: usize,
    checked: bool,
    webview: tauri::Webview,
) -> Result<String, String> {
    renderer::ensure_main(webview.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        set_task_checked_text(&content, task_index, checked)
    })
    .await
    .map_err(|error| error.to_string())
}

fn set_task_checked_text(content: &str, task_index: usize, checked: bool) -> String {
    markdown::set_task_checked(content, task_index, checked)
}

#[cfg(test)]
mod source_edit_tests {
    use super::*;

    #[test]
    fn checking_one_box_keeps_all_list_text() {
        let original = "# Tasks\n\n- [x] Tables, task lists, and footnotes\n- [x] Code with syntax highlighting\n- [ ] Your next idea\n";
        let updated = set_task_checked_text(original, 2, true);
        assert_eq!(
            updated,
            original.replace("- [ ] Your next idea", "- [x] Your next idea")
        );
    }
}

#[tauri::command]
fn new_document(
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    *state.document.lock().unwrap() = None;
    Ok(())
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
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<Saved>, CommandError> {
    renderer::ensure_main(webview.label()).map_err(CommandError::from)?;
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
}

#[tauri::command]
async fn render_markdown(
    content: String,
    remote_images: bool,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<RenderedMarkdown, String> {
    renderer::ensure_main(webview.label())?;
    let state = Arc::clone(&state);
    let path = state
        .document
        .lock()
        .unwrap()
        .as_ref()
        .map(|document| document.path.clone());
    // Comrak, syntect, ammonia, and base64 encoding are all synchronous; keep
    // them off the async runtime so the renderer stays responsive.
    tauri::async_runtime::spawn_blocking(move || {
        let html = match markdown::render_with_blocks_checked(
            &content,
            path.as_deref().and_then(Path::parent),
            remote_images,
            &markdown::DEFAULT_RENDER_LIMITS,
            false,
        ) {
            Ok((html, _)) => html,
            Err(error) => markdown::preview_limit_html(&error),
        };
        Ok(RenderedMarkdown { html })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
struct HighlightedCode {
    html: String,
}

const MAX_HIGHLIGHT_CODE_BYTES: usize = 1024 * 1024;

/// Highlight one fenced code block directly, without rendering Markdown, so a
/// keystroke inside a fence does not cost a whole document render.
#[tauri::command(async)]
fn highlight_code(
    code: String,
    language: Option<String>,
    webview: tauri::Webview,
) -> Result<HighlightedCode, String> {
    renderer::ensure_main(webview.label())?;
    if code.len() > MAX_HIGHLIGHT_CODE_BYTES {
        return Err(format!(
            "This code block is larger than the {} MiB highlighting limit.",
            MAX_HIGHLIGHT_CODE_BYTES / (1024 * 1024)
        ));
    }
    Ok(HighlightedCode {
        html: markdown::highlight_code(&code, language.as_deref()),
    })
}

#[derive(Serialize)]
struct PreviewCheck {
    limited: Option<String>,
}

#[tauri::command(async)]
fn preview_check(content: String, webview: tauri::Webview) -> Result<PreviewCheck, String> {
    renderer::ensure_main(webview.label())?;
    let limited = markdown::preview_check(&content, &markdown::DEFAULT_RENDER_LIMITS)
        .map(|error| error.kind.as_str().to_string());
    Ok(PreviewCheck { limited })
}

/// Show the main window once the frontend says it is ready. Idempotent: later
/// calls (or the startup fallback) cannot re-show or race the first one.
#[tauri::command]
fn ready(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if window.label() != renderer::MAIN_LABEL {
        return Ok(());
    }
    if !state.shown.swap(true, Ordering::SeqCst) {
        window.show().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_window_zoom(
    scale: f64,
    webview: tauri::Webview,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    if !scale.is_finite() || !(0.6..=2.0).contains(&scale) {
        return Err("Unsupported zoom level.".into());
    }
    window.set_zoom(scale).map_err(|error| error.to_string())
}

#[tauri::command(async)]
fn document_changed(
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    renderer::ensure_main(webview.label())?;
    Ok(state
        .document
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(document::changed))
}

#[tauri::command]
fn set_title(
    name: String,
    dirty: bool,
    webview: tauri::Webview,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    let title = if name.is_empty() {
        "Folio".to_string()
    } else {
        format!("{}{} — Folio", if dirty { "● " } else { "" }, name)
    };
    window.set_title(&title).map_err(|error| error.to_string())
}

#[tauri::command]
fn close_window(
    webview: tauri::Webview,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    {
        let _handoff = state.renderer_handoff.lock().unwrap();
        state.renderer.lock().unwrap().take_all_pending();
    }
    if let Some(renderer) = app.get_webview_window(renderer::RENDERER_LABEL) {
        let _ = renderer.destroy();
    }
    window.destroy().map_err(|error| error.to_string())
}

#[tauri::command]
fn open_link(url: String, webview: tauri::Webview, app: tauri::AppHandle) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
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
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    renderer::ensure_main(webview.label())?;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedTarget {
    path: String,
    kind: PickerKind,
}

struct PickerGuard<'a> {
    active: &'a Mutex<bool>,
}

impl Drop for PickerGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            *active = false;
        }
    }
}

fn begin_picker(state: &AppState) -> Result<PickerGuard<'_>, String> {
    let mut active = state.picker_active.lock().unwrap();
    if *active {
        return Err("A file picker is already open.".into());
    }
    *active = true;
    Ok(PickerGuard {
        active: &state.picker_active,
    })
}

/// Choose a usable starting directory for the native dialog. A selected file
/// starts in its parent folder; anything missing falls back to the supplied
/// default (home or current directory), and a missing default simply opens the
/// platform's normal default location.
fn resolve_picker_start(start: Option<&str>, fallback: Option<PathBuf>) -> Option<PathBuf> {
    let selected = start.and_then(|value| {
        let path = PathBuf::from(value);
        if path.is_dir() {
            Some(path)
        } else if path.is_file() {
            path.parent().map(Path::to_path_buf)
        } else {
            None
        }
    });
    selected
        .filter(|path| path.is_dir())
        .or_else(|| fallback.filter(|path| path.is_dir()))
}

#[tauri::command]
async fn pick_open_target(
    kind: PickerKind,
    start: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<PickedTarget>, String> {
    renderer::ensure_main(webview.label())?;
    let _guard = begin_picker(state.inner())?;
    let fallback = app
        .path()
        .home_dir()
        .ok()
        .or_else(|| std::env::current_dir().ok());
    let start = resolve_picker_start(start.as_deref(), fallback);
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = handle.dialog().file();
        if let Some(start) = start {
            dialog = dialog.set_directory(start);
        }
        match kind {
            PickerKind::File => dialog
                .add_filter("Markdown", MARKDOWN_EXTENSIONS)
                .blocking_pick_file(),
            PickerKind::Folder => dialog.blocking_pick_folder(),
        }
        .map(|file| file.into_path().map_err(|error| error.to_string()))
        .transpose()
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(picked.map(|path| PickedTarget {
        path: path.to_string_lossy().into(),
        kind,
    }))
}

fn ensure_renderer_window(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
    if *state.renderer_recycling.lock().unwrap() {
        return Err("The diagram renderer is restarting. Try again.".into());
    }
    if app.get_webview_window(renderer::RENDERER_LABEL).is_some() {
        return Ok(());
    }
    let _guard = state.renderer_creation.lock().unwrap();
    if *state.renderer_recycling.lock().unwrap() {
        return Err("The diagram renderer is restarting. Try again.".into());
    }
    if app.get_webview_window(renderer::RENDERER_LABEL).is_some() {
        return Ok(());
    }
    state.renderer.lock().unwrap().reset_ready();
    renderer::build_window(app)
        .map_err(|error| format!("Could not start the diagram renderer: {error}"))?;
    Ok(())
}

/// Serializes the recycling decision with request submission. A request can
/// never observe a non-recycling renderer, pause, and then record pending work
/// after finish_recycle has already decided there was none.
fn begin_renderer_recycle(state: &AppState) -> bool {
    let _handoff = state.renderer_handoff.lock().unwrap();
    let mut recycling = state.renderer_recycling.lock().unwrap();
    if *recycling {
        return false;
    }
    *recycling = true;
    state.renderer.lock().unwrap().reset_ready();
    true
}

fn finish_renderer_recycle_locked(state: &AppState) -> bool {
    let _handoff = state.renderer_handoff.lock().unwrap();
    *state.renderer_recycling.lock().unwrap() = false;
    !state.renderer.lock().unwrap().is_empty()
}

fn submit_renderer_request(state: &AppState, request: RenderRequest) -> Result<bool, String> {
    let _handoff = state.renderer_handoff.lock().unwrap();
    if *state.renderer_recycling.lock().unwrap() {
        return Err("The diagram renderer is restarting. Try again.".into());
    }
    state
        .renderer
        .lock()
        .unwrap()
        .submit(request)
        .map_err(|error| error.to_string())
}

/// A dispatched request observed a missing window. Readiness belongs to the
/// actual create/ready path: a stale no-window observation must not reset a
/// replacement that became ready in the meantime.
fn finish_dispatched_missing_window(
    state: &AppState,
    request_id: &str,
    ensure: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    match ensure() {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = state.renderer.lock().unwrap().cancel(request_id);
            Err(error)
        }
    }
}

/// Marks the renderer unavailable before calling `destroy()` (which may remove
/// the window asynchronously), then waits for actual destruction before a
/// rebuild. New requests fail explicitly while recycling instead of attaching
/// to a doomed window and waiting forever.
fn recycle_renderer(app: &tauri::AppHandle, state: &AppState) {
    let _creation = state.renderer_creation.lock().unwrap();
    if !begin_renderer_recycle(state) {
        return;
    }
    drop(_creation);
    if let Some(window) = app.get_webview_window(renderer::RENDERER_LABEL) {
        let _ = window.destroy();
    }
    let app = app.clone();
    std::thread::spawn(move || finish_recycle(app));
}

fn finish_recycle(app: tauri::AppHandle) {
    let state = app.state::<Arc<AppState>>();
    let mut destroyed = false;
    for _ in 0..2 {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if app.get_webview_window(renderer::RENDERER_LABEL).is_none() {
                destroyed = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        if destroyed {
            break;
        }
        if let Some(window) = app.get_webview_window(renderer::RENDERER_LABEL) {
            let _ = window.destroy();
        }
    }

    if !destroyed {
        let survivors = state.renderer.lock().unwrap().take_all_pending();
        for id in survivors {
            emit_render_failure(
                &app,
                &id,
                "timeout",
                "The diagram renderer could not restart.",
            );
        }
        // Keep the unavailable state: new requests fail explicitly rather than
        // attaching to a window that is still registered but unusable.
        return;
    }

    let has_pending = finish_renderer_recycle_locked(state.inner());
    if !has_pending {
        return;
    }
    if let Err(error) = ensure_renderer_window(&app, state.inner()) {
        let survivors = state.renderer.lock().unwrap().take_all_pending();
        for id in survivors {
            emit_render_failure(
                &app,
                &id,
                "timeout",
                &format!("The diagram renderer could not restart: {error}"),
            );
        }
    }
}

fn emit_render_result(app: &tauri::AppHandle, event: renderer::RenderResultEvent) {
    let _ = app.emit_to(renderer::MAIN_LABEL, "mermaid-render-result", event);
}

fn emit_render_failure(app: &tauri::AppHandle, id: &str, code: &str, message: &str) {
    emit_render_result(
        app,
        renderer::RenderResultEvent {
            id: id.into(),
            ok: false,
            svg: None,
            error: Some(renderer::RenderFailure {
                code: code.into(),
                message: message.into(),
            }),
            sanitized: false,
        },
    );
}

#[tauri::command]
async fn mermaid_render_request(
    request: RenderRequest,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    let expired = state.renderer.lock().unwrap().prune(Instant::now());
    let had_expired = !expired.is_empty();
    for id in expired {
        emit_render_failure(
            &app,
            &id,
            "timeout",
            "The diagram renderer did not answer in time.",
        );
    }
    if had_expired {
        recycle_renderer(&app, state.inner());
    }
    let dispatch = submit_renderer_request(state.inner(), request.clone())?;
    if dispatch {
        if app.get_webview_window(renderer::RENDERER_LABEL).is_none() {
            finish_dispatched_missing_window(state.inner(), &request.id, || {
                ensure_renderer_window(&app, state.inner())
            })?;
        } else if let Err(error) = app.emit_to(
            renderer::RENDERER_LABEL,
            "mermaid-render-request",
            request.clone(),
        ) {
            let _ = state.renderer.lock().unwrap().cancel(&request.id);
            recycle_renderer(&app, state.inner());
            return Err(error.to_string());
        }
    } else if app.get_webview_window(renderer::RENDERER_LABEL).is_none() {
        if let Err(error) = ensure_renderer_window(&app, state.inner()) {
            let _ = state.renderer.lock().unwrap().cancel(&request.id);
            return Err(error);
        }
    }
    Ok(())
}

#[tauri::command]
fn mermaid_render_cancel(
    id: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    let outcome = state
        .renderer
        .lock()
        .unwrap()
        .cancel(&id)
        .map_err(|error| error.to_string())?;
    if let Some(dispatched) = outcome {
        let _ = app.emit_to(
            renderer::RENDERER_LABEL,
            "mermaid-render-cancel",
            CancelRequest { id },
        );
        if dispatched {
            // Mermaid has no cancellation API. Destroy the renderer so a
            // cancelled active render cannot keep the queue hung forever.
            recycle_renderer(&app, state.inner());
        }
    }
    Ok(())
}

#[tauri::command(async)]
fn mermaid_renderer_ready(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    renderer::ensure_renderer(webview.label())?;
    let (expired, pending) = {
        let _handoff = state.renderer_handoff.lock().unwrap();
        if *state.renderer_recycling.lock().unwrap() {
            return Ok(());
        }
        let mut transport = state.renderer.lock().unwrap();
        let expired = transport.prune(Instant::now());
        (expired, transport.mark_ready())
    };
    for id in expired {
        emit_render_failure(
            &app,
            &id,
            "timeout",
            "The diagram renderer did not answer in time.",
        );
    }
    let mut first_error = None;
    for request in pending {
        if let Err(error) = app.emit_to(renderer::RENDERER_LABEL, "mermaid-render-request", request)
        {
            first_error.get_or_insert(error);
        }
    }
    match first_error {
        Some(error) => Err(error.to_string()),
        None => Ok(()),
    }
}

#[tauri::command(async)]
fn mermaid_render_result(
    id: String,
    result: RenderResult,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    renderer::ensure_renderer(webview.label())?;
    let outcome = state
        .renderer
        .lock()
        .unwrap()
        .accept(&id, result)
        .map_err(|error| error.to_string())?;
    match outcome {
        AcceptOutcome::Accepted(event) => emit_render_result(&app, event),
        AcceptOutcome::Rejected { id, failure } => emit_render_result(
            &app,
            renderer::RenderResultEvent {
                id,
                ok: false,
                svg: None,
                error: Some(failure),
                sanitized: false,
            },
        ),
    }
    Ok(())
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
mod enumeration_tests {
    use super::*;

    #[test]
    fn browser_listing_stops_before_collecting_unbounded_children() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..20 {
            fs::write(directory.path().join(format!("note-{index}.md")), "# Note").unwrap();
        }
        let listed = browse_directory_with_limits(
            directory.path(),
            EnumerationLimits {
                inspected: 5,
                output: 4,
                depth: 12,
            },
        )
        .unwrap();
        assert!(listed.truncated);
        assert!(listed.entries.len() <= 4);
    }

    #[test]
    fn browser_listing_reports_output_truncation() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..8 {
            fs::write(directory.path().join(format!("note-{index}.md")), "# Note").unwrap();
        }
        let listed = browse_directory_with_limits(
            directory.path(),
            EnumerationLimits {
                inspected: 10_000,
                output: 2,
                depth: 12,
            },
        )
        .unwrap();
        assert!(listed.truncated);
        assert_eq!(listed.entries.len(), 2);
    }

    #[test]
    fn folder_scan_counts_inspected_entries_before_sorting_and_filters() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..10 {
            fs::write(
                directory.path().join(format!("{index}.txt")),
                "not markdown",
            )
            .unwrap();
        }
        fs::write(directory.path().join("z.md"), "# Markdown").unwrap();
        let (entries, truncated, _) = scan_folder_with_limits(
            directory.path(),
            EnumerationLimits {
                inspected: 3,
                output: 5_000,
                depth: 12,
            },
        )
        .unwrap();
        assert!(truncated);
        assert!(
            entries.len() < 2,
            "inspection cap must apply before collecting all children"
        );
    }

    #[test]
    fn folder_scan_depth_cap_reports_truncation() {
        let directory = tempfile::tempdir().unwrap();
        let nested = directory.path().join("one").join("two");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("deep.md"), "# Deep").unwrap();
        let (_, truncated, _) = scan_folder_with_limits(
            directory.path(),
            EnumerationLimits {
                inspected: 10_000,
                output: 5_000,
                depth: 0,
            },
        )
        .unwrap();
        assert!(truncated);
    }
}

#[cfg(test)]
mod picker_tests {
    use super::*;

    #[test]
    fn a_selected_file_starts_the_dialog_in_its_parent_folder() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("note.md");
        fs::write(&file, "# Note").unwrap();
        assert_eq!(
            resolve_picker_start(Some(file.to_str().unwrap()), None),
            Some(directory.path().to_path_buf())
        );
    }

    #[test]
    fn missing_start_falls_back_and_missing_fallback_uses_the_platform_default() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing");
        assert_eq!(
            resolve_picker_start(
                Some(missing.to_str().unwrap()),
                Some(directory.path().to_path_buf())
            ),
            Some(directory.path().to_path_buf())
        );
        assert_eq!(resolve_picker_start(None, None), None);
        assert_eq!(
            resolve_picker_start(None, Some(missing)),
            None,
            "a missing fallback must not become a dialog argument"
        );
    }

    #[test]
    fn duplicate_picker_launches_are_refused_until_the_first_finishes() {
        let state = AppState::default();
        let first = begin_picker(&state).unwrap();
        assert!(begin_picker(&state).is_err());
        drop(first);
        assert!(begin_picker(&state).is_ok());
    }
}

#[cfg(test)]
mod renderer_lifecycle_tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    fn request(id: &str) -> RenderRequest {
        RenderRequest {
            id: id.into(),
            source: "flowchart TD\n A-->B".into(),
            theme: renderer::RendererTheme::default(),
        }
    }

    #[test]
    fn concurrent_submit_and_recycle_never_orphan_a_request() {
        for _ in 0..200 {
            let state = Arc::new(AppState::default());
            let barrier = Arc::new(Barrier::new(2));

            let submit_state = state.clone();
            let submit_barrier = barrier.clone();
            let submit = std::thread::spawn(move || {
                submit_barrier.wait();
                submit_renderer_request(&submit_state, request("race"))
            });

            let recycle_state = state.clone();
            let recycle_barrier = barrier.clone();
            let recycle = std::thread::spawn(move || {
                recycle_barrier.wait();
                begin_renderer_recycle(&recycle_state)
            });

            let submitted = submit.join().unwrap();
            let began_recycle = recycle.join().unwrap();
            let (recycling, pending) = {
                let _handoff = state.renderer_handoff.lock().unwrap();
                (
                    *state.renderer_recycling.lock().unwrap(),
                    !state.renderer.lock().unwrap().is_empty(),
                )
            };

            match submitted {
                Ok(_) => {
                    assert!(
                        began_recycle && (recycling || pending),
                        "a successful submit must be pending or covered by an active recycle"
                    );
                }
                Err(message) => {
                    assert_eq!(message, "The diagram renderer is restarting. Try again.");
                    assert!(!pending, "a rejected submit must not leave orphaned work");
                }
            }
        }
    }

    #[test]
    fn stale_no_window_observation_keeps_replacement_ready() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let state = AppState::default();
        state.renderer.lock().unwrap().mark_ready();
        assert_eq!(
            submit_renderer_request(&state, request("stale-missing-window")),
            Ok(true)
        );

        let ensure_called = AtomicBool::new(false);
        finish_dispatched_missing_window(&state, "stale-missing-window", || {
            ensure_called.store(true, Ordering::SeqCst);
            Ok(())
        })
        .unwrap();
        assert!(ensure_called.load(Ordering::SeqCst));

        let outcome = state
            .renderer
            .lock()
            .unwrap()
            .accept(
                "stale-missing-window",
                RenderResult {
                    svg: Some(
                        "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0\"/></svg>".into(),
                    ),
                    error: None,
                },
            )
            .unwrap();
        assert!(matches!(outcome, AcceptOutcome::Accepted(_)));
    }

    #[test]
    fn immediate_retry_is_serialized_with_recycle_completion() {
        let state = AppState::default();
        assert!(submit_renderer_request(&state, request("before")).is_ok());
        assert!(begin_renderer_recycle(&state));
        assert_eq!(
            submit_renderer_request(&state, request("retry")),
            Err("The diagram renderer is restarting. Try again.".to_string())
        );
        assert!(
            finish_renderer_recycle_locked(&state),
            "survivors must still be pending when recycling finishes"
        );
        assert!(submit_renderer_request(&state, request("after")).is_ok());
        assert!(!state.renderer.lock().unwrap().is_empty());
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
    let _ = app.emit_to(renderer::MAIN_LABEL, "open-files", paths);
    if let Some(window) = app.get_webview_window(renderer::MAIN_LABEL) {
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

pub(crate) fn is_app_navigation(url: &tauri::Url) -> bool {
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
                    std::thread::sleep(Duration::from_secs(10));
                    let current = theme::current();
                    if current != previous {
                        let _ = handle.emit_to(renderer::MAIN_LABEL, "system-theme", &current);
                        previous = current;
                    }
                }
            });
            let cleanup = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(5));
                let state = cleanup.state::<Arc<AppState>>();
                let expired = state.renderer.lock().unwrap().prune(Instant::now());
                let had_expired = !expired.is_empty();
                for id in expired {
                    emit_render_failure(
                        &cleanup,
                        &id,
                        "timeout",
                        "The diagram renderer did not answer in time.",
                    );
                }
                if had_expired {
                    recycle_renderer(&cleanup, state.inner());
                }
            });
            tauri::WebviewWindowBuilder::new(
                app,
                renderer::MAIN_LABEL,
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Folio")
            .inner_size(1120.0, 800.0)
            .min_inner_size(600.0, 440.0)
            .decorations(true)
            .visible(false)
            .on_navigation(is_app_navigation)
            .build()?;
            // A frontend that never calls `ready` (a crash during boot, a broken
            // bundle) must not leave the app permanently invisible.
            let fallback = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(2));
                let state = fallback.state::<Arc<AppState>>();
                if !state.shown.swap(true, Ordering::SeqCst) {
                    if let Some(window) = fallback.get_webview_window(renderer::MAIN_LABEL) {
                        let _ = window.show();
                    }
                }
            });
            #[cfg(debug_assertions)]
            if std::env::var_os("FOLIO_NATIVE_PROBE").is_some() {
                println!("FOLIO_NATIVE_PROBE starting");
                renderer::build_window(app.handle())?;
                renderer::spawn_native_probe(app.handle().clone());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == renderer::RENDERER_LABEL {
                if let tauri::WindowEvent::Destroyed = event {
                    let app = window.app_handle().clone();
                    let state = app.state::<Arc<AppState>>();
                    let recycling = *state.renderer_recycling.lock().unwrap();
                    let has_pending = !state.renderer.lock().unwrap().is_empty();
                    if !recycling
                        && has_pending
                        && app.get_webview_window(renderer::RENDERER_LABEL).is_none()
                    {
                        std::thread::spawn(move || finish_recycle(app));
                    }
                }
                return;
            }
            if window.label() != renderer::MAIN_LABEL {
                return;
            }
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
            highlight_code,
            preview_check,
            ready,
            set_window_zoom,
            document_changed,
            set_title,
            close_window,
            open_link,
            resolve_document_link,
            pick_open_target,
            mermaid_render_request,
            mermaid_render_cancel,
            mermaid_renderer_ready,
            mermaid_render_result
        ])
        .build(tauri::generate_context!())
        .expect("Folio could not start");
    app.run(handle_run_event);
}
