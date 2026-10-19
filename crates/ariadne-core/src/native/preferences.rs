//! Global owner-only preferences. Draft persistence never creates domain Inputs.
use super::errors;
use crate::*;
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::StoreError, ui::UiFile};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256 as Hasher};
use std::collections::{BTreeMap, BTreeSet};

// Older ui.json snapshots retain this retired view field. Keep patch DTOs strict,
// accept only this legacy snapshot key. The disk adapter writes hidden for
// strict older binaries; API snapshots remain rail-less.
pub(crate) fn session_preferences_without_legacy_rail<'de, D>(
    deserializer: D,
) -> Result<Vec<SessionPreferences>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct LegacySessionPreferences {
        #[serde(default, rename = "rail")]
        _rail: Option<serde::de::IgnoredAny>,
        #[serde(flatten)]
        preferences: SessionPreferences,
    }
    Vec::<LegacySessionPreferences>::deserialize(deserializer).map(|sessions| {
        sessions
            .into_iter()
            .map(|session| session.preferences)
            .collect()
    })
}

const RECEIPT_WINDOW: usize = 256;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    // This canonical field is the sole authoritative file schema version.
    #[serde(serialize_with = "serialize_disk_snapshot")]
    snapshot: PreferencesSnapshot,
    operations: Vec<Operation>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Operation {
    actor_scope: ReceiptActorScope,
    operation_id: UuidV4,
    command_digest: Sha256,
    result: PreferencesPatchedReceipt,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryRecord {
    schema_version: SchemaVersion,
    resolved_input_ids: Vec<UuidV4>,
    operations: Vec<Operation>,
}

fn serialize_disk_snapshot<S: serde::Serializer>(
    snapshot: &PreferencesSnapshot,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let mut value = serde_json::to_value(snapshot).map_err(serde::ser::Error::custom)?;
    value
        .as_object_mut()
        .expect("typed snapshot")
        .remove("resolved_unsent_input_ids");
    for session in value["sessions"].as_array_mut().expect("typed sessions") {
        session
            .as_object_mut()
            .expect("typed session")
            .insert("rail".into(), serde_json::json!("hidden"));
    }
    value.serialize(serializer)
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
            .with_ui_file(|mut file| Ok(load_read(&mut file)?.0.snapshot))
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
        params.entries.iter().try_for_each(layout_bounds)?;
        let normalized = crate::receipts::normalized("preferences_patch", params)?;
        // Global preferences have one native owner scope, without session routing.
        let digest = Sha256::new(format!("{:x}", Hasher::digest(serde_json::to_vec(
            &serde_json::json!({"actor_scope": ReceiptActorScope::Owner {}, "command": normalized})
        ).expect("typed normalized preferences"))))
        .expect("SHA256");
        self.registry
            .with_ui_file(|mut file| {
                let (mut record, mut recovery) = load(&mut file)?;
                let saved: Vec<_> = record.operations.iter().chain(&recovery.operations).filter(|entry| &entry.operation_id == op_id).collect();
                if !saved.is_empty() {
                    return if saved.iter().all(|entry| entry.command_digest == digest) {
                        Ok(saved[0].result.clone())
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
                    if let PreferencesPatchEntry::UpsertDraft { draft } = entry {
                        if record.snapshot.drafts.iter().any(|saved| {
                            saved.op_id == draft.op_id && saved.submission_attempted && saved != draft
                        }) {
                            return Err(Failure::Core(errors::local(
                                CoreErrorCode::OperationReused,
                                "An attempted draft must retain its exact operation and payload until reconciled",
                            )));
                        }
                    }
                    apply(&mut record.snapshot, entry).map_err(Failure::Core)?;
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
                let operation = Operation {
                    actor_scope: ReceiptActorScope::Owner {},
                    operation_id: op_id.clone(),
                    command_digest: digest,
                    result: result.clone(),
                };
                record.operations.push(operation.clone());
                trim(&mut record.operations);
                validate(&record).map_err(Failure::Core)?;
                let bytes = encode(&record)?;
                if params.entries.iter().any(|entry| matches!(entry, PreferencesPatchEntry::ResolveUnsentInput { .. })) {
                    recovery.resolved_input_ids = record.snapshot.resolved_unsent_input_ids.clone();
                    recovery.operations.push(operation);
                    trim(&mut recovery.operations);
                    validate_recovery(&recovery).map_err(Failure::Core)?;
                    file.publish_recovery(&encode(&recovery)?, op_id)?;
                    file.publish_current(&bytes, op_id).map_err(|_| Failure::Store(StoreError::CommitUncertain { operation_id: Some(op_id.clone()) }))?;
                } else {
                    file.publish_current(&bytes, op_id)?;
                }
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
            text_scale: TEXT_SCALE_DEFAULT,
            selected_navigation: NavigationSelection::Projects {},
            window: None,
            pinned: false,
            notification_watermark: None,
            notification_ledger: vec![],
            notification_preview: false,
            detail_width: None,
            waiting_collapsed: false,
            session_archive_expanded_project_ids: vec![],
        },
        sessions: vec![],
        later: vec![],
        drafts: vec![],
        seen: vec![],
        resolved_unsent_input_ids: vec![],
    }
}
fn one() -> SchemaVersion {
    SchemaVersion::new(1).expect("literal")
}

fn trim(operations: &mut Vec<Operation>) {
    if operations.len() > RECEIPT_WINDOW {
        operations.drain(..operations.len() - RECEIPT_WINDOW);
    }
}

fn encode(value: &impl Serialize) -> Result<Vec<u8>, Failure> {
    serde_json::to_vec_pretty(value).map_err(|_| {
        Failure::Core(errors::local(
            CoreErrorCode::InvalidArgument,
            "Preferences cannot be serialized",
        ))
    })
}

fn validate_recovery(record: &RecoveryRecord) -> Result<(), CoreError> {
    validate_resolved(&record.resolved_input_ids)?;
    if record.schema_version != one()
        || record.operations.is_empty()
        || record.operations.len() > RECEIPT_WINDOW
    {
        return Err(errors::local(
            CoreErrorCode::InvalidArgument,
            "Invalid recovery ledger",
        ));
    }
    let mut ids = BTreeSet::new();
    let mut revision = 1;
    for saved in &record.operations {
        if !matches!(saved.actor_scope, ReceiptActorScope::Owner {})
            || !ids.insert(&saved.operation_id)
            || saved.result.operation_id != saved.operation_id
            || saved.result.preferences_revision.value() <= revision
        {
            return Err(errors::local(
                CoreErrorCode::InvalidArgument,
                "Invalid recovery receipt history",
            ));
        }
        revision = saved.result.preferences_revision.value();
    }
    Ok(())
}

fn validate_resolved(ids: &[UuidV4]) -> Result<(), CoreError> {
    if ids.len() > RESOLVED_UNSENT_INPUT_CAPACITY {
        return Err(errors::local(
            CoreErrorCode::CapacityExceeded,
            "Resolved unsent inputs exceed the 10000 entry bound",
        ));
    }
    let mut unique = BTreeSet::new();
    if !ids.iter().all(|id| unique.insert(id)) {
        return Err(errors::local(
            CoreErrorCode::InvalidArgument,
            "Duplicate resolved unsent input",
        ));
    }
    Ok(())
}

/// The companion is authoritative for markers. Its last receipt is also the
/// recoverable revision projection if publication stopped between the two files.
fn load(file: &mut UiFile<'_>) -> Result<(Record, RecoveryRecord), Failure> {
    load_with(file, project_recovery)
}

fn load_read(file: &mut UiFile<'_>) -> Result<(Record, RecoveryRecord), Failure> {
    load_with(file, |file, record, recovery| {
        project_recovery_with(
            file,
            record,
            recovery,
            ProjectionMode::Read,
            |file, operation_id| file.confirm_recovery(operation_id),
            |file, bytes, operation_id| file.publish_current(bytes, operation_id),
        )
    })
}

fn load_with(
    file: &mut UiFile<'_>,
    project: impl FnOnce(
        &mut UiFile<'_>,
        Record,
        RecoveryRecord,
    ) -> Result<(Record, RecoveryRecord), Failure>,
) -> Result<(Record, RecoveryRecord), Failure> {
    let original = decode(file.bytes(), &file.path())?;
    let Some(bytes) = file.recovery_bytes() else {
        return Ok((original, empty_recovery()));
    };
    let recovery =
        serde_json::from_slice::<RecoveryRecord>(bytes).map_err(|_| corrupt(&file.recovery_path()));
    let attempt = recovery.and_then(|recovery| {
        validate_recovery(&recovery).map_err(Failure::Core)?;
        project(file, original.clone(), recovery)
    });
    match attempt {
        Ok(records) => Ok(records),
        Err(Failure::Core(_)) => {
            file.discard_recovery();
            Ok((original, empty_recovery()))
        }
        // A publication or durability failure does not make a valid marker
        // corrupt. Preserve its receipt so the same operation can retry.
        Err(error @ Failure::Store(_)) => Err(error),
    }
}

fn empty_recovery() -> RecoveryRecord {
    RecoveryRecord {
        schema_version: one(),
        resolved_input_ids: vec![],
        operations: vec![],
    }
}

fn project_recovery(
    file: &mut UiFile<'_>,
    record: Record,
    recovery: RecoveryRecord,
) -> Result<(Record, RecoveryRecord), Failure> {
    project_recovery_with(
        file,
        record,
        recovery,
        ProjectionMode::Patch,
        |file, operation_id| file.confirm_recovery(operation_id),
        |file, bytes, operation_id| file.publish_current(bytes, operation_id),
    )
}

#[derive(Clone, Copy)]
enum ProjectionMode {
    Read,
    Patch,
}

fn project_recovery_with(
    file: &mut UiFile<'_>,
    mut record: Record,
    recovery: RecoveryRecord,
    mode: ProjectionMode,
    confirm: impl FnOnce(&UiFile<'_>, &UuidV4) -> Result<(), StoreError>,
    publish: impl FnOnce(&mut UiFile<'_>, &[u8], &UuidV4) -> Result<(), StoreError>,
) -> Result<(Record, RecoveryRecord), Failure> {
    let original = record.clone();
    record.snapshot.resolved_unsent_input_ids = recovery.resolved_input_ids.clone();
    // Old binaries may publish an ordinary patch at the marker's intended
    // revision. Its fields and history win; the durable marker still applies.
    if let Some(pending) = recovery.operations.last() {
        let wanted = pending.result.preferences_revision;
        if record.snapshot.revision.value() < wanted.value() - 1 {
            return Err(corrupt(&file.recovery_path()));
        }
        if record.snapshot.revision.value() == wanted.value() - 1 {
            if record
                .operations
                .iter()
                .any(|saved| saved.operation_id == pending.operation_id)
            {
                return Err(corrupt(&file.recovery_path()));
            }
            record.snapshot.revision = wanted;
            record.operations.push(pending.clone());
            trim(&mut record.operations);
            validate(&record).map_err(|_| corrupt(&file.recovery_path()))?;
            if let Err(error) = confirm(file, &pending.operation_id) {
                return match mode {
                    ProjectionMode::Read => Ok((original, empty_recovery())),
                    ProjectionMode::Patch => Err(error.into()),
                };
            }
            if publish(file, &encode(&record)?, &pending.operation_id).is_err()
                && matches!(mode, ProjectionMode::Patch)
            {
                return Err(Failure::Store(StoreError::CommitUncertain {
                    operation_id: Some(pending.operation_id.clone()),
                }));
            }
        } else {
            validate(&record).map_err(|_| corrupt(&file.path()))?;
            // The main file already carries this receipt, published after the
            // companion. A read takes it as is; only a patch re-confirms it.
            if matches!(mode, ProjectionMode::Patch) {
                confirm(file, &pending.operation_id)?;
            }
        }
    }
    validate(&record).map_err(|_| corrupt(&file.path()))?;
    Ok((record, recovery))
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
    // Recovery markers belong exclusively to the durable companion, never an
    // inline extension that an older binary would reject or discard.
    if !record.snapshot.resolved_unsent_input_ids.is_empty() {
        return Err(corrupt(path));
    }
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
    validate_resolved(&snapshot.resolved_unsent_input_ids)?;
    let mut operations = BTreeSet::new();
    let first_revision = snapshot
        .revision
        .value()
        .checked_sub(record.operations.len() as u64)
        .filter(|revision| *revision >= 1)
        .ok_or_else(|| {
            errors::local(
                CoreErrorCode::InvalidArgument,
                "Preferences revision disagrees with retained receipts",
            )
        })?;
    for (index, saved) in record.operations.iter().enumerate() {
        if !matches!(saved.actor_scope, ReceiptActorScope::Owner {})
            || !operations.insert(&saved.operation_id)
            || saved.result.operation_id != saved.operation_id
            || saved.result.preferences_revision.value() != first_revision + index as u64 + 1
        {
            return Err(errors::local(
                CoreErrorCode::InvalidArgument,
                "Invalid owner preference receipt history",
            ));
        }
    }
    let mut seen_sessions = BTreeSet::new();
    for seen in &snapshot.seen {
        if !seen_sessions.insert((&seen.session.project_id, &seen.session.session_id)) {
            return Err(errors::local(
                CoreErrorCode::InvalidArgument,
                "Duplicate seen session",
            ));
        }
        layout_bounds(&PreferencesPatchEntry::MarkSeen {
            session: seen.session.clone(),
            at: seen.since.clone(),
            items: seen.items.clone(),
            topics: seen.topics.clone(),
        })?;
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
    validate_preferences_response(snapshot)
}

pub(crate) fn validate_preferences_response(
    snapshot: &PreferencesSnapshot,
) -> Result<(), CoreError> {
    validate_resolved(&snapshot.resolved_unsent_input_ids)?;
    let framed = |snapshot| {
        ApplicationEnvelope::Success(SuccessEnvelope {
            api_version: one(),
            ok: SuccessFlag,
            data: QueryResult::PreferencesGet(snapshot),
        })
    };
    let size = |snapshot| {
        serde_json::to_vec(&framed(snapshot))
            .map(|bytes| bytes.len())
            .map_err(|_| {
                errors::local(
                    CoreErrorCode::InvalidArgument,
                    "Invalid preferences response",
                )
            })
    };
    let mut ordinary = snapshot.clone();
    ordinary.resolved_unsent_input_ids.clear();
    // Receipt projection must not crowd out an old-valid snapshot when the
    // revision gains a digit. Account for revision metadata in the same fixed
    // recovery allowance, leaving the ordinary data budget unchanged.
    ordinary.revision = PositiveSafeInteger::new(1).expect("literal");
    if size(ordinary)? > PREFERENCES_RESPONSE_BYTES
        || size(snapshot.clone())? > PREFERENCES_RESPONSE_BYTES + RECOVERY_RESPONSE_BYTES
    {
        return Err(errors::local(
            CoreErrorCode::CapacityExceeded,
            "Preferences response exceeds its 1MiB data budget or 400KiB recovery allowance; reduce this patch",
        ));
    }
    Ok(())
}
/// Bounds of the renderer preferences: text size, detail width and folded topic bands.
fn layout_bounds(entry: &PreferencesPatchEntry) -> Result<(), CoreError> {
    match entry {
        PreferencesPatchEntry::SetGlobal { preferences } => {
            if preferences.session_archive_expanded_project_ids.len()
                > SESSION_ARCHIVE_EXPANSION_CAPACITY
            {
                return Err(errors::local(
                    CoreErrorCode::CapacityExceeded,
                    "Expanded session archive groups exceed the 256 entry bound",
                ));
            }
            let mut projects = BTreeSet::new();
            if !preferences
                .session_archive_expanded_project_ids
                .iter()
                .all(|id| projects.insert(id))
            {
                return Err(errors::local(
                    CoreErrorCode::InvalidArgument,
                    "Duplicate expanded session archive project",
                ));
            }
            if !TEXT_SCALE_STEPS.contains(&preferences.text_scale) {
                return Err(errors::local(
                    CoreErrorCode::InvalidArgument,
                    "Text size must be 70%, 80%, 90%, 100%, 110% or 120%",
                ));
            }
            if preferences
                .detail_width
                .is_some_and(|width| !(DETAIL_WIDTH_MIN..=DETAIL_WIDTH_MAX).contains(&width))
            {
                return Err(errors::local(
                    CoreErrorCode::InvalidArgument,
                    format!("Detail panel width must be {DETAIL_WIDTH_MIN} to {DETAIL_WIDTH_MAX} pixels"),
                ));
            }
        }
        PreferencesPatchEntry::SetSessionView { preferences } => {
            if preferences.recent_items.len() > RECENT_ITEMS_CAPACITY {
                return Err(errors::local(
                    CoreErrorCode::CapacityExceeded,
                    "Recent items exceed the 15 entry bound",
                ));
            }
            let mut recent = BTreeSet::new();
            if !preferences
                .recent_items
                .iter()
                .all(|entry| recent.insert(&entry.item_id))
            {
                return Err(errors::local(
                    CoreErrorCode::InvalidArgument,
                    "Duplicate recent item",
                ));
            }
            if preferences.collapsed_topic_ids.len() > COLLAPSED_TOPICS_CAPACITY {
                return Err(errors::local(
                    CoreErrorCode::CapacityExceeded,
                    format!("Folded topics exceed the {COLLAPSED_TOPICS_CAPACITY} entry bound"),
                ));
            }
            let mut topics = BTreeSet::new();
            if !preferences
                .collapsed_topic_ids
                .iter()
                .all(|topic| topics.insert(topic))
            {
                return Err(errors::local(
                    CoreErrorCode::InvalidArgument,
                    "Duplicate folded topic",
                ));
            }
        }
        PreferencesPatchEntry::MarkSeen { items, topics, .. } => {
            if items.len() > SEEN_ITEMS_CAPACITY || topics.len() > SEEN_TOPICS_CAPACITY {
                return Err(seen_capacity());
            }
            let mut item_ids = BTreeSet::new();
            let mut topic_ids = BTreeSet::new();
            if !items.iter().all(|item| item_ids.insert(&item.item_id))
                || !topics.iter().all(|topic| topic_ids.insert(&topic.topic_id))
            {
                return Err(errors::local(
                    CoreErrorCode::InvalidArgument,
                    "Duplicate seen item or topic",
                ));
            }
        }
        _ => {}
    }
    Ok(())
}
fn entry_valid(entry: PreferencesPatchEntry) -> Result<(), CoreError> {
    layout_bounds(&entry)?;
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
fn seen_capacity() -> CoreError {
    CoreError::new(
        CoreErrorCode::CapacityExceeded,
        "Seen history has too many items or topics in this session",
        "Try marking fewer items or topics at once.",
    )
}
fn apply(
    snapshot: &mut PreferencesSnapshot,
    entry: &PreferencesPatchEntry,
) -> Result<(), CoreError> {
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
        PreferencesPatchEntry::ResolveUnsentInput { input_id } => {
            if !snapshot.resolved_unsent_input_ids.contains(input_id) {
                // Preserve insertion order. Only a new marker evicts the oldest;
                // an existing ID is idempotent and never refreshes its position.
                if snapshot.resolved_unsent_input_ids.len() == RESOLVED_UNSENT_INPUT_CAPACITY {
                    snapshot.resolved_unsent_input_ids.remove(0);
                }
                snapshot.resolved_unsent_input_ids.push(input_id.clone());
            }
        }
        PreferencesPatchEntry::MarkSeen {
            session,
            at,
            items,
            topics,
        } => {
            if let Some(seen) = snapshot
                .seen
                .iter_mut()
                .find(|seen| seen.session == *session)
            {
                let mut item_indices: BTreeMap<_, _> = seen
                    .items
                    .iter()
                    .enumerate()
                    .map(|(index, item)| (item.item_id.clone(), index))
                    .collect();
                for item in items {
                    if let Some(index) = item_indices.get(&item.item_id) {
                        seen.items[*index].revision =
                            seen.items[*index].revision.max(item.revision);
                    } else {
                        item_indices.insert(item.item_id.clone(), seen.items.len());
                        seen.items.push(item.clone());
                    }
                }
                let mut topic_indices: BTreeMap<_, _> = seen
                    .topics
                    .iter()
                    .enumerate()
                    .map(|(index, topic)| (topic.topic_id.clone(), index))
                    .collect();
                for topic in topics {
                    if let Some(index) = topic_indices.get(&topic.topic_id) {
                        if topic.at > seen.topics[*index].at {
                            seen.topics[*index].at = topic.at.clone();
                        }
                    } else {
                        topic_indices.insert(topic.topic_id.clone(), seen.topics.len());
                        seen.topics.push(topic.clone());
                    }
                }
                if seen.items.len() > SEEN_ITEMS_CAPACITY
                    || seen.topics.len() > SEEN_TOPICS_CAPACITY
                {
                    return Err(seen_capacity());
                }
            } else {
                snapshot.seen.push(SessionSeen {
                    session: session.clone(),
                    since: at.clone(),
                    items: items.clone(),
                    topics: topics.clone(),
                });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod recovery_retry_tests {
    use super::*;
    use std::fs;

    fn id(n: u64) -> UuidV4 {
        UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
    }

    fn owner() -> OwnerContext {
        OwnerContext::from_trusted_entrypoint(OwnerScope::Preferences)
    }

    struct PendingMarker {
        home: tempfile::TempDir,
        registry: Registry,
        command: OwnerCommand,
        main: Vec<u8>,
        companion: Vec<u8>,
    }

    impl PendingMarker {
        fn new() -> Self {
            let home = tempfile::tempdir().unwrap();
            let registry = Registry::open(home.path()).unwrap();
            let service = PreferencesService::new(&registry);
            let command = |op, expected, input| OwnerCommand::PreferencesPatch {
                api_version: one(),
                op_id: id(op),
                params: PreferencesPatch {
                    expected_preferences_revision: PositiveSafeInteger::new(expected).unwrap(),
                    entries: vec![PreferencesPatchEntry::ResolveUnsentInput {
                        input_id: id(input),
                    }],
                },
            };
            service.patch(&owner(), &command(100, 1, 90)).unwrap();
            service.patch(&owner(), &command(101, 2, 91)).unwrap();
            let main_path = home.path().join(".ariadne/ui.json");
            let main = fs::read(&main_path).unwrap();
            let command = command(102, 3, 92);
            service.patch(&owner(), &command).unwrap();
            let companion = fs::read(home.path().join(".ariadne/ui-recovery.json")).unwrap();
            // Leave three authoritative markers with the last projection pending.
            fs::write(main_path, &main).unwrap();
            Self {
                home,
                registry,
                command,
                main,
                companion,
            }
        }

        fn assert_preserved(&self) {
            let root = self.home.path().join(".ariadne");
            assert_eq!(fs::read(root.join("ui.json")).unwrap(), self.main);
            assert_eq!(
                fs::read(root.join("ui-recovery.json")).unwrap(),
                self.companion
            );
            assert!(!fs::read_dir(root).unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("ui-recovery.corrupt-")));
        }

        fn assert_retry_completes(&self) {
            let service = PreferencesService::new(&self.registry);
            let receipt = service.patch(&owner(), &self.command).unwrap();
            assert_eq!(receipt.preferences_revision.value(), 4);
            assert_eq!(
                service.get(&owner()).unwrap().resolved_unsent_input_ids,
                vec![id(90), id(91), id(92)]
            );
            assert_eq!(
                fs::read(self.home.path().join(".ariadne/ui-recovery.json")).unwrap(),
                self.companion
            );
            assert_eq!(service.patch(&owner(), &self.command).unwrap(), receipt);
        }
    }

    #[test]
    fn disk_full_dismissal_projection_retries_preserve_all_markers() {
        let pending = PendingMarker::new();
        for _ in 0..3 {
            let result = pending.registry.with_ui_file(|mut file| {
                load_with(&mut file, |file, record, recovery| {
                    project_recovery_with(
                        file,
                        record,
                        recovery,
                        ProjectionMode::Patch,
                        |file, operation| file.confirm_recovery(operation),
                        |file, _, _| {
                            Err(StoreError::Io {
                                action: "write",
                                path: file.path(),
                                kind: std::io::ErrorKind::StorageFull,
                            })
                        },
                    )
                })
            });
            assert!(
                matches!(result, Err(Failure::Store(StoreError::CommitUncertain {
                operation_id: Some(ref operation),
            })) if operation == &id(102))
            );
            pending.assert_preserved();
        }
        pending.assert_retry_completes();
    }

    #[test]
    fn repeated_recovery_directory_sync_failure_never_reports_success_or_quarantines() {
        let pending = PendingMarker::new();
        for _ in 0..3 {
            let result = pending.registry.with_ui_file(|mut file| {
                load_with(&mut file, |file, record, recovery| {
                    project_recovery_with(
                        file,
                        record,
                        recovery,
                        ProjectionMode::Patch,
                        |_, operation| {
                            Err(StoreError::CommitUncertain {
                                operation_id: Some(operation.clone()),
                            })
                        },
                        |_, _, _| panic!("unconfirmed marker must not publish main preferences"),
                    )
                })
            });
            assert!(
                matches!(result, Err(Failure::Store(StoreError::CommitUncertain {
                operation_id: Some(ref operation),
            })) if operation == &id(102))
            );
            pending.assert_preserved();
        }
        pending.assert_retry_completes();
    }

    #[test]
    fn preferences_read_returns_main_without_markers_when_confirmation_fails() {
        let pending = PendingMarker::new();
        for _ in 0..3 {
            let result = pending.registry.with_ui_file(|mut file| {
                load_with(&mut file, |file, record, recovery| {
                    project_recovery_with(
                        file,
                        record,
                        recovery,
                        ProjectionMode::Read,
                        |_, operation| {
                            Err(StoreError::CommitUncertain {
                                operation_id: Some(operation.clone()),
                            })
                        },
                        |_, _, _| panic!("unconfirmed marker must not publish main preferences"),
                    )
                })
            });
            let (record, recovery) = result.map_err(failure).unwrap();
            assert_eq!(record.snapshot.revision.value(), 3);
            assert!(record.snapshot.resolved_unsent_input_ids.is_empty());
            assert!(recovery.operations.is_empty());
            pending.assert_preserved();
        }
        pending.assert_retry_completes();
    }

    #[test]
    fn preferences_read_returns_durable_projection_when_main_publication_fails() {
        let pending = PendingMarker::new();
        for _ in 0..3 {
            let result = pending.registry.with_ui_file(|mut file| {
                load_with(&mut file, |file, record, recovery| {
                    project_recovery_with(
                        file,
                        record,
                        recovery,
                        ProjectionMode::Read,
                        |file, operation| file.confirm_recovery(operation),
                        |file, _, _| {
                            Err(StoreError::Io {
                                action: "write",
                                path: file.path(),
                                kind: std::io::ErrorKind::StorageFull,
                            })
                        },
                    )
                })
            });
            let (record, recovery) = result.map_err(failure).unwrap();
            assert_eq!(record.snapshot.revision.value(), 4);
            assert_eq!(
                record.snapshot.resolved_unsent_input_ids,
                vec![id(90), id(91), id(92)]
            );
            assert_eq!(recovery.operations.last().unwrap().operation_id, id(102));
            pending.assert_preserved();
        }
        pending.assert_retry_completes();
    }

    fn load_counting(
        pending: &PendingMarker,
        mode: ProjectionMode,
        confirms: &std::cell::Cell<usize>,
    ) -> (Record, RecoveryRecord) {
        pending
            .registry
            .with_ui_file(|mut file| {
                load_with(&mut file, |file, record, recovery| {
                    project_recovery_with(
                        file,
                        record,
                        recovery,
                        mode,
                        |file, operation| {
                            confirms.set(confirms.get() + 1);
                            file.confirm_recovery(operation)
                        },
                        |file, bytes, operation| file.publish_current(bytes, operation),
                    )
                })
            })
            .map_err(failure)
            .unwrap()
    }

    #[test]
    fn preferences_reads_confirm_only_the_one_time_repair_and_patches_still_confirm() {
        let pending = PendingMarker::new();
        let confirms = std::cell::Cell::new(0);
        for _ in 0..3 {
            let (record, recovery) = load_counting(&pending, ProjectionMode::Read, &confirms);
            assert_eq!(record.snapshot.revision.value(), 4);
            assert_eq!(
                record.snapshot.resolved_unsent_input_ids,
                vec![id(90), id(91), id(92)]
            );
            assert_eq!(recovery.operations.last().unwrap().operation_id, id(102));
        }
        // The interrupted projection was repaired once; later reads never sync.
        assert_eq!(confirms.get(), 1);
        let service = PreferencesService::new(&pending.registry);
        for _ in 0..3 {
            assert_eq!(
                service.get(&owner()).unwrap().resolved_unsent_input_ids,
                vec![id(90), id(91), id(92)]
            );
        }
        load_counting(&pending, ProjectionMode::Patch, &confirms);
        assert_eq!(confirms.get(), 2);
        assert_eq!(
            fs::read(pending.home.path().join(".ariadne/ui-recovery.json")).unwrap(),
            pending.companion
        );
    }

    #[test]
    fn transient_companion_read_makes_a_dismissal_patch_store_busy_and_keeps_every_copy() {
        let pending = PendingMarker::new();
        ariadne_store::ui::test_support::fail_next_companion_read_with_eio();
        let error = PreferencesService::new(&pending.registry)
            .patch(&owner(), &pending.command)
            .unwrap_err();
        assert_eq!(error.code, CoreErrorCode::StoreBusy);
        assert!(error.retryable);
        pending.assert_preserved();
        pending.assert_retry_completes();
    }

    #[test]
    fn busy_markers_are_worded_try_again_and_lasting_refusals_are_not() {
        let busy = failure(Failure::Store(StoreError::Busy));
        assert_eq!(busy.code, CoreErrorCode::StoreBusy);
        assert!(busy.retryable);
        assert!(busy.hint.contains("try again"));
        let refused = failure(Failure::Store(StoreError::UnsafePath {
            path: "ui-recovery.json".into(),
        }));
        assert_eq!(refused.code, CoreErrorCode::PermissionDenied);
        assert!(!refused.retryable);
    }
}
