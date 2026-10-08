//! Owner removal: subtree purge, agent notice, backups, families and bounds.
use ariadne_agent_protocol::{EventPayload, NormalizedEvent, TurnFinishedStatus};
use ariadne_core::{
    apply::ApplyService,
    delivery::DeliveryService,
    history_actions::{HistoryActionError, HistoryActionService},
    inputs::InputService,
    *,
};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tempfile::TempDir;

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn p(n: u64) -> PositiveSafeInteger {
    PositiveSafeInteger::new(n).unwrap()
}
fn r(text: &str) -> ItemRef {
    ItemRef::new(text).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn version() -> SchemaVersion {
    SchemaVersion::new(1).unwrap()
}
fn seed() -> Session {
    serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap()
}
fn demo() -> Session {
    serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json")).unwrap()
}
fn source() -> Session {
    serde_json::from_str(include_str!(
        "../../../fixtures/domain/demo/source-session.json"
    ))
    .unwrap()
}
fn owner(project: u64, session: u64) -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(project), id(session)),
    ))
}
fn registry_scope() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Registry)
}
fn item_remove(item: &str, revision: PositiveSafeInteger, op: u64) -> OwnerCommand {
    OwnerCommand::ItemRemove {
        api_version: version(),
        op_id: id(op),
        params: ItemRemoveParams {
            item_id: r(item),
            expected_revision: revision,
        },
    }
}
fn topic_remove(topic: u64, revision: PositiveSafeInteger, op: u64) -> OwnerCommand {
    topic_remove_id(id(topic), revision, op)
}
fn topic_remove_id(topic: UuidV4, revision: PositiveSafeInteger, op: u64) -> OwnerCommand {
    OwnerCommand::TopicRemove {
        api_version: version(),
        op_id: id(op),
        params: TopicLifecycleParams {
            topic_id: topic,
            expected_revision: revision,
        },
    }
}
fn store_error(result: Result<MutationReceipt, HistoryActionError>) {
    match result.unwrap_err() {
        HistoryActionError::Store(_) => {}
        other => panic!("store error, got {other:?}"),
    }
}
/// Every `pre-remove-…` name in a directory (empty when it does not exist).
fn removal_backups(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .map(|e| e.unwrap().file_name().into_string().unwrap())
                .filter(|name| name.starts_with("pre-remove-"))
                .collect()
        })
        .unwrap_or_default()
}
fn target_seed(session: u64) -> Session {
    let mut target = seed();
    target.id = id(session);
    target
}
/// The seed with its binding paused by the owner.
fn paused_seed() -> Session {
    let mut session = seed();
    let binding = session.bindings.0.get_mut(&id(3)).unwrap();
    binding.dispatch_state = DispatchState::Paused;
    binding.owner_paused = true;
    session
}
fn session_remove(
    project: u64,
    session: u64,
    revision: PositiveSafeInteger,
    op: u64,
) -> OwnerCommand {
    OwnerCommand::SessionRemove {
        api_version: version(),
        op_id: id(op),
        params: SessionRemoveParams {
            project_id: id(project),
            session_id: id(session),
            expected_revision: revision,
        },
    }
}
fn project_remove(project: u64, op: u64) -> OwnerCommand {
    OwnerCommand::ProjectRemove {
        api_version: version(),
        op_id: id(op),
        params: ProjectRemoveParams {
            project_id: id(project),
        },
    }
}
fn saved(receipt: MutationReceipt) -> SavedReceipt {
    let MutationReceipt::Session(saved) = receipt else {
        panic!("session receipt")
    };
    *saved
}
fn removed(receipt: MutationReceipt) -> RemovedReceipt {
    let MutationReceipt::Removed(removed) = receipt else {
        panic!("removed receipt")
    };
    removed
}
struct Removal {
    item_ids: Vec<ItemRef>,
    topic_ids: Vec<UuidV4>,
    input_ids: Vec<UuidV4>,
    family: Vec<RemovalTarget>,
    notice: Option<RemovalTarget>,
    backup: PathBuf,
}
fn removal(receipt: &SavedReceipt) -> Removal {
    let SavedReceiptData::Removal {
        item_ids,
        topic_ids,
        input_ids,
        family,
        notice,
        backup,
    } = receipt.data.clone()
    else {
        panic!("removal data")
    };
    Removal {
        item_ids,
        topic_ids,
        input_ids,
        family,
        notice,
        backup: PathBuf::from(backup),
    }
}
fn core_error(result: Result<MutationReceipt, HistoryActionError>) -> CoreError {
    match result.unwrap_err() {
        HistoryActionError::Core(error) => error,
        other => panic!("core error, got {other:?}"),
    }
}

