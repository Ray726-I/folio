#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod document;
mod file_operations;
mod markdown;
mod native_menu;
mod native_move;
mod recovery;
mod renderer;
mod theme;
mod workspace;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use document::Document;
#[cfg(target_os = "linux")]
use gtk::{gdk::EventType, prelude::*};
use native_menu::sync_native_menu;
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
    documents: Mutex<workspace::Registry>,
    recovery: Mutex<Option<recovery::Store>>,
    folder: Mutex<Option<PathBuf>>,
    window_folders:
        Mutex<std::collections::HashMap<String, (PathBuf, Arc<file_operations::Scope>)>>,
    window_pending: Mutex<std::collections::HashMap<String, Vec<String>>>,
    window_transfers: Mutex<std::collections::HashMap<String, WindowTransfer>>,
    folder_scope: Mutex<Option<Arc<file_operations::Scope>>>,
    pending: Mutex<Vec<String>>,
    picker_active: Mutex<bool>,
    renderer: Mutex<Transport>,
    render_routes: Mutex<renderer::Routes>,
    renderer_creation: Mutex<()>,
    renderer_recycling: Mutex<bool>,
    renderer_handoff: Mutex<()>,
    quit: Mutex<workspace::QuitCoordinator>,
    /// Recovery records to clear once a close_window really reaches native
    /// destruction. Never persisted before Destroyed.
    window_recovery_cleanup: Mutex<std::collections::HashMap<String, Vec<DiscardDocument>>>,
    /// Labels whose frontend finished `start()` and installed its event
    /// listeners. A quit must not target a newly created webview before this.
    window_ready: Mutex<std::collections::HashSet<String>>,
    /// Set once the main window has been shown, either by the frontend calling
    /// `ready` or by the startup fallback. Test-and-set keeps `ready`
    /// idempotent and the fallback from re-showing a visible window.
    shown: AtomicBool,
    window_shown: Mutex<std::collections::HashSet<String>>,
    /// Linux touchpad pinch gestures are blocked unless the user opts in.
    touchpad_zoom: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingWindowTransfer {
    token: String,
    document: serde_json::Value,
}
struct WindowTransfer {
    token: String,
    document_id: String,
    source: String,
    session: Option<serde_json::Value>,
    completion: std::sync::mpsc::Sender<()>,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscardDocument {
    document_id: String,
}

/// Holds the quit coordinator's creation gate for the whole synchronous window
/// construction. Quit cannot snapshot labels while a new workspace is between
/// creation and registration, and a quit already running rejects creation.
struct WindowCreationGuard {
    state: Arc<AppState>,
}

impl WindowCreationGuard {
    fn begin(state: &Arc<AppState>) -> Result<Self, String> {
        let mut quit = state.quit.lock().unwrap();
        if !quit.begin_window_creation() {
            return Err("Finish quitting before creating another window.".into());
        }
        drop(quit);
        Ok(Self {
            state: state.clone(),
        })
    }
}

impl Drop for WindowCreationGuard {
    fn drop(&mut self) {
        self.state.quit.lock().unwrap().finish_window_creation();
    }
}

fn register_created_window(state: &AppState, label: &str) {
    let _quit = state.quit.lock().unwrap();
    workspace::register_window(label);
}
fn cleanup_workspace(state: &AppState, label: &str) {
    workspace::unregister_window(label);
    state.window_folders.lock().unwrap().remove(label);
    state.window_pending.lock().unwrap().remove(label);
    state.window_shown.lock().unwrap().remove(label);
    state.window_ready.lock().unwrap().remove(label);
    let mut transfers = state.window_transfers.lock().unwrap();
    let mut registry = state.documents.lock().unwrap();
    transfers.retain(|destination, transfer| {
        if destination == label || transfer.source == label {
            registry.rollback_transfer(&transfer.document_id);
            false
        } else {
            true
        }
    });
    let ids: Vec<_> = registry
        .sessions
        .keys()
        .filter(|id| registry.owner(id) == label)
        .cloned()
        .collect();
    for id in ids {
        let _ = registry.close(&id);
    }
    registry.window_active.remove(label);
    registry.end_close(label);
}
#[tauri::command(async)]
fn new_window(
    document_id: Option<String>,
    session: Option<serde_json::Value>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    renderer::ensure_main(webview.label())?;
    let label = format!("workspace-{}", workspace::fresh_id());
    // Creation and quit are serialized: quit cannot start while this window is
    // between creation and registration, and this command cannot start once a
    // quit sequence owns the app.
    let _creation = WindowCreationGuard::begin(state.inner())?;
    let (sender, receiver) = std::sync::mpsc::channel();
    if let Some(id) = &document_id {
        let session = session.ok_or("Capture the document before moving it.")?;
        if session
            .get("documentId")
            .and_then(serde_json::Value::as_str)
            != Some(id.as_str())
        {
            return Err("The transfer snapshot does not match its document.".into());
        }
        if serde_json::to_vec(&session)
            .map_err(|e| e.to_string())?
            .len()
            > 32 * 1024 * 1024
        {
            return Err("This document snapshot is too large to move to another window.".into());
        }
        let token = workspace::fresh_id();
        state
            .documents
            .lock()
            .unwrap()
            .begin_transfer(webview.label(), &label, id, &token)?;
        state.window_transfers.lock().unwrap().insert(
            label.clone(),
            WindowTransfer {
                token,
                document_id: id.clone(),
                source: webview.label().into(),
                session: Some(session),
                completion: sender,
            },
        );
    } else if session.is_some() {
        return Err("A transfer snapshot requires a document ID.".into());
    }
    register_created_window(&state, &label);
    let built =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html".into()))
            .title("Folio")
            .inner_size(1120.0, 800.0)
            .min_inner_size(600.0, 440.0)
            .decorations(true)
            .visible(false)
            .on_navigation(is_app_navigation)
            .build();
    let window = match built {
        Ok(window) => window,
        Err(error) => {
            cleanup_workspace(&state, &label);
            return Err(format!("Could not create a window: {error}"));
        }
    };
    #[cfg(target_os = "linux")]
    {
        let gesture_state = state.inner().clone();
        if let Err(error) = window.with_webview(move |webview| {
            webview.inner().connect_event(move |_, event| {
                if event.event_type() == EventType::TouchpadPinch
                    && !gesture_state.touchpad_zoom.load(Ordering::SeqCst)
                {
                    gtk::glib::Propagation::Stop
                } else {
                    gtk::glib::Propagation::Proceed
                }
            });
        }) {
            cleanup_workspace(&state, &label);
            let _ = window.destroy();
            return Err(error.to_string());
        }
    }
    if document_id.is_none() {
        let fallback = app.clone();
        let fallback_label = label.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            if workspace::ensure_window(&fallback_label).is_err() {
                return;
            }
            let state = fallback.state::<Arc<AppState>>();
            if state
                .window_shown
                .lock()
                .unwrap()
                .insert(fallback_label.clone())
            {
                if let Some(window) = fallback.get_webview_window(&fallback_label) {
                    let _ = window.show();
                }
            }
        });
    }
    if let Some(document_id) = &document_id {
        if receiver.recv_timeout(Duration::from_secs(30)).is_err() {
            // Hold the transfer map while deciding rollback, so an acknowledgement
            // and timeout cannot both commit opposite ownership outcomes.
            let mut transfers = state.window_transfers.lock().unwrap();
            if let Some(transfer) = transfers.remove(&label) {
                state
                    .documents
                    .lock()
                    .unwrap()
                    .rollback_transfer(&transfer.document_id);
                drop(transfers);
                cleanup_workspace(&state, &label);
                let _ = window.destroy();
                return Err(
                    "The new window did not accept the document. Your original tab is still open."
                        .into(),
                );
            }
            // An acknowledgement committed just before the timeout fired.
            if state.documents.lock().unwrap().owner(document_id) != label {
                drop(transfers);
                cleanup_workspace(&state, &label);
                let _ = window.destroy();
                return Err(
                    "The window transfer was cancelled. Your original tab is still open.".into(),
                );
            }
        }
    }
    Ok(label)
}
#[tauri::command(async)]
fn finish_window_transfer(
    token: String,
    document_id: String,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    let mut transfers = state.window_transfers.lock().unwrap();
    let transfer = transfers
        .get(webview.label())
        .ok_or("No pending window transfer")?;
    if transfer.token != token || transfer.document_id != document_id || transfer.session.is_some()
    {
        return Err("Invalid window transfer acknowledgement".into());
    }
    state
        .documents
        .lock()
        .unwrap()
        .finish_transfer(webview.label(), &document_id, &token)?;
    let transfer = transfers.remove(webview.label()).unwrap();
    let _ = transfer.completion.send(());
    Ok(())
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
    window_label: String,
    pending_transfer: Option<PendingWindowTransfer>,
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
        paths: if webview.label() == "main" {
            std::mem::take(&mut *state.pending.lock().unwrap())
        } else {
            state
                .window_pending
                .lock()
                .unwrap()
                .remove(webview.label())
                .unwrap_or_default()
        },
        window_label: webview.label().into(),
        pending_transfer: state
            .window_transfers
            .lock()
            .unwrap()
            .get_mut(webview.label())
            .and_then(|transfer| {
                transfer
                    .session
                    .take()
                    .map(|document| PendingWindowTransfer {
                        token: transfer.token.clone(),
                        document,
                    })
            }),
        theme: theme::current(),
        platform: std::env::consts::OS,
    })
}

