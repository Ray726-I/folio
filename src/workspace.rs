use crate::document::{self, Document, OpenDocument};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
// Labels enter this set only immediately before native window construction.
fn windows() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static WINDOWS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    WINDOWS.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::from(["main".into()])))
}
pub fn ensure_window(label: &str) -> Result<(), String> {
    if windows().lock().unwrap().contains(label) {
        Ok(())
    } else {
        Err("This webview is not an application workspace.".into())
    }
}
pub fn register_window(label: &str) {
    windows().lock().unwrap().insert(label.into());
}
pub fn unregister_window(label: &str) {
    windows().lock().unwrap().remove(label);
}
pub fn window_labels() -> Vec<String> {
    windows().lock().unwrap().iter().cloned().collect()
}
pub struct RecoveryBaseline {
    pub original_path: Option<String>,
    pub fingerprint: Option<String>,
    pub bom: bool,
    pub crlf: bool,
}
#[derive(Default)]
pub struct Registry {
    pub sessions: HashMap<String, Option<OpenDocument>>,
    pub active: Option<String>,
    pub owners: HashMap<String, String>,
    pub window_active: HashMap<String, String>,
    pub transfers: HashMap<String, (String, String, String)>,
    pub encoding: HashMap<String, (bool, bool)>,
    pub recovery_origins: HashMap<String, (Option<String>, Option<String>)>,
}
pub fn fresh_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "doc-{:x}-{:x}-{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
impl Registry {
    pub fn owner(&self, id: &str) -> &str {
        self.owners.get(id).map(String::as_str).unwrap_or("main")
    }
    pub fn id_for(&self, window: &str, id: Option<&str>, mutate: bool) -> Result<String, String> {
        let id = id
            .or_else(|| self.window_active.get(window).map(String::as_str))
            .or_else(|| {
                if window == "main" {
                    self.active.as_deref()
                } else {
                    None
                }
            })
            .ok_or("No open document")?;
        self.id(Some(id))?;
        if let Some((_, destination, _)) = self.transfers.get(id) {
            if mutate {
                return Err("This document is moving to another window.".into());
            }
            if destination == window {
                return Ok(id.into());
            }
        }
        if self.owner(id) != window {
            return Err("This document belongs to another window.".into());
        }
        Ok(id.into())
    }
    pub fn get_for(&self, window: &str, id: Option<&str>) -> Result<Option<OpenDocument>, String> {
        if id.is_none()
            && !self.window_active.contains_key(window)
            && (window != "main" || self.active.is_none())
        {
            return Ok(None);
        }
        self.get(Some(&self.id_for(window, id, false)?))
    }
    pub fn activate_for(&mut self, window: &str, id: &str) -> Result<(), String> {
        self.id_for(window, Some(id), true)?;
        self.window_active.insert(window.into(), id.into());
        if window == "main" {
            self.active = Some(id.into());
        }
        Ok(())
    }
    pub fn new_document_for(&mut self, window: &str) -> String {
        let id = fresh_id();
        self.sessions.insert(id.clone(), None);
        self.owners.insert(id.clone(), window.into());
        self.activate_for(window, &id).unwrap();
        id
    }
    pub fn open_for(
        &mut self,
        window: &str,
        path: &Path,
        reuse: bool,
    ) -> Result<(String, Document), String> {
        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        if let Some((id, _)) = self
            .sessions
            .iter()
            .find(|(_, doc)| doc.as_ref().is_some_and(|d| d.path == canonical))
        {
            self.id_for(window, Some(id), true)?;
        }
        let main_active = self.active.clone();
        let (id, data) = self.open_with_reuse(path, reuse)?;
        if window != "main" {
            self.active = main_active;
        }
        self.owners.insert(id.clone(), window.into());
        self.activate_for(window, &id)?;
        Ok((id, data))
    }
    pub fn begin_transfer(
        &mut self,
        source: &str,
        destination: &str,
        id: &str,
        token: &str,
    ) -> Result<(), String> {
        self.id_for(source, Some(id), true)?;
        self.transfers
            .insert(id.into(), (source.into(), destination.into(), token.into()));
        Ok(())
    }
    pub fn rollback_transfer(&mut self, id: &str) {
        self.transfers.remove(id);
    }
    pub fn finish_transfer(
        &mut self,
        destination: &str,
        id: &str,
        token: &str,
    ) -> Result<(), String> {
        let (source, target, expected) =
            self.transfers.get(id).ok_or("No pending window transfer")?;
        if target != destination || expected != token {
            return Err("Invalid window transfer acknowledgement".into());
        }
        let source = source.clone();
        self.owners.insert(id.into(), destination.into());
        self.transfers.remove(id);
        if self
            .window_active
            .get(&source)
            .is_some_and(|active| active == id)
        {
            self.window_active.remove(&source);
        }
        if source == "main" && self.active.as_deref() == Some(id) {
            self.active = None;
        }
        self.activate_for(destination, id)
    }
    #[cfg(test)]
    pub fn new_document(&mut self) -> String {
        let id = fresh_id();
        self.sessions.insert(id.clone(), None);
        self.active = Some(id.clone());
        id
    }
    pub fn id(&self, id: Option<&str>) -> Result<String, String> {
        let id = id.or(self.active.as_deref()).ok_or("No open document")?;
        if !self.sessions.contains_key(id) {
            return Err("This document session is closed".into());
        }
        Ok(id.into())
    }
    pub fn get(&self, id: Option<&str>) -> Result<Option<OpenDocument>, String> {
        match id {
            None if self.active.is_none() => Ok(None),
            _ => Ok(self.sessions[&self.id(id)?].clone()),
        }
    }
    #[cfg(test)]
    pub fn open(&mut self, path: &Path) -> Result<(String, Document), String> {
        self.open_with_reuse(path, false)
    }
    pub fn open_with_reuse(
        &mut self,
        path: &Path,
        reuse: bool,
    ) -> Result<(String, Document), String> {
        let (document, mut data) = document::load(path)?;
        let id = self
            .sessions
            .iter()
            .find(|(_, item)| item.as_ref().is_some_and(|item| item.path == document.path))
            .map(|(id, _)| id.clone())
            .unwrap_or_else(fresh_id);
        if !reuse || !self.sessions.contains_key(&id) {
            self.sessions.insert(id.clone(), Some(document));
        }
        self.active = Some(id.clone());
        data.document_id = id.clone();
        Ok((id, data))
    }
    pub fn recovery_metadata(&self, id: &str) -> Result<RecoveryBaseline, String> {
        let document = self.get(Some(id))?;
        let origin = self.recovery_origins.get(id);
        let (bom, crlf) = document
            .as_ref()
            .map(|d| (d.bom, d.crlf))
            .or_else(|| self.encoding.get(id).copied())
            .unwrap_or_default();
        Ok(RecoveryBaseline {
            original_path: document
                .as_ref()
                .map(|d| d.path.to_string_lossy().into())
                .or_else(|| origin.and_then(|o| o.0.clone())),
            fingerprint: document
                .as_ref()
                .map(|d| d.fingerprint.clone())
                .or_else(|| origin.and_then(|o| o.1.clone())),
            bom,
            crlf,
        })
    }
    pub fn save(
        &mut self,
        id: &str,
        path: &Path,
        content: &str,
        force: bool,
    ) -> Result<OpenDocument, document::SaveError> {
        self.id(Some(id))?;
        self.check_destination(id, path)?;
        document::save_with_encoding(
            path,
            content,
            self.sessions[id].as_ref(),
            force,
            self.encoding.get(id).copied(),
        )
    }
    pub fn destination(path: &Path) -> Result<PathBuf, String> {
        if path.exists() {
            path.canonicalize().map_err(|e| e.to_string())
        } else {
            Ok(path
                .parent()
                .ok_or("Invalid destination")?
                .canonicalize()
                .map_err(|e| e.to_string())?
                .join(path.file_name().ok_or("Invalid destination")?))
        }
    }
    pub fn check_destination(&self, id: &str, path: &Path) -> Result<(), String> {
        let path = Self::destination(path)?;
        if self
            .sessions
            .iter()
            .any(|(other, doc)| other != id && doc.as_ref().is_some_and(|doc| doc.path == path))
        {
            Err("This destination is already open in another document. Activate that document instead.".into())
        } else {
            Ok(())
        }
    }
    pub fn close(&mut self, id: &str) -> Result<(), String> {
        self.id(Some(id))?;
        self.sessions.remove(id);
        self.owners.remove(id);
        self.transfers.remove(id);
        self.window_active.retain(|_, active| active != id);
        self.encoding.remove(id);
        self.recovery_origins.remove(id);
        if self.active.as_deref() == Some(id) {
            self.active = None;
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_prefix_alone_does_not_grant_application_access() {
        assert!(ensure_window("workspace-forged-label").is_err());
        register_window("workspace-trusted-test");
        assert!(ensure_window("workspace-trusted-test").is_ok());
        unregister_window("workspace-trusted-test");
        assert!(ensure_window("workspace-trusted-test").is_err());
    }
    #[test]
    fn opening_in_a_second_window_keeps_main_active_and_foreign_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        let mut r = Registry::default();
        let (first, _) = r.open_for("main", &a, true).unwrap();
        r.open_for("workspace-test", &b, true).unwrap();
        assert_eq!(r.id_for("main", None, true).unwrap(), first);
        std::fs::write(&a, "external").unwrap();
        assert!(r.open_for("workspace-test", &a, false).is_err());
        assert!(r.save(&first, &a, "edit", false).is_err());
    }
    #[test]
    fn window_context_denies_foreign_sessions_and_resolves_own_active() {
        let mut r = Registry::default();
        let a = r.new_document_for("main");
        let b = r.new_document_for("workspace-test");
        assert_eq!(r.id_for("main", None, true).unwrap(), a);
        assert_eq!(r.id_for("workspace-test", None, true).unwrap(), b);
        assert!(r.id_for("main", Some(&b), false).is_err());
    }
    #[test]
    fn pending_transfer_is_read_only_until_ack_and_rollback_keeps_source() {
        let mut r = Registry::default();
        let id = r.new_document_for("main");
        r.begin_transfer("main", "workspace-test", &id, "token")
            .unwrap();
        assert!(r.id_for("workspace-test", Some(&id), false).is_ok());
        assert!(r.id_for("workspace-test", Some(&id), true).is_err());
        assert!(r.id_for("main", Some(&id), true).is_err());
        assert!(r.finish_transfer("main", &id, "token").is_err());
        r.rollback_transfer(&id);
        assert!(r.id_for("main", Some(&id), true).is_ok());
        r.begin_transfer("main", "workspace-test", &id, "token2")
            .unwrap();
        r.finish_transfer("workspace-test", &id, "token2").unwrap();
        assert!(r.id_for("main", Some(&id), false).is_err());
        assert_eq!(r.id_for("workspace-test", None, true).unwrap(), id);
    }
    #[test]
    fn reusing_an_open_tab_does_not_refresh_its_save_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        std::fs::write(&path, "old").unwrap();
        let mut registry = Registry::default();
        let (id, _) = registry.open(&path).unwrap();
        std::fs::write(&path, "external").unwrap();
        assert_eq!(registry.open_with_reuse(&path, true).unwrap().0, id);
        assert!(registry.save(&id, &path, "edited", false).is_err());
    }
    #[test]
    fn reopening_refreshes_the_disk_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        std::fs::write(&path, "old").unwrap();
        let mut registry = Registry::default();
        let (id, _) = registry.open(&path).unwrap();
        std::fs::write(&path, "\u{feff}new\r\n").unwrap();
        let (same, data) = registry.open(&path).unwrap();
        assert_eq!(id, same);
        assert_eq!(data.content, "new\n");
        let baseline = registry.get(Some(&id)).unwrap().unwrap();
        assert!(!document::changed(&baseline));
        assert!(baseline.bom && baseline.crlf);
    }
    #[test]
    fn unnamed_recovery_preserves_encoding_when_saved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        let mut registry = Registry::default();
        let id = registry.new_document();
        registry.encoding.insert(id.clone(), (true, true));
        registry.save(&id, &path, "draft\n", false).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"\xef\xbb\xbfdraft\r\n");
    }
    #[test]
    fn detached_recovery_keeps_origin_across_snapshots() {
        let mut registry = Registry::default();
        let id = registry.new_document();
        let origin = crate::recovery::Record {
            document_id: id.clone(),
            revision: 1,
            content: "draft".into(),
            name: "lost.md".into(),
            original_path: Some("/missing/lost.md".into()),
            baseline_fingerprint: Some("disk-hash".into()),
            bom: true,
            crlf: true,
            snapshot_time: 1,
        };
        registry.recovery_origins.insert(
            id.clone(),
            (
                origin.original_path.clone(),
                origin.baseline_fingerprint.clone(),
            ),
        );
        registry.encoding.insert(id.clone(), (true, true));
        let next = registry.recovery_metadata(&id).unwrap();
        assert_eq!(next.original_path, origin.original_path);
        assert_eq!(next.fingerprint, origin.baseline_fingerprint);
        assert!(next.bom && next.crlf);
    }
    #[test]
    fn sessions_deduplicate_and_reject_other_owners() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        std::fs::write(&path, "a").unwrap();
        let mut registry = Registry::default();
        let (a, _) = registry.open(&path).unwrap();
        let (again, _) = registry.open(&path).unwrap();
        assert_eq!(a, again);
        let b = registry.new_document();
        assert!(registry.check_destination(&b, &path).is_err());
        assert!(registry.check_destination(&a, &path).is_ok());
        registry.close(&a).unwrap();
        assert_ne!(registry.open(&path).unwrap().0, a);
    }
}
