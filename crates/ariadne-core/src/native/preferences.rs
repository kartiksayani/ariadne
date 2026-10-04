//! Global owner-only preferences. Draft persistence never creates domain Inputs.
use super::errors;
use crate::*;
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::StoreError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256 as Hasher};
use std::collections::BTreeSet;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    // This canonical field is the sole authoritative file schema version.
    snapshot: PreferencesSnapshot,
    operations: Vec<Operation>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Operation {
    actor_scope: ReceiptActorScope,
    operation_id: UuidV4,
    command_digest: Sha256,
    result: PreferencesPatchedReceipt,
}

pub struct PreferencesService<'a> {
    registry: &'a Registry,
}
impl<'a> PreferencesService<'a> {
    pub fn new(registry: &'a Registry) -> Self {
        Self { registry }
    }

    pub fn get(&self, context: &OwnerContext) -> Result<PreferencesSnapshot, CoreError> {
        owner(context)?;
        self.registry
            .with_ui_file(|file| Ok(decode(file.bytes(), &file.path())?.snapshot))
            .map_err(failure)
    }

    pub fn patch(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
    ) -> Result<PreferencesPatchedReceipt, CoreError> {
        owner(context)?;
        command.validate_wire()?;
        let OwnerCommand::PreferencesPatch { op_id, params, .. } = command else {
            return Err(errors::local(
                CoreErrorCode::InvalidArgument,
                "Expected preferences_patch",
            ));
        };
        let normalized = crate::receipts::normalized("preferences_patch", params)?;
        // Global preferences have one native owner scope, without session routing.
        let digest = Sha256::new(format!("{:x}", Hasher::digest(serde_json::to_vec(
            &serde_json::json!({"actor_scope": ReceiptActorScope::Owner {}, "command": normalized})
        ).expect("typed normalized preferences"))))
        .expect("SHA256");
        self.registry
            .with_ui_file(|file| {
                let mut record = decode(file.bytes(), &file.path())?;
                if let Some(saved) = record
                    .operations
                    .iter()
                    .find(|entry| &entry.operation_id == op_id)
                {
                    return if saved.command_digest == digest {
                        Ok(saved.result.clone())
                    } else {
                        Err(Failure::Core(errors::local(
                            CoreErrorCode::OperationReused,
                            "Preferences operation ID has different saved parameters",
                        )))
                    };
                }
                if params.expected_preferences_revision != record.snapshot.revision {
                    let mut error = errors::local(
                        CoreErrorCode::RevisionConflict,
                        "Preferences revision changed; reload before applying this new patch",
                    );
                    error.current_revision = Some(record.snapshot.revision);
                    return Err(Failure::Core(error));
                }
                for entry in &params.entries {
                    apply(&mut record.snapshot, entry);
                }
                record.snapshot.revision = PositiveSafeInteger::new(
                    record.snapshot.revision.value() + 1,
                )
                .map_err(|_| {
                    Failure::Core(errors::local(
                        CoreErrorCode::CapacityExceeded,
                        "Preferences revision cannot increment",
                    ))
                })?;
                let result = PreferencesPatchedReceipt {
                    operation_id: op_id.clone(),
                    preferences_revision: record.snapshot.revision,
                };
                record.operations.push(Operation {
                    actor_scope: ReceiptActorScope::Owner {},
                    operation_id: op_id.clone(),
                    command_digest: digest,
                    result: result.clone(),
                });
                validate(&record).map_err(Failure::Core)?;
                let bytes = serde_json::to_vec_pretty(&record).map_err(|_| {
                    Failure::Core(errors::local(
                        CoreErrorCode::InvalidArgument,
                        "Preferences cannot be serialized",
                    ))
                })?;
                file.publish(&bytes, op_id)?;
                Ok(result)
            })
            .map_err(failure)
    }
}

