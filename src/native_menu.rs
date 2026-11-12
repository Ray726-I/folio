//! macOS application menu. Quit is deliberately an ordinary item: the caller
//! must route `Quit` through the application's coordinated shutdown protocol.
use std::collections::HashMap;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, WebviewWindow,
};

#[derive(Default, serde::Deserialize)]
pub struct NativeMenuState {
    #[serde(default)]
    enabled: HashMap<String, bool>,
    #[serde(default)]
    recent: Vec<String>,
    #[serde(default, rename = "pickerNative")]
    picker_native: bool,
}

// (id, label, accelerator). Accelerators belong to the native menu, so they
// are not re-dispatched as synthetic webview keyboard events.
const FILE: &[(&str, &str, Option<&str>)] = &[
    ("new", "New Document", Some("Cmd+N")),
    ("new-window", "New Window", None),
    ("open", "Open File…", Some("Cmd+O")),
    ("folder", "Open Folder…", Some("Cmd+Shift+O")),
    ("save", "Save", Some("Cmd+S")),
    ("save-as", "Save As…", Some("Cmd+Shift+S")),
    ("recovery", "Recover Documents…", None),
    ("close", "Close File", None),
    ("move-window", "Move Tab to New Window", None),
    ("home", "Welcome Screen", None),
];
const EDIT: &[(&str, &str, Option<&str>)] = &[
    ("undo", "Undo", Some("Cmd+Z")),
    ("redo", "Redo", Some("Cmd+Shift+Z")),
    ("find", "Find…", Some("Cmd+F")),
    ("replace", "Find and Replace…", None),
    (
        "folder-search",
        "Search Folder Contents…",
        Some("Cmd+Shift+F"),
    ),
];
const VIEW: &[(&str, &str, Option<&str>)] = &[
    ("commands", "Command Window…", Some("Cmd+Shift+P")),
    ("lab", "Folio Lab…", None),
    ("companion", "Show Reading Companion", None),
    ("files", "Toggle File Explorer", None),
    ("outline", "Toggle Outline", None),
    ("reading", "Toggle Reading Mode", None),
    ("focus", "Toggle Focus Mode", None),
    ("fullscreen", "Toggle Full Screen", None),
    ("zoom-in", "Zoom In", None),
    ("zoom-out", "Zoom Out", None),
    ("zoom-reset", "Reset Window Zoom", None),
];
const GO: &[(&str, &str, Option<&str>)] = &[
    ("back", "Back", None),
    ("forward", "Forward", None),
    ("heading", "Go to Heading", None),
    ("top", "Go to Top", None),
    ("bottom", "Go to Bottom", None),
];
const HELP: &[(&str, &str, Option<&str>)] = &[
    ("shortcuts", "Keyboard Shortcuts", None),
    ("documentation", "Documentation", None),
    ("issue", "Report an Issue", None),
];

fn add(
    app: &AppHandle,
    menu: &Submenu<tauri::Wry>,
    state: &NativeMenuState,
    id: &str,
    label: &str,
    shortcut: Option<&str>,
) -> tauri::Result<()> {
    let enabled = state.enabled.get(id).copied().unwrap_or(false);
    menu.append(&MenuItem::with_id(
        app,
        format!("folio:{id}"),
        label,
        enabled,
        shortcut,
    )?)
}

fn add_group(
    app: &AppHandle,
    root: &Menu<tauri::Wry>,
    state: &NativeMenuState,
    title: &str,
    items: &[(&str, &str, Option<&str>)],
) -> tauri::Result<Submenu<tauri::Wry>> {
    let submenu = Submenu::new(app, title, true)?;
    for &(id, label, shortcut) in items {
        add(app, &submenu, state, id, label, shortcut)?;
    }
    root.append(&submenu)?;
    Ok(submenu)
}