/// One data root with any number of registered project folders.
struct Setup {
    home: TempDir,
    roots: Vec<(u64, TempDir)>,
    registry: Registry,
    next: AtomicU64,
}
impl Setup {
    fn new(projects: &[(u64, &[Session])]) -> Self {
        let home = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        let mut roots = vec![];
        for (n, (project, sessions)) in projects.iter().enumerate() {
            let root = tempfile::tempdir().unwrap();
            registry
                .register(root.path(), &id(0x990 + n as u64), || id(*project))
                .unwrap();
            let store =
                Store::open_registered(&registry.project_dir(&id(*project)), id(*project)).unwrap();
            for session in sessions.iter() {
                store.create(session).unwrap();
            }
            roots.push((*project, root));
        }
        Self {
            home,
            roots,
            registry,
            next: AtomicU64::new(0x10000),
        }
    }
    fn root(&self, project: u64) -> &Path {
        self.roots
            .iter()
            .find(|(p, _)| *p == project)
            .unwrap()
            .1
            .path()
    }
    /// The project's store under the data root, as the registry spells it.
    fn dir(&self, project: u64) -> PathBuf {
        self.registry.project_dir(&id(project))
    }
    fn store(&self, project: u64) -> Store {
        Store::open_registered(&self.dir(project), id(project)).unwrap()
    }
    fn read(&self, project: u64, session: u64) -> Session {
        self.store(project).read(&id(session)).unwrap()
    }
    fn file(&self, project: u64, session: u64) -> PathBuf {
        self.dir(project)
            .join("sessions")
            .join(format!("{}.json", id(session).as_str()))
    }
    fn uuid(&self) -> UuidV4 {
        id(self.next.fetch_add(1, Ordering::SeqCst))
    }
    fn remove(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
    ) -> Result<MutationReceipt, HistoryActionError> {
        HistoryActionService::new(&self.registry).remove(context, command, || self.uuid(), at())
    }
    fn remove_at(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
        at: UtcMillis,
    ) -> Result<MutationReceipt, HistoryActionError> {
        HistoryActionService::new(&self.registry).remove(context, command, || self.uuid(), at)
    }
    /// The data root's own `backups/` directory.
    fn data_backups(&self) -> PathBuf {
        fs::canonicalize(self.home.path())
            .unwrap()
            .join(".ariadne/backups")
    }
    fn projects_file(&self) -> PathBuf {
        fs::canonicalize(self.home.path())
            .unwrap()
            .join(".ariadne/projects.json")
    }
    /// Continue `topic` from one session of project 1 into another through the
    /// real preview and continue commands; returns the new copy's topic ID.
    fn continue_into(&self, from: u64, topic: &UuidV4, to: u64, op: u64) -> UuidV4 {
        let service = HistoryActionService::new(&self.registry);
        let request = ContinuePreviewRequest {
            source: SessionRef {
                project_id: id(1),
                session_id: id(from),
            },
            source_topic_id: topic.clone(),
            target: SessionRef {
                project_id: id(1),
                session_id: id(to),
            },
        };
        let preview = service.preview(&owner(1, to), &request).unwrap();
        let command = OwnerCommand::TopicContinue {
            api_version: version(),
            op_id: id(op),
            params: TopicContinueParams {
                source: preview.source,
                source_topic_id: preview.source_topic_id,
                source_revision: preview.source_revision,
                source_sha256: preview.source_sha256,
                target: preview.target,
                target_binding_id: id(3),
                summary: preview.summary,
            },
        };
        let receipt = service
            .continue_topic(&owner(1, to), &command, || self.uuid(), at())
            .unwrap();
        let SavedReceiptData::Continuation { continuation } = saved(receipt).data else {
            panic!("continuation receipt")
        };
        continuation.target_topic_id
    }
}

