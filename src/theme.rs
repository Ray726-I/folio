use serde::Serialize;
use std::{collections::BTreeMap, fs, path::PathBuf};

#[derive(Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub name: String,
    pub mode: String,
    pub colors: BTreeMap<String, String>,
}

pub fn parse(source: &str, name: String) -> Option<Theme> {
    let values: toml::Table = source.parse().ok()?;
    let colors: BTreeMap<String, String> = values
        .iter()
        .filter_map(|(key, value)| {
            let color = value.as_str()?;
            (color.len() == 7
                && color.starts_with('#')
                && color[1..].chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| (key.clone(), color.to_string()))
        })
        .collect();
    if !colors.contains_key("background") || !colors.contains_key("foreground") {
        return None;
    }
    Some(Theme {
        name,
        mode: values
            .get("mode")
            .and_then(|value| value.as_str())
            .unwrap_or("dark")
            .into(),
        colors,
    })
}

pub fn current() -> Option<Theme> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let state = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/state"));
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    for current in [
        state.join("omarchy/current"),
        config.join("omarchy/current"),
    ] {
        if let Ok(source) = fs::read_to_string(current.join("theme/colors.toml")) {
            let name =
                fs::read_to_string(current.join("theme.name")).unwrap_or_else(|_| "Omarchy".into());
            if let Some(theme) = parse(&source, name.trim().replace('-', " ")) {
                return Some(theme);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_accepts_palette_colors() {
        let theme = parse(
            "background = '#060b1e'\nforeground = '#ffcead'\naccent = 'url(evil)'\nmode = 'dark'",
            "test".into(),
        )
        .unwrap();
        assert_eq!(theme.colors.len(), 2);
        assert!(!theme.colors.contains_key("accent"));
    }
}
