//! Same-filesystem moves that never replace an existing destination.
//!
//! Document renames need an exclusive destination, but hard links do not exist
//! on FAT/exFAT. A no-replace rename is the portable alternative: it preserves
//! the file's bytes and identity, is atomic on a single filesystem, and refuses
//! to clobber an existing name on both desktop platforms.
//!
//! Windows uses `MoveFileExW` with no flags, which refuses an existing
//! destination (`MOVEFILE_REPLACE_EXISTING` is absent) and never simulates a
//! cross-volume move by copying (`MOVEFILE_COPY_ALLOWED` is absent).
//!
//! On Unix, filesystems or kernels that cannot perform an exclusive rename
//! fail closed with an explicit `ErrorKind::Unsupported` error. The previous
//! hard-link+unlink fallback is deliberately not used: its source unlink is a
//! path-based operation that can race with another writer replacing the source
//! and delete unrelated data. The tradeoff is that some filesystems which
//! support hard links but not an exclusive rename (for example some NFS/FUSE
//! mounts) can no longer rename documents. There is no copy fallback.
//!
//! `file_operations` anchors its mover to open directory handles because
//! explorer paths are workspace-scoped. Document paths are already canonical
//! absolute paths, so this helper passes them to the native primitive directly.

use std::{io, path::Path};

/// Move `from` to `to` without ever replacing an existing destination.
///
/// Returns an error if the destination exists or the move cannot be completed.
/// It never falls back to copying or replacement.
pub(crate) fn no_replace(from: &Path, to: &Path) -> io::Result<()> {
    no_replace_with(from, to, imp)
}

fn no_replace_with(
    from: &Path,
    to: &Path,
    exclusive_rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    match exclusive_rename(from, to) {
        Ok(()) => Ok(()),
        #[cfg(unix)]
        Err(error) if unsupported_exclusive_rename(&error) => Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("the filesystem does not support a safe no-replace rename: {error}"),
        )),
        Err(error) => Err(error),
    }
}

/// Identify an unavailable or unsupported exclusive-rename primitive so it can
/// fail closed. `EEXIST`, permission errors, and other failures pass through
/// unchanged.
#[cfg(unix)]
fn unsupported_exclusive_rename(error: &io::Error) -> bool {
    use rustix::io::Errno;

    if error.kind() == io::ErrorKind::Unsupported {
        return true;
    }
    let Some(raw) = error.raw_os_error() else {
        return false;
    };
    // Linux: ENOSYS on old kernels, EINVAL when the filesystem does not
    // implement RENAME_NOREPLACE, and EOPNOTSUPP/ENOTSUP (the same value).
    // Darwin: renameatx_np returns ENOSYS before macOS 10.12, and ENOTSUP (45)
    // is a different value from EOPNOTSUPP (102); std only maps the latter to
    // ErrorKind::Unsupported there. EPERM is intentionally not included: it is
    // a permission failure, not proof that exclusive rename is unavailable.
    if raw == Errno::INVAL.raw_os_error() || raw == Errno::NOSYS.raw_os_error() {
        return true;
    }
    if raw == Errno::OPNOTSUPP.raw_os_error() {
        return true;
    }
    #[cfg(not(target_os = "redox"))]
    if raw == Errno::NOTSUP.raw_os_error() {
        return true;
    }
    false
}

#[cfg(any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "redox"
))]
fn imp(from: &Path, to: &Path) -> io::Result<()> {
    use rustix::fs::{renameat_with, RenameFlags, CWD};

    // RENAME_NOREPLACE is atomic and returns EEXIST for an existing
    // destination. Filesystems that cannot support the flag fail safely.
    renameat_with(CWD, from, CWD, to, RenameFlags::NOREPLACE).map_err(io::Error::from)
}

#[cfg(all(
    unix,
    not(any(
        target_vendor = "apple",
        target_os = "linux",
        target_os = "android",
        target_os = "redox"
    ))
))]
fn imp(_: &Path, _: &Path) -> io::Result<()> {
    // rustix does not expose renameat_with here; fail closed instead of using
    // a non-atomic hard-link fallback.
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "exclusive rename is unsupported on this platform",
    ))
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn MoveFileExW(existing: *const u16, destination: *const u16, flags: u32) -> i32;
}