#[test]
fn item_remove_drops_the_subtree_with_rounds_and_inputs_and_tells_the_agent() {
    let t = Setup::new(&[(1, &[demo()])]);
    let before = t.read(1, 2);
    let bytes = fs::read(t.file(1, 2)).unwrap();
    assert_eq!(before.items.0[&r("1.1")].parent, Some(r("1")));
    let receipt = saved(
        t.remove(
            &owner(1, 2),
            &item_remove("1", before.items.0[&r("1")].revision, 100),
        )
        .unwrap(),
    );
    let data = removal(&receipt);
    assert_eq!(data.item_ids, vec![r("1"), r("1.1")]);
    assert!(data.topic_ids.is_empty());
    assert!(data.family.is_empty());
    // Both inputs on item 1 are dropped with it; nothing else is.
    assert_eq!(data.input_ids, vec![id(0x70), id(0x78)]);
    // The backup is the complete session as it was before the removal.
    assert!(data.backup.starts_with(t.dir(1).join("backups")));
    assert!(data
        .backup
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("pre-remove-20261004T120000000Z-"));
    assert_eq!(fs::read(&data.backup).unwrap(), bytes);

    let after = t.read(1, 2);
    assert!(!after.items.0.contains_key(&r("1")));
    assert!(!after.items.0.contains_key(&r("1.1")));
    assert!(after.items.0.contains_key(&r("2")));
    assert!(!after.rounds.0.contains_key(&id(0x40)));
    assert!(after.rounds.0.contains_key(&id(0x41)));
    assert!(after.answers.is_empty());
    assert!(!after.inputs.0.contains_key(&id(0x70)));
    assert!(after.inputs.0.contains_key(&id(0x76)));
    assert!(after.messages.iter().all(|m| m
        .item_id
        .as_ref()
        .is_none_or(|i| i != &r("1") && i != &r("1.1"))));
    assert_eq!(after.revision, p(before.revision.value() + 1));

    // The selected binding gets one queued notice naming every removed item.
    let notice = data.notice.unwrap();
    assert_eq!(notice.session_id, id(2));
    let input = &after.inputs.0[&notice.id];
    assert_eq!(input.kind, InputKind::Removed);
    assert_eq!(input.state, InputState::Queued);
    assert_eq!(input.binding_id, id(0x20));
    assert_eq!(input.target.item_id, None);
    let payload = input.payload.removed.as_ref().unwrap();
    assert_eq!(payload.refs.len(), 2);
    assert!(matches!(&payload.refs[0], RemovedRef::Item { r#ref, .. } if r#ref == &r("1")));
    assert!(payload.note.starts_with("The owner removed item 1 \""));
    assert!(payload
        .note
        .contains("and the 1 item below it from Ariadne."));
    assert!(payload.note.ends_with("never bring them up again."));
    let message = after
        .messages
        .iter()
        .find(|m| m.id == input.message_id)
        .unwrap();
    assert_eq!(message.kind, MessageKind::OwnerInput);
    assert_eq!(message.body, payload.note);

    // An exact retry replays the saved receipt without writing.
    let current = fs::read(t.file(1, 2)).unwrap();
    let replay = t
        .remove(
            &owner(1, 2),
            &item_remove("1", before.items.0[&r("1")].revision, 100),
        )
        .unwrap();
    assert_eq!(saved(replay), receipt);
    assert_eq!(fs::read(t.file(1, 2)).unwrap(), current);
    // A fresh request for a removed item fails as not found.
    let gone = core_error(t.remove(&owner(1, 2), &item_remove("1", p(3), 101)));
    assert_eq!(gone.code, CoreErrorCode::NotFound);
}

#[test]
fn item_remove_refuses_live_replacements_without_writing_and_takes_pending_inputs() {
    let t = Setup::new(&[(1, &[demo()])]);
    let bytes = fs::read(t.file(1, 2)).unwrap();
    let session = t.read(1, 2);
    // Item 7 was replaced by item 4, so item 4 must stay.
    let replaced = core_error(t.remove(
        &owner(1, 2),
        &item_remove("4", session.items.0[&r("4")].revision, 101),
    ));
    assert_eq!(replaced.code, CoreErrorCode::InvalidTransition);
    assert_eq!(replaced.details.unwrap().blocking_item_ids, vec![r("7")]);
    let stale = core_error(t.remove(&owner(1, 2), &item_remove("5", p(99), 102)));
    assert_eq!(stale.code, CoreErrorCode::RevisionConflict);
    assert_eq!(fs::read(t.file(1, 2)).unwrap(), bytes);
    assert!(fs::read_dir(t.dir(1).join("backups"))
        .map(|dir| dir.count() == 0)
        .unwrap_or(true));
    // Owner rule: pending inputs never block removal. Item 3's input is in
    // flight; it goes with the item and frees its binding.
    let data = removal(&saved(
        t.remove(
            &owner(1, 2),
            &item_remove("3", session.items.0[&r("3")].revision, 100),
        )
        .unwrap(),
    ));
    assert!(data.input_ids.contains(&id(0x72)));
    let live = t.read(1, 2);
    assert!(!live.inputs.0.contains_key(&id(0x72)));
    assert_eq!(live.bindings.0[&id(0x20)].active_input_id, None);
    assert_eq!(live.bindings.0[&id(0x20)].pause_reason, None);
    // Item 7's input needs attention; its barrier lifts with it.
    let data = removal(&saved(
        t.remove(
            &owner(1, 2),
            &item_remove("7", live.items.0[&r("7")].revision, 101),
        )
        .unwrap(),
    ));
    assert!(data.input_ids.contains(&id(0x74)));
    let live = t.read(1, 2);
    let binding = &live.bindings.0[&id(0x21)];
    assert_eq!(binding.pause_reason, None);
    assert_eq!(binding.active_input_id, None);
    assert_ne!(binding.dispatch_state, DispatchState::RecoveryRequired);
}

#[test]
fn removal_takes_an_in_flight_input_and_late_agent_reports_are_ignored() {
    let t = Setup::new(&[(1, &[seed()])]);
    let route = RegisteredSession::from_trusted_entrypoint(id(1), id(2));
    let submit = OwnerCommand::InputSubmit {
        api_version: version(),
        op_id: id(90),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: id(5),
                item_id: Some(r("1")),
            },
            kind: InputKind::Reply,
            text: "Owner text in flight".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    InputService::new(&t.registry)
        .execute(&owner(1, 2), &submit, || t.uuid(), at())
        .unwrap();
    let generation = t.read(1, 2).bindings.0[&id(3)].generation.clone();
    let lease = ValidatedDispatchContext::from_trusted_current_lease(
        route.clone(),
        id(3),
        generation.clone(),
    );
    let claim = ClaimRequest {
        binding_id: id(3),
        generation: generation.clone(),
        request_id: id(200),
    };
    let attempt = DeliveryService::new(&t.registry)
        .claim(&lease, &claim, || t.uuid(), at())
        .unwrap()
        .unwrap();
    assert_eq!(
        t.read(1, 2).inputs.0[&attempt.input_id].state,
        InputState::InFlight
    );
    let revision = t.read(1, 2).items.0[&r("1")].revision;
    let data = removal(&saved(
        t.remove(&owner(1, 2), &item_remove("1", revision, 100))
            .unwrap(),
    ));
    assert_eq!(data.input_ids, vec![attempt.input_id.clone()]);
    let binding = &t.read(1, 2).bindings.0[&id(3)];
    assert_eq!(binding.active_input_id, None);
    assert_eq!(binding.pause_reason, None);
    // The host still reports the turn failed: ignored, no barrier.
    let adapter = AdapterContext::from_trusted_entrypoint(route, id(3), generation.clone(), None);
    DeliveryService::new(&t.registry)
        .report(
            &adapter,
            &NormalizedEvent {
                event_id: "late-failure".into(),
                binding_id: id(3),
                generation: generation.clone(),
                input_id: Some(attempt.input_id.clone()),
                attempt_id: Some(attempt.attempt_id.clone()),
                host_turn_id: Some("turn".into()),
                observed_at: at(),
                event: EventPayload::TurnFinished {
                    status: TurnFinishedStatus::Failed,
                    reason: Some("stopped".into()),
                    diagnostic_text: None,
                    truncated: false,
                },
            },
            || t.uuid(),
        )
        .unwrap();
    let binding = &t.read(1, 2).bindings.0[&id(3)];
    assert_eq!(binding.pause_reason, None);
    assert_ne!(binding.dispatch_state, DispatchState::RecoveryRequired);
    // The agent's late apply learns the work was removed, as a cancelled input.
    let error = ariadne_core::native::AgentResolver::resolve(
        &t.registry,
        id(3),
        generation,
        Some(attempt.input_id.clone()),
        Some(attempt.attempt_id.clone()),
    )
    .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::AttemptSealed);
    assert_eq!(
        error.details.unwrap().reason,
        Some(BarrierReason::InputCancelled)
    );
}

#[test]
fn removal_notice_is_delivered_and_acknowledged_without_replies() {
    let t = Setup::new(&[(1, &[seed()])]);
    let route = RegisteredSession::from_trusted_entrypoint(id(1), id(2));
    // A queued reply on item 1 is dropped with it.
    let submit = OwnerCommand::InputSubmit {
        api_version: version(),
        op_id: id(90),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: id(5),
                item_id: Some(r("1")),
            },
            kind: InputKind::Reply,
            text: "Queued owner text".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    let queued = InputService::new(&t.registry)
        .execute(&owner(1, 2), &submit, || t.uuid(), at())
        .unwrap();
    let SavedReceiptData::InputSubmit {
        input_id: dropped, ..
    } = saved(queued).data
    else {
        panic!()
    };
    let revision = t.read(1, 2).items.0[&r("1")].revision;
    let data = removal(&saved(
        t.remove(&owner(1, 2), &item_remove("1", revision, 100))
            .unwrap(),
    ));
    assert_eq!(data.input_ids, vec![dropped.clone()]);
    let notice = data.notice.unwrap();

    let generation = t.read(1, 2).bindings.0[&id(3)].generation.clone();
    let lease = ValidatedDispatchContext::from_trusted_current_lease(
        route.clone(),
        id(3),
        generation.clone(),
    );
    let claim = ClaimRequest {
        binding_id: id(3),
        generation: generation.clone(),
        request_id: id(200),
    };
    let attempt = DeliveryService::new(&t.registry)
        .claim(&lease, &claim, || t.uuid(), at())
        .unwrap()
        .unwrap();
    assert_eq!(attempt.input_id, notice.id);
    let json = &attempt.formatted_payload[attempt.formatted_payload.find('{').unwrap()..];
    let envelope: serde_json::Value = serde_json::from_str(json).unwrap();
    // The rules for a removal notice live in the skill; the envelope carries
    // only the routing IDs and the saved notice.
    let keys: Vec<_> = envelope.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "attempt_id",
            "binding_id",
            "generation",
            "input_kind",
            "owner_message_number",
            "removed",
            "source_input_id"
        ]
    );
    assert_eq!(envelope["input_kind"], "removed");
    assert_eq!(envelope["source_input_id"], notice.id.as_str());
    assert_eq!(envelope["removed"]["refs"][0]["kind"], "item");
    assert_eq!(envelope["removed"]["refs"][0]["ref"], "1");
    // The removed records and their context are not in the envelope.
    assert!(!json.contains("Queued owner text"));

    let session = t.read(1, 2);
    let number = session
        .messages
        .iter()
        .find(|m| m.id == session.inputs.0[&notice.id].message_id)
        .unwrap()
        .number;
    let agent = AgentContext::from_trusted_entrypoint(
        route.clone(),
        id(3),
        generation.clone(),
        AgentReadScope::Dispatched {
            source_input_id: notice.id.clone(),
            attempt_id: attempt.attempt_id.clone(),
            issued_through_message_number: NonnegativeSafeInteger::new(number.value()).unwrap(),
        },
    );
    let ack = ApplyRequest {
        op_id: id(300),
        source_input_id: Some(notice.id.clone()),
        attempt_id: Some(attempt.attempt_id.clone()),
        expected_item_revisions: UniqueMap(Default::default()),
        expected_topic_revisions: UniqueMap(Default::default()),
        summary: String::new(),
        operations: vec![],
        input_result: Some(ResultDraft {
            outcome: ResultOutcome::Answered,
            explanation: "Stopped work on the removed item.".into(),
            reply_refs: vec![],
            followup_item_refs: vec![],
            handled_through_message_number: number,
        }),
    };
    ApplyService::new(&t.registry)
        .execute(&agent, &ack, || t.uuid(), at())
        .unwrap();
    let adapter = AdapterContext::from_trusted_entrypoint(route, id(3), generation.clone(), None);
    DeliveryService::new(&t.registry)
        .report(
            &adapter,
            &NormalizedEvent {
                event_id: "completed".into(),
                binding_id: id(3),
                generation,
                input_id: Some(notice.id.clone()),
                attempt_id: Some(attempt.attempt_id.clone()),
                host_turn_id: Some("turn".into()),
                observed_at: at(),
                event: EventPayload::TurnFinished {
                    status: TurnFinishedStatus::Completed,
                    reason: None,
                    diagnostic_text: None,
                    truncated: false,
                },
            },
            || t.uuid(),
        )
        .unwrap();
    assert_eq!(t.read(1, 2).inputs.0[&notice.id].state, InputState::Handled);
}

