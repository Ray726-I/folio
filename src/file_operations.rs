//! Workspace-scoped mutations. Never overwrite a destination and never
//! traverse a symbolic directory when performing explorer operations.
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub path: Option<String>,
    pub old_path: Option<String>,
    pub directory: bool,
}
pub struct Scope {
    root: PathBuf,
    alias: PathBuf,
    #[cfg(any(unix, windows))]
    directory: fs::File,
}
struct Parent {
    path: PathBuf,
    #[cfg(unix)]
    name: std::ffi::OsString,
    #[cfg(windows)]
    _guards: Vec<fs::File>,
    #[cfg(unix)]
    directory: fs::File,
}
fn error(error: impl std::fmt::Display) -> String {
    format!("Could not change the file: {error}")
}
fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
#[cfg(windows)]
fn locked_directory(path: &Path) -> Result<fs::File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    // Denying delete sharing keeps every opened ancestor stable until the
    // operation returns. OPEN_REPARSE_POINT inspects junctions themselves.
    let file = fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2)
        .custom_flags(0x02000000 | 0x00200000)
        .open(path)
        .map_err(error)?;
    let metadata = file.metadata().map_err(error)?;
    if linked(&metadata) || !metadata.is_dir() {
        return Err("Linked folders cannot be changed through the explorer.".into());
    }
    Ok(file)
}
impl Scope {
    fn ensure_attached(&self) -> Result<(), String> {
        #[cfg(any(unix, windows))]
        {
            let held = same_file::Handle::from_file(self.directory.try_clone().map_err(error)?)
                .map_err(error)?;
            let current = same_file::Handle::from_path(&self.root).map_err(error)?;
            if held != current {
                return Err(
                    "The workspace folder moved or was replaced. Reopen it before changing files."
                        .into(),
                );
            }
        }
        Ok(())
    }
    pub fn validated_source(&self, path: &Path) -> Result<PathBuf, String> {
        self.ensure_attached()?;
        let source = self.parent(path)?;
        let canonical = source.path.canonicalize().map_err(error)?;
        if !canonical.starts_with(&self.root) {
            return Err("Choose a path inside the open workspace.".into());
        }
        Ok(canonical)
    }
    pub fn new(root: &Path) -> Result<Self, String> {
        let expected = fs::symlink_metadata(root).map_err(error)?;
        if linked(&expected) {
            return Err("The workspace folder was replaced by a link. Reopen the folder before changing files.".into());
        }
        let canonical = root.canonicalize().map_err(error)?;
        if !canonical.is_dir() {
            return Err("Open a workspace folder first.".into());
        }
        #[cfg(unix)]
        let directory = {
            use std::os::unix::fs::MetadataExt;
            let directory = rustix::fs::open(
                &canonical,
                rustix::fs::OFlags::RDONLY
                    | rustix::fs::OFlags::DIRECTORY
                    | rustix::fs::OFlags::NOFOLLOW
                    | rustix::fs::OFlags::CLOEXEC,
                rustix::fs::Mode::empty(),
            )
            .map(fs::File::from)
            .map_err(error)?;
            let opened = directory.metadata().map_err(error)?;
            if opened.dev() != expected.dev() || opened.ino() != expected.ino() {
                return Err("The workspace folder changed while opening. Try again.".into());
            }
            directory
        };
        Ok(Self {
            #[cfg(unix)]
            directory,
            #[cfg(windows)]
            directory: locked_directory(&canonical)?,
            root: canonical,
            alias: root.to_path_buf(),
        })
    }
    fn parent(&self, path: &Path) -> Result<Parent, String> {
        let relative = path
            .strip_prefix(&self.root)
            .or_else(|_| path.strip_prefix(&self.alias))
            .map_err(|_| "Choose a path inside the open workspace.".to_string())?;
        let parts: Vec<_> = relative.components().collect();
        if parts.is_empty() || parts.iter().any(|p| !matches!(p, Component::Normal(_))) {
            return Err("The workspace root and parent paths cannot be changed.".into());
        }
        let name = parts.last().unwrap().as_os_str().to_os_string();
        let mut parent = self.root.clone();
        #[cfg(windows)]
        let mut guards = vec![self.directory.try_clone().map_err(error)?];
        #[cfg(unix)]
        let mut handle = self.directory.try_clone().map_err(error)?;
        for part in &parts[..parts.len() - 1] {
            parent.push(part.as_os_str());
            #[cfg(unix)]
            {
                handle = rustix::fs::openat(
                    &handle,
                    part.as_os_str(),
                    rustix::fs::OFlags::RDONLY
                        | rustix::fs::OFlags::DIRECTORY
                        | rustix::fs::OFlags::NOFOLLOW
                        | rustix::fs::OFlags::CLOEXEC,
                    rustix::fs::Mode::empty(),
                )
                .map(fs::File::from)
                .map_err(error)?;
            }
            #[cfg(windows)]
            guards.push(locked_directory(&parent)?);
            #[cfg(not(unix))]
            {
                let metadata = fs::symlink_metadata(&parent).map_err(error)?;
                if linked(&metadata) || !metadata.is_dir() {
                    return Err("Linked folders cannot be changed through the explorer.".into());
                }
            }
        }
        let target = parent.join(&name);
        if let Ok(metadata) = fs::symlink_metadata(&target) {
            if linked(&metadata) {
                return Err(
                    "Linked files and folders cannot be changed through the explorer.".into(),
                );
            }
        }
        Ok(Parent {
            path: target,
            #[cfg(unix)]
            name,
            #[cfg(windows)]
            _guards: guards,
            #[cfg(unix)]
            directory: handle,
        })
    }
}
impl Parent {
    fn create(&self) -> Result<fs::File, String> {
        #[cfg(unix)]
        {
            rustix::fs::openat(
                &self.directory,
                &self.name,
                rustix::fs::OFlags::WRONLY
                    | rustix::fs::OFlags::CREATE
                    | rustix::fs::OFlags::EXCL
                    | rustix::fs::OFlags::NOFOLLOW
                    | rustix::fs::OFlags::CLOEXEC,
                rustix::fs::Mode::from_raw_mode(0o666),
            )
            .map(fs::File::from)
            .map_err(error)
        }
        #[cfg(not(unix))]
        {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&self.path)
                .map_err(error)
        }
    }
    fn read(&self) -> Result<fs::File, String> {
        #[cfg(unix)]
        {
            rustix::fs::openat(
                &self.directory,
                &self.name,
                rustix::fs::OFlags::RDONLY
                    | rustix::fs::OFlags::NOFOLLOW
                    | rustix::fs::OFlags::CLOEXEC,
                rustix::fs::Mode::empty(),
            )
            .map(fs::File::from)
            .map_err(error)
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let file = fs::OpenOptions::new()
                .read(true)
                .custom_flags(0x00200000)
                .open(&self.path)
                .map_err(error)?;
            if linked(&file.metadata().map_err(error)?) {
                return Err("Linked files cannot be duplicated.".into());
            }
            Ok(file)
        }
        #[cfg(not(any(unix, windows)))]
        {
            fs::File::open(&self.path).map_err(error)
        }
    }
    fn mkdir(&self) -> Result<(), String> {
        #[cfg(unix)]
        {
            rustix::fs::mkdirat(
                &self.directory,
                &self.name,
                rustix::fs::Mode::from_raw_mode(0o777),
            )
            .map_err(error)
        }
        #[cfg(not(unix))]
        {
            fs::create_dir(&self.path).map_err(error)
        }
    }
    fn remove_created_file(&self) {
        #[cfg(unix)]
        {
            let _ = rustix::fs::unlinkat(&self.directory, &self.name, rustix::fs::AtFlags::empty());
        }
        #[cfg(not(unix))]
        {
            let _ = fs::remove_file(&self.path);
        }
    }
    fn sync(&self) {
        #[cfg(unix)]
        {
            let _ = self.directory.sync_all();
        }
    }
}
#[cfg(unix)]
fn move_no_replace(from: &Parent, to: &Parent) -> Result<(), String> {
    rustix::fs::renameat_with(&from.directory, &from.name, &to.directory, &to.name, rustix::fs::RenameFlags::NOREPLACE).map_err(|e| format!("Could not move without replacing another item (cross-filesystem moves are not supported): {e}"))
}
#[cfg(windows)]
fn move_no_replace(from: &Parent, to: &Parent) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileW(existing: *const u16, destination: *const u16) -> i32;
    }
    let from: Vec<u16> = from.path.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both arguments are valid, NUL-terminated UTF-16 strings retained
    // across the synchronous call. MoveFileW refuses existing destinations.
    if unsafe { MoveFileW(from.as_ptr(), to.as_ptr()) } == 0 {
        Err(error(std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}
#[cfg(not(any(unix, windows)))]
fn move_no_replace(_: &Parent, _: &Parent) -> Result<(), String> {
    Err("Moving files is unsupported on this platform.".into())
}

fn move_exclusive(from: &Parent, to: &Parent) -> Result<(), String> {
    let failure = match move_no_replace(from, to) {
        Ok(()) => return Ok(()),
        Err(failure) => failure,
    };
    let from_name = from.path.file_name().unwrap_or_default();
    let to_name = to.path.file_name().unwrap_or_default();
    if from.path.parent() != to.path.parent()
        || from_name == to_name
        || from_name.to_string_lossy().to_lowercase() != to_name.to_string_lossy().to_lowercase()
        || !same_file::is_same_file(&from.path, &to.path).unwrap_or(false)
    {
        return Err(failure);
    }
    let entries: Vec<_> = fs::read_dir(from.path.parent().unwrap())
        .map_err(error)?
        .flatten()
        .map(|e| e.file_name())
        .collect();
    // Two actual directory entries (including hard links) are a collision,
    // even if their names differ only by case on a case-sensitive volume.
    if entries.iter().any(|n| n == from_name) && entries.iter().any(|n| n == to_name) {
        return Err(failure);
    }
    let temporary_name = format!(".folio-rename-{}", crate::workspace::fresh_id());
    let temporary = Parent {
        path: from.path.parent().unwrap().join(&temporary_name),
        #[cfg(unix)]
        name: temporary_name.into(),
        #[cfg(unix)]
        directory: from.directory.try_clone().map_err(error)?,
        #[cfg(windows)]
        _guards: from
            ._guards
            .iter()
            .map(fs::File::try_clone)
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(error)?,
    };
    move_no_replace(from, &temporary)?;
    if let Err(failure) = move_no_replace(&temporary, to) {
        if move_no_replace(&temporary, from).is_err() {
            return Err(format!(
                "{failure}. The original is preserved at {}",
                temporary.path.display()
            ));
        }
        return Err(failure);
    }
    Ok(())
}

#[cfg(unix)]
fn trash_unix(source: &Parent, trash_root: &Path, record_location: bool) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(trash_root)
        .map_err(error)?;
    let scope = Scope::new(trash_root)?;
    let files_path = if record_location {
        trash_root.join("files")
    } else {
        trash_root.to_path_buf()
    };
    if record_location {
        for name in ["files", "info"] {
            let directory = scope.parent(&trash_root.join(name))?;
            match directory.mkdir() {
                Ok(()) => (),
                Err(_) if directory.path.is_dir() => (),
                Err(failure) => return Err(failure),
            }
        }
    }
    let nonce = crate::workspace::fresh_id();
    let original_name = source.name.to_string_lossy();
    let name = if original_name.len() <= 180 {
        format!("{original_name}-{nonce}")
    } else {
        nonce
    };
    let target = scope.parent(&files_path.join(&name))?;
    let info = if record_location {
        let info = scope.parent(&trash_root.join("info").join(format!("{name}.trashinfo")))?;
        let mut file = info.create()?;
        let location = percent_encoding::percent_encode(
            source.path.as_os_str().as_encoded_bytes(),
            percent_encoding::NON_ALPHANUMERIC,
        );
        let date = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S");
        let text = format!("[Trash Info]\nPath={location}\nDeletionDate={date}\n");
        if let Err(failure) = file
            .write_all(text.as_bytes())
            .and_then(|_| file.sync_all())
        {
            info.remove_created_file();
            return Err(error(failure));
        }
        info.sync();
        Some(info)
    } else {
        None
    };
    if let Err(failure) = move_exclusive(source, &target) {
        if let Some(info) = info {
            info.remove_created_file();
            info.sync();
        }
        return Err(failure);
    }
    source.sync();
    target.sync();
    Ok(())
}
fn trash_scoped(source: &Parent) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let data = std::env::var_os("XDG_DATA_HOME")
            .filter(|value| Path::new(value).is_absolute())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
            })
            .ok_or("The system trash directory is unavailable.")?;
        trash_unix(source, &data.join("Trash"), true)
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or("The system trash directory is unavailable.")?;
        trash_unix(source, &PathBuf::from(home).join(".Trash"), false)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        trash::delete(&source.path).map_err(error)
    }
}

