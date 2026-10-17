use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const MAX_DOCUMENT_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct OpenDocument {
    pub path: PathBuf,
    pub fingerprint: String,
    pub crlf: bool,
    pub bom: bool,
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

fn read_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| format!("Could not open file: {e}"))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Please open a regular text file.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("This file exceeds Folio's current 20 MB document limit.".into());
    }
    Ok(bytes)
}

pub fn load(path: &Path) -> Result<(OpenDocument, Document), String> {
    let path = path
        .canonicalize()
        .map_err(|e| format!("Could not find file: {e}"))?;
    let bytes = read_bytes(&path)?;
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
        },
        document,
    ))
}

pub fn changed(document: &OpenDocument) -> bool {
    read_bytes(&document.path)
        .map(|bytes| fingerprint(&bytes) != document.fingerprint)
        .unwrap_or(true)
}
pub fn save(
    path: &Path,
    text: &str,
    previous: Option<&OpenDocument>,
    force: bool,
) -> Result<OpenDocument, String> {
    if text.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("This document exceeds Folio's current 20 MB limit.".into());
    }
    let path = if path.exists() {
        path.canonicalize().map_err(|e| e.to_string())?
    } else {
        path.to_path_buf()
    };
    let same = previous.filter(|document| document.path == path);
    if !force && same.is_some_and(changed) {
        return Err(
            "FILE_CHANGED: This file changed on disk. Reload it or explicitly overwrite it.".into(),
        );
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
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("Could not create save file: {e}"))?;
    if let Ok(metadata) = fs::metadata(&path) {
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
    Ok(OpenDocument {
        path,
        fingerprint: fingerprint(content.as_bytes()),
        crlf,
        bom,
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
        assert!(save(&path, "My edit", Some(&document), false)
            .unwrap_err()
            .starts_with("FILE_CHANGED:"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "External edit");
        save(&path, "My edit", Some(&document), true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "My edit");
    }

    #[test]
    fn preserves_crlf_bom_and_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.md");
        fs::write(&path, "\u{feff}Hello\r\nworld\r\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let (document, data) = load(&path).unwrap();
        assert_eq!(data.content, "Hello\nworld\n");
        let saved = save(&path, "Changed\n", Some(&document), false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "\u{feff}Changed\r\n");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert!(!changed(&saved));
    }
}
