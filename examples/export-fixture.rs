//! Test harness for the standalone HTML export.
//!
//! Reads `{ source, base, theme, assets }` JSON from stdin and prints the
//! generated document to stdout. The browser regression test uses this to
//! inspect the exact offline artifact without a running Tauri window.

#[path = "../src/export.rs"]
#[allow(dead_code)]
mod export;
#[path = "../src/markdown.rs"]
#[allow(dead_code)]
mod markdown;
#[path = "../src/renderer.rs"]
#[allow(dead_code, unused_imports)]
mod renderer;

// `renderer.rs` is shared with the native app, and `cargo test --all-targets`
// compiles its unit tests into this fixture too. The fixture never opens a
// window, so these stubs must mirror the app's deny-by-default gate in
// `src/workspace.rs`: the registry is seeded with the main window and grows
// only when a native window is constructed, which never happens here. An
// unconditional `Ok` would let the shared caller-gate tests pass vacuously.
mod workspace {
    use crate::renderer::MAIN_LABEL;

    pub fn ensure_window(label: &str) -> Result<(), String> {
        if label == MAIN_LABEL {
            Ok(())
        } else {
            Err("This webview is not an application workspace.".into())
        }
    }
    pub fn window_labels() -> Vec<String> {
        vec![MAIN_LABEL.into()]
    }
}

fn is_app_navigation(_url: &tauri::Url) -> bool {
    false
}

fn main() {
    let mut input = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut input).unwrap();
    let request: serde_json::Value = serde_json::from_str(&input).unwrap();
    let source = request["source"].as_str().unwrap_or_default();
    let base = request["base"].as_str().map(std::path::Path::new);
    let theme: export::ExportTheme =
        serde_json::from_value(request.get("theme").cloned().unwrap_or_default()).unwrap();
    let assets: Vec<export::ExportAsset> =
        serde_json::from_value(request.get("assets").cloned().unwrap_or_default()).unwrap();
    match export::export_document(
        source,
        base,
        &markdown::DEFAULT_RENDER_LIMITS,
        assets,
        theme,
    ) {
        Ok(document) => print!("{document}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{renderer, workspace};

    /// The fixture links the app's shared renderer module, which `cargo test
    /// --all-targets` builds with its unit tests. If these stubs admit more
    /// than the main window, the shared gate tests stop meaning anything, so
    /// pin the stub contract where it is defined.
    #[test]
    fn workspace_stub_admits_only_the_main_window() {
        assert!(workspace::ensure_window(renderer::MAIN_LABEL).is_ok());
        assert!(workspace::ensure_window(renderer::RENDERER_LABEL).is_err());
        assert!(workspace::ensure_window("other").is_err());
        assert_eq!(
            workspace::window_labels(),
            vec![renderer::MAIN_LABEL.to_string()]
        );
    }
}