impl Scope {
    pub fn perform(
        &self,
        action: &str,
        path: &Path,
        destination: Option<&Path>,
        content: Option<&str>,
    ) -> Result<Outcome, String> {
        if content.is_some_and(|value| value.len() as u64 > crate::document::MAX_DOCUMENT_BYTES) {
            return Err("The copy exceeds the document size limit.".into());
        }
        self.ensure_attached()?;
        let scope = self;
        let source = scope.parent(path)?;
        let mut outcome = Outcome {
            path: Some(source.path.to_string_lossy().into()),
            old_path: None,
            directory: false,
        };
        match action {
            "new-file" => {
                source.create()?.sync_all().map_err(error)?;
            }
            "new-folder" => {
                source.mkdir()?;
                outcome.directory = true;
            }
            "duplicate" => {
                let target =
                    scope.parent(destination.ok_or("Choose a destination for the copy.")?)?;
                let mut original = source.read()?;
                if !original.metadata().map_err(error)?.is_file() {
                    return Err("Duplicate currently supports files.".into());
                }
                let mut copy = target.create()?;
                let copied = (|| -> Result<(), String> {
                    if let Some(content) = content {
                        copy.write_all(content.as_bytes()).map_err(error)?;
                    } else {
                        std::io::copy(&mut original, &mut copy).map_err(error)?;
                    }
                    copy.sync_all().map_err(error)
                })();
                if let Err(failure) = copied {
                    drop(copy);
                    target.remove_created_file();
                    return Err(failure);
                }
                target.sync();
                outcome.path = Some(target.path.to_string_lossy().into());
            }
            "move" | "rename" => {
                let target = scope.parent(destination.ok_or("Choose a destination.")?)?;
                let metadata = fs::symlink_metadata(&source.path).map_err(error)?;
                outcome.directory = metadata.is_dir();
                if target.path == source.path {
                    return Ok(outcome);
                }
                if outcome.directory && target.path.starts_with(&source.path) {
                    return Err("A folder cannot be moved into itself.".into());
                }
                move_exclusive(&source, &target)?;
                target.sync();
                outcome.old_path = Some(source.path.to_string_lossy().into());
                outcome.path = Some(target.path.to_string_lossy().into());
            }
            "trash" => {
                outcome.directory = fs::symlink_metadata(&source.path).map_err(error)?.is_dir();
                trash_scoped(&source).map_err(|failure| format!("Could not move to the system trash; no permanent deletion was attempted: {failure}"))?;
                outcome.old_path = outcome.path.take();
            }
            _ => return Err("Unknown explorer operation.".into()),
        }
        source.sync();
        Ok(outcome)
    }
}

