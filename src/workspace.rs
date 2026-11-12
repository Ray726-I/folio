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
    closing: std::collections::HashSet<String>,
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
/// Deterministic, platform-independent sequential quit coordinator.
///
/// Quit closes one workspace at a time through the existing per-window close
/// review. A window advances only after the native Destroyed event, never on a
/// command result. Cancellation, error or timeout stops the sequence; windows
/// already closed stay closed and the remaining ones stay open.
#[derive(Debug, PartialEq, Eq)]
pub enum QuitStart {
    Ignored,
    NoWindows,
    Busy,
    Review { token: u64, label: String },
}

#[derive(Debug, PartialEq, Eq)]
pub enum QuitStep {
    Ignored,
    Next { token: u64, label: String },
    Complete { token: u64 },
    Cancel { token: u64, label: String },
}

struct QuitSequence {
    token: u64,
    current: String,
    remaining: std::collections::VecDeque<String>,
    /// Set when close_window has validated this exact token/label and is about
    /// to request native destruction. Timeout must not revoke an admitted close.
    admitted: bool,
}

#[derive(Default)]
pub struct QuitCoordinator {
    next_token: u64,
    /// Window creation is serialized with the quit snapshot so a workspace
    /// cannot be registered between "snapshot labels" and "sequence active".
    creating: usize,
    sequence: Option<QuitSequence>,
    exiting: bool,
    /// Windows whose ordinary CloseRequested/close_window path was already
    /// reviewed. They are allowed to finish the last-window exit without
    /// being mistaken for an unreviewed native termination.
    normal_close: std::collections::HashSet<String>,
}

impl QuitCoordinator {
    fn next_token(&mut self) -> u64 {
        self.next_token = self.next_token.saturating_add(1);
        self.next_token
    }

    pub fn begin_window_creation(&mut self) -> bool {
        if self.sequence.is_some() || self.exiting {
            return false;
        }
        self.creating = self.creating.saturating_add(1);
        true
    }

    pub fn finish_window_creation(&mut self) {
        self.creating = self.creating.saturating_sub(1);
    }

    pub fn begin(&mut self, labels: Vec<String>) -> QuitStart {
        if self.exiting || self.sequence.is_some() {
            return QuitStart::Ignored;
        }
        if self.creating > 0 {
            return QuitStart::Busy;
        }
        let mut seen = std::collections::HashSet::new();
        let mut labels: Vec<String> = labels
            .into_iter()
            .filter(|label| seen.insert(label.clone()))
            .collect();
        if labels.is_empty() {
            // No workspace can be left behind: this is a terminal state, and
            // new window creation must be rejected until the process exits.
            self.exiting = true;
            return QuitStart::NoWindows;
        }
        self.exiting = false;
        let token = self.next_token();
        let current = labels.remove(0);
        self.sequence = Some(QuitSequence {
            token,
            current: current.clone(),
            remaining: labels.into(),
            admitted: false,
        });
        QuitStart::Review {
            token,
            label: current,
        }
    }

    pub fn is_active(&self) -> bool {
        self.sequence.is_some()
    }

    pub fn is_current(&self, label: &str) -> bool {
        self.sequence
            .as_ref()
            .is_some_and(|sequence| sequence.current == label)
    }

    /// Atomically validate a quit token for this exact window and mark the
    /// close as admitted. After this succeeds, timeout cannot revoke it.
    /// A duplicate or stale close is rejected.
    pub fn admit_close(&mut self, token: u64, label: &str) -> bool {
        let Some(sequence) = &mut self.sequence else {
            return false;
        };
        if sequence.token != token || sequence.current != label || sequence.admitted {
            return false;
        }
        sequence.admitted = true;
        true
    }

    /// Native destruction failed after admission. Stop the sequence so the
    /// window can stay open and rewrite its live recovery.
    pub fn close_failed(&mut self, token: u64, label: &str) -> bool {
        let Some(sequence) = &self.sequence else {
            return false;
        };
        if sequence.token != token || sequence.current != label {
            return false;
        }
        self.sequence = None;
        true
    }

