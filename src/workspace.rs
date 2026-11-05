use crate::document::{self, Document, OpenDocument};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
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
    pub fn open(&mut self, path: &Path) -> Result<(String, Document), String> {
        let (document, mut data) = document::load(path)?;
        let id = self
            .sessions
            .iter()
            .find(|(_, item)| item.as_ref().is_some_and(|item| item.path == document.path))
            .map(|(id, _)| id.clone())
            .unwrap_or_else(fresh_id);
        self.sessions.insert(id.clone(), Some(document));
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