#[test]
fn owners_cannot_submit_a_removal_notice_themselves() {
    let t = Setup::new(&[(1, &[seed()])]);
    let submit = OwnerCommand::InputSubmit {
        api_version: version(),
        op_id: id(90),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: id(5),
                item_id: None,
            },
            kind: InputKind::Removed,
            text: "Forget it".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    let error = InputService::new(&t.registry)
        .execute(&owner(1, 2), &submit, || t.uuid(), at())
        .unwrap_err();
    let ariadne_core::inputs::InputError::Core(error) = error else {
        panic!("core error, got {error:?}")
    };
    assert_eq!(error.code, CoreErrorCode::InvalidArgument);
}

#[test]
fn closed_session_removal_queues_no_notice() {
    let mut session = seed();
    for item in session.items.0.values_mut() {
        item.status = ItemStatus::Done;
        item.outcome = Some("Retained complete outcome".into());
        item.why = Some("Explicitly completed".into());
        item.waiting_since = None;
    }
    let binding = session.bindings.0.get_mut(&id(3)).unwrap();
    binding.dispatch_state = DispatchState::Paused;
    binding.owner_paused = true;
    let t = Setup::new(&[(1, &[session])]);
    let close = OwnerCommand::SessionClose {
        api_version: version(),
        op_id: id(90),
        params: SessionLifecycleParams {
            expected_revision: p(1),
        },
    };
    HistoryActionService::new(&t.registry)
        .execute(&owner(1, 2), &close, at())
        .unwrap();
    let data = removal(&saved(
        t.remove(&owner(1, 2), &item_remove("1", p(1), 100))
            .unwrap(),
    ));
    assert!(data.notice.is_none());
    let after = t.read(1, 2);
    assert_eq!(after.state, SessionState::Closed);
    assert!(after
        .inputs
        .0
        .values()
        .all(|i| i.kind != InputKind::Removed));
    // Topic removal on a closed session is silent too.
    let topic = after.topics.0[&id(5)].revision;
    let data = removal(&saved(
        t.remove(&owner(1, 2), &topic_remove(5, topic, 101))
            .unwrap(),
    ));
    assert!(data.notice.is_none());
    assert!(t.read(1, 2).topics.0.is_empty());
    assert!(t.read(1, 2).items.0.is_empty());
}