    /// Called only after the window is actually destroyed. A missing current
    /// window advances the sequence; a missing queued window is skipped. When
    /// the last participant disappears, complete instead of producing a
    /// commit with no window left to acknowledge it.
    pub fn window_closed(&mut self, label: &str) -> QuitStep {
        self.normal_close.remove(label);
        let Some(mut sequence) = self.sequence.take() else {
            return QuitStep::Ignored;
        };
        let token = sequence.token;
        if sequence.current == label {
            if let Some(next) = sequence.remaining.pop_front() {
                sequence.current = next.clone();
                sequence.admitted = false;
                self.sequence = Some(sequence);
                QuitStep::Next { token, label: next }
            } else {
                self.exiting = true;
                QuitStep::Complete { token }
            }
        } else {
            sequence.remaining.retain(|item| item != label);
            self.sequence = Some(sequence);
            QuitStep::Ignored
        }
    }

    /// The target window declined or failed to close. Stop before touching any
    /// further window; no approval is inferred from a token.
    pub fn cancel_window(&mut self, token: u64, label: &str) -> bool {
        let Some(sequence) = &self.sequence else {
            return false;
        };
        if sequence.token != token || sequence.current != label || sequence.admitted {
            return false;
        }
        self.sequence = None;
        true
    }

    /// Timeout invalidates the token without approving or destroying anything.
    /// Once close_window admitted the close, expiry is ignored: destruction is
    /// already irreversible and the frontend must not be unlocked mid-close.
    pub fn expire(&mut self, token: u64, label: &str) -> QuitStep {
        let Some(sequence) = &self.sequence else {
            return QuitStep::Ignored;
        };
        if sequence.token != token || sequence.current != label || sequence.admitted {
            return QuitStep::Ignored;
        }
        self.sequence = None;
        QuitStep::Cancel {
            token,
            label: label.into(),
        }
    }

    pub fn normal_close_approved(&mut self, label: &str) {
        self.normal_close.insert(label.into());
    }

    pub fn normal_close_cancelled(&mut self, label: &str) {
        self.normal_close.remove(label);
    }

    /// Only our own completed sequence, an empty workspace, or a set of windows
    /// that already completed the ordinary close review may leave the process.
    /// A window still being created must never be lost to an exit.
    pub fn allows_exit(&self, labels: &[String]) -> bool {
        self.creating == 0
            && (self.exiting
                || (self.sequence.is_none()
                    && (labels.is_empty()
                        || labels.iter().all(|label| self.normal_close.contains(label)))))
    }
}

