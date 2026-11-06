use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::SystemTime,
};

pub const MAX_DOCUMENT_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

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
    pub document_id: String,
    pub revision: u64,
    pub path: String,
    pub name: String,
    pub content: String,
    pub line_ending: &'static str,
    pub writable: bool,
}

// Probe handles only; never write document bytes. Atomic saves also require
// creating a sibling, so file write access alone is insufficient.
pub fn writable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if metadata.permissions().readonly() || fs::OpenOptions::new().write(true).open(path).is_err() {
        return false;
    }
    path.parent().is_some_and(|parent| {
        tempfile::Builder::new()
            .prefix(".folio-access-")
            .tempfile_in(parent)
            .is_ok()
    })
}

pub fn rename(document: &OpenDocument, name: &str) -> Result<OpenDocument, String> {
    if name.trim().is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return Err("Choose a filename without path separators.".into());
    }
    if changed_exact(document) {
        return Err("This file changed on disk. Reload it before renaming.".into());
    }
    let destination = document
        .path
        .parent()
        .ok_or("Invalid document path")?
        .join(name);
    // A hard link creates the destination exclusively on all desktop platforms;
    // unlike rename(), it cannot silently replace an existing document.
    fs::hard_link(&document.path, &destination)
        .map_err(|error| format!("Could not rename document: {error}"))?;
    if let Err(error) = fs::remove_file(&document.path) {
        let _ = fs::remove_file(&destination);
        return Err(format!("Could not rename document: {error}"));
    }
    let mut renamed = document.clone();
    renamed.path = destination;
    Ok(renamed)
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
        document_id: String::new(),
        revision: 0,
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        path: path.to_string_lossy().into(),
        content: text.replace("\r\n", "\n"),
        line_ending: if crlf { "CRLF" } else { "LF" },
        writable: writable(&path),
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
pub(crate) fn changed_exact(document: &OpenDocument) -> bool {
    read_bytes(&document.path)
        .map(|(bytes, _)| fingerprint(&bytes) != document.fingerprint)
        .unwrap_or(true)
}

/// A pasted or dropped image that now lives beside its Markdown document.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    pub path: String,
    pub name: String,
}

/// Map the image media types a clipboard can expose to the extension used in
/// Markdown. SVG is deliberately absent: raster clipboard data is bounded and
/// simple to validate, while SVG is an XML document with a much wider surface.
pub fn image_extension_from_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// Normalize an image filename extension for a dropped file. These are the
/// formats the native renderer itself resolves; extensions it cannot display
/// are rejected rather than copied into the folder.
pub fn image_extension(extension: &str) -> Option<&'static str> {
    match extension.trim().to_ascii_lowercase().as_str() {
        "png" => Some("png"),
        "jpg" | "jpeg" => Some("jpg"),
        "gif" => Some("gif"),
        "webp" => Some("webp"),
        "svg" => Some("svg"),
        _ => None,
    }
}

/// Check the bytes actually match the declared raster format. A clipboard
/// payload is not trusted just because the webview labels it with a MIME type.
pub fn validate_image_bytes(extension: &str, bytes: &[u8]) -> Result<(), String> {
    let valid = match extension.trim().to_ascii_lowercase().as_str() {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("The pasted image is not a supported PNG, JPEG, GIF, or WebP file.".into())
    }
}

fn image_name(index: usize, extension: &str) -> String {
    if index == 1 {
        format!("image.{extension}")
    } else {
        format!("image-{index}.{extension}")
    }
}

/// Create a fresh image file without ever replacing an existing one. The
/// exclusive create is what makes two quick pastes race safely.
fn create_image_file(directory: &Path, extension: &str) -> Result<(fs::File, PathBuf), String> {
    if !directory.is_dir() {
        return Err("The document's folder is no longer available.".into());
    }
    for index in 1..=10_000usize {
        let path = directory.join(image_name(index, extension));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((file, path)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not create the image file: {error}")),
        }
    }
    Err("Could not find an unused image filename.".into())
}

fn saved_image(path: PathBuf) -> SavedImage {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into();
    SavedImage {
        path: path.to_string_lossy().into(),
        name,
    }
}