// Guard the declaration against signature drift: PCWSTR, PCWSTR, u32 -> BOOL.
#[cfg(windows)]
const _: unsafe extern "system" fn(*const u16, *const u16, u32) -> i32 = MoveFileExW;

#[cfg(windows)]
fn imp(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // Zero flags means neither MOVEFILE_REPLACE_EXISTING (1) nor
    // MOVEFILE_COPY_ALLOWED (2): refuse an existing destination and never
    // simulate a cross-volume move by copying.
    // SAFETY: both arguments are valid, NUL-terminated UTF-16 strings retained
    // across the synchronous call.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
fn imp(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "renaming files is unsupported on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn moves_and_preserves_bytes_without_replacing_a_destination() {
        let directory = tempfile::tempdir().unwrap();
        let from = directory.path().join("from.md");
        let to = directory.path().join("to.md");
        fs::write(&from, "source").unwrap();

        no_replace(&from, &to).unwrap();
        assert!(!from.exists());
        assert_eq!(fs::read_to_string(&to).unwrap(), "source");

        fs::write(&from, "replacement").unwrap();
        let error = no_replace(&from, &to).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists, "{error}");
        assert_eq!(
            fs::read_to_string(&to).unwrap(),
            "source",
            "an existing destination is never replaced"
        );
        assert_eq!(
            fs::read_to_string(&from).unwrap(),
            "replacement",
            "a refused move leaves the source in place"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unsupported_exclusive_rename_fails_closed_without_moving() {
        let directory = tempfile::tempdir().unwrap();
        let from = directory.path().join("from.md");
        let to = directory.path().join("to.md");
        fs::write(&from, "source").unwrap();

        let error = no_replace_with(&from, &to, |_, _| {
            Err(io::Error::from_raw_os_error(
                rustix::io::Errno::INVAL.raw_os_error(),
            ))
        })
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::Unsupported, "{error}");
        assert!(
            error
                .to_string()
                .contains("does not support a safe no-replace rename"),
            "the failure is explicit: {error}"
        );
        assert_eq!(fs::read_to_string(&from).unwrap(), "source");
        assert!(
            !to.exists(),
            "an unsupported exclusive move must not link or unlink anything"
        );
    }

    #[cfg(unix)]
    #[test]
    fn only_unavailable_or_unsupported_rename_errors_are_mapped_to_fail_closed() {
        use rustix::io::Errno;

        for errno in [Errno::INVAL, Errno::NOSYS, Errno::OPNOTSUPP] {
            assert!(
                unsupported_exclusive_rename(&io::Error::from_raw_os_error(errno.raw_os_error())),
                "{errno:?} must be treated as unsupported"
            );
        }
        #[cfg(not(target_os = "redox"))]
        assert!(unsupported_exclusive_rename(&io::Error::from_raw_os_error(
            Errno::NOTSUP.raw_os_error()
        )));

        for errno in [
            Errno::EXIST,
            Errno::ACCESS,
            Errno::PERM,
            Errno::XDEV,
            Errno::NOENT,
        ] {
            assert!(
                !unsupported_exclusive_rename(&io::Error::from_raw_os_error(errno.raw_os_error())),
                "{errno:?} must not be treated as unsupported"
            );
        }
        assert!(!unsupported_exclusive_rename(&io::Error::from(
            io::ErrorKind::AlreadyExists
        )));
        assert!(!unsupported_exclusive_rename(&io::Error::from(
            io::ErrorKind::PermissionDenied
        )));
    }

    #[test]
    fn non_unsupported_rename_errors_are_returned_unchanged() {
        for kind in [
            io::ErrorKind::AlreadyExists,
            io::ErrorKind::PermissionDenied,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let from = directory.path().join("from.md");
            let to = directory.path().join("to.md");
            fs::write(&from, "source").unwrap();

            let error = no_replace_with(&from, &to, |_, _| Err(io::Error::from(kind))).unwrap_err();

            assert_eq!(error.kind(), kind);
            assert_eq!(fs::read_to_string(&from).unwrap(), "source");
            assert!(!to.exists());
        }
    }
}