impl Registry {
    pub fn owner(&self, id: &str) -> &str {
        self.owners.get(id).map(String::as_str).unwrap_or("main")
    }
    /// Reject a discard-recovery list unless every ID is currently owned by
    /// this window. Callers hold the registry lock so ownership cannot change
    /// between validation and admitting the close.
    pub fn validate_owned(&self, window: &str, ids: &[String]) -> Result<(), String> {
        for id in ids {
            if self.transfers.contains_key(id) {
                return Err("This document is moving to another window.".into());
            }
            self.id_for(window, Some(id), false)?;
        }
        Ok(())
    }
    /// Mark a window as closing so no document can start moving out after the
    /// discard list was validated but before native destruction.
    pub fn begin_close(&mut self, window: &str) -> Result<(), String> {
        if self
            .transfers
            .values()
            .any(|(source, destination, _)| source == window || destination == window)
        {
            return Err(
                "Wait for the document to finish moving before closing this window.".into(),
            );
        }
        self.closing.insert(window.into());
        Ok(())
    }
    pub fn end_close(&mut self, window: &str) {
        self.closing.remove(window);
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
        if self.closing.contains(source) || self.closing.contains(destination) {
            return Err("This window is closing.".into());
        }
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
    #[test]
    fn discard_recovery_ids_must_belong_to_the_closing_window() {
        let mut registry = Registry::default();
        let main_doc = registry.new_document_for("main");
        let other_doc = registry.new_document_for("workspace-a");
        assert!(registry
            .validate_owned("main", std::slice::from_ref(&main_doc))
            .is_ok());
        assert!(registry
            .validate_owned("main", std::slice::from_ref(&other_doc))
            .is_err());
        assert!(registry
            .validate_owned("main", &["missing-document".into()])
            .is_err());
        registry
            .begin_transfer("main", "workspace-a", &main_doc, "token")
            .unwrap();
        assert!(registry
            .validate_owned("main", std::slice::from_ref(&main_doc))
            .is_err());
    }
    #[test]
    fn closing_window_rejects_new_transfers() {
        let mut registry = Registry::default();
        let id = registry.new_document_for("main");
        registry.begin_close("main").unwrap();
        assert!(registry
            .begin_transfer("main", "workspace-a", &id, "token")
            .is_err());
        registry.end_close("main");
        assert!(registry
            .begin_transfer("main", "workspace-a", &id, "token")
            .is_ok());
        // Destination is equally terminal: closing it would abandon a tab that
        // is already in flight to it.
        assert!(registry.begin_close("workspace-a").is_err());
        assert!(registry.begin_close("main").is_err());
        registry
            .finish_transfer("workspace-a", &id, "token")
            .unwrap();
        assert!(registry.begin_close("workspace-a").is_ok());
        let other = registry.new_document_for("main");
        assert!(registry
            .begin_transfer("main", "workspace-a", &other, "token-2")
            .is_err());
        registry.end_close("workspace-a");
    }
    fn quit_labels() -> Vec<String> {
        vec!["main".into(), "workspace-a".into()]
    }
    #[test]
    fn sequential_quit_advances_only_after_actual_destruction() {
        let mut quit = QuitCoordinator::default();
        let QuitStart::Review { token, label } = quit.begin(quit_labels()) else {
            panic!("expected a review request");
        };
        assert_eq!(label, "main");
        assert!(quit.is_active());
        assert!(quit.is_current("main"));
        assert_eq!(quit.begin(quit_labels()), QuitStart::Ignored);
        assert_eq!(quit.window_closed("workspace-a"), QuitStep::Ignored);
        assert!(quit.is_current("main"));
        assert_eq!(quit.window_closed("main"), QuitStep::Complete { token });
        assert!(!quit.is_active());
        assert!(quit.allows_exit(&[]));
    }
    #[test]
    fn sequential_quit_moves_to_the_next_window_after_destruction() {
        let mut quit = QuitCoordinator::default();
        let QuitStart::Review { token, label } = quit.begin(quit_labels()) else {
            panic!("expected a review request");
        };
        assert_eq!(label, "main");
        assert_eq!(
            quit.window_closed("main"),
            QuitStep::Next {
                token,
                label: "workspace-a".into(),
            }
        );
        assert!(quit.is_current("workspace-a"));
        assert_eq!(
            quit.window_closed("workspace-a"),
            QuitStep::Complete { token }
        );
    }
    #[test]
    fn quit_cancel_and_timeout_never_infer_approval() {
        let mut quit = QuitCoordinator::default();
        let QuitStart::Review { token, label: _ } = quit.begin(quit_labels()) else {
            panic!("expected a review request");
        };
        assert!(!quit.cancel_window(token, "workspace-a"));
        assert!(quit.cancel_window(token, "main"));
        assert!(!quit.is_active());
        assert_eq!(quit.window_closed("main"), QuitStep::Ignored);
        assert!(!quit.allows_exit(&["main".into(), "workspace-a".into()]));

        let QuitStart::Review { token, label } = quit.begin(quit_labels()) else {
            panic!("expected a new review request");
        };
        assert_eq!(
            quit.expire(token, "main"),
            QuitStep::Cancel {
                token,
                label: label.clone(),
            }
        );
        assert!(!quit.is_active());
        assert_eq!(quit.expire(token, "main"), QuitStep::Ignored);
        assert!(!quit.allows_exit(&["main".into(), "workspace-a".into()]));
    }
    #[test]
    fn window_creation_and_quit_snapshot_are_mutually_exclusive() {
        let mut quit = QuitCoordinator::default();
        assert!(quit.begin_window_creation());
        assert_eq!(quit.begin(quit_labels()), QuitStart::Busy);
        assert!(
            !quit.allows_exit(&[]),
            "a pending window creation must block last-window exit"
        );
        quit.finish_window_creation();
        let QuitStart::Review { token, label } = quit.begin(quit_labels()) else {
            panic!("expected a review request");
        };
        assert!(
            !quit.begin_window_creation(),
            "new windows are blocked while quitting"
        );
        quit.cancel_window(token, &label);
        assert!(quit.begin_window_creation());
        quit.finish_window_creation();
    }
    #[test]
    fn no_window_and_completed_quit_are_terminal_for_new_creation() {
        let mut quit = QuitCoordinator::default();
        assert_eq!(quit.begin(Vec::new()), QuitStart::NoWindows);
        assert!(quit.allows_exit(&[]));
        assert!(
            !quit.begin_window_creation(),
            "NoWindows is terminal; a new window must not race app.exit"
        );
        assert_eq!(quit.begin(quit_labels()), QuitStart::Ignored);

        let mut completed = QuitCoordinator::default();
        let QuitStart::Review { token, label } = completed.begin(vec!["main".into()]) else {
            panic!("expected a review request");
        };
        assert!(completed.admit_close(token, &label));
        assert_eq!(
            completed.window_closed(&label),
            QuitStep::Complete { token }
        );
        assert!(completed.allows_exit(&[]));
        assert!(!completed.begin_window_creation());
    }
    #[test]
    fn admitted_close_cannot_be_revoked_by_timeout_or_cancel() {
        let mut quit = QuitCoordinator::default();
        let QuitStart::Review { token, label } = quit.begin(quit_labels()) else {
            panic!("expected a review request");
        };
        assert!(quit.admit_close(token, &label));
        assert!(
            !quit.admit_close(token, &label),
            "duplicate close is rejected"
        );
        assert_eq!(
            quit.expire(token, &label),
            QuitStep::Ignored,
            "expiry must not revoke admitted destruction"
        );
        assert!(!quit.cancel_window(token, &label));
        assert_eq!(
            quit.window_closed(&label),
            QuitStep::Next {
                token,
                label: "workspace-a".into(),
            }
        );
    }
    #[test]
    fn advancing_to_the_next_window_resets_admission() {
        let mut quit = QuitCoordinator::default();
        let QuitStart::Review { token, label } = quit.begin(quit_labels()) else {
            panic!("expected a review request");
        };
        assert!(quit.admit_close(token, &label));
        assert_eq!(
            quit.window_closed(&label),
            QuitStep::Next {
                token,
                label: "workspace-a".into(),
            }
        );
        assert!(
            quit.admit_close(token, "workspace-a"),
            "the next window must be independently admissible"
        );
        assert_eq!(
            quit.expire(token, "workspace-a"),
            QuitStep::Ignored,
            "its own admitted close is still not revocable by timeout"
        );
        assert_eq!(
            quit.window_closed("workspace-a"),
            QuitStep::Complete { token }
        );

        let mut retry = QuitCoordinator::default();
        let QuitStart::Review { token, label } = retry.begin(quit_labels()) else {
            panic!("expected a new review request");
        };
        assert!(retry.admit_close(token, &label));
        assert!(matches!(retry.window_closed(&label), QuitStep::Next { .. }));
        assert!(
            retry.cancel_window(token, "workspace-a"),
            "cancel works for the non-admitted next window"
        );
        assert!(!retry.is_active());
    }
    #[test]
    fn failed_admitted_close_stops_the_sequence() {
        let mut quit = QuitCoordinator::default();
        let QuitStart::Review { token, label } = quit.begin(quit_labels()) else {
            panic!("expected a review request");
        };
        assert!(quit.admit_close(token, &label));
        assert!(quit.close_failed(token, &label));
        assert!(!quit.is_active());
        assert_eq!(
            quit.window_closed(&label),
            QuitStep::Ignored,
            "a failed close must not advance after rollback"
        );
    }
    #[test]
    fn normal_window_close_is_distinguished_from_an_unreviewed_app_exit() {
        let mut quit = QuitCoordinator::default();
        quit.normal_close_approved("main");
        assert!(!quit.allows_exit(&["main".into(), "workspace-a".into()]));
        quit.normal_close_approved("workspace-a");
        assert!(quit.allows_exit(&["main".into(), "workspace-a".into()]));
        assert!(quit.allows_exit(&[]));
        quit.normal_close_cancelled("workspace-a");
        assert!(!quit.allows_exit(&["main".into(), "workspace-a".into()]));
        let mut empty = QuitCoordinator::default();
        assert_eq!(empty.begin(Vec::new()), QuitStart::NoWindows);
        assert!(empty.allows_exit(&[]));
    }
}