/// Save clipboard bytes beside the document under the next free `image.*`
/// name. The returned name is safe to place directly in Markdown.
pub fn save_image_bytes(
    directory: &Path,
    bytes: &[u8],
    extension: &str,
) -> Result<SavedImage, String> {
    if bytes.is_empty() {
        return Err("The pasted image is empty.".into());
    }
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("The pasted image exceeds Folio's 10 MB image limit.".into());
    }
    validate_image_bytes(extension, bytes)?;
    let (mut file, path) = create_image_file(directory, extension)?;
    if let Err(error) = file.write_all(bytes) {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(format!("Could not save the image: {error}"));
    }
    Ok(saved_image(path))
}

/// Copy a dropped image into the document's folder under the next free
/// `image.*` name. The source file is read-only to Folio and is never moved or
/// changed; a growing source is still capped by the read budget.
pub fn import_image(directory: &Path, source: &Path) -> Result<SavedImage, String> {
    let metadata = fs::metadata(source)
        .map_err(|error| format!("Could not read the dropped image: {error}"))?;
    if !metadata.is_file() {
        return Err("Drop a regular image file, not a folder.".into());
    }
    if metadata.len() == 0 {
        return Err("The dropped image is empty.".into());
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err("The dropped image exceeds Folio's 10 MB image limit.".into());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .and_then(image_extension)
        .ok_or("Only PNG, JPEG, GIF, WebP, and SVG images can be added.")?;
    let mut input = fs::File::open(source)
        .map_err(|error| format!("Could not read the dropped image: {error}"))?;
    let (mut output, path) = create_image_file(directory, extension)?;
    let copied = match io::copy(
        &mut Read::by_ref(&mut input).take(MAX_IMAGE_BYTES + 1),
        &mut output,
    ) {
        Ok(copied) => copied,
        Err(error) => {
            drop(output);
            let _ = fs::remove_file(&path);
            return Err(format!("Could not save the dropped image: {error}"));
        }
    };
    if copied == 0 {
        drop(output);
        let _ = fs::remove_file(&path);
        return Err("The dropped image is empty.".into());
    }
    if copied > MAX_IMAGE_BYTES {
        drop(output);
        let _ = fs::remove_file(&path);
        return Err("The dropped image exceeds Folio's 10 MB image limit.".into());
    }
    Ok(saved_image(path))
}

pub fn save(
    path: &Path,
    text: &str,
    previous: Option<&OpenDocument>,
    force: bool,
) -> Result<OpenDocument, SaveError> {
    save_with_encoding(path, text, previous, force, None)
}

pub fn save_with_encoding(
    path: &Path,
    text: &str,
    previous: Option<&OpenDocument>,
    force: bool,
    encoding: Option<(bool, bool)>,
) -> Result<OpenDocument, SaveError> {
    if text.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("This document exceeds Folio's current 20 MB limit.".into());
    }
    let path = if path.exists() {
        path.canonicalize().map_err(|e| e.to_string())?
    } else {
        path.to_path_buf()
    };
    if path.exists() && !writable(&path) {
        return Err("Filesystem permissions prevent saving this file. Use Save As to create a writable copy.".into());
    }
    let same = previous.filter(|document| document.path == path);
    if !force && same.is_some_and(changed_exact) {
        return Err(SaveError::Changed(
            "This file changed on disk. Reload it or explicitly overwrite it.".into(),
        ));
    }
    let (bom, crlf) = previous
        .map(|document| (document.bom, document.crlf))
        .or(encoding)
        .unwrap_or_default();
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
    let builder = tempfile::Builder::new();
    #[cfg(unix)]
    let mut builder = builder;
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
    fn rename_preserves_bytes_and_refuses_existing_destinations() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.md");
        fs::write(&path, "\u{feff}# Keep\r\n").unwrap();
        let (document, _) = load(&path).unwrap();
        fs::write(directory.path().join("taken.md"), "Do not replace").unwrap();
        assert!(rename(&document, "taken.md").is_err());
        assert_eq!(
            fs::read_to_string(directory.path().join("taken.md")).unwrap(),
            "Do not replace"
        );
        for name in ["../escape.md", "sub/note.md", "sub\\note.md", "", ".", ".."] {
            assert!(rename(&document, name).is_err());
        }
        let renamed = rename(&document, "renamed.md").unwrap();
        assert!(!path.exists());
        assert_eq!(
            fs::read_to_string(&renamed.path).unwrap(),
            "\u{feff}# Keep\r\n"
        );
        save(&renamed.path, "# Edited\n", Some(&renamed), false).unwrap();
        assert_eq!(
            fs::read_to_string(&renamed.path).unwrap(),
            "\u{feff}# Edited\r\n"
        );
    }

    #[test]
    fn rename_refuses_external_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.md");
        fs::write(&path, "Before").unwrap();
        let (document, _) = load(&path).unwrap();
        fs::write(&path, "After").unwrap();
        assert!(rename(&document, "renamed.md").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "After");
        assert!(!directory.path().join("renamed.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn readonly_permissions_are_reported_and_not_bypassed_by_atomic_save() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("locked.md");
        fs::write(&path, "Original").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        let (document, data) = load(&path).unwrap();
        assert!(!data.writable);
        assert!(save(&path, "Edit", Some(&document), true).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "Original");
        save(
            &directory.path().join("copy.md"),
            "Edit",
            Some(&document),
            false,
        )
        .unwrap();
        assert_eq!(
            fs::read_dir(directory.path()).unwrap().count(),
            2,
            "permission probes leave no files behind"
        );
    }

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
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\npayload";

    #[test]
    fn pasted_images_get_unique_names_beside_the_document() {
        let directory = tempfile::tempdir().unwrap();
        let first = save_image_bytes(directory.path(), PNG, "png").unwrap();
        assert_eq!(first.name, "image.png");
        assert_eq!(
            fs::read(&first.path).unwrap(),
            PNG,
            "the pasted bytes are written beside the document"
        );
        let second = save_image_bytes(directory.path(), PNG, "png").unwrap();
        assert_eq!(
            second.name, "image-2.png",
            "an existing image is never overwritten"
        );
        assert_eq!(fs::read(&second.path).unwrap(), PNG);
    }

    #[test]
    fn clipboard_media_types_map_to_renderable_extensions() {
        assert_eq!(image_extension_from_mime("image/png"), Some("png"));
        assert_eq!(image_extension_from_mime("IMAGE/JPEG"), Some("jpg"));
        assert_eq!(image_extension_from_mime("image/webp"), Some("webp"));
        assert_eq!(image_extension_from_mime("image/svg+xml"), None);
        assert_eq!(image_extension("JPEG"), Some("jpg"));
        assert_eq!(image_extension("avif"), None);
    }

    #[test]
    fn pasted_images_must_match_their_declared_format() {
        assert!(validate_image_bytes("png", PNG).is_ok());
        assert!(validate_image_bytes("jpg", PNG).is_err());
        assert!(validate_image_bytes("gif", b"not an image").is_err());
        assert!(save_image_bytes(tempfile::tempdir().unwrap().path(), b"not png", "png").is_err());
    }

    #[test]
    fn imported_images_are_copied_beside_the_document() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("downloaded.jpg");
        fs::write(&source, b"jpeg bytes").unwrap();
        let saved = import_image(directory.path(), &source).unwrap();
        assert_eq!(saved.name, "image.jpg");
        assert_eq!(fs::read(&saved.path).unwrap(), b"jpeg bytes");
        assert_eq!(
            fs::read(&source).unwrap(),
            b"jpeg bytes",
            "the dropped file is left alone"
        );
    }

    #[test]
    fn imported_images_refuse_empty_files() {
        let directory = tempfile::tempdir().unwrap();
        let empty = directory.path().join("empty.png");
        fs::write(&empty, b"").unwrap();
        assert!(import_image(directory.path(), &empty).is_err());
    }

    #[test]
    fn imported_images_refuse_other_file_types() {
        let directory = tempfile::tempdir().unwrap();
        let text = directory.path().join("notes.txt");
        fs::write(&text, b"not an image").unwrap();
        assert!(import_image(directory.path(), &text).is_err());
    }

    #[test]
    fn image_imports_and_pastes_are_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let oversized = vec![0; MAX_IMAGE_BYTES as usize + 1];
        assert!(save_image_bytes(directory.path(), &oversized, "png").is_err());
        let source = directory.path().join("huge.png");
        fs::write(&source, &oversized).unwrap();
        assert!(import_image(directory.path(), &source).is_err());
    }
}