#[test]
fn topic_remove_takes_the_continuation_family_and_tells_only_the_latest_copy() {
    let t = Setup::new(&[(1, &[demo()]), (0x901, &[source()])]);
    let copy = t.read(1, 2);
    assert!(copy.topics.0[&id(0x11)].origin.is_some());
    // Removing the source topic from its own session removes the copy too.
    let receipt = saved(
        t.remove(&owner(0x901, 0x902), &topic_remove(0x910, p(12), 100))
            .unwrap(),
    );
    let data = removal(&receipt);
    assert_eq!(data.topic_ids, vec![id(0x910)]);
    assert_eq!(data.family.len(), 2);
    let notice = data.notice.unwrap();
    assert_eq!(notice.session_id, id(2));
    assert!(t.read(0x901, 0x902).topics.0.is_empty());
    assert!(t.read(0x901, 0x902).inputs.0.is_empty());

    let after = t.read(1, 2);
    assert!(!after.topics.0.contains_key(&id(0x11)));
    assert!(after.topics.0.contains_key(&id(0x10)));
    assert!(!after.items.0.contains_key(&r("8")));
    assert!(!after.rounds.0.contains_key(&id(0x42)));
    // The queued continue handoff and the continuation record go with it.
    assert!(!after.inputs.0.contains_key(&id(0x77)));
    assert!(after.continuations.0.is_empty());
    let input = &after.inputs.0[&notice.id];
    assert_eq!(input.kind, InputKind::Removed);
    assert_eq!(input.target.topic_id, id(0x11));
    let refs = &input.payload.removed.as_ref().unwrap().refs;
    assert!(matches!(&refs[0], RemovedRef::Topic { topic_id, .. } if topic_id == &id(0x11)));
    assert!(input
        .payload
        .text
        .starts_with("The owner removed topic \"Continued context\" and all its items"));
    // Each member session has its own backup, in its own project store.
    assert!(fs::read_dir(t.dir(1).join("backups")).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_str()
        .unwrap()
        .starts_with("pre-remove-")));
    assert!(data.backup.starts_with(t.dir(0x901)));

    // A retry replays the route and leaves every member as it is.
    let bytes = fs::read(t.file(1, 2)).unwrap();
    let replay = saved(
        t.remove(&owner(0x901, 0x902), &topic_remove(0x910, p(12), 100))
            .unwrap(),
    );
    assert_eq!(replay, receipt);
    assert_eq!(fs::read(t.file(1, 2)).unwrap(), bytes);
}

#[test]
fn session_remove_keeps_shared_topic_copies_and_takes_in_flight_inputs() {
    let t = Setup::new(&[(1, &[demo()]), (0x901, &[source()])]);
    let bytes = fs::read(t.file(0x901, 0x902)).unwrap();
    let receipt = removed(
        t.remove(&registry_scope(), &session_remove(0x901, 0x902, p(12), 100))
            .unwrap(),
    );
    assert_eq!(receipt.scope, RemovedScope::Session);
    assert_eq!(receipt.project_id, id(0x901));
    assert_eq!(receipt.session_ids, vec![id(0x902)]);
    let backup = PathBuf::from(&receipt.backup);
    assert_eq!(fs::read(&backup).unwrap(), bytes);
    assert!(!t.file(0x901, 0x902).exists());
    // The continued copy in the other session is that session's own topic.
    let copy = t.read(1, 2);
    assert!(copy.topics.0.contains_key(&id(0x11)));
    assert!(copy.items.0.contains_key(&r("8")));
    // An exact retry after the file is gone replays the same backup path.
    let replay = removed(
        t.remove(&registry_scope(), &session_remove(0x901, 0x902, p(12), 100))
            .unwrap(),
    );
    assert_eq!(replay, receipt);
    let gone = core_error(t.remove(&registry_scope(), &session_remove(0x901, 0x902, p(12), 101)));
    assert_eq!(gone.code, CoreErrorCode::NotFound);

    // Session removal needs the registry scope, item removal a session route.
    assert_eq!(
        core_error(t.remove(&owner(1, 2), &session_remove(1, 2, copy.revision, 103))).code,
        CoreErrorCode::PermissionDenied
    );
    assert_eq!(
        core_error(t.remove(&registry_scope(), &item_remove("2", p(2), 104))).code,
        CoreErrorCode::PermissionDenied
    );
    // Owner rule: a session with an input in flight is removed with it.
    assert_eq!(t.read(1, 2).inputs.0[&id(0x72)].state, InputState::InFlight);
    removed(
        t.remove(&registry_scope(), &session_remove(1, 2, copy.revision, 102))
            .unwrap(),
    );
    assert!(!t.file(1, 2).exists());
}