#[tauri::command(async)]
fn open_document(
    path: String,
    reuse_existing: Option<bool>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Document, String> {
    renderer::ensure_main(webview.label())?;
    if *state.picker_active.lock().unwrap() {
        return Err("Finish choosing a file or folder first.".into());
    }
    if let Ok(path) = Path::new(&path).canonicalize() {
        let registry = state.documents.lock().unwrap();
        if let Some((id, _)) = registry
            .sessions
            .iter()
            .find(|(_, doc)| doc.as_ref().is_some_and(|doc| doc.path == path))
        {
            if registry.owner(id) != webview.label() {
                if let Some(owner) = app.get_webview_window(registry.owner(id)) {
                    let _ = owner.unminimize();
                    let _ = owner.set_focus();
                }
                return Err(
                    "This file is open in another window. Its owning window has been focused."
                        .into(),
                );
            }
        }
    }
    let (_, data) = state.documents.lock().unwrap().open_for(
        webview.label(),
        Path::new(&path),
        reuse_existing.unwrap_or(true),
    )?;
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
    if webview.label() == "main" {
        *state.folder_scope.lock().unwrap() = Some(Arc::new(file_operations::Scope::new(&path)?));
        *state.folder.lock().unwrap() = Some(path.clone());
    }
    state.window_folders.lock().unwrap().insert(
        webview.label().into(),
        (path.clone(), Arc::new(file_operations::Scope::new(&path)?)),
    );
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSessionChange {
    document_id: String,
    path: Option<String>,
    name: String,
}
#[derive(Serialize)]
struct FileOperationResult {
    #[serde(flatten)]
    outcome: file_operations::Outcome,
    documents: Vec<FileSessionChange>,
}
#[tauri::command(async)]
fn file_operation(
    action: String,
    path: String,
    destination: Option<String>,
    content: Option<String>,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<FileOperationResult, String> {
    renderer::ensure_main(webview.label())?;
    let folder = state
        .window_folders
        .lock()
        .unwrap()
        .get(webview.label())
        .map(|(_, scope)| scope.clone())
        .ok_or("Open a workspace folder first.")?;
    let mut registry = state.documents.lock().unwrap();
    if ["move", "rename", "trash"].contains(&action.as_str()) {
        let source = folder.validated_source(Path::new(&path))?;
        for (id, document) in &registry.sessions {
            if document.as_ref().is_some_and(|doc| {
                doc.path.starts_with(&source)
                    || doc
                        .path
                        .ancestors()
                        .any(|ancestor| same_file::is_same_file(ancestor, &source).unwrap_or(false))
            }) {
                registry.id_for(webview.label(), Some(id), true).map_err(|_| "An affected file belongs to another window or is moving. Close or move its tab first.")?;
            }
        }
    }
    perform_workspace_operation(
        &mut registry,
        &folder,
        &action,
        Path::new(&path),
        destination.as_deref().map(Path::new),
        content.as_deref(),
    )
}
fn perform_workspace_operation(
    registry: &mut workspace::Registry,
    folder: &file_operations::Scope,
    action: &str,
    path: &Path,
    destination: Option<&Path>,
    content: Option<&str>,
) -> Result<FileOperationResult, String> {
    let normalized;
    let path = if ["move", "rename", "trash"].contains(&action) {
        normalized = folder.validated_source(path)?;
        normalized.as_path()
    } else {
        path
    };
    let source_directory = path.is_dir();
    let mut affected = Vec::new();
    if ["move", "rename", "trash"].contains(&action) {
        for (id, document) in &registry.sessions {
            let Some(document) = document else {
                continue;
            };
            let ancestor = document.path.ancestors().find(|ancestor| {
                *ancestor == path
                    || (source_directory
                        && same_file::is_same_file(ancestor, path).unwrap_or(false))
            });
            if let Some(ancestor) = ancestor {
                if document::changed_exact(document) {
                    return Err("An affected open file changed on disk. Reload it before moving or trashing it.".into());
                }
                affected.push((
                    id.clone(),
                    document.clone(),
                    document.path.strip_prefix(ancestor).unwrap().to_path_buf(),
                ));
            }
        }
    }
    let outcome = folder.perform(action, path, destination, content)?;
    let mut documents = Vec::new();
    if outcome.old_path.is_some() {
        for (id, mut document, suffix) in affected {
            match &outcome.path {
                Some(path) => {
                    document.path = if suffix.as_os_str().is_empty() {
                        PathBuf::from(path)
                    } else {
                        Path::new(path).join(suffix)
                    };
                    documents.push(FileSessionChange {
                        document_id: id.clone(),
                        path: Some(document.path.to_string_lossy().into()),
                        name: document
                            .path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into(),
                    });
                    registry.sessions.insert(id, Some(document));
                }
                None => {
                    documents.push(FileSessionChange {
                        document_id: id.clone(),
                        path: None,
                        name: document
                            .path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into(),
                    });
                    registry.recovery_origins.insert(
                        id.clone(),
                        (
                            Some(document.path.to_string_lossy().into()),
                            Some(document.fingerprint.clone()),
                        ),
                    );
                    registry
                        .encoding
                        .insert(id.clone(), (document.bom, document.crlf));
                    registry.sessions.insert(id, None);
                }
            }
        }
    }
    Ok(FileOperationResult { outcome, documents })
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
) -> Result<NewDocument, String> {
    renderer::ensure_main(webview.label())?;
    Ok(NewDocument {
        document_id: state
            .documents
            .lock()
            .unwrap()
            .new_document_for(webview.label()),
        revision: 0,
    })
}

fn recovery_store<'a>(
    state: &'a AppState,
    app: &tauri::AppHandle,
) -> Result<std::sync::MutexGuard<'a, Option<recovery::Store>>, String> {
    let mut store = state.recovery.lock().unwrap();
    if store.is_none() {
        *store = Some(recovery::Store::new(
            app.path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("recovery-v1"),
        ));
    }
    Ok(store)
}

#[tauri::command(async)]
fn activate_document(
    document_id: String,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    let mut registry = state.documents.lock().unwrap();
    registry.activate_for(webview.label(), &document_id)?;
    Ok(())
}
#[tauri::command(async)]
fn close_document(
    document_id: String,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    let mut registry = state.documents.lock().unwrap();
    registry.id_for(webview.label(), Some(&document_id), true)?;
    registry.close(&document_id)
}
#[tauri::command(async)]
fn recovery_write(
    document_id: String,
    revision: u64,
    content: String,
    name: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<u64, String> {
    renderer::ensure_main(webview.label())?;
    // Keep the registry locked through durability: close/save cannot invalidate
    // the native baseline while a snapshot is being captured.
    let registry = state.documents.lock().unwrap();
    registry.id_for(webview.label(), Some(&document_id), true)?;
    let baseline = registry.recovery_metadata(&document_id)?;
    let record = recovery::Record {
        document_id,
        revision,
        content,
        name,
        original_path: baseline.original_path,
        baseline_fingerprint: baseline.fingerprint,
        bom: baseline.bom,
        crlf: baseline.crlf,
        snapshot_time: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    };
    recovery_store(&state, &app)?
        .as_mut()
        .unwrap()
        .write(record)?;
    Ok(revision)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoverySummary {
    document_id: String,
    revision: u64,
    name: String,
    original_path: Option<String>,
    snapshot_time: u64,
}
#[tauri::command(async)]
fn recovery_list(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<RecoverySummary>, String> {
    renderer::ensure_main(webview.label())?;
    let records = recovery_store(&state, &app)?.as_mut().unwrap().list()?;
    let registry = state.documents.lock().unwrap();
    Ok(records
        .into_iter()
        .filter(|r| !registry.sessions.contains_key(&r.document_id))
        .map(|r| RecoverySummary {
            document_id: r.document_id,
            revision: r.revision,
            name: r.name,
            original_path: r.original_path,
            snapshot_time: r.snapshot_time,
        })
        .collect())
}
#[tauri::command(async)]
fn recovery_warnings(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<recovery::Warning>, String> {
    renderer::ensure_main(webview.label())?;
    recovery_store(&state, &app)?.as_ref().unwrap().warnings()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Recovered {
    document_id: String,
    revision: u64,
    path: Option<String>,
    original_path: Option<String>,
    name: String,
    content: String,
    saved: String,
    line_ending: &'static str,
    writable: bool,
    dirty: bool,
}
#[tauri::command(async)]
fn recovery_restore(
    document_id: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Recovered, String> {
    renderer::ensure_main(webview.label())?;
    let record = recovery_store(&state, &app)?
        .as_ref()
        .unwrap()
        .restore(&document_id)?;
    let mut registry = state.documents.lock().unwrap();
    if registry.sessions.contains_key(&document_id) {
        return Err("This recovery document is already open.".into());
    }
    let matched = record
        .original_path
        .as_ref()
        .and_then(|path| document::load(Path::new(path)).ok())
        .filter(|(d, _)| Some(&d.fingerprint) == record.baseline_fingerprint.as_ref())
        .filter(|(d, _)| registry.check_destination(&document_id, &d.path).is_ok());
    let (original, path, saved, writable) = match matched {
        Some((mut original, data)) => {
            original.bom = record.bom;
            original.crlf = record.crlf;
            (Some(original), Some(data.path), data.content, data.writable)
        }
        None => (None, None, String::new(), true),
    };
    registry
        .encoding
        .insert(document_id.clone(), (record.bom, record.crlf));
    registry.recovery_origins.insert(
        document_id.clone(),
        (
            record.original_path.clone(),
            record.baseline_fingerprint.clone(),
        ),
    );
    registry.sessions.insert(document_id.clone(), original);
    registry
        .owners
        .insert(document_id.clone(), webview.label().into());
    registry.activate_for(webview.label(), &document_id)?;
    Ok(Recovered {
        document_id,
        revision: record.revision,
        path,
        original_path: record.original_path,
        name: record.name,
        content: record.content,
        saved,
        line_ending: if record.crlf { "CRLF" } else { "LF" },
        writable,
        dirty: true,
    })
}
#[tauri::command(async)]
fn recovery_discard(
    document_id: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    let registry = state.documents.lock().unwrap();
    if registry.sessions.contains_key(&document_id) {
        return Err("Close this document before discarding its recovery.".into());
    }
    recovery_store(&state, &app)?
        .as_mut()
        .unwrap()
        .discard(&document_id)
}
#[tauri::command(async)]
fn recovery_saved(
    document_id: String,
    revision: u64,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    let registry = state.documents.lock().unwrap();
    registry.id_for(webview.label(), Some(&document_id), true)?;
    recovery_store(&state, &app)?
        .as_mut()
        .unwrap()
        .saved(&document_id, revision)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewDocument {
    document_id: String,
    revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    document_id: String,
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
    document_id: Option<String>,
    content: String,
    save_as: bool,
    force: bool,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<Saved>, CommandError> {
    renderer::ensure_main(webview.label()).map_err(CommandError::from)?;
    let id =
        state
            .documents
            .lock()
            .unwrap()
            .id_for(webview.label(), document_id.as_deref(), true)?;
    let original = state
        .documents
        .lock()
        .unwrap()
        .get_for(webview.label(), Some(&id))?;
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
    let mut registry = state.documents.lock().unwrap();
    registry.id_for(webview.label(), Some(&id), true)?;
    registry.check_destination(&id, &path)?;
    let current = registry.sessions.get(&id).unwrap();
    if current.as_ref().map(|d| (&d.path, &d.fingerprint))
        != original.as_ref().map(|d| (&d.path, &d.fingerprint))
    {
        return Err("The document changed while saving. Try again.".into());
    }
    let saved = registry
        .save(&id, &path, &content, force)
        .map_err(CommandError::from)?;
    let payload = Saved {
        document_id: id.clone(),
        path: saved.path.to_string_lossy().into(),
        name: saved
            .path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
    };
    registry.sessions.insert(id, Some(saved));
    Ok(Some(payload))
}

/// Resolve the active document's folder for an image write. An unsaved
/// document has no destination yet, so the UI asks for Save first.
fn image_directory(
    webview: &tauri::Webview,
    state: &AppState,
    document_id: Option<String>,
) -> Result<PathBuf, CommandError> {
    renderer::ensure_main(webview.label()).map_err(CommandError::from)?;
    let id =
        state
            .documents
            .lock()
            .unwrap()
            .id_for(webview.label(), document_id.as_deref(), true)?;
    let document = state
        .documents
        .lock()
        .unwrap()
        .get_for(webview.label(), Some(&id))?;
    let document = document.ok_or("Save the document before adding images.")?;
    document
        .path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| CommandError::from("The document has no folder."))
}

#[tauri::command(async)]
fn save_pasted_image(
    document_id: Option<String>,
    data: String,
    mime: String,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<document::SavedImage, CommandError> {
    let directory = image_directory(&webview, state.inner(), document_id)?;
    let extension = document::image_extension_from_mime(&mime)
        .ok_or("Paste a PNG, JPEG, GIF, or WebP image.")?;
    // Bound the encoded payload before decoding it, so an oversized clipboard
    // request cannot allocate first and fail the size check afterwards.
    if data.len() as u64 > (document::MAX_IMAGE_BYTES / 3 + 1) * 4 {
        return Err("The pasted image exceeds Folio's 10 MB image limit.".into());
    }
    let bytes = STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "The pasted image data could not be decoded.")?;
    document::save_image_bytes(&directory, &bytes, extension).map_err(CommandError::from)
}

#[tauri::command(async)]
fn import_document_image(
    document_id: Option<String>,
    path: String,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<document::SavedImage, CommandError> {
    let directory = image_directory(&webview, state.inner(), document_id)?;
    document::import_image(&directory, Path::new(&path)).map_err(CommandError::from)
}

#[derive(Serialize)]
struct RenderedMarkdown {
    html: String,
}

#[tauri::command]
async fn render_markdown(
    document_id: Option<String>,
    content: String,
    remote_images: bool,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<RenderedMarkdown, String> {
    renderer::ensure_main(webview.label())?;
    let state = Arc::clone(&state);
    let path = state
        .documents
        .lock()
        .unwrap()
        .get_for(webview.label(), document_id.as_deref())?
        .map(|d| d.path);
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
    renderer::ensure_main(window.label())?;
    // Listeners are installed before this command is invoked. Marking ready
    // here keeps quit from targeting a webview whose event bridge does not
    // exist yet.
    state
        .window_ready
        .lock()
        .unwrap()
        .insert(window.label().into());
    let first = if window.label() == "main" {
        !state.shown.swap(true, Ordering::SeqCst)
    } else {
        state
            .window_shown
            .lock()
            .unwrap()
            .insert(window.label().into())
    };
    if first {
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

#[tauri::command]
fn set_touchpad_zoom(
    enabled: bool,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    state.touchpad_zoom.store(enabled, Ordering::SeqCst);
    Ok(())
}

#[tauri::command(async)]
fn document_changed(
    document_id: Option<String>,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    renderer::ensure_main(webview.label())?;
    Ok(state
        .documents
        .lock()
        .unwrap()
        .get_for(webview.label(), document_id.as_deref())?
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
fn request_quit(webview: tauri::Webview, app: tauri::AppHandle) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    let _ = begin_guarded_quit(&app);
    Ok(())
}

#[tauri::command]
fn quit_window_cancel(
    token: u64,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    app.state::<Arc<AppState>>()
        .quit
        .lock()
        .unwrap()
        .cancel_window(token, webview.label());
    Ok(())
}

#[tauri::command]
fn close_window(
    quit_token: Option<u64>,
    discard_recovery: Option<Vec<DiscardDocument>>,
    webview: tauri::Webview,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    if state
        .window_transfers
        .lock()
        .unwrap()
        .values()
        .any(|transfer| transfer.source == webview.label())
    {
        return Err("Wait for the document to finish moving before closing this window.".into());
    }
    // Keep the metadata until Destroyed; clearing recovery before native
    // destruction can erase the only copy of a dirty document.
    let discard_recovery = discard_recovery.filter(|items| !items.is_empty());
    {
        let mut registry = state.documents.lock().unwrap();
        // Lock ownership against transfers for the whole admit/destroy window.
        registry.begin_close(webview.label())?;
        if let Some(items) = &discard_recovery {
            let ids: Vec<String> = items.iter().map(|item| item.document_id.clone()).collect();
            if let Err(error) = registry.validate_owned(webview.label(), &ids) {
                registry.end_close(webview.label());
                return Err(error);
            }
        }
    }
    let admission = {
        let mut quit = state.quit.lock().unwrap();
        if quit.is_current(webview.label()) {
            match quit_token {
                Some(token) if quit.admit_close(token, webview.label()) => Ok(()),
                Some(_) => Err("This quit request is no longer active.".to_string()),
                None => Err("This window is being quit; provide the quit token.".to_string()),
            }
        } else if quit_token.is_some() {
            Err("This quit request is no longer active.".to_string())
        } else {
            Ok(())
        }
    };
    if let Err(error) = admission {
        state.documents.lock().unwrap().end_close(webview.label());
        return Err(error);
    }
    if let Some(items) = discard_recovery {
        state
            .window_recovery_cleanup
            .lock()
            .unwrap()
            .insert(webview.label().into(), items);
    }
    // Keep document ownership usable if the platform rejects destruction.
    state
        .quit
        .lock()
        .unwrap()
        .normal_close_approved(webview.label());
    if let Err(error) = window.destroy() {
        state
            .window_recovery_cleanup
            .lock()
            .unwrap()
            .remove(webview.label());
        state.documents.lock().unwrap().end_close(webview.label());
        state
            .quit
            .lock()
            .unwrap()
            .normal_close_cancelled(webview.label());
        if let Some(token) = quit_token {
            state
                .quit
                .lock()
                .unwrap()
                .close_failed(token, webview.label());
        }
        return Err(error.to_string());
    }
    cancel_window_renders(&app, state.inner(), webview.label());
    cleanup_workspace(&state, webview.label());
    if workspace::window_labels().is_empty() {
        if let Some(renderer) = app.get_webview_window(renderer::RENDERER_LABEL) {
            let _ = renderer.destroy();
        }
    }
    Ok(())
}

#[tauri::command]
fn toggle_fullscreen(webview: tauri::Webview, window: tauri::Window) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    window
        .set_fullscreen(!window.is_fullscreen().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
fn reveal_path(
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    let scope = state
        .window_folders
        .lock()
        .unwrap()
        .get(webview.label())
        .map(|(_, scope)| scope.clone())
        .ok_or("Open a workspace folder first.")?;
    let path = scope.validated_source(Path::new(&path))?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
fn reveal_document(
    document_id: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    renderer::ensure_main(webview.label())?;
    let path = state
        .documents
        .lock()
        .unwrap()
        .get_for(webview.label(), document_id.as_deref())?
        .ok_or("Save the document first.")?
        .path;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
fn rename_document(
    document_id: Option<String>,
    name: String,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Saved, String> {
    renderer::ensure_main(webview.label())?;
    if !is_markdown(Path::new(&name)) {
        return Err("Use a Markdown filename (.md, .markdown, .mdown or .mdtxt).".into());
    }
    let mut registry = state.documents.lock().unwrap();
    let id = registry.id_for(webview.label(), document_id.as_deref(), true)?;
    let original = registry
        .get(Some(&id))?
        .ok_or("Save the document before renaming it.")?;
    registry.check_destination(&id, &original.path.with_file_name(&name))?;
    let renamed = document::rename(&original, &name)?;
    let result = Saved {
        document_id: id.clone(),
        path: renamed.path.to_string_lossy().into(),
        name,
    };
    registry.sessions.insert(id, Some(renamed));
    Ok(result)
}

#[tauri::command(async)]
fn duplicate_document(
    document_id: Option<String>,
    content: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    renderer::ensure_main(webview.label())?;
    state
        .documents
        .lock()
        .unwrap()
        .id_for(webview.label(), document_id.as_deref(), true)?;
    let original = state
        .documents
        .lock()
        .unwrap()
        .get_for(webview.label(), document_id.as_deref())?;
    let mut dialog = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"]);
    if let Some(document) = &original {
        let stem = document
            .path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy();
        dialog = dialog
            .set_directory(document.path.parent().unwrap_or(Path::new(".")))
            .set_file_name(format!("{stem} copy.md"));
    } else {
        dialog = dialog.set_file_name("Untitled copy.md");
    }
    let Some(file) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|error| error.to_string())?;
    state
        .documents
        .lock()
        .unwrap()
        .check_destination("", &path)?;
    if original
        .as_ref()
        .is_some_and(|document| path.canonicalize().ok().as_ref() == Some(&document.path))
    {
        return Err("Choose a different destination for the duplicate.".into());
    }
    // Destination confirmation belongs to the native save dialog. The original
    // stays active, with its fingerprint and unsaved buffer intact.
    let saved = document::save(&path, &content, original.as_ref(), false)
        .map_err(|error| error.message().to_string())?;
    Ok(Some(saved.path.to_string_lossy().into()))
}

#[tauri::command(async)]
fn export_html(
    document_id: Option<String>,
    content: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    renderer::ensure_main(webview.label())?;
    state
        .documents
        .lock()
        .unwrap()
        .id_for(webview.label(), document_id.as_deref(), true)?;
    let original = state
        .documents
        .lock()
        .unwrap()
        .get_for(webview.label(), document_id.as_deref())?;
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("HTML", &["html"])
        .set_file_name("document.html")
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|error| error.to_string())?;
    state
        .documents
        .lock()
        .unwrap()
        .check_destination("", &path)?;
    if original
        .as_ref()
        .is_some_and(|document| path.canonicalize().ok().as_ref() == Some(&document.path))
    {
        return Err("Choose an HTML destination separate from the open document.".into());
    }
    // Render again through the native sanitizer; never export author-controlled
    // webview HTML or implicitly fetch remote media.
    let (html, _) = markdown::render_with_blocks_checked(
        &content,
        original
            .as_ref()
            .and_then(|document| document.path.parent()),
        false,
        &markdown::DEFAULT_RENDER_LIMITS,
        false,
    )
    .map_err(|error| error.to_string())?;
    let output = format!("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Folio document</title><style>body{{max-width:54rem;margin:3rem auto;padding:0 1.5rem;font:18px/1.7 Georgia,serif;color:#222}}pre{{overflow:auto;padding:1rem;background:#f4f4f4}}table{{border-collapse:collapse}}th,td{{border:1px solid #ccc;padding:.4rem .7rem}}img{{max-width:100%}}</style></head><body>{html}</body></html>");
    let parent = path.parent().ok_or("Invalid export path")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    use std::io::Write;
    temp.write_all(output.as_bytes())
        .map_err(|error| error.to_string())?;
    temp.persist(&path).map_err(|error| error.to_string())?;
    Ok(Some(path.to_string_lossy().into()))
}

#[derive(Serialize)]
struct SearchHit {
    path: String,
    name: String,
    snippet: String,
    line: usize,
    offset: usize,
    length: usize,
    fingerprint: String,
}
#[derive(Serialize)]
struct SearchResults {
    results: Vec<SearchHit>,
    truncated: bool,
}

#[cfg(test)]
fn search_folder_at(path: &Path, query: &str) -> Result<SearchResults, String> {
    search_folder_filtered(path, query, "", "")
}

// Comma-separated, case-insensitive path substrings; * spans any characters.
fn search_path_matches(path: &str, patterns: &str) -> bool {
    let path = path.to_lowercase();
    patterns
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .any(|pattern| {
            let pattern = pattern.to_lowercase();
            let mut remaining = path.as_str();
            pattern.split('*').all(|part| {
                if let Some(at) = remaining.find(part) {
                    remaining = &remaining[at + part.len()..];
                    true
                } else {
                    false
                }
            })
        })
}

fn search_folder_filtered(
    path: &Path,
    query: &str,
    include: &str,
    exclude: &str,
) -> Result<SearchResults, String> {
    use std::io::Read;
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    let (entries, truncated, skipped) = scan_folder(&path)?;
    let query = query.to_lowercase();
    let mut result = SearchResults {
        results: Vec::new(),
        truncated: truncated || skipped > 0,
    };
    if query.is_empty() {
        return Ok(result);
    }
    let mut budget = 16 * 1024 * 1024_u64;
    for entry in entries.into_iter().filter(|entry| !entry.directory) {
        let relative = Path::new(&entry.path)
            .strip_prefix(&path)
            .unwrap_or(Path::new(&entry.path))
            .to_string_lossy()
            .replace('\\', "/");
        if (include.split(',').any(|pattern| !pattern.trim().is_empty())
            && !search_path_matches(&relative, include))
            || search_path_matches(&relative, exclude)
        {
            continue;
        }
        if result.results.len() >= 100 || budget == 0 {
            result.truncated = true;
            break;
        }
        let candidate = match Path::new(&entry.path).canonicalize() {
            Ok(candidate) if candidate.starts_with(&path) => candidate,
            _ => {
                result.truncated = true;
                continue;
            }
        };
        let cap = budget.min(2 * 1024 * 1024);
        let metadata = match fs::metadata(&candidate) {
            Ok(metadata) if metadata.len() <= cap => metadata,
            _ => {
                result.truncated = true;
                continue;
            }
        };
        let mut content = String::with_capacity(metadata.len() as usize);
        let read = fs::File::open(&candidate)
            .and_then(|file| file.take(cap + 1).read_to_string(&mut content));
        budget = budget.saturating_sub(content.len() as u64);
        if read.is_err() || content.len() as u64 > cap {
            result.truncated = true;
            continue;
        }
        // Match the document loader's BOM/CRLF normalization and JavaScript's
        // UTF-16 offsets so clicking a line opens the right source location.
        let content = content.trim_start_matches('\u{feff}').replace("\r\n", "\n");
        let mut offset = 0;
        let mut fingerprint = None;
        for (index, raw) in content.split_inclusive('\n').enumerate() {
            let line = raw.strip_suffix('\n').unwrap_or(raw);
            let folded = line.to_lowercase();
            if let Some(found) = folded.find(&query) {
                if result.results.len() >= 100 {
                    result.truncated = true;
                    break;
                }
                // Lowercase expansion (e.g. İ -> i + combining dot) changes
                // folded lengths. Map back before slicing the original line.
                let mut folded_bytes = 0;
                let original_index = line
                    .chars()
                    .position(|character| {
                        folded_bytes += character.to_lowercase().map(char::len_utf8).sum::<usize>();
                        folded_bytes > found
                    })
                    .unwrap_or(0);
                let start = original_index.saturating_sub(40);
                let snippet = line.chars().skip(start).take(180).collect();
                result.results.push(SearchHit {
                    path: entry.path.clone(),
                    name: entry.name.clone(),
                    snippet,
                    line: index + 1,
                    offset,
                    length: line.encode_utf16().count(),
                    fingerprint: fingerprint
                        .get_or_insert_with(|| document::fingerprint(content.as_bytes()))
                        .clone(),
                });
            }
            offset += raw.encode_utf16().count();
        }
    }
    Ok(result)
}

#[tauri::command(async)]
fn search_folder(
    query: String,
    include: Option<String>,
    exclude: Option<String>,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<SearchResults, String> {
    renderer::ensure_main(webview.label())?;
    if query.len() > 1024 {
        return Err("Use a shorter search query.".into());
    }
    let path = state
        .window_folders
        .lock()
        .unwrap()
        .get(webview.label())
        .map(|(path, _)| path.clone())
        .ok_or("Open a folder to search files.")?;
    search_folder_filtered(
        &path,
        &query,
        include.as_deref().unwrap_or(""),
        exclude.as_deref().unwrap_or(""),
    )
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
    document_id: Option<String>,
    link: String,
    webview: tauri::Webview,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    renderer::ensure_main(webview.label())?;
    let current = state
        .documents
        .lock()
        .unwrap()
        .get_for(webview.label(), document_id.as_deref())?;
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

#[cfg(test)]
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

fn submit_window_renderer_request(
    state: &AppState,
    window: &str,
    mut request: RenderRequest,
) -> Result<(RenderRequest, bool), String> {
    let _handoff = state.renderer_handoff.lock().unwrap();
    if *state.renderer_recycling.lock().unwrap() {
        return Err("The diagram renderer is restarting. Try again.".into());
    }
    let native = state
        .render_routes
        .lock()
        .unwrap()
        .record(window, &request.id)?;
    request.id = native.clone();
    let result = state
        .renderer
        .lock()
        .unwrap()
        .submit(request.clone())
        .map_err(|error| error.to_string());
    match result {
        Ok(dispatch) => Ok((request, dispatch)),
        Err(error) => {
            state.render_routes.lock().unwrap().remove(&native);
            Err(error)
        }
    }
}
fn cancel_window_renders(app: &tauri::AppHandle, state: &AppState, window: &str) {
    let mut recycle = false;
    let ids = {
        let _handoff = state.renderer_handoff.lock().unwrap();
        let ids = state.render_routes.lock().unwrap().take_window(window);
        let mut transport = state.renderer.lock().unwrap();
        for id in &ids {
            recycle |= transport.cancel(id).ok().flatten().unwrap_or(false);
        }
        ids
    };
    for id in ids {
        let _ = app.emit_to(
            renderer::RENDERER_LABEL,
            "mermaid-render-cancel",
            CancelRequest { id },
        );
    }
    if recycle {
        recycle_renderer(app, state);
    }
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

fn emit_render_result(app: &tauri::AppHandle, mut event: renderer::RenderResultEvent) {
    let state = app.state::<Arc<AppState>>();
    let route = state.render_routes.lock().unwrap().remove(&event.id);
    if let Some((owner, client_id)) = route {
        event.id = client_id;
        let _ = app.emit_to(&owner, "mermaid-render-result", event);
    }
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
    let (request, dispatch) =
        submit_window_renderer_request(state.inner(), webview.label(), request)?;
    if dispatch {
        if app.get_webview_window(renderer::RENDERER_LABEL).is_none() {
            if let Err(error) = finish_dispatched_missing_window(state.inner(), &request.id, || {
                ensure_renderer_window(&app, state.inner())
            }) {
                state.render_routes.lock().unwrap().remove(&request.id);
                return Err(error);
            }
        } else if let Err(error) = app.emit_to(
            renderer::RENDERER_LABEL,
            "mermaid-render-request",
            request.clone(),
        ) {
            let _ = state.renderer.lock().unwrap().cancel(&request.id);
            state.render_routes.lock().unwrap().remove(&request.id);
            recycle_renderer(&app, state.inner());
            return Err(error.to_string());
        }
    } else if app.get_webview_window(renderer::RENDERER_LABEL).is_none() {
        if let Err(error) = ensure_renderer_window(&app, state.inner()) {
            let _ = state.renderer.lock().unwrap().cancel(&request.id);
            state.render_routes.lock().unwrap().remove(&request.id);
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
    let (id, outcome) = {
        let _handoff = state.renderer_handoff.lock().unwrap();
        let Some(native) = state
            .render_routes
            .lock()
            .unwrap()
            .find(webview.label(), &id)?
        else {
            return Ok(());
        };
        let outcome = state
            .renderer
            .lock()
            .unwrap()
            .cancel(&native)
            .map_err(|error| error.to_string())?;
        state.render_routes.lock().unwrap().remove(&native);
        (native, outcome)
    };
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
    // An OS-open during a quit sequence must not inject work into a window
    // that is being reviewed or closed. Cancel the open; the user can retry.
    if state.quit.lock().unwrap().is_active() {
        return;
    }
    let labels = workspace::window_labels();
    let Some(label) = labels
        .iter()
        .find(|label| label.as_str() == "main")
        .or_else(|| labels.first())
    else {
        return;
    };
    if label == "main" {
        state.pending.lock().unwrap().extend(paths.iter().cloned());
    } else {
        state
            .window_pending
            .lock()
            .unwrap()
            .entry(label.clone())
            .or_default()
            .extend(paths.iter().cloned());
    }
    let _ = app.emit_to(label, "open-files", paths);
    if let Some(window) = app.get_webview_window(label) {
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
    match event {
        tauri::RunEvent::Opened { urls } => {
            let paths = urls
                .iter()
                .filter_map(|url| url.to_file_path().ok())
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            queue_paths(app, paths);
        }
        tauri::RunEvent::MenuEvent(event) => {
            if native_menu::handle_event(app, event.id().as_ref()) {
                begin_guarded_quit(app);
            }
        }
        tauri::RunEvent::ExitRequested { api, .. } => handle_exit_requested(app, api),
        _ => {}
    }
}

#[cfg(not(target_os = "macos"))]
fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::MenuEvent(event) => {
            if native_menu::handle_event(app, event.id().as_ref()) {
                begin_guarded_quit(app);
            }
        }
        tauri::RunEvent::ExitRequested { api, .. } => handle_exit_requested(app, api),
        _ => {}
    }
}

/// How long one window may take to review and destroy itself before quit gives
/// up and unlocks it. Timeout cancels; it never treats silence as approval.
const QUIT_WINDOW_TIMEOUT: Duration = Duration::from_secs(60);

fn quit_window_payload(token: u64) -> serde_json::Value {
    serde_json::json!({ "quitToken": token })
}

fn watch_quit_window(app: tauri::AppHandle, token: u64, label: String) {
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_WINDOW_TIMEOUT);
        let step = app
            .state::<Arc<AppState>>()
            .quit
            .lock()
            .unwrap()
            .expire(token, &label);
        if let workspace::QuitStep::Cancel { token, label } = step {
            // Unlock the still-open window. The token is already invalid, so a
            // late close result cannot advance the sequence.
            let _ = app.emit_to(
                &label,
                "quit-sequence-cancelled",
                quit_window_payload(token),
            );
        }
    });
}

fn start_quit_window_review(app: &tauri::AppHandle, token: u64, label: String) {
    let state = app.state::<Arc<AppState>>();
    if app.get_webview_window(&label).is_none() {
        // The window vanished between snapshot and delivery. It is really gone,
        // so withdraw it and continue with the next participant.
        let step = state.quit.lock().unwrap().window_closed(&label);
        apply_quit_step(app, step);
        return;
    }
    if app
        .emit_to(&label, "request-close", quit_window_payload(token))
        .is_err()
    {
        // A live window we cannot address must not be silently skipped.
        state.quit.lock().unwrap().cancel_window(token, &label);
        return;
    }
    watch_quit_window(app.clone(), token, label);
}

fn apply_quit_step(app: &tauri::AppHandle, step: workspace::QuitStep) {
    match step {
        workspace::QuitStep::Ignored => {}
        workspace::QuitStep::Next { token, label } => start_quit_window_review(app, token, label),
        workspace::QuitStep::Complete { .. } => app.exit(0),
        workspace::QuitStep::Cancel { token, label } => {
            let _ = app.emit_to(
                &label,
                "quit-sequence-cancelled",
                quit_window_payload(token),
            );
        }
    }
}

/// The single entry point for a native-menu Quit (or any other app-level quit).
///
/// It closes one workspace at a time through the ordinary per-window close
/// review. The next window is targeted only after the previous window's native
/// Destroyed event. Cancel/error/timeout stops the sequence: earlier windows
/// stay closed and the remaining ones stay open. No approval is inferred.
pub(crate) fn begin_guarded_quit(app: &tauri::AppHandle) -> bool {
    let state = app.state::<Arc<AppState>>();
    let focused = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .map(|window| window.label().to_string());
    let mut quit = state.quit.lock().unwrap();
    // Snapshot labels under the same lock used by new_window registration.
    let mut labels = workspace::window_labels();
    labels.sort();
    let ready = {
        let ready = state.window_ready.lock().unwrap();
        labels.iter().all(|label| ready.contains(label))
    };
    if !ready {
        return false;
    }
    if let Some(focused) = focused {
        if let Some(index) = labels.iter().position(|label| label == &focused) {
            let label = labels.remove(index);
            labels.insert(0, label);
        }
    }
    let start = quit.begin(labels);
    drop(quit);
    match start {
        workspace::QuitStart::Ignored | workspace::QuitStart::Busy => false,
        workspace::QuitStart::NoWindows => {
            app.exit(0);
            true
        }
        workspace::QuitStart::Review { token, label } => {
            start_quit_window_review(app, token, label);
            true
        }
    }
}

fn handle_exit_requested(app: &tauri::AppHandle, api: tauri::ExitRequestApi) {
    // On macOS, a predefined native Quit can terminate through AppKit without
    // a reliable ExitRequested hook (tao does not implement
    // applicationShouldTerminate). The custom menu Quit item must call
    // `begin_guarded_quit`; this guard covers lifecycle paths that do report an
    // exit request. OS/force termination remains unrecoverable by design and
    // is protected only by the recovery snapshots.
    let labels = workspace::window_labels();
    let state = app.state::<Arc<AppState>>();
    let allowed = state.quit.lock().unwrap().allows_exit(&labels);
    if allowed {
        return;
    }
    api.prevent_exit();
    begin_guarded_quit(app);
}

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
            #[cfg(target_os = "macos")]
            {
                // A menu setup error must not abort startup. If installing the
                // replacement menu fails, remove the platform default menu so
                // its unguarded Quit item is not left reachable; the in-window
                // HTML menu remains available and the frontend can retry sync.
                match native_menu::build(app.handle(), &Default::default())
                    .and_then(|menu| app.set_menu(menu).map(|_| ()))
                {
                    Ok(()) => {}
                    Err(error) => {
                        eprintln!("Could not install the native menu: {error}");
                        let _ = app.remove_menu();
                    }
                }
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut previous = theme::current();
                loop {
                    std::thread::sleep(Duration::from_secs(10));
                    let current = theme::current();
                    if current != previous {
                        for label in workspace::window_labels() {
                            let _ = handle.emit_to(&label, "system-theme", &current);
                        }
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
            let _main_window = tauri::WebviewWindowBuilder::new(
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
            #[cfg(target_os = "linux")]
            {
                let state = app.state::<Arc<AppState>>().inner().clone();
                _main_window.with_webview(move |webview| {
                    webview.inner().connect_event(move |_, event| {
                        if event.event_type() == EventType::TouchpadPinch
                            && !state.touchpad_zoom.load(Ordering::SeqCst)
                        {
                            gtk::glib::Propagation::Stop
                        } else {
                            gtk::glib::Propagation::Proceed
                        }
                    });
                })?;
            }
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
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle().clone();
                let state = app.state::<Arc<AppState>>();
                let pending_recovery = state
                    .window_recovery_cleanup
                    .lock()
                    .unwrap()
                    .remove(window.label());
                // close_window may already have unregistered this label; the
                // coordinator still needs the real destruction notification.
                if workspace::ensure_window(window.label()).is_ok() {
                    cancel_window_renders(&app, state.inner(), window.label());
                    cleanup_workspace(&state, window.label());
                }
                if let Some(items) = pending_recovery {
                    // Only now, after native destruction, retire discarded
                    // recovery. If this fails the draft remains recoverable.
                    match recovery_store(&state, &app) {
                        Ok(mut store) => {
                            if let Some(store) = store.as_mut() {
                                for item in items {
                                    if let Err(error) = store.discard(&item.document_id) {
                                        eprintln!(
                                            "Could not retire recovery for {}: {error}",
                                            item.document_id
                                        );
                                    }
                                }
                            }
                        }
                        Err(error) => {
                            eprintln!("Could not open recovery storage after close: {error}")
                        }
                    }
                }
                let step = state.quit.lock().unwrap().window_closed(window.label());
                apply_quit_step(&app, step);
                return;
            }
            if workspace::ensure_window(window.label()).is_err() {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                let state = app.state::<Arc<AppState>>();
                // Only the window currently under quit review is owned by the
                // sequence. Other windows may still close normally and then
                // withdraw from the remaining quit queue.
                if state.quit.lock().unwrap().is_current(window.label()) {
                    return;
                }
                // Emit to this exact window; Window::emit would broadcast the
                // close review to every workspace.
                let _ = app.emit_to(window.label(), "request-close", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            new_window,
            finish_window_transfer,
            activate_document,
            close_document,
            recovery_write,
            recovery_list,
            recovery_warnings,
            recovery_restore,
            recovery_discard,
            recovery_saved,
            toggle_fullscreen,
            reveal_document,
            reveal_path,
            rename_document,
            duplicate_document,
            export_html,
            search_folder,
            bootstrap,
            open_document,
            open_folder,
            file_operation,
            browse_directory,
            path_is_directory,
            set_task_checked,
            new_document,
            save_document,
            save_pasted_image,
            import_document_image,
            render_markdown,
            highlight_code,
            preview_check,
            ready,
            set_window_zoom,
            set_touchpad_zoom,
            document_changed,
            set_title,
            close_window,
            request_quit,
            quit_window_cancel,
            sync_native_menu,
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

#[cfg(test)]
mod document_action_tests {
    use super::*;
    #[test]
    fn discard_metadata_ignores_untrusted_revision_and_unknown_ids_are_validated_elsewhere() {
        let parsed: DiscardDocument = serde_json::from_value(serde_json::json!({
            "documentId": "doc-1",
            "revision": u64::MAX
        }))
        .unwrap();
        assert_eq!(parsed.document_id, "doc-1");
    }
    #[cfg(unix)]
    #[test]
    fn folder_search_accepts_a_symlinked_root() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("folder");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("note.md"), "a needle here").unwrap();
        let alias = directory.path().join("alias");
        symlink(&root, &alias).unwrap();
        let result = search_folder_at(&alias, "needle").unwrap();
        assert_eq!(result.results.len(), 1);
    }

    #[test]
    fn folder_search_filters_before_the_result_budget() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("a-archive.md"),
            "needle\n".repeat(110),
        )
        .unwrap();
        fs::write(directory.path().join("z-guide.md"), "needle here").unwrap();
        let result = search_folder_filtered(directory.path(), "needle", "*guide.md", "").unwrap();
        assert_eq!(result.results.len(), 1);
        assert_eq!(result.results[0].name, "z-guide.md");
        assert!(!result.truncated);
        let result = search_folder_filtered(directory.path(), "needle", "", "archive").unwrap();
        assert_eq!(result.results.len(), 1);
        assert!(!result.truncated);
    }

    #[test]
    fn folder_search_offsets_match_normalized_utf16_and_limit_lines() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("unicode.md"),
            "\u{feff}😀 first\r\nneedle one\r\nneedle two\r\n",
        )
        .unwrap();
        let result = search_folder_at(directory.path(), "needle").unwrap();
        assert_eq!(result.results.len(), 2);
        assert_eq!(result.results[0].line, 2);
        assert_eq!(
            result.results[0].offset,
            "😀 first\n".encode_utf16().count()
        );
        assert_eq!(
            result.results[1].offset,
            "😀 first\nneedle one\n".encode_utf16().count()
        );
        fs::write(directory.path().join("many.md"), "needle\n".repeat(110)).unwrap();
        let limited = search_folder_at(directory.path(), "needle").unwrap();
        assert_eq!(limited.results.len(), 100);
        assert!(limited.truncated);
    }

    #[test]
    fn folder_search_snippets_survive_lowercase_expansion() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("unicode.md"),
            format!("{} needle", "İ".repeat(200)),
        )
        .unwrap();
        let result = search_folder_at(directory.path(), "needle").unwrap();
        assert_eq!(result.results.len(), 1);
        assert!(result.results[0].snippet.contains("needle"));
    }

    #[test]
    fn folder_search_matches_content_lines_and_reports_limits() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("Report.md"), "No matching body").unwrap();
        fs::write(
            directory.path().join("notes.md"),
            "# Heading\nA REPORT inside the document\nreport again",
        )
        .unwrap();
        fs::write(directory.path().join("skip.txt"), "report").unwrap();
        let results = search_folder_at(directory.path(), "report").unwrap();
        assert_eq!(results.results.len(), 2);
        assert!(!results.truncated);
        assert!(
            results.results.iter().all(|hit| hit.name == "notes.md"),
            "filenames alone are not content matches"
        );
        assert_eq!(
            serde_json::to_value(&results.results[1]).unwrap()["line"],
            3
        );
        assert!(results
            .results
            .iter()
            .any(|hit| hit.snippet.contains("REPORT")));
        fs::write(
            directory.path().join("large.md"),
            vec![b'x'; 2 * 1024 * 1024 + 1],
        )
        .unwrap();
        assert!(
            search_folder_at(directory.path(), "report")
                .unwrap()
                .truncated
        );
    }
}

#[cfg(test)]
mod file_operation_tests {
    use super::*;
    #[test]
    fn renamed_open_file_can_save_to_its_new_path() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("a.md");
        let new = root.path().join("b.md");
        fs::write(&old, "original").unwrap();
        let mut registry = workspace::Registry::default();
        let (id, _) = registry.open(&old).unwrap();
        perform_workspace_operation(
            &mut registry,
            &file_operations::Scope::new(root.path()).unwrap(),
            "rename",
            &old,
            Some(&new),
            None,
        )
        .unwrap();
        let moved = registry.get(Some(&id)).unwrap().unwrap();
        assert_eq!(fs::read_to_string(&moved.path).unwrap(), "original");
        let saved = registry.save(&id, &moved.path, "edited", false).unwrap();
        assert_eq!(saved.path, new.canonicalize().unwrap());
        assert!(!old.exists());
    }
    #[test]
    fn moving_directory_updates_all_open_descendants_and_rejects_changed_files() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("notes");
        fs::create_dir(&old).unwrap();
        let file = old.join("a.md");
        fs::write(&file, "original").unwrap();
        let mut registry = workspace::Registry::default();
        let (id, _) = registry.open(&file).unwrap();
        let new = root.path().join("moved");
        fs::write(&file, "external").unwrap();
        assert!(perform_workspace_operation(
            &mut registry,
            &file_operations::Scope::new(root.path()).unwrap(),
            "move",
            &old,
            Some(&new),
            None
        )
        .is_err());
        assert!(old.exists());
        assert!(!new.exists());
        registry.open(&file).unwrap();
        perform_workspace_operation(
            &mut registry,
            &file_operations::Scope::new(root.path()).unwrap(),
            "move",
            &old,
            Some(&new),
            None,
        )
        .unwrap();
        let moved = registry.get(Some(&id)).unwrap().unwrap();
        assert_eq!(fs::read_to_string(moved.path).unwrap(), "external");
    }
}
