//! Synchronous transactions over trusted registered project roots.
//!
//! Callbacks do only local domain work: no host, socket, inference or lease waits.
//! Core owns authorization, expected revisions and command-specific semantics.
mod fs;
mod lock;

use ariadne_domain::history::{validate_session_history, HistoryError};
use ariadne_domain::models::*;
use ariadne_domain::validation::{validate_session_items, ValidationError};
use fs::Directory;
use serde_json::Value;
use sha2::{Digest, Sha256 as Hasher};
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum StoreError {
    Io {
        action: &'static str,
        path: PathBuf,
        kind: io::ErrorKind,
    },
    UnsafePath {
        path: PathBuf,
    },
    InvalidSnapshot,
    FutureSchema,
    IdentityMismatch,
    Validation(ValidationError),
    History(HistoryError),
    Busy,
    LockPoisoned,
    AlreadyExists,
    OperationReused,
    CounterOverflow,
    CommitUncertain {
        operation_id: Option<UuidV4>,
    },
}

impl StoreError {
    fn io(action: &'static str, path: &Path, error: io::Error) -> Self {
        Self::Io {
            action,
            path: path.into(),
            kind: error.kind(),
        }
    }
}
impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}
impl std::error::Error for StoreError {}

#[derive(Debug)]
pub enum TransactionError<E> {
    Store(StoreError),
    Command(E),
}
impl<E> From<StoreError> for TransactionError<E> {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl<E: fmt::Debug> fmt::Display for TransactionError<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}
impl<E: fmt::Debug> std::error::Error for TransactionError<E> {}

pub struct Store {
    project_id: UuidV4,
    sessions: Directory,
    locks: Directory,
    backups: Directory,
}

impl Store {
    /// `root` is selected by trusted registry wiring, never a renderer command.
    /// Existing project metadata must match; setup/registry owns its creation.
    pub fn open_registered(root: &Path, project_id: UuidV4) -> Result<Self, StoreError> {
        let root = Directory::root(root)?;
        let data = root.child(".ariadne", false)?;
        let bytes = data.read("project.json")?;
        let project: Project = decode(&bytes)?;
        if project.id != project_id {
            return Err(StoreError::IdentityMismatch);
        }
        Ok(Self {
            project_id,
            sessions: data.child("sessions", true)?,
            locks: data.child("locks", true)?,
            backups: data.child("backups", true)?,
        })
    }

    /// Validated first creation under the same permanent sibling lock.
    pub fn create(&self, session: &Session) -> Result<(), StoreError> {
        self.with_lock(&session.id, || {
            let name = format!("{}.json", session.id.as_str());
            if self.sessions.verify_target(&name)? {
                return Err(StoreError::AlreadyExists);
            }
            self.validate(session, &session.id)?;
            let bytes = encode(session)?;
            self.commit(&name, None, &bytes, None)
        })
    }

    /// Reads share the writer lock and validation boundary; no backup recovery.
    pub fn read(&self, session_id: &UuidV4) -> Result<Session, StoreError> {
        self.with_lock(session_id, || {
            self.live(session_id).map(|(session, _)| session)
        })
    }

    /// `normalized_command` is ephemeral canonical command input, with explicit
    /// defaults and expected revisions, exact prose and no transport request ID.
    /// The store adds project/session routing and the canonical actor scope.
    /// Exact replay precedes the callback, including its current-revision checks.
    pub fn transact<E>(
        &self,
        session_id: &UuidV4,
        actor: &ReceiptActorScope,
        operation_id: &UuidV4,
        normalized_command: &Value,
        apply: impl FnOnce(&mut Session) -> Result<SavedReceiptData, E>,
    ) -> Result<SavedReceipt, TransactionError<E>> {
        self.with_lock(session_id, || {
            let (live, previous) = self.live(session_id)?;
            let digest = self.digest(session_id, actor, normalized_command)?;
            if let Some(receipt) = live
                .operation_receipts
                .0
                .get(operation_id)
                .and_then(|bucket| bucket.iter().find(|receipt| &receipt.actor_scope == actor))
            {
                return if receipt.command_digest == digest {
                    Ok(receipt.result.clone())
                } else {
                    Err(StoreError::OperationReused.into())
                };
            }
            let mut candidate = live.clone();
            let data = apply(&mut candidate).map_err(TransactionError::Command)?;
            // Callback owns business effects, not transaction bookkeeping.
            if candidate.id != live.id
                || candidate.project_id != live.project_id
                || candidate.revision != live.revision
                || candidate.operation_receipts != live.operation_receipts
            {
                return Err(StoreError::IdentityMismatch.into());
            }
            candidate.revision = PositiveSafeInteger::new(live.revision.value() + 1)
                .map_err(|_| StoreError::CounterOverflow)?;
            let saved = SavedReceipt {
                operation_id: operation_id.clone(),
                session_id: session_id.clone(),
                revision: candidate.revision,
                data,
            };
            candidate
                .operation_receipts
                .0
                .entry(operation_id.clone())
                .or_default()
                .push(OperationReceipt {
                    operation_id: operation_id.clone(),
                    actor_scope: actor.clone(),
                    command_digest: digest,
                    result: saved.clone(),
                });
            self.validate(&candidate, session_id)?;
            let bytes = encode(&candidate)?;
            self.commit(
                &format!("{}.json", session_id.as_str()),
                Some(&previous),
                &bytes,
                Some(operation_id.clone()),
            )?;
            Ok(saved)
        })
    }