#[test]
fn session_remove_retry_at_a_later_time_reuses_the_first_backup() {
    let t = Setup::new(&[(1, &[demo()]), (0x901, &[source()])]);
    let live = t.file(0x901, 0x902);
    let bytes = fs::read(&live).unwrap();
    let first = removed(
        t.remove(&registry_scope(), &session_remove(0x901, 0x902, p(12), 100))
            .unwrap(),
    );
    // A crash after the backup but before the unlink leaves the file in place.
    {
        use std::os::unix::fs::PermissionsExt;
        fs::write(&live, &bytes).unwrap();
        fs::set_permissions(&live, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let later = UtcMillis::new("2026-10-04T12:00:05.000Z").unwrap();
    let retry = removed(
        t.remove_at(
            &registry_scope(),
            &session_remove(0x901, 0x902, p(12), 100),
            later,
        )
        .unwrap(),
    );
    assert_eq!(retry.backup, first.backup);
    assert_eq!(removal_backups(&t.dir(0x901).join("backups")).len(), 1);
    assert_eq!(fs::read(&first.backup).unwrap(), bytes);
    assert!(!live.exists());
}

#[test]
fn project_remove_deletes_only_the_project_store_under_the_data_root() {
    let t = Setup::new(&[(1, &[demo()]), (0x901, &[source()])]);
    let root = t.root(0x901).to_path_buf();
    let store = t.dir(0x901);
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("keep.txt"), "outside").unwrap();
    fs::write(root.join("notes.txt"), "owner file").unwrap();
    std::os::unix::fs::symlink(outside.path(), store.join("link")).unwrap();
    // An earlier removal leaves a backup in the store; the project backup keeps it.
    let earlier = removal(&saved(
        t.remove(&owner(0x901, 0x902), &item_remove("2", p(1), 99))
            .unwrap(),
    ))
    .backup;
    let earlier_bytes = fs::read(&earlier).unwrap();
    let session = fs::read(t.file(0x901, 0x902)).unwrap();

    let receipt = removed(
        t.remove(&registry_scope(), &project_remove(0x901, 100))
            .unwrap(),
    );
    assert_eq!(receipt.scope, RemovedScope::Project);
    assert_eq!(receipt.session_ids, vec![id(0x902)]);
    let backup = PathBuf::from(&receipt.backup);
    assert_eq!(
        backup,
        fs::canonicalize(t.home.path())
            .unwrap()
            .join(".ariadne/backups")
            .join(format!(
                "pre-remove-20261004T120000000Z-{}",
                id(100).as_str()
            ))
    );
    assert_eq!(
        fs::read(
            backup
                .join("sessions")
                .join(format!("{}.json", id(0x902).as_str()))
        )
        .unwrap(),
        session
    );
    assert_eq!(
        fs::read(backup.join("backups").join(earlier.file_name().unwrap())).unwrap(),
        earlier_bytes
    );
    assert!(backup.join("project.json").is_file());
    // Only the project's store goes; the folder, its files and link targets stay.
    assert!(!store.exists());
    assert!(t.dir(1).exists());
    assert!(root.is_dir());
    assert_eq!(
        fs::read_to_string(root.join("notes.txt")).unwrap(),
        "owner file"
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("keep.txt")).unwrap(),
        "outside"
    );
    let projects = t.registry.registered_projects().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].project_id, id(1));
    assert!(t.file(1, 2).exists());
    // An exact retry replays the saved removal.
    assert_eq!(
        removed(
            t.remove(&registry_scope(), &project_remove(0x901, 100))
                .unwrap()
        ),
        receipt
    );
    // Owner rule: a project whose session has an input in flight is removed too.
    assert_eq!(t.read(1, 2).inputs.0[&id(0x72)].state, InputState::InFlight);
    let receipt = removed(
        t.remove(&registry_scope(), &project_remove(1, 101))
            .unwrap(),
    );
    assert_eq!(receipt.session_ids, vec![id(2)]);
    assert!(!t.dir(1).exists());
    assert!(t.registry.registered_projects().unwrap().is_empty());
    assert_eq!(removal_backups(&t.data_backups()).len(), 2);
}

#[test]
fn project_remove_retry_rebuilds_a_missing_record_from_the_backup() {
    let t = Setup::new(&[(1, &[demo()]), (0x901, &[source()])]);
    let receipt = removed(
        t.remove(&registry_scope(), &project_remove(0x901, 100))
            .unwrap(),
    );
    // A crash after unregistering but before the record was written.
    let backup = PathBuf::from(&receipt.backup);
    fs::remove_file(backup.join("removal.json")).unwrap();
    let retry = removed(
        t.remove(&registry_scope(), &project_remove(0x901, 100))
            .unwrap(),
    );
    assert_eq!(retry, receipt);
    assert!(backup.join("removal.json").is_file());
    // The same operation ID for another project is refused.
    fs::remove_file(backup.join("removal.json")).unwrap();
    let reused = t.remove(&registry_scope(), &project_remove(1, 100));
    assert!(reused.is_err());
    assert!(t.file(1, 2).exists());
}

