//! Fixed owner UI file IO. Core parses and validates its typed record while locked.
//! This primitive has no selectable paths, preference semantics or provider work.
use crate::session::{fs::Directory, lock, StoreError};
use ariadne_domain::models::UuidV4;
use std::io;

pub struct UiFile<'a> {
    directory: &'a Directory,
    previous: Option<Vec<u8>>,
}

pub(crate) fn with_file<T, E: From<StoreError>>(
    directory: &Directory,
    work: impl FnOnce(UiFile<'_>) -> Result<T, E>,
) -> Result<T, E> {
    lock::with_lock(directory, "ui.lock", || {
        let previous = match directory.read("ui.json") {
            Ok(bytes) => Some(bytes),
            Err(StoreError::Io {
                kind: io::ErrorKind::NotFound,
                ..
            }) => None,
            Err(error) => return Err(error.into()),
        };
        work(UiFile {
            directory,
            previous,
        })
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

    /// Core must have validated both the previous typed record and the candidate.
    /// Consuming the guard permits only one publication per locked callback.
    pub fn publish(self, candidate: &[u8], operation_id: &UuidV4) -> Result<(), StoreError> {
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
            })
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
