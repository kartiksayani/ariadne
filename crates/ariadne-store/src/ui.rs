//! Fixed owner UI file IO. Core parses and validates its typed record while locked.
//! This primitive has no selectable paths, preference semantics or provider work.
use crate::session::{fs::Directory, lock, StoreError};
use ariadne_domain::models::UuidV4;
use std::io;

pub struct UiFile<'a> {
    directory: &'a Directory,
    previous: Option<Vec<u8>>,
    recovery: Option<Vec<u8>>,
    recovery_writable: bool,
}

pub(crate) fn with_file<T, E: From<StoreError>>(
    directory: &Directory,
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
        // The companion is optional. Even an unreadable entry must not block
        // opening the authoritative main file or saving ordinary preferences.
        let recovery = directory.read("ui-recovery.json");
        let recovery_problem = !matches!(
            &recovery,
            Ok(_)
                | Err(StoreError::Io {
                    kind: io::ErrorKind::NotFound,
                    ..
                })
        );
        let mut file = UiFile {
            directory,
            previous,
            recovery: recovery.ok(),
            recovery_writable: true,
        };
        if recovery_problem {
            file.discard_recovery();
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
    /// disables its markers, and forbids replacing the unquarantined source.
    pub fn discard_recovery(&mut self) {
        self.recovery = None;
        self.recovery_writable = false;
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let target = format!("ui-recovery.corrupt-{timestamp}.json");
        match self.directory.rename_entry_no_replace("ui-recovery.json", &target)
            .and_then(|()| self.directory.sync()) {
            Ok(()) => {
                self.recovery_writable = true;
                eprintln!("Ariadne: quarantined optional UI recovery companion; continuing without markers");
            }
            Err(_) => eprintln!("Ariadne: could not quarantine optional UI recovery companion; preserving its entry and continuing without markers"),
        }
    }

    /// Re-establish durability on a retry after an uncertain directory sync.
    /// Companion data was synced before its atomic publication.
    pub fn confirm_recovery(&self, operation_id: &UuidV4) -> Result<(), StoreError> {
        self.directory
            .sync()
            .map_err(|_| StoreError::CommitUncertain {
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
        if !self.recovery_writable {
            return Err(StoreError::UnsafePath {
                path: self.recovery_path(),
            });
        }
        let temporary = self.directory.temp("ui-recovery.json", candidate)?;
        if self.recovery.is_some() {
            temporary.replace("ui-recovery.json")?;
        } else {
            temporary
                .create("ui-recovery.json")
                .map_err(|error| uncertain(error, operation_id))?;
        }
        self.directory
            .sync()
            .map_err(|_| StoreError::CommitUncertain {
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