#[cfg(test)]
fn perform(
    root: &Path,
    action: &str,
    path: &Path,
    destination: Option<&Path>,
    content: Option<&str>,
) -> Result<Outcome, String> {
    Scope::new(root)?.perform(action, path, destination, content)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn create_duplicate_and_move_never_replace_existing_files() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a.md");
        perform(root.path(), "new-file", &a, None, None).unwrap();
        std::fs::write(&a, "original").unwrap();
        assert!(perform(root.path(), "new-file", &a, None, None).is_err());
        let b = root.path().join("b.md");
        perform(root.path(), "duplicate", &a, Some(&b), None).unwrap();
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "original");
        assert!(perform(root.path(), "move", &a, Some(&b), None).is_err());
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "original");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "original");
    }
    #[test]
    fn directory_move_preserves_descendants_and_rejects_descendant_destination() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("notes");
        perform(root.path(), "new-folder", &a, None, None).unwrap();
        std::fs::write(a.join("one.md"), "one").unwrap();
        assert!(perform(root.path(), "move", &a, Some(&a.join("child")), None).is_err());
        let b = root.path().join("renamed");
        perform(root.path(), "move", &a, Some(&b), None).unwrap();
        assert_eq!(std::fs::read_to_string(b.join("one.md")).unwrap(), "one");
        assert!(!a.exists());
    }
    #[test]
    fn case_only_rename_preserves_file_on_insensitive_filesystems() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("Case.md");
        let new = root.path().join("case.md");
        fs::write(&old, "value").unwrap();
        perform(root.path(), "rename", &old, Some(&new), None).unwrap();
        assert_eq!(fs::read_to_string(&new).unwrap(), "value");
        assert!(fs::read_dir(root.path())
            .unwrap()
            .flatten()
            .any(|e| e.file_name() == "case.md"));
    }
    #[test]
    fn paths_outside_the_workspace_and_root_mutation_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        assert!(perform(
            root.path(),
            "new-file",
            &outside.path().join("bad.md"),
            None,
            None
        )
        .is_err());
        assert!(perform(
            root.path(),
            "move",
            root.path(),
            Some(&outside.path().join("moved")),
            None
        )
        .is_err());
        assert!(perform(
            root.path(),
            "new-file",
            &root.path().join("../bad.md"),
            None,
            None
        )
        .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn a_replaced_workspace_root_cannot_authorize_outside_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).unwrap();
        let scope = Scope::new(&root).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("a.md"), "outside").unwrap();
        fs::rename(&root, temp.path().join("moved-root")).unwrap();
        std::os::unix::fs::symlink(outside.path(), &root).unwrap();
        assert!(scope
            .perform("trash", &root.join("a.md"), None, None)
            .is_err());
        assert!(scope
            .perform("new-file", &root.join("new.md"), None, None)
            .is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join("a.md")).unwrap(),
            "outside"
        );
        assert!(!outside.path().join("new.md").exists());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_ancestors_and_symlink_targets_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
        assert!(perform(
            root.path(),
            "new-file",
            &root.path().join("escape/bad.md"),
            None,
            None
        )
        .is_err());
        assert!(perform(
            root.path(),
            "duplicate",
            &root.path().join("escape"),
            Some(&root.path().join("copy.md")),
            None
        )
        .is_err());
        assert!(!outside.path().join("bad.md").exists());
    }
}

