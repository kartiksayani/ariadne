//! Synchronous transactions over trusted registered project roots.
//!
//! Callbacks do only local domain work: no host, socket, inference or lease waits.
//! Core owns authorization, expected revisions and command-specific semantics.
mod catalogue;
mod events;
pub(crate) mod fs;
pub(crate) mod lock;
pub use catalogue::{ProjectCatalogue, SessionReadOutcome};
pub use events::{EventIdentity, EventMutation, EventTransaction};

use ariadne_domain::history::{validate_session_history, HistoryError};
use ariadne_domain::models::*;
use ariadne_domain::validation::{
    validate_session_delivery, validate_session_items, ValidationError,
};
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
    SessionFile {
        path: PathBuf,
        source: Box<StoreError>,
    },
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
    pub(crate) fn io(action: &'static str, path: &Path, error: io::Error) -> Self {
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
            self.sessions.temp(&name, &bytes)?.create(&name)?;
            self.sessions
                .sync()
                .map_err(|_| StoreError::CommitUncertain { operation_id: None })
        })
    }

    /// First session commit plus its authoritative replay receipt. Caller supplies
    /// the complete domain candidate; IDs are allocated while setup locks are held.
    /// A creation retry can replay only this exact route/actor/command tuple.
    pub fn create_with_receipt(
        &self,
        session: &Session,
        actor: &ReceiptActorScope,
        operation_id: &UuidV4,
        normalized_command: &Value,
        data: SavedReceiptData,
    ) -> Result<SavedReceipt, StoreError> {
        self.create_with_receipt_guarded(
            session,
            actor,
            operation_id,
            normalized_command,
            data,
            || Ok::<_, std::convert::Infallible>(()),
        )
        .map_err(|error| match error {
            TransactionError::Store(error) => error,
            TransactionError::Command(never) => match never {},
        })
    }

    /// Native fresh-work admission after the final stable lock, exact replay and
    /// candidate validation, immediately before the first transaction temp write.
    /// Once writing starts, existing commit/uncertainty semantics remain intact.
    pub fn create_with_receipt_guarded<E>(
        &self,
        session: &Session,
        actor: &ReceiptActorScope,
        operation_id: &UuidV4,
        normalized_command: &Value,
        data: SavedReceiptData,
        before_create: impl FnOnce() -> Result<(), E>,
    ) -> Result<SavedReceipt, TransactionError<E>> {
        self.with_lock(&session.id, || {
            let name = format!("{}.json", session.id.as_str());
            if self.sessions.verify_target(&name)? {
                let (live, _) = self.live(&session.id)?;
                return self
                    .saved(&live, actor, operation_id, normalized_command)?
                    .ok_or(StoreError::AlreadyExists)
                    .map_err(TransactionError::Store);
            }
            if session.revision.value() != 1 || !session.operation_receipts.0.is_empty() {
                return Err(StoreError::InvalidSnapshot.into());
            }
            let mut candidate = session.clone();
            let receipt = SavedReceipt {
                operation_id: operation_id.clone(),
                session_id: candidate.id.clone(),
                revision: candidate.revision,
                data,
            };
            candidate.operation_receipts.0.insert(
                operation_id.clone(),
                vec![OperationReceipt {
                    operation_id: operation_id.clone(),
                    actor_scope: actor.clone(),
                    command_digest: self.digest(&candidate.id, actor, normalized_command)?,
                    result: receipt.clone(),
                }],
            );
            self.validate(&candidate, &candidate.id)?;
            let bytes = encode(&candidate)?;
            before_create().map_err(TransactionError::Command)?;
            self.sessions
                .temp(&name, &bytes)?
                .create(&name)
                .map_err(|error| uncertain_operation(error, operation_id))?;
            self.sessions
                .sync()
                .map_err(|_| StoreError::CommitUncertain {
                    operation_id: Some(operation_id.clone()),
                })?;
            Ok(receipt)
        })
    }

    /// Locked canonical replay check, before core current-state guards or host I/O.
    pub fn replay(
        &self,
        session_id: &UuidV4,
        actor: &ReceiptActorScope,
        operation_id: &UuidV4,
        normalized_command: &Value,
    ) -> Result<Option<SavedReceipt>, StoreError> {
        self.with_lock(session_id, || {
            let (live, _) = self.live(session_id)?;
            self.saved(&live, actor, operation_id, normalized_command)
        })
    }

    fn saved(
        &self,
        live: &Session,
        actor: &ReceiptActorScope,
        operation_id: &UuidV4,
        command: &Value,
    ) -> Result<Option<SavedReceipt>, StoreError> {
        let digest = self.digest(&live.id, actor, command)?;
        match live
            .operation_receipts
            .0
            .get(operation_id)
            .and_then(|bucket| bucket.iter().find(|entry| &entry.actor_scope == actor))
        {
            Some(entry) if entry.command_digest == digest => Ok(Some(entry.result.clone())),
            Some(_) => Err(StoreError::OperationReused),
            None => Ok(None),
        }
    }

    /// Enumerates only generated authoritative session names in this registered
    /// directory. Each snapshot is reread and validated under its own stable lock.
    pub fn sessions(&self) -> Result<Vec<Session>, StoreError> {
        let mut result = Vec::new();
        let names = self
            .sessions
            .names()
            .map_err(|source| StoreError::SessionFile {
                path: self.sessions.path.clone(),
                source: Box::new(source),
            })?;
        for name in names {
            if name.starts_with('.') || !name.ends_with(".json") {
                continue;
            }
            let id = UuidV4::new(name.strip_suffix(".json").expect("filtered suffix")).map_err(
                |_| StoreError::UnsafePath {
                    path: self.sessions.path.join(&name),
                },
            )?;
            result.push(self.read(&id).map_err(|source| StoreError::SessionFile {
                path: self.sessions.path.join(&name),
                source: Box::new(source),
            })?);
        }
        Ok(result)
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
            if let Some(saved) = self.saved(&live, actor, operation_id, normalized_command)? {
                return Ok(saved);
            }
            let digest = self.digest(session_id, actor, normalized_command)?;
            let mut candidate = live.clone();
            let data = apply(&mut candidate).map_err(TransactionError::Command)?;
            self.save_effect(
                &live,
                &previous,
                candidate,
                actor,
                operation_id,
                digest,
                data,
            )
            .map_err(TransactionError::Store)
        })
    }

    /// Shared transaction bookkeeping, called only while the session lock is held.
    #[allow(clippy::too_many_arguments)]
    fn save_effect(
        &self,
        live: &Session,
        previous: &[u8],
        mut candidate: Session,
        actor: &ReceiptActorScope,
        operation_id: &UuidV4,
        digest: Sha256,
        data: SavedReceiptData,
    ) -> Result<SavedReceipt, StoreError> {
        // Callbacks own business effects, not transaction bookkeeping.
        if candidate.id != live.id
            || candidate.project_id != live.project_id
            || candidate.revision != live.revision
            || candidate.operation_receipts != live.operation_receipts
        {
            return Err(StoreError::IdentityMismatch);
        }
        if live
            .operation_receipts
            .0
            .get(operation_id)
            .is_some_and(|bucket| bucket.iter().any(|entry| &entry.actor_scope == actor))
        {
            return Err(StoreError::OperationReused);
        }
        candidate.revision = PositiveSafeInteger::new(live.revision.value() + 1)
            .map_err(|_| StoreError::CounterOverflow)?;
        let saved = SavedReceipt {
            operation_id: operation_id.clone(),
            session_id: live.id.clone(),
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
        self.validate(&candidate, &live.id)?;
        let bytes = encode(&candidate)?;
        self.commit(
            &format!("{}.json", live.id.as_str()),
            Some(previous),
            &bytes,
            Some(operation_id.clone()),
        )?;
        Ok(saved)
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
        Self::read_validated(&self.sessions, id, &self.project_id)
    }

    fn read_validated(
        sessions: &Directory,
        id: &UuidV4,
        project_id: &UuidV4,
    ) -> Result<(Session, Vec<u8>), StoreError> {
        let bytes = sessions.read(&format!("{}.json", id.as_str()))?;
        let session = decode(&bytes)?;
        Self::validate_in_project(&session, id, project_id)?;
        Ok((session, bytes))
    }

    fn validate(&self, session: &Session, id: &UuidV4) -> Result<(), StoreError> {
        Self::validate_in_project(session, id, &self.project_id)
    }
    fn validate_in_project(
        session: &Session,
        id: &UuidV4,
        project_id: &UuidV4,
    ) -> Result<(), StoreError> {
        if &session.id != id || &session.project_id != project_id {
            return Err(StoreError::IdentityMismatch);
        }
        validate_session_items(session).map_err(StoreError::Validation)?;
        validate_session_history(session).map_err(StoreError::History)?;
        validate_session_delivery(session).map_err(StoreError::Validation)?;
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

pub(crate) fn encode(value: &impl serde::Serialize) -> Result<Vec<u8>, StoreError> {
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

pub(crate) fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, StoreError> {
    // Internal callers are strict versioned Project, Session, registry Projects
    // or BindingIndex DTOs, all requiring SchemaVersion(1). Successful typed
    // decoding therefore proves the current version without building a second
    // generic Value tree. Do not use this helper with permissive/unversioned T.
    if let Ok(value) = serde_json::from_slice::<T>(bytes) {
        return Ok(value);
    }
    // Preserve the existing diagnostic precedence on typed failure, including
    // Value's last-key semantics for duplicate schema_version fields. The typed
    // decoder still rejects duplicate keys, unknown fields and invalid shapes.
    if serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| value.get("schema_version").and_then(Value::as_u64))
        .is_some_and(|version| version > 1)
    {
        return Err(StoreError::FutureSchema);
    }
    Err(StoreError::InvalidSnapshot)
}

#[cfg(test)]
#[path = "tests/decode.rs"]
mod decode_tests;

fn uncertain_operation(error: StoreError, operation_id: &UuidV4) -> StoreError {
    match error {
        StoreError::CommitUncertain { .. } => StoreError::CommitUncertain {
            operation_id: Some(operation_id.clone()),
        },
        other => other,
    }
}