#[test]
fn project_remove_retry_finishes_a_store_delete_cut_short() {
    let t = Setup::new(&[(1, &[demo()]), (0x901, &[source()])]);
    let projects = fs::read(t.projects_file()).unwrap();
    let receipt = removed(
        t.remove(&registry_scope(), &project_remove(0x901, 100))
            .unwrap(),
    );
    // A crash part-way through deleting the store: the record is saved, the
    // project is still registered and the store has lost `project.json`.
    use std::os::unix::fs::PermissionsExt;
    fs::write(t.projects_file(), &projects).unwrap();
    fs::create_dir_all(t.dir(0x901).join("locks")).unwrap();
    for dir in [t.dir(0x901), t.dir(0x901).join("locks")] {
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    }
    fs::write(t.dir(0x901).join("locks/left.lock"), b"").unwrap();
    assert_eq!(t.registry.registered_projects().unwrap().len(), 2);
    let retry = removed(
        t.remove(&registry_scope(), &project_remove(0x901, 100))
            .unwrap(),
    );
    assert_eq!(retry, receipt);
    assert!(!t.dir(0x901).exists());
    let left = t.registry.registered_projects().unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].project_id, id(1));
}

#[test]
fn topic_remove_takes_every_copy_one_member_session_holds() {
    let t = Setup::new(&[(1, &[seed(), target_seed(20)])]);
    let first = t.continue_into(2, &id(5), 20, 50);
    let second = t.continue_into(2, &id(5), 20, 51);
    assert_ne!(first, second);
    let revision = t.read(1, 2).topics.0[&id(5)].revision;
    let receipt = saved(
        t.remove(&owner(1, 2), &topic_remove(5, revision, 100))
            .unwrap(),
    );
    let data = removal(&receipt);
    assert_eq!(data.family.len(), 3);
    assert!(t.read(1, 2).topics.0.is_empty());
    let after = t.read(1, 20);
    assert!(!after.topics.0.contains_key(&first));
    assert!(!after.topics.0.contains_key(&second));
    // Session 20's own topic with the same ID is not a copy and stays.
    assert!(after.topics.0.contains_key(&id(5)));
    assert!(after.items.0.values().all(|i| i.topic_id == id(5)));
    // One notice in the latest copy's session names both copies.
    let notice = data.notice.unwrap();
    assert_eq!(notice.session_id, id(20));
    let refs = &after.inputs.0[&notice.id]
        .payload
        .removed
        .as_ref()
        .unwrap()
        .refs;
    for topic in [&first, &second] {
        assert!(refs
            .iter()
            .any(|r| matches!(r, RemovedRef::Topic { topic_id, .. } if topic_id == topic)));
    }
    let bytes = fs::read(t.file(1, 20)).unwrap();
    assert_eq!(
        saved(
            t.remove(&owner(1, 2), &topic_remove(5, revision, 100))
                .unwrap()
        ),
        receipt
    );
    assert_eq!(fs::read(t.file(1, 20)).unwrap(), bytes);
}

#[test]
fn topic_remove_takes_a_copy_continued_back_into_the_route_session() {
    let t = Setup::new(&[(1, &[seed(), target_seed(20)])]);
    let copy = t.continue_into(2, &id(5), 20, 50);
    let back = t.continue_into(20, &copy, 2, 51);
    let held = t.read(1, 2);
    assert!(held.topics.0.contains_key(&id(5)) && held.topics.0.contains_key(&back));
    // The route session holds the original and the copy of its copy.
    let revision = held.topics.0[&id(5)].revision;
    let data = removal(&saved(
        t.remove(&owner(1, 2), &topic_remove(5, revision, 100))
            .unwrap(),
    ));
    assert_eq!(data.family.len(), 3);
    assert_eq!(data.topic_ids.len(), 2);
    assert!(t.read(1, 2).topics.0.is_empty());
    let other = t.read(1, 20);
    assert!(!other.topics.0.contains_key(&copy));
    assert!(other.topics.0.contains_key(&id(5)));

    // From the middle copy: the far session holds two family topics.
    let t = Setup::new(&[(1, &[seed(), target_seed(20)])]);
    let copy = t.continue_into(2, &id(5), 20, 50);
    let back = t.continue_into(20, &copy, 2, 51);
    let revision = t.read(1, 20).topics.0[&copy].revision;
    t.remove(&owner(1, 20), &topic_remove_id(copy.clone(), revision, 100))
        .unwrap();
    let source = t.read(1, 2);
    assert!(!source.topics.0.contains_key(&id(5)));
    assert!(!source.topics.0.contains_key(&back));
    assert!(!t.read(1, 20).topics.0.contains_key(&copy));
}

#[test]
fn topic_remove_refuses_when_a_member_store_cannot_be_read() {
    let t = Setup::new(&[(1, &[demo()]), (0x901, &[source()])]);
    let route = fs::read(t.file(0x901, 0x902)).unwrap();
    fs::write(t.file(1, 2), b"{").unwrap();
    store_error(t.remove(&owner(0x901, 0x902), &topic_remove(0x910, p(12), 100)));
    // Nothing was removed and no backup was written.
    assert_eq!(fs::read(t.file(0x901, 0x902)).unwrap(), route);
    assert!(removal_backups(&t.dir(0x901).join("backups")).is_empty());
    assert!(removal_backups(&t.dir(1).join("backups")).is_empty());
}