#[cfg(all(test, unix))]
mod trash_tests {
    use super::*;
    #[test]
    fn anchored_trash_moves_original_and_records_its_restore_location() {
        let root = tempfile::tempdir().unwrap();
        let trash = tempfile::tempdir().unwrap();
        let dir = root.path().join("notes");
        fs::create_dir(&dir).unwrap();
        let path = dir.join("a.md");
        fs::write(&path, "original").unwrap();
        let scope = Scope::new(root.path()).unwrap();
        let source = scope.parent(&path).unwrap();
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("a.md"), "external").unwrap();
        fs::rename(&dir, root.path().join("moved")).unwrap();
        std::os::unix::fs::symlink(external.path(), &dir).unwrap();
        trash_unix(&source, trash.path(), true).unwrap();
        assert_eq!(
            fs::read_to_string(external.path().join("a.md")).unwrap(),
            "external"
        );
        let files: Vec<_> = fs::read_dir(trash.path().join("files"))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(files.len(), 1);
        assert_eq!(fs::read_to_string(files[0].path()).unwrap(), "original");
        let info = fs::read_dir(trash.path().join("info"))
            .unwrap()
            .flatten()
            .next()
            .unwrap();
        let text = fs::read_to_string(info.path()).unwrap();
        assert!(text.contains("[Trash Info]"));
        assert!(text.contains("DeletionDate="));
        assert!(text.contains(
            &percent_encoding::percent_encode(
                path.as_os_str().as_encoded_bytes(),
                percent_encoding::NON_ALPHANUMERIC
            )
            .to_string()
        ));
    }
}
