//! Guards the three-place command contract.
//!
//! Every custom command must appear in `generate_handler!` (src/main.rs), the
//! build-time command manifest (build.rs), and a capability permission
//! (capabilities/main.json). A command missing from the manifest or the
//! capability compiles and registers fine, but the Tauri ACL rejects it at
//! runtime with "not allowed. Command not found" — the UI then only shows a
//! toast. `set_touchpad_zoom` shipped in exactly that state.

use std::collections::BTreeSet;

const MAIN: &str = include_str!("../src/main.rs");
const BUILD: &str = include_str!("../build.rs");
const CAPABILITIES: &str = include_str!("../capabilities/main.json");

fn quoted_commands(source: &str, marker: &str, terminator: &str) -> BTreeSet<String> {
    let start = source
        .find(marker)
        .unwrap_or_else(|| panic!("missing {marker}"))
        + marker.len();
    let rest = &source[start..];
    let end = rest
        .find(terminator)
        .unwrap_or_else(|| panic!("unterminated {marker}"));
    rest[..end]
        .split(',')
        .map(|entry| entry.trim().trim_matches('"'))
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}

fn handler_commands() -> BTreeSet<String> {
    quoted_commands(MAIN, "generate_handler![", "]")
}

fn manifest_commands() -> BTreeSet<String> {
    quoted_commands(BUILD, ".commands(&[", "])")
}

fn capability_commands(identifier: &str) -> BTreeSet<String> {
    let capabilities: serde_json::Value =
        serde_json::from_str(CAPABILITIES).expect("capabilities/main.json is valid JSON");
    let capability = capabilities
        .as_array()
        .expect("capabilities are a list")
        .iter()
        .find(|entry| entry["identifier"] == identifier)
        .unwrap_or_else(|| panic!("missing capability {identifier}"));
    capability["permissions"]
        .as_array()
        .expect("permissions are a list")
        .iter()
        .filter_map(|permission| permission.as_str())
        .filter_map(|permission| permission.strip_prefix("allow-"))
        .map(|permission| permission.replace('-', "_"))
        .collect()
}

#[test]
fn every_registered_command_is_in_the_build_manifest() {
    let registered = handler_commands();
    let manifest = manifest_commands();
    assert_eq!(
        registered, manifest,
        "build.rs and generate_handler! must list exactly the same commands"
    );
}

#[test]
fn every_registered_command_has_a_capability_permission() {
    let registered = handler_commands();
    let main = capability_commands("main");
    let renderer = capability_commands("mermaid-renderer");
    let allowed: BTreeSet<String> = main.union(&renderer).cloned().collect();
    let missing: Vec<&String> = registered.difference(&allowed).collect();
    assert!(
        missing.is_empty(),
        "commands registered but not allowed by any capability: {missing:?}"
    );
    let unknown: Vec<&String> = allowed.difference(&registered).collect();
    assert!(
        unknown.is_empty(),
        "capability permissions without a registered command: {unknown:?}"
    );
}

#[test]
fn renderer_only_commands_stay_out_of_the_main_capability() {
    let main = capability_commands("main");
    let renderer = capability_commands("mermaid-renderer");
    assert!(
        main.is_disjoint(&renderer),
        "a command must belong to exactly one webview"
    );
    assert_eq!(
        renderer,
        BTreeSet::from([
            "mermaid_render_result".to_string(),
            "mermaid_renderer_ready".to_string()
        ]),
        "the hidden renderer may only answer render jobs"
    );
    for command in [
        "set_touchpad_zoom",
        "set_window_zoom",
        "open_document",
        "save_document",
    ] {
        assert!(
            main.contains(command),
            "{command} must stay available to the main webview"
        );
    }
}
