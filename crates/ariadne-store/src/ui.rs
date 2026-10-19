//! Fixed owner UI file IO. Core parses and validates its typed record while locked.
//! This primitive has no selectable paths, preference semantics or provider work.
use crate::session::{
    fs::{Directory, IoFailure},
    lock, StoreError,
};
use ariadne_domain::models::UuidV4;
use std::io;

pub struct UiFile<'a> {
    directory: &'a Directory,
    previous: Option<Vec<u8>>,
    recovery: Option<Vec<u8>>,
    markers: Markers,
    /// Directory sync for the companion's steps; tests inject its failures.
    sync: fn(&Directory) -> Result<(), IoFailure>,
}

/// Whether this run may publish the companion.
#[derive(Clone, Copy)]
enum Markers {
    Writable,
    /// A transient failure left the companion unread or unquarantined. Its
    /// entry is kept; a write that needs markers is busy and can try again.
    Busy,
    /// The companion's entry could not be quarantined for a lasting reason.
    Refused,
}

pub(crate) fn with_file<T, E: From<StoreError>>(
    directory: &Directory,
    work: impl FnOnce(UiFile<'_>) -> Result<T, E>,
) -> Result<T, E> {
    with_file_reading(
        directory,
        read_companion,
        Directory::sync_noting_transient,
        work,
    )
}

fn read_companion(directory: &Directory) -> Result<Vec<u8>, IoFailure> {
    #[cfg(feature = "test-support")]
    if test_support::take_companion_read_fault() {
        return Err(IoFailure::os(
            "read",
            &directory.path.join("ui-recovery.json"),
            io::Error::from_raw_os_error(libc::EIO),
        ));
    }
    directory.read_noting_transient("ui-recovery.json")
}

/// Fault injection for other crates' tests. Built only with `test-support`,
/// which only dev-dependencies enable.
#[cfg(feature = "test-support")]
pub mod test_support {
    use std::cell::Cell;

    thread_local! {
        static COMPANION_READ_FAULT: Cell<bool> = const { Cell::new(false) };
    }

    /// The next read of `ui-recovery.json` on this thread fails with EIO.
    pub fn fail_next_companion_read_with_eio() {
        COMPANION_READ_FAULT.with(|fault| fault.set(true));
    }

    pub(super) fn take_companion_read_fault() -> bool {
        COMPANION_READ_FAULT.with(|fault| fault.replace(false))
    }
}

fn with_file_reading<T, E: From<StoreError>>(
    directory: &Directory,
    read_recovery: impl FnOnce(&Directory) -> Result<Vec<u8>, IoFailure>,
    sync: fn(&Directory) -> Result<(), IoFailure>,
    work: impl FnOnce(UiFile<'_>) -> Result<T, E>,
) -> Result<T, E> {
    lock::with_lock(directory, "ui.lock", || {
        let read = |name| -> Result<Option<Vec<u8>>, E> {
            match directory.read(name) {
                Ok(bytes) => Ok(Some(bytes)),
                Err(StoreError::Io {
                    kind: io::ErrorKind::NotFound,
                    ..
                }) => Ok(None),
                Err(error) => Err(error.into()),
            }
        };
        let previous = read("ui.json")?;
        let mut file = UiFile {
            directory,
            previous,
            recovery: None,
            markers: Markers::Writable,
            sync,
        };
        // The companion is optional. Even an unreadable entry must not block
        // opening the authoritative main file or saving ordinary preferences.
        match read_recovery(directory) {
            Ok(bytes) => file.recovery = Some(bytes),
            Err(IoFailure {
                error:
                    StoreError::Io {
                        kind: io::ErrorKind::NotFound,
                        ..
                    },
                ..
            }) => {}
            // A transient failure says nothing about the bytes: keep the entry.
            Err(IoFailure {
                transient: true, ..
            }) => {
                file.markers = Markers::Busy;
                eprintln!("Ariadne: could not read optional UI recovery companion for now; keeping it and continuing without markers");
            }
            Err(_) => file.discard_recovery(),
        }
        work(file)
    })
}

impl UiFile<'_> {
    pub fn path(&self) -> std::path::PathBuf {
        self.directory.path.join("ui.json")
    }

    /// Absent data remains absent; only the stable coordination lock may be created.
    pub fn bytes(&self) -> Option<&[u8]> {
        self.previous.as_deref()
    }

    pub fn recovery_path(&self) -> std::path::PathBuf {
        self.directory.path.join("ui-recovery.json")
    }

    pub fn recovery_bytes(&self) -> Option<&[u8]> {
        self.recovery.as_deref()
    }

    /// Preserve the optional companion entry under ui.lock. Failure still
    /// disables its markers for this run (busy when the failure was transient),
    /// and forbids replacing the unquarantined source.
    pub fn discard_recovery(&mut self) {
        self.recovery = None;
        self.markers = Markers::Refused;
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let target = format!("ui-recovery.corrupt-{timestamp}.json");
        match self
            .directory
            .rename_entry_no_replace("ui-recovery.json", &target)
            .and_then(|()| (self.sync)(self.directory))
        {
            Ok(()) => {
                self.markers = Markers::Writable;
                eprintln!("Ariadne: quarantined optional UI recovery companion; continuing without markers");
            }
            Err(failure) => {
                if failure.transient {
                    self.markers = Markers::Busy;
                }
                eprintln!("Ariadne: could not quarantine optional UI recovery companion; preserving its entry and continuing without markers");
            }
        }
    }

    /// Re-establish durability on a retry after an uncertain directory sync.
    /// Companion data was synced before its atomic publication.
    pub fn confirm_recovery(&self, operation_id: &UuidV4) -> Result<(), StoreError> {
        (self.sync)(self.directory).map_err(|_| StoreError::CommitUncertain {
            operation_id: Some(operation_id.clone()),
        })
    }

    /// Fixed companion publication under the same ui.lock. Core validates the
    /// monotonic ledger before committing it, then projects its receipt to ui.json.
    pub fn publish_recovery(
        &mut self,
        candidate: &[u8],
        operation_id: &UuidV4,
    ) -> Result<(), StoreError> {
        match self.markers {
            Markers::Writable => {}
            Markers::Busy => return Err(StoreError::Busy),
            Markers::Refused => {
                return Err(StoreError::UnsafePath {
                    path: self.recovery_path(),
                })
            }
        }
        let temporary = self.directory.temp("ui-recovery.json", candidate)?;
        if self.recovery.is_some() {
            temporary.replace("ui-recovery.json")?;
        } else {
            temporary
                .create("ui-recovery.json")
                .map_err(|error| uncertain(error, operation_id))?;
        }
        (self.sync)(self.directory).map_err(|_| StoreError::CommitUncertain {
            operation_id: Some(operation_id.clone()),
        })?;
        self.recovery = Some(candidate.to_vec());
        Ok(())
    }

    /// Core must have validated both the previous typed record and the candidate.
    /// Consuming the guard permits only one publication per locked callback.
    pub fn publish(mut self, candidate: &[u8], operation_id: &UuidV4) -> Result<(), StoreError> {
        self.publish_current(candidate, operation_id)
    }

    /// Allows receipt roll-forward followed by a new patch without releasing
    /// ui.lock. Each publication retains the immediately preceding ui.json.
    pub fn publish_current(
        &mut self,
        candidate: &[u8],
        operation_id: &UuidV4,
    ) -> Result<(), StoreError> {
        let temporary = self.directory.temp("ui.json", candidate)?;
        if let Some(previous) = &self.previous {
            self.directory
                .temp("ui.previous.json", previous)?
                .replace("ui.previous.json")?;
            self.directory.sync()?;
            temporary.replace("ui.json")?;
        } else {
            temporary
                .create("ui.json")
                .map_err(|error| uncertain(error, operation_id))?;
        }
        self.directory
            .sync()
            .map_err(|_| StoreError::CommitUncertain {
                operation_id: Some(operation_id.clone()),
            })?;
        self.previous = Some(candidate.to_vec());
        Ok(())
    }
}

fn uncertain(error: StoreError, operation_id: &UuidV4) -> StoreError {
    match error {
        StoreError::CommitUncertain { .. } => StoreError::CommitUncertain {
            operation_id: Some(operation_id.clone()),
        },
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    const COMPANION: &[u8] = b"companion ledger";

    fn operation() -> UuidV4 {
        UuidV4::new("00000000-0000-4000-8000-000000000001").unwrap()
    }

    fn private(path: &std::path::Path, bytes: &[u8]) {
        fs::write(path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn store() -> (tempfile::TempDir, Directory) {
        let root = tempfile::tempdir().unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        private(&root.path().join("ui.json"), b"main record");
        private(&root.path().join("ui-recovery.json"), COMPANION);
        let directory = Directory::root(root.path()).unwrap();
        (root, directory)
    }

    fn quarantined(root: &tempfile::TempDir) -> Vec<Vec<u8>> {
        fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("ui-recovery.corrupt-")
            })
            .map(|path| fs::read(path).unwrap())
            .collect()
    }

    fn failing_read(code: libc::c_int) -> impl FnOnce(&Directory) -> Result<Vec<u8>, IoFailure> {
        move |directory| {
            Err(IoFailure::os(
                "read",
                &directory.path.join("ui-recovery.json"),
                io::Error::from_raw_os_error(code),
            ))
        }
    }

    fn real_read(directory: &Directory) -> Result<Vec<u8>, IoFailure> {
        directory.read_noting_transient("ui-recovery.json")
    }

    fn sync_fails(code: libc::c_int) -> Result<(), IoFailure> {
        Err(IoFailure::os(
            "sync_directory",
            std::path::Path::new("store"),
            io::Error::from_raw_os_error(code),
        ))
    }
    fn sync_eio(_: &Directory) -> Result<(), IoFailure> {
        sync_fails(libc::EIO)
    }
    fn sync_eacces(_: &Directory) -> Result<(), IoFailure> {
        sync_fails(libc::EACCES)
    }

    #[test]
    fn transient_companion_read_keeps_the_file_and_makes_marker_writes_busy() {
        fn fstat_eio(_: libc::c_int, _: *mut libc::stat) -> libc::c_int {
            // SAFETY: errno is this thread's writable OS error slot.
            unsafe { *crate::session::fs::errno() = libc::EIO };
            -1
        }
        // `None`: the open succeeds and the stat of the opened companion fails.
        let faults = crate::session::fs::TRANSIENT.map(Some).into_iter();
        for fault in faults.chain([None]) {
            let (root, directory) = store();
            with_file_reading(
                &directory,
                |directory| match fault {
                    Some(code) => failing_read(code)(directory),
                    None => directory.read_noting_transient_with("ui-recovery.json", fstat_eio),
                },
                Directory::sync_noting_transient,
                |mut file| {
                    assert_eq!(file.bytes(), Some(b"main record".as_slice()));
                    assert!(file.recovery_bytes().is_none());
                    assert!(matches!(
                        file.publish_recovery(b"new ledger", &operation()),
                        Err(StoreError::Busy)
                    ));
                    // Ordinary preferences still save without the markers.
                    file.publish_current(b"main save", &operation())
                },
            )
            .unwrap();
            assert_eq!(
                fs::read(root.path().join("ui-recovery.json")).unwrap(),
                COMPANION
            );
            assert_eq!(fs::read(root.path().join("ui.json")).unwrap(), b"main save");
            assert!(quarantined(&root).is_empty());
            // The next run reads the kept companion and its markers again.
            with_file_reading(
                &directory,
                real_read,
                Directory::sync_noting_transient,
                |mut file| {
                    assert_eq!(file.recovery_bytes(), Some(COMPANION));
                    file.publish_recovery(b"next ledger", &operation())
                },
            )
            .unwrap();
            assert_eq!(
                fs::read(root.path().join("ui-recovery.json")).unwrap(),
                b"next ledger"
            );
        }
    }

    #[test]
    fn lasting_companion_read_failure_still_quarantines_and_keeps_markers_writable() {
        for code in [libc::EACCES, libc::ELOOP] {
            let (root, directory) = store();
            with_file_reading(
                &directory,
                failing_read(code),
                Directory::sync_noting_transient,
                |mut file| {
                    assert!(file.recovery_bytes().is_none());
                    file.publish_recovery(b"new ledger", &operation())
                },
            )
            .unwrap();
            assert_eq!(quarantined(&root), vec![COMPANION.to_vec()]);
            assert_eq!(
                fs::read(root.path().join("ui-recovery.json")).unwrap(),
                b"new ledger"
            );
        }
    }

    #[test]
    fn quarantine_sync_failure_removes_nothing_and_words_only_transient_failures_busy() {
        for (sync, busy) in [
            (sync_eio as fn(&Directory) -> Result<(), IoFailure>, true),
            (sync_eacces, false),
        ] {
            let (root, directory) = store();
            let result = with_file_reading(&directory, real_read, sync, |mut file| {
                assert_eq!(file.recovery_bytes(), Some(COMPANION));
                // Core found the bytes unparseable.
                file.discard_recovery();
                assert!(file.recovery_bytes().is_none());
                file.publish_recovery(b"new ledger", &operation())
            });
            if busy {
                assert!(matches!(result, Err(StoreError::Busy)));
            } else {
                assert!(matches!(result, Err(StoreError::UnsafePath { .. })));
            }
            assert_eq!(quarantined(&root), vec![COMPANION.to_vec()]);
            assert!(!root.path().join("ui-recovery.json").exists());
            assert_eq!(
                fs::read(root.path().join("ui.json")).unwrap(),
                b"main record"
            );
        }
    }

    #[test]
    fn companion_sync_failure_after_publication_is_uncertain_and_removes_nothing() {
        for present in [true, false] {
            let (root, directory) = store();
            if !present {
                fs::remove_file(root.path().join("ui-recovery.json")).unwrap();
            }
            let result = with_file_reading(&directory, real_read, sync_eio, |mut file| {
                let uncertain = file.publish_recovery(b"new ledger", &operation());
                assert!(matches!(
                    file.confirm_recovery(&operation()),
                    Err(StoreError::CommitUncertain { operation_id: Some(ref id) }) if id == &operation()
                ));
                uncertain
            });
            assert!(matches!(
                result,
                Err(StoreError::CommitUncertain { operation_id: Some(ref id) }) if id == &operation()
            ));
            assert_eq!(
                fs::read(root.path().join("ui-recovery.json")).unwrap(),
                b"new ledger"
            );
            assert_eq!(
                fs::read(root.path().join("ui.json")).unwrap(),
                b"main record"
            );
            assert!(quarantined(&root).is_empty());
            assert!(!fs::read_dir(root.path()).unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp-")));
        }
    }
}
