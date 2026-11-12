fn main() {
    // The UI is embedded at compile time; rebuild when any asset changes so a
    // previously built binary cannot silently ship an older editor.
    println!("cargo:rerun-if-changed=ui");
    // Every custom command must be listed here. Adding a command to
    // `generate_handler!` without adding it below makes the app ACL deny it.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "new_window",
            "finish_window_transfer",
            "toggle_fullscreen",
            "activate_document",
            "close_document",
            "recovery_write",
            "recovery_list",
            "recovery_warnings",
            "recovery_restore",
            "recovery_discard",
            "recovery_saved",
            "reveal_document",
            "reveal_path",
            "rename_document",
            "duplicate_document",
            "export_html",
            "search_folder",
            "bootstrap",
            "open_document",
            "open_folder",
            "file_operation",
            "browse_directory",
            "path_is_directory",
            "set_task_checked",
            "new_document",
            "save_document",
            "save_pasted_image",
            "import_document_image",
            "render_markdown",
            "highlight_code",
            "preview_check",
            "ready",
            "set_window_zoom",
            "set_touchpad_zoom",
            "document_changed",
            "set_title",
            "close_window",
            "request_quit",
            "quit_window_cancel",
            "sync_native_menu",
            "open_link",
            "resolve_document_link",
            "pick_open_target",
            "mermaid_render_request",
            "mermaid_render_cancel",
            "mermaid_renderer_ready",
            "mermaid_render_result",
        ]),
    ))
    .expect("failed to run tauri-build");
}
