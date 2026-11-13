//! Guards the native file-dialog backend split.
//!
//! `tauri-plugin-dialog` enables rfd's GTK3 backend by default. Linux should use
//! the XDG desktop portal instead, while other desktop targets keep their
//! platform default. Cargo unifies features across a dependency graph, so a
//! root-level entry (or an entry that leaves default features on for Linux)
//! silently selects GTK3 again even if the platform-specific entry asks for the
//! portal.

const MANIFEST: &str = include_str!("../Cargo.toml");

fn manifest() -> toml::Value {
    toml::from_str(MANIFEST).expect("Cargo.toml is valid TOML")
}

fn target_dependency<'a>(manifest: &'a toml::Value, target: &str) -> &'a toml::Value {
    manifest
        .get("target")
        .and_then(|targets| targets.get(target))
        .and_then(|target| target.get("dependencies"))
        .and_then(|dependencies| dependencies.get("tauri-plugin-dialog"))
        .unwrap_or_else(|| panic!("{target} has an explicit tauri-plugin-dialog dependency"))
}

fn feature_list(dependency: &toml::Value) -> Vec<&str> {
    dependency
        .get("features")
        .and_then(toml::Value::as_array)
        .map(|features| features.iter().filter_map(toml::Value::as_str).collect())
        .unwrap_or_default()
}

#[test]
fn linux_selects_xdg_portal_without_gtk3() {
    let manifest = manifest();
    let linux = target_dependency(&manifest, "cfg(target_os = \"linux\")");
    assert_eq!(
        linux.get("default-features").and_then(toml::Value::as_bool),
        Some(false),
        "the Linux dialog dependency must disable its default GTK3 backend"
    );
    let features = feature_list(linux);
    assert!(
        features.contains(&"xdg-portal"),
        "the Linux dialog dependency must enable the XDG portal backend"
    );
    assert!(
        !features.contains(&"gtk3"),
        "the Linux dialog dependency must not enable GTK3"
    );
}

#[test]
fn other_targets_keep_the_plugin_default_backend() {
    let manifest = manifest();
    let non_linux = target_dependency(&manifest, "cfg(not(target_os = \"linux\"))");
    assert_ne!(
        non_linux
            .get("default-features")
            .and_then(toml::Value::as_bool),
        Some(false),
        "non-Linux targets must keep the plugin's platform default features"
    );
    let features = feature_list(non_linux);
    assert!(
        !features.contains(&"xdg-portal") && !features.contains(&"gtk3"),
        "non-Linux targets must not opt into a Linux dialog backend"
    );
}

#[test]
fn no_root_dependency_re_enables_the_default_backend() {
    let manifest = manifest();
    assert!(
        manifest
            .get("dependencies")
            .and_then(|dependencies| dependencies.get("tauri-plugin-dialog"))
            .is_none(),
        "a root-level dialog dependency would union its default GTK3 feature into Linux"
    );
}