pub fn build(app: &AppHandle, state: &NativeMenuState) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    let folio = Submenu::new(app, "Folio", true)?;
    add(app, &folio, state, "about", "About Folio", None)?;
    folio.append(&PredefinedMenuItem::separator(app)?)?;
    folio.append(&MenuItem::with_id(
        app,
        "folio:preferences",
        "Settings…",
        true,
        Some("Cmd+,"),
    )?)?;
    folio.append(&PredefinedMenuItem::separator(app)?)?;
    folio.append(&PredefinedMenuItem::services(app, None)?)?;
    folio.append(&PredefinedMenuItem::separator(app)?)?;
    folio.append(&PredefinedMenuItem::hide(app, None)?)?;
    folio.append(&PredefinedMenuItem::hide_others(app, None)?)?;
    folio.append(&PredefinedMenuItem::show_all(app, None)?)?;
    folio.append(&PredefinedMenuItem::separator(app)?)?;
    folio.append(&MenuItem::with_id(
        app,
        "folio:quit",
        "Quit Folio",
        true,
        Some("Cmd+Q"),
    )?)?;
    menu.append(&folio)?;
    let file = add_group(app, &menu, state, "File", FILE)?;
    add(
        app,
        &file,
        state,
        "picker-toggle",
        if state.picker_native {
            "Use Folio File Picker"
        } else {
            "Use System File Picker"
        },
        None,
    )?;
    let recent = Submenu::new(app, "Open Recent", !state.recent.is_empty())?;
    for path in state.recent.iter().take(20) {
        let label = std::path::Path::new(path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(path);
        recent.append(&MenuItem::with_id(
            app,
            format!("folio:recent:{path}"),
            label,
            true,
            None::<&str>,
        )?)?;
    }
    file.append(&recent)?;
    let edit = add_group(app, &menu, state, "Edit", EDIT)?;
    // Native responder-chain operations also work in settings and dialogs,
    // where routing through document actions would steal the text selection.
    edit.append(&PredefinedMenuItem::separator(app)?)?;
    edit.append(&PredefinedMenuItem::cut(app, None)?)?;
    edit.append(&PredefinedMenuItem::copy(app, None)?)?;
    edit.append(&PredefinedMenuItem::paste(app, None)?)?;
    edit.append(&PredefinedMenuItem::select_all(app, None)?)?;
    add_group(app, &menu, state, "View", VIEW)?;
    add_group(app, &menu, state, "Go", GO)?;
    let window = Submenu::with_id(app, tauri::menu::WINDOW_SUBMENU_ID, "Window", true)?;
    window.append(&PredefinedMenuItem::minimize(app, None)?)?;
    window.append(&PredefinedMenuItem::close_window(app, None)?)?;
    menu.append(&window)?;
    let help = Submenu::with_id(app, tauri::menu::HELP_SUBMENU_ID, "Help", true)?;
    for &(id, label, shortcut) in HELP {
        add(app, &help, state, id, label, shortcut)?;
    }
    menu.append(&help)?;
    Ok(menu)
}

#[tauri::command]
pub fn sync_native_menu(window: WebviewWindow, state: NativeMenuState) -> Result<bool, String> {
    if !window.is_focused().unwrap_or(false) {
        return Ok(false);
    }
    let app = window.app_handle();
    let menu = build(app, &state).map_err(|e| e.to_string())?;
    // Focus can change while constructing native objects.
    if window.is_focused().unwrap_or(false) {
        app.set_menu(menu).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

fn dispatch_action(
    windows: impl IntoIterator<Item = (String, bool)>,
    action: &str,
    send: impl FnOnce(&str, &str),
) {
    if let Some((label, _)) = windows.into_iter().find(|(_, eligible)| *eligible) {
        send(&label, action);
    }
}

/// Returns true for Quit; the caller must invoke the guarded app quit coordinator.
pub fn handle_event(app: &AppHandle, id: &str) -> bool {
    let Some(action) = id.strip_prefix("folio:") else {
        return false;
    };
    if action == "quit" {
        return true;
    }
    // Never send an action to an arbitrary, unfocused or background renderer.
    dispatch_action(
        app.webview_windows().into_values().map(|window| {
            let eligible = crate::workspace::ensure_window(window.label()).is_ok()
                && window.is_focused().unwrap_or(false);
            (window.label().to_owned(), eligible)
        }),
        action,
        |label, action| {
            let _ = app.emit_to(label, "native-menu-action", action);
        },
    );
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_is_delivered_only_to_focused_workspace_label() {
        let mut deliveries = Vec::new();
        dispatch_action(
            vec![
                ("main".into(), false),
                ("workspace-2".into(), true),
                ("workspace-3".into(), false),
            ],
            "save",
            |label, action| deliveries.push((label.to_owned(), action.to_owned())),
        );
        assert_eq!(
            deliveries,
            vec![("workspace-2".to_owned(), "save".to_owned())]
        );
    }
}