#[test]
fn topic_remove_names_removed_and_remaining_members_when_one_fails_after_the_route() {
    use std::os::unix::fs::PermissionsExt;
    let t = Setup::new(&[(1, &[demo()]), (0x901, &[source()])]);
    // The member can be read, but a directory blocks its backup name, so its
    // commit fails only after the route session has committed.
    let blocker = t.dir(1).join("backups").join(format!(
        "pre-remove-20261004T120000000Z-{}-{}.json",
        id(100).as_str(),
        id(2).as_str()
    ));
    fs::create_dir_all(&blocker).unwrap();
    fs::set_permissions(&blocker, fs::Permissions::from_mode(0o700)).unwrap();
    let error = core_error(t.remove(&owner(0x901, 0x902), &topic_remove(0x910, p(12), 100)));
    fs::remove_dir(&blocker).unwrap();
    assert!(error.message.contains(&format!(
        "removed from session(s) {} but is still in session(s) {}",
        id(0x902).as_str(),
        id(2).as_str()
    )));
    assert!(error.hint.contains(id(100).as_str()));
    let partial = error
        .details
        .as_ref()
        .unwrap()
        .partial_removal
        .as_ref()
        .unwrap();
    assert_eq!(partial.removed, vec![id(0x902)]);
    assert_eq!(partial.remaining, vec![id(2)]);
    assert!(t.read(0x901, 0x902).topics.0.is_empty());
    assert!(t.read(1, 2).topics.0.contains_key(&id(0x11)));
    // The same operation finishes the family once the cause is fixed.
    let data = removal(&saved(
        t.remove(&owner(0x901, 0x902), &topic_remove(0x910, p(12), 100))
            .unwrap(),
    ));
    let after = t.read(1, 2);
    assert!(!after.topics.0.contains_key(&id(0x11)));
    let notice = data.notice.unwrap();
    assert_eq!(after.inputs.0[&notice.id].kind, InputKind::Removed);
}

#[test]
fn removal_notice_is_queued_on_a_paused_binding() {
    let t = Setup::new(&[(1, &[paused_seed()])]);
    let data = removal(&saved(
        t.remove(&owner(1, 2), &item_remove("1", p(1), 100))
            .unwrap(),
    ));
    let notice = data.notice.unwrap();
    let input = &t.read(1, 2).inputs.0[&notice.id];
    assert_eq!(input.binding_id, id(3));
    assert_eq!(input.state, InputState::Queued);
}

#[test]
fn removal_notice_is_queued_on_a_disconnected_binding() {
    let t = Setup::new(&[(1, &[seed()])]);
    let disconnect = OwnerCommand::BindingDisconnect {
        api_version: version(),
        op_id: id(90),
        params: BindingStateParams {
            binding_id: id(3),
            expected_generation: id(4),
        },
    };
    ariadne_core::bindings::BindingService::new(&t.registry)
        .state(&owner(1, 2), &disconnect, at())
        .unwrap();
    let session = t.read(1, 2);
    let revision = session.items.0[&r("1")].revision;
    let data = removal(&saved(
        t.remove(&owner(1, 2), &item_remove("1", revision, 100))
            .unwrap(),
    ));
    let notice = data.notice.unwrap();
    let input = &t.read(1, 2).inputs.0[&notice.id];
    assert_eq!(input.binding_id, id(3));
    assert_eq!(input.state, InputState::Queued);
}

#[test]
fn item_remove_refuses_a_full_queue_without_writing() {
    let t = Setup::new(&[(1, &[seed()])]);
    for n in 0..100 {
        let submit = OwnerCommand::InputSubmit {
            api_version: version(),
            op_id: id(1000 + n),
            params: InputSubmitParams {
                binding_id: id(3),
                target: InputTarget {
                    topic_id: id(5),
                    item_id: Some(r("1")),
                },
                kind: InputKind::Note,
                text: format!("Queued request {n}"),
                selected_option_id: None,
                expected_question_revision: None,
                supersedes_answer_id: None,
            },
        };
        InputService::new(&t.registry)
            .execute(&owner(1, 2), &submit, || t.uuid(), at())
            .unwrap();
    }
    let bytes = fs::read(t.file(1, 2)).unwrap();
    let revision = t.read(1, 2).items.0[&r("2")].revision;
    let full = core_error(t.remove(&owner(1, 2), &item_remove("2", revision, 100)));
    assert_eq!(full.code, CoreErrorCode::QueueFull);
    assert_eq!(fs::read(t.file(1, 2)).unwrap(), bytes);
    assert!(removal_backups(&t.dir(1).join("backups")).is_empty());
    // Removing the item the queued inputs target frees their slots.
    let revision = t.read(1, 2).items.0[&r("1")].revision;
    let data = removal(&saved(
        t.remove(&owner(1, 2), &item_remove("1", revision, 101))
            .unwrap(),
    ));
    assert_eq!(data.input_ids.len(), 100);
    assert!(data.notice.is_some());
}

#[test]
fn removal_notice_shortens_names_that_would_pass_the_delivery_budget() {
    let mut session = seed();
    let long = "n".repeat(70 * 1024);
    session.topics.0.get_mut(&id(5)).unwrap().name = long.clone();
    let t = Setup::new(&[(1, &[session])]);
    let revision = t.read(1, 2).topics.0[&id(5)].revision;
    let data = removal(&saved(
        t.remove(&owner(1, 2), &topic_remove(5, revision, 100))
            .unwrap(),
    ));
    let notice = data.notice.unwrap();
    let input = &t.read(1, 2).inputs.0[&notice.id];
    let removed = input.payload.removed.as_ref().unwrap();
    let RemovedRef::Topic { topic_id, name } = &removed.refs[0] else {
        panic!("topic ref")
    };
    assert_eq!(topic_id, &id(5));
    assert_eq!(name.chars().count(), 200);
    assert!(name.ends_with('…'));
    assert!(removed.note.len() < 1024);
}
