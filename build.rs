fn main() {
    // The UI is embedded at compile time; rebuild when any asset changes so a
    // previously built binary cannot silently ship an older editor.
    println!("cargo:rerun-if-changed=ui");
    // Every custom command must be listed here. Adding a command to
    // `generate_handler!` without adding it below makes the app ACL deny it.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "bootstrap",
            "open_document",
            "open_folder",
            "browse_directory",
            "path_is_directory",
            "set_task_checked",
            "new_document",
            "save_document",
            "render_markdown",
            "highlight_code",
            "preview_check",
            "ready",
            "set_window_zoom",
            "document_changed",
            "set_title",
            "close_window",
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
