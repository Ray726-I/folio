use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::SystemTime,
};

pub const MAX_DOCUMENT_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct OpenDocument {
    pub path: PathBuf,
    pub fingerprint: String,
    pub crlf: bool,
    pub bom: bool,
    modified: Option<SystemTime>,
    len: u64,
}

#[derive(Debug)]
pub enum SaveError {
    Changed(String),
    Other(String),
}

impl SaveError {
    pub fn code(&self) -> &'static str {
        match self {
            SaveError::Changed(_) => "file_changed",
            SaveError::Other(_) => "error",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            SaveError::Changed(message) | SaveError::Other(message) => message,
        }
    }
}

impl From<String> for SaveError {
    fn from(error: String) -> Self {
        SaveError::Other(error)
    }
}

impl From<&str> for SaveError {
    fn from(error: &str) -> Self {
        SaveError::Other(error.into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub path: String,
    pub name: String,
    pub content: String,
    pub line_ending: &'static str,
}

pub fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_bytes(path: &Path) -> Result<(Vec<u8>, fs::Metadata), String> {
    let file = fs::File::open(path).map_err(|e| format!("Could not open file: {e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Please open a regular text file.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("This file exceeds Folio's current 20 MB document limit.".into());
    }
    Ok((bytes, metadata))
}

pub fn load(path: &Path) -> Result<(OpenDocument, Document), String> {
    let path = path
        .canonicalize()
        .map_err(|e| format!("Could not find file: {e}"))?;
    let (bytes, metadata) = read_bytes(&path)?;
    let text =
        String::from_utf8(bytes.clone()).map_err(|_| "This file is not UTF-8 text.".to_string())?;
    let bom = text.starts_with('\u{feff}');
    let text = text.trim_start_matches('\u{feff}');
    let crlf = text.contains("\r\n") && !text.replace("\r\n", "").contains('\n');
    let document = Document {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        path: path.to_string_lossy().into(),
        content: text.replace("\r\n", "\n"),
        line_ending: if crlf { "CRLF" } else { "LF" },
    };
    Ok((
        OpenDocument {
            path,
            fingerprint: fingerprint(&bytes),
            crlf,
            bom,
            modified: metadata.modified().ok(),
            len: metadata.len(),
        },
        document,
    ))
}

pub fn changed(document: &OpenDocument) -> bool {
    // This is the 3-second polling check used for the disk-change banner. It may
    // use cheap metadata to avoid reading a large file repeatedly, so it can be
    // conservative but must never be used to authorize a destructive save.
    let Ok(metadata) = fs::metadata(&document.path) else {
        return true;
    };
    if metadata.len() != document.len {
        return true;
    }
    if let (Ok(current), Some(saved)) = (metadata.modified(), document.modified) {
        if current == saved {
            return false;
        }
    }
    changed_exact(document)
}

/// Authoritative content check. Save conflicts must always compare bytes: an
/// external edit can preserve both the file length and its mtime (`touch -r`,
/// coarse timestamp filesystems, editors that restore timestamps), and silently
/// overwriting it would lose data.
fn changed_exact(document: &OpenDocument) -> bool {
    read_bytes(&document.path)
        .map(|(bytes, _)| fingerprint(&bytes) != document.fingerprint)
        .unwrap_or(true)
}

pub fn save(
    path: &Path,
    text: &str,
    previous: Option<&OpenDocument>,
    force: bool,
) -> Result<OpenDocument, SaveError> {
    if text.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("This document exceeds Folio's current 20 MB limit.".into());
    }
    let path = if path.exists() {
        path.canonicalize().map_err(|e| e.to_string())?
    } else {
        path.to_path_buf()
    };
    let same = previous.filter(|document| document.path == path);
    if !force && same.is_some_and(changed_exact) {
        return Err(SaveError::Changed(
            "This file changed on disk. Reload it or explicitly overwrite it.".into(),
        ));
    }
    let crlf = previous.is_some_and(|document| document.crlf);
    let bom = previous.is_some_and(|document| document.bom);
    let normalized = text.replace("\r\n", "\n");
    let mut content = if crlf {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    };
    if bom {
        content.insert(0, '\u{feff}');
    }
    let parent = path.parent().ok_or("Invalid save path.")?;
    let existing = fs::metadata(&path).ok();
    let mut builder = tempfile::Builder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if existing.is_none() {
            // Let the kernel apply the process umask, so a newly created document
            // gets normal 0644-style permissions instead of tempfile's 0600.
            builder.permissions(fs::Permissions::from_mode(0o666));
        }
    }
    let mut temp = builder
        .tempfile_in(parent)
        .map_err(|e| format!("Could not create save file: {e}"))?;
    if let Some(metadata) = existing {
        temp.as_file()
            .set_permissions(metadata.permissions())
            .map_err(|e| e.to_string())?;
    }
    temp.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(&path)
        .map_err(|e| format!("Could not save document: {}", e.error))?;
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    let metadata = fs::metadata(&path).ok();
    Ok(OpenDocument {
        path,
        fingerprint: fingerprint(content.as_bytes()),
        crlf,
        bom,
        modified: metadata
            .as_ref()
            .and_then(|metadata| metadata.modified().ok()),
        len: metadata
            .map(|metadata| metadata.len())
            .unwrap_or(content.len() as u64),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_to_overwrite_external_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.md");
        fs::write(&path, "Original").unwrap();
        let (document, _) = load(&path).unwrap();
        fs::write(&path, "External edit").unwrap();
        let error = save(&path, "My edit", Some(&document), false).unwrap_err();
        assert!(matches!(error, SaveError::Changed(_)), "{error:?}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "External edit");
        save(&path, "My edit", Some(&document), true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "My edit");
    }

    #[test]
    fn unchanged_metadata_is_not_reported_as_an_external_edit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.md");
        fs::write(&path, "Stable").unwrap();
        let (document, _) = load(&path).unwrap();
        assert!(!changed(&document));
        assert!(save(&path, "Stable", Some(&document), false).is_ok());
    }

    #[test]
    fn save_detects_same_size_edits_even_with_a_restored_mtime() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.md");
        fs::write(&path, "Original").unwrap();
        let (document, _) = load(&path).unwrap();
        let original = fs::metadata(&path).unwrap();

        // Same length as "Original", with the original mtime restored. This is
        // the case a metadata-only save check cannot distinguish.
        fs::write(&path, "Changed!").unwrap();
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(original.modified().unwrap()).unwrap();
        drop(file);
        assert_eq!(fs::metadata(&path).unwrap().len(), original.len());

        let error = save(&path, "My edit", Some(&document), false).unwrap_err();
        assert!(matches!(error, SaveError::Changed(_)), "{error:?}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "Changed!");
    }

    #[cfg(unix)]
    #[test]
    fn new_files_follow_the_process_umask() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        // Creating a probe with the same requested mode reveals the effective
        // umask without mutating process-global state from a parallel test.
        let probe = tempfile::Builder::new()
            .permissions(fs::Permissions::from_mode(0o666))
            .tempfile_in(directory.path())
            .unwrap();
        let expected = probe.path().metadata().unwrap().permissions().mode() & 0o777;
        let path = directory.path().join("new.md");
        save(&path, "Hello\n", None, false).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            expected
        );
    }

    #[test]
    fn preserves_crlf_bom_and_permissions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.md");
        fs::write(&path, "\u{feff}Hello\r\nworld\r\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        }
        let (document, data) = load(&path).unwrap();
        assert_eq!(data.content, "Hello\nworld\n");
        let saved = save(&path, "Changed\n", Some(&document), false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "\u{feff}Changed\r\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
        assert!(!changed(&saved));
    }
}