    fn with_lock<T, E: From<StoreError>>(
        &self,
        session_id: &UuidV4,
        work: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        let name = format!("{}.lock", session_id.as_str());
        let path = self.locks.path.join(&name);
        let keyed = lock::keyed(&path)?;
        let mut wait = lock::Wait::new();
        let _mutex = wait.mutex(&keyed)?;
        let _flock = wait.flock(self.locks.open(&name, true)?, &path)?;
        work()
    }

    fn live(&self, id: &UuidV4) -> Result<(Session, Vec<u8>), StoreError> {
        let bytes = self.sessions.read(&format!("{}.json", id.as_str()))?;
        let session = decode(&bytes)?;
        self.validate(&session, id)?;
        Ok((session, bytes))
    }

    fn validate(&self, session: &Session, id: &UuidV4) -> Result<(), StoreError> {
        if &session.id != id || session.project_id != self.project_id {
            return Err(StoreError::IdentityMismatch);
        }
        validate_session_items(session).map_err(StoreError::Validation)?;
        validate_session_history(session).map_err(StoreError::History)?;
        for (operation_id, bucket) in &session.operation_receipts.0 {
            for (index, receipt) in bucket.iter().enumerate() {
                if &receipt.operation_id != operation_id
                    || &receipt.result.operation_id != operation_id
                    || receipt.result.session_id != session.id
                    || receipt.result.revision > session.revision
                    || bucket[..index]
                        .iter()
                        .any(|old| old.actor_scope == receipt.actor_scope)
                {
                    return Err(StoreError::InvalidSnapshot);
                }
            }
        }
        Ok(())
    }

    fn digest(
        &self,
        session_id: &UuidV4,
        actor: &ReceiptActorScope,
        command: &Value,
    ) -> Result<Sha256, StoreError> {
        let value = serde_json::json!({"project_id": self.project_id, "session_id": session_id, "actor_scope": actor, "command": command});
        Sha256::new(format!("{:x}", Hasher::digest(encode(&value)?)))
            .map_err(|_| StoreError::InvalidSnapshot)
    }

    fn commit(
        &self,
        name: &str,
        previous: Option<&[u8]>,
        bytes: &[u8],
        operation_id: Option<UuidV4>,
    ) -> Result<(), StoreError> {
        let candidate = self.sessions.temp(name, bytes)?;
        if let Some(previous) = previous {
            let backup = format!("{}.previous.json", name.trim_end_matches(".json"));
            self.backups.temp(&backup, previous)?.replace(&backup)?;
            self.backups.sync()?;
        }
        candidate.replace(name)?;
        self.sessions
            .sync()
            .map_err(|_| StoreError::CommitUncertain { operation_id })
    }
}

fn encode(value: &impl serde::Serialize) -> Result<Vec<u8>, StoreError> {
    let value = serde_json::to_value(value).map_err(|_| StoreError::InvalidSnapshot)?;
    let mut bytes =
        serde_json::to_vec_pretty(&sorted(value)).map_err(|_| StoreError::InvalidSnapshot)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn sorted(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, sorted(value)))
                .collect::<std::collections::BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(sorted).collect()),
        scalar => scalar,
    }
}

fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, StoreError> {
    // Probe only for an actionable future-version error; final typed decode
    // rejects duplicate keys, unknown fields and all lexical/shape violations.
    if serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| value.get("schema_version").and_then(Value::as_u64))
        .is_some_and(|version| version > 1)
    {
        return Err(StoreError::FutureSchema);
    }
    serde_json::from_slice(bytes).map_err(|_| StoreError::InvalidSnapshot)
}
