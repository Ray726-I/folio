use crate::document::{fingerprint, MAX_DOCUMENT_BYTES};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub document_id: String,
    pub revision: u64,
    pub content: String,
    pub name: String,
    pub original_path: Option<String>,
    pub baseline_fingerprint: Option<String>,
    pub bom: bool,
    pub crlf: bool,
    pub snapshot_time: u64,
}
#[derive(Serialize, Deserialize)]
struct Envelope {
    version: u32,
    checksum: String,
    record: Record,
}
#[derive(Default, Serialize, Deserialize)]
struct Floor {
    revision: u64,
    retired: bool,
    #[serde(default)]
    high_water: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub document_id: String,
    pub message: String,
}
pub struct Store {
    root: PathBuf,
    budget: u64,
}
impl Store {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            budget: 256 * 1024 * 1024,
        }
    }
    fn path(&self, id: &str, kind: &str) -> Result<PathBuf, String> {
        if id.is_empty()
            || id.len() > 160
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("Invalid document ID".into());
        }
        Ok(self.root.join(format!("{id}.{kind}")))
    }
    fn initialize(&self) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn atomic(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        self.initialize()?;
        let mut file = tempfile::NamedTempFile::new_in(&self.root).map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        file.persist(path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        fs::File::open(&self.root)
            .and_then(|file| file.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    fn floor(&self, id: &str) -> Result<Floor, String> {
        let path = self.path(id, "floor")?;
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("Damaged recovery ordering record: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Floor::default()),
            Err(e) => Err(e.to_string()),
        }
    }
    fn generation(&self, id: &str, kind: &str) -> Result<Record, String> {
        let mut bytes = Vec::new();
        fs::File::open(self.path(id, kind)?)
            .map_err(|e| e.to_string())?
            .take(MAX_DOCUMENT_BYTES * 7 + 65536)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let envelope: Envelope = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if envelope.version != 1
            || envelope.record.document_id != id
            || envelope.record.content.len() as u64 > MAX_DOCUMENT_BYTES
            || fingerprint(&serde_json::to_vec(&envelope.record).map_err(|e| e.to_string())?)
                != envelope.checksum
        {
            return Err("Invalid recovery checksum or version".into());
        }
        Ok(envelope.record)
    }
    pub fn restore(&self, id: &str) -> Result<Record, String> {
        let floor = self.floor(id)?;
        if floor.retired {
            return Err("Recovery was discarded".into());
        }
        ["current", "previous"]
            .iter()
            .filter_map(|kind| self.generation(id, kind).ok())
            .filter(|r| r.revision > floor.revision)
            .max_by_key(|r| r.revision)
            .map(|mut record| {
                record.revision = record.revision.max(floor.high_water);
                record
            })
            .ok_or("No valid recovery generation".into())
    }
    pub fn list(&mut self) -> Result<Vec<Record>, String> {
        self.initialize()?;
        let mut ids = std::collections::BTreeSet::new();
        for entry in fs::read_dir(&self.root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some((id, kind)) = name.rsplit_once('.') {
                if kind == "current" || kind == "previous" {
                    ids.insert(id.to_string());
                }
            }
        }
        Ok(ids
            .into_iter()
            .filter_map(|id| self.restore(&id).ok())
            .collect())
    }
    pub fn warnings(&self) -> Result<Vec<Warning>, String> {
        self.initialize()?;
        let mut warnings = Vec::new();
        let mut ids = std::collections::BTreeSet::new();
        let mut damaged_ids = std::collections::BTreeSet::new();
        for entry in fs::read_dir(&self.root).map_err(|e| e.to_string())? {
            let name = entry
                .map_err(|e| e.to_string())?
                .file_name()
                .to_string_lossy()
                .into_owned();
            if let Some((id, kind)) = name.rsplit_once('.') {
                if kind.starts_with("damaged-") {
                    damaged_ids.insert(id.to_string());
                }
                if ["current", "previous", "floor"].contains(&kind) || kind.starts_with("damaged-")
                {
                    ids.insert(id.to_string());
                }
            }
        }
        for id in ids {
            if self.path(&id, "current").is_err() {
                continue;
            }
            let damaged = ["current", "previous"].iter().any(|kind| {
                self.path(&id, kind).is_ok_and(|path| path.exists())
                    && self.generation(&id, kind).is_err()
            }) || self.floor(&id).is_err();
            if damaged || damaged_ids.contains(&id) {
                warnings.push(Warning{document_id:id,message:"A damaged or unsupported recovery record was retained in the recovery-v1 app-data directory for manual investigation.".into()});
            }
        }
        Ok(warnings)
    }
    fn check_budget(&self, additional: u64) -> Result<(), String> {
        self.initialize()?;
        let mut used = 0u64;
        for entry in fs::read_dir(&self.root).map_err(|e| e.to_string())? {
            let metadata = entry
                .map_err(|e| e.to_string())?
                .metadata()
                .map_err(|e| e.to_string())?;
            if metadata.is_file() {
                used = used.saturating_add(metadata.len());
            }
        }
        if used.saturating_add(additional) > self.budget {
            return Err("Recovery storage budget exceeded (256 MiB). Save or explicitly discard drafts to free space; no drafts were evicted.".into());
        }
        Ok(())
    }
    pub fn write(&mut self, record: Record) -> Result<(), String> {
        if record.content.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err("Recovery exceeds the 20 MB document limit".into());
        }
        let mut floor = self.floor(&record.document_id)?;
        let previous = self.restore(&record.document_id).ok();
        if floor.retired
            || record.revision <= floor.revision
            || record.revision <= floor.high_water
            || previous
                .as_ref()
                .is_some_and(|r| record.revision <= r.revision)
        {
            return Err("Stale recovery revision".into());
        }
        let id = record.document_id.clone();
        // Reserve the peak atomic replacement space before changing either generation.
        let incoming = serde_json::to_vec(&record)
            .map_err(|e| e.to_string())?
            .len() as u64
            + 256;
        let backup = previous
            .as_ref()
            .map(|r| serde_json::to_vec(r).map(|v| v.len() as u64 + 256))
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        self.check_budget(incoming.saturating_add(backup).saturating_add(4096))?;
        if let Some(previous) = previous {
            self.write_generation(&id, "previous", previous)?;
        }
        floor.high_water = record.revision;
        self.write_generation(&id, "current", record)?;
        self.atomic(
            &self.path(&id, "floor")?,
            &serde_json::to_vec(&floor).map_err(|e| e.to_string())?,
        )
    }
    fn write_generation(&self, id: &str, kind: &str, record: Record) -> Result<(), String> {
        let original = self.path(id, kind)?;
        if original.exists() && self.generation(id, kind).is_err() {
            let size = fs::metadata(&original).map_err(|e| e.to_string())?.len();
            self.check_budget(size)?;
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let quarantine = self.root.join(format!("{id}.damaged-{kind}-{nonce}"));
            fs::hard_link(&original, &quarantine)
                .map_err(|e| format!("Could not preserve damaged recovery data: {e}"))?;
            #[cfg(unix)]
            fs::File::open(&self.root)
                .and_then(|file| file.sync_all())
                .map_err(|e| e.to_string())?;
        }
        let checksum = fingerprint(&serde_json::to_vec(&record).map_err(|e| e.to_string())?);
        self.atomic(
            &self.path(id, kind)?,
            &serde_json::to_vec(&Envelope {
                version: 1,
                checksum,
                record,
            })
            .map_err(|e| e.to_string())?,
        )
    }
    pub fn saved(&mut self, id: &str, revision: u64) -> Result<(), String> {
        let mut floor = self.floor(id)?;
        floor.revision = floor.revision.max(revision);
        self.atomic(
            &self.path(id, "floor")?,
            &serde_json::to_vec(&floor).map_err(|e| e.to_string())?,
        )?;
        self.cleanup(id, &floor)
    }
    pub fn discard(&mut self, id: &str) -> Result<(), String> {
        let mut floor = self.floor(id)?;
        floor.retired = true;
        self.atomic(
            &self.path(id, "floor")?,
            &serde_json::to_vec(&floor).map_err(|e| e.to_string())?,
        )?;
        self.cleanup(id, &floor)
    }
    fn cleanup(&self, id: &str, floor: &Floor) -> Result<(), String> {
        for kind in ["current", "previous"] {
            if floor.retired
                || self
                    .generation(id, kind)
                    .is_ok_and(|r| r.revision <= floor.revision)
            {
                match fs::remove_file(self.path(id, kind)?) {
                    Ok(()) => (),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                    Err(e) => return Err(e.to_string()),
                }
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn record(revision: u64) -> Record {
        Record {
            document_id: "doc-1".into(),
            revision,
            content: format!("draft {revision}"),
            name: "Untitled".into(),
            original_path: None,
            baseline_fingerprint: None,
            bom: false,
            crlf: false,
            snapshot_time: 1,
        }
    }
    #[test]
    fn discovery_survives_restart_and_corrupt_current() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::new(dir.path().into());
        store.write(record(1)).unwrap();
        store.write(record(2)).unwrap();
        std::fs::write(dir.path().join("doc-1.current"), "broken").unwrap();
        let mut restarted = Store::new(dir.path().into());
        assert_eq!(restarted.list().unwrap()[0].content, "draft 1");
        assert_eq!(restarted.list().unwrap()[0].revision, 2);
        assert!(restarted.write(record(1)).is_err());
        assert!(restarted.write(record(2)).is_err());
        restarted.write(record(3)).unwrap();
        let quarantined: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(".damaged-"))
            .collect();
        assert_eq!(
            quarantined.len(),
            1,
            "damaged bytes must survive subsequent snapshots for manual recovery"
        );
        assert_eq!(fs::read_to_string(quarantined[0].path()).unwrap(), "broken");
        assert_eq!(restarted.warnings().unwrap().len(), 1);
    }
    #[test]
    fn discard_blocks_late_writes_and_saved_allows_newer_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::new(dir.path().into());
        store.write(record(3)).unwrap();
        store.saved("doc-1", 2).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        store.saved("doc-1", 3).unwrap();
        assert!(store.list().unwrap().is_empty());
        assert!(store.write(record(3)).is_err());
        store.write(record(4)).unwrap();
        store.discard("doc-1").unwrap();
        assert!(Store::new(dir.path().into()).write(record(99)).is_err());
    }
    #[test]
    fn storage_budget_refuses_new_drafts_without_eviction() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::new(dir.path().into());
        store.write(record(1)).unwrap();
        store.budget = 1;
        assert!(store.write(record(2)).unwrap_err().contains("budget"));
        assert_eq!(store.restore("doc-1").unwrap().content, "draft 1");
    }
    #[test]
    fn damaged_records_are_exposed_without_content() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().into());
        std::fs::write(dir.path().join("doc-1.current"), "secret damaged content").unwrap();
        let warnings = store.warnings().unwrap();
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].document_id, "doc-1");
        assert!(!warnings[0].message.contains("secret"));
    }
    #[test]
    #[ignore = "spawned by forced_process_termination_preserves_the_durable_snapshot"]
    fn crash_writer_child() {
        let Some(path) = std::env::var_os("FOLIO_CRASH_TEST_DIR") else {
            return;
        };
        let mut store = Store::new(PathBuf::from(path));
        store.write(record(7)).unwrap();
        println!("FOLIO_SNAPSHOT_DURABLE");
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::park();
        }
    }
    #[test]
    fn forced_process_termination_preserves_the_durable_snapshot() {
        use std::io::BufRead;
        let directory = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "recovery::tests::crash_writer_child",
                "--ignored",
                "--nocapture",
            ])
            .env("FOLIO_CRASH_TEST_DIR", directory.path())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        let mut durable = false;
        while output.read_line(&mut line).unwrap() != 0 {
            if line.contains("FOLIO_SNAPSHOT_DURABLE") {
                durable = true;
                break;
            }
            line.clear();
        }
        let _ = child.kill();
        let _ = child.wait();
        assert!(durable, "child did not acknowledge a durable snapshot");
        let restored = Store::new(directory.path().into())
            .restore("doc-1")
            .unwrap();
        assert_eq!(restored.content, "draft 7");
        assert_eq!(restored.revision, 7);
    }
    #[test]
    fn oversized_content_is_rejected_without_losing_draft() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::new(dir.path().into());
        store.write(record(1)).unwrap();
        let mut large = record(2);
        large.content = "x".repeat(crate::document::MAX_DOCUMENT_BYTES as usize + 1);
        assert!(store.write(large).is_err());
        assert_eq!(store.list().unwrap()[0].revision, 1);
    }
}