enum Failure {
    Core(CoreError),
    Store(StoreError),
}
impl From<StoreError> for Failure {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
fn failure(error: Failure) -> CoreError {
    match error {
        Failure::Core(error) => error,
        Failure::Store(error) => errors::store(error),
    }
}
fn owner(context: &OwnerContext) -> Result<(), CoreError> {
    if matches!(context.scope(), OwnerScope::Preferences) {
        Ok(())
    } else {
        Err(errors::local(
            CoreErrorCode::PermissionDenied,
            "Preferences require the global local-owner scope",
        ))
    }
}
fn defaults() -> PreferencesSnapshot {
    PreferencesSnapshot {
        schema_version: one(),
        revision: PositiveSafeInteger::new(1).expect("literal"),
        global: GlobalPreferences {
            theme: Theme::System,
            selected_navigation: NavigationSelection::Projects {},
            window: None,
            pinned: false,
            notification_watermark: None,
        },
        sessions: vec![],
        later: vec![],
        drafts: vec![],
    }
}
fn one() -> SchemaVersion {
    SchemaVersion::new(1).expect("literal")
}
fn decode(bytes: Option<&[u8]>, path: &std::path::Path) -> Result<Record, Failure> {
    let Some(bytes) = bytes else {
        return Ok(Record {
            snapshot: defaults(),
            operations: vec![],
        });
    };
    if serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|v| v.get("snapshot")?.get("schema_version")?.as_u64())
        .is_some_and(|version| version > 1)
    {
        return Err(Failure::Core(errors::local(
            CoreErrorCode::FutureSchema,
            format!(
                "{} uses a future preferences schema; keep this file unchanged",
                path.display()
            ),
        )));
    }
    let record: Record = serde_json::from_slice(bytes).map_err(|_| corrupt(path))?;
    validate(&record).map_err(|_| corrupt(path))?;
    if record.operations.is_empty() {
        return Err(corrupt(path));
    }
    Ok(record)
}
fn corrupt(path: &std::path::Path) -> Failure {
    Failure::Core(errors::local(CoreErrorCode::CorruptSession,format!("{} is not a valid preferences record; preserve the file and drafts for explicit owner recovery",path.display())))
}
fn validate(record: &Record) -> Result<(), CoreError> {
    let snapshot = &record.snapshot;
    let mut operations = BTreeSet::new();
    for (index, saved) in record.operations.iter().enumerate() {
        if !matches!(saved.actor_scope, ReceiptActorScope::Owner {})
            || !operations.insert(&saved.operation_id)
            || saved.result.operation_id != saved.operation_id
            || saved.result.preferences_revision.value() != index as u64 + 2
        {
            return Err(errors::local(
                CoreErrorCode::InvalidArgument,
                "Invalid owner preference receipt history",
            ));
        }
    }
    if snapshot.revision.value() != record.operations.len() as u64 + 1 {
        return Err(errors::local(
            CoreErrorCode::InvalidArgument,
            "Preferences revision disagrees with retained receipts",
        ));
    }
    let mut sessions = BTreeSet::new();
    for view in &snapshot.sessions {
        if !sessions.insert((
            view.session.project_id.clone(),
            view.session.session_id.clone(),
        )) {
            return Err(errors::local(
                CoreErrorCode::InvalidArgument,
                "Duplicate preference session route",
            ));
        }
        entry_valid(PreferencesPatchEntry::SetSessionView {
            preferences: view.clone(),
        })?;
    }
    let mut later = BTreeSet::new();
    for item in &snapshot.later {
        if !later.insert((
            item.project_id.clone(),
            item.session_id.clone(),
            item.item_id.clone(),
        )) {
            return Err(errors::local(
                CoreErrorCode::InvalidArgument,
                "Duplicate Later item route",
            ));
        }
    }
    let mut drafts = BTreeSet::new();
    for draft in &snapshot.drafts {
        if !drafts.insert(&draft.op_id) {
            return Err(errors::local(
                CoreErrorCode::InvalidArgument,
                "Duplicate draft operation ID",
            ));
        }
        entry_valid(PreferencesPatchEntry::UpsertDraft {
            draft: draft.clone(),
        })?;
    }
    entry_valid(PreferencesPatchEntry::SetGlobal {
        preferences: snapshot.global.clone(),
    })?;
    let framed = ApplicationEnvelope::Success(SuccessEnvelope {
        api_version: one(),
        ok: SuccessFlag,
        data: QueryResult::PreferencesGet(snapshot.clone()),
    });
    if serde_json::to_vec(&framed)
        .map_err(|_| {
            errors::local(
                CoreErrorCode::InvalidArgument,
                "Invalid preferences response",
            )
        })?
        .len()
        > 1024 * 1024
    {
        return Err(errors::local(
            CoreErrorCode::CapacityExceeded,
            "Preferences response exceeds the 1MiB canonical response budget; reduce this patch",
        ));
    }
    Ok(())
}
fn entry_valid(entry: PreferencesPatchEntry) -> Result<(), CoreError> {
    OwnerCommand::PreferencesPatch {
        api_version: one(),
        op_id: UuidV4::new("00000000-0000-4000-8000-000000000001").expect("literal"),
        params: PreferencesPatch {
            expected_preferences_revision: PositiveSafeInteger::new(1).expect("literal"),
            entries: vec![entry],
        },
    }
    .validate_wire()
}
fn apply(snapshot: &mut PreferencesSnapshot, entry: &PreferencesPatchEntry) {
    match entry {
        PreferencesPatchEntry::SetGlobal { preferences } => snapshot.global = preferences.clone(),
        PreferencesPatchEntry::SetSessionView { preferences } => {
            if let Some(current) = snapshot
                .sessions
                .iter_mut()
                .find(|v| v.session == preferences.session)
            {
                *current = preferences.clone();
            } else {
                snapshot.sessions.push(preferences.clone());
            }
        }
        PreferencesPatchEntry::SetLater { item, later } => {
            if *later {
                if !snapshot.later.contains(item) {
                    snapshot.later.push(item.clone());
                }
            } else {
                snapshot.later.retain(|current| current != item);
            }
        }
        PreferencesPatchEntry::UpsertDraft { draft } => {
            if let Some(current) = snapshot.drafts.iter_mut().find(|v| v.op_id == draft.op_id) {
                *current = draft.clone();
            } else {
                snapshot.drafts.push(draft.clone());
            }
        }
        PreferencesPatchEntry::DeleteDraft { operation_id } => {
            snapshot.drafts.retain(|draft| &draft.op_id != operation_id)
        }
    }
}
