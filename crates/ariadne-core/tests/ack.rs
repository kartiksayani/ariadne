use ariadne_core::{
    history_actions::{HistoryActionError, HistoryActionService},
    native::NativeCoreService,
    *,
};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use std::fs;
use tempfile::TempDir;
fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn p(n: u64) -> PositiveSafeInteger {
    PositiveSafeInteger::new(n).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn seed() -> Session {
    serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap()
}
fn owner() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
    ))
}
fn command(revision: u64) -> OwnerCommand {
    OwnerCommand::Ack {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(300),
        params: ItemAckParams {
            item_id: ItemRef::new("1").unwrap(),
            expected_revision: p(revision),
        },
    }
}
fn proposed(target: AckTarget) -> Session {
    let mut s = seed();
    let i = s.items.0.get_mut(&ItemRef::new("1").unwrap()).unwrap();
    i.status = ItemStatus::Open;
    i.waiting_since = None;
    i.ask = None;
    i.ack_to = Some(target);
    s
}
fn refused(result: Result<MutationReceipt, HistoryActionError>) -> CoreError {
    match result.unwrap_err() {
        HistoryActionError::Core(e) => e,
        other => panic!("core error: {other:?}"),
    }
}
struct Setup {
    home: TempDir,
    _root: TempDir,
    registry: Registry,
}
impl Setup {
    fn new(session: &Session) -> Self {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        Store::open_registered(&dir(&home), id(1))
            .unwrap()
            .create(session)
            .unwrap();
        Self {
            home,
            _root: root,
            registry,
        }
    }
    fn service(&self) -> HistoryActionService<'_> {
        HistoryActionService::new(&self.registry)
    }
    /// A fresh handle on the same files, as after the app restarts.
    fn read(&self) -> Session {
        Store::open_registered(&dir(&self.home), id(1))
            .unwrap()
            .read(&id(2))
            .unwrap()
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(dir(&self.home).join(format!("sessions/{}.json", id(2).as_str()))).unwrap()
    }
}
fn dir(home: &TempDir) -> std::path::PathBuf {
    home.path().join(".ariadne/projects").join(id(1).as_str())
}

#[test]
fn native_ack_preserves_prose_records_owner_history_and_dispatches_nothing() {
    for target in [AckTarget::Decided, AckTarget::Done, AckTarget::Dropped] {
        let mut source = proposed(target);
        let key = ItemRef::new("1").unwrap();
        let item = source.items.0.get_mut(&key).unwrap();
        item.outcome = Some("Exact proposed outcome\nwith retained details.".into());
        item.why = Some("Exact proposed reason.".into());
        let setup = Setup::new(&source);
        let before = setup.read();
        let core = NativeCoreService::new(
            Registry::open(setup.home.path()).unwrap(),
            || id(301),
            at,
            |_| panic!("Ack does not contact a provider"),
        );
        let receipt = core.execute_owner(owner(), command(1)).unwrap();
        service::validate_owner_receipt(
            &OwnerMutationRequest {
                session: Some(SessionRef {
                    project_id: id(1),
                    session_id: id(2),
                }),
                command: command(1),
            },
            &receipt,
        )
        .unwrap();
        let saved = setup.read();
        let item = &saved.items.0[&key];
        assert_eq!(item.status, target.status());
        assert_eq!(item.ack_to, None);
        assert_eq!(item.outcome, before.items.0[&key].outcome);
        assert_eq!(item.why, before.items.0[&key].why);
        assert_eq!(item.revision, p(2));
        assert_eq!(saved.inputs, before.inputs);
        assert_eq!(saved.bindings, before.bindings);
        assert_eq!(saved.answers, before.answers);
        let message = saved.messages.last().unwrap();
        assert_eq!(message.author, MessageAuthor::Owner);
        assert_eq!(message.kind, MessageKind::Activity);
        assert_eq!(message.input_id, None);
        assert_eq!(message.binding_id, None);
        let history = item.status_history.last().unwrap();
        assert_eq!(history.old_status, ItemStatus::Open);
        assert_eq!(history.new_status, target.status());
        assert_eq!(history.cause_message_id, message.id);
        assert_eq!(history.binding_id, None);
        assert_eq!(core.execute_owner(owner(), command(1)).unwrap(), receipt);
        assert_eq!(
            setup.read(),
            saved,
            "retry replays without another Activity"
        );
    }
}

#[test]
fn defaults_keep_terminal_metadata_valid_and_in_progress_can_ack() {
    let mut source = proposed(AckTarget::Done);
    source
        .items
        .0
        .get_mut(&ItemRef::new("1").unwrap())
        .unwrap()
        .status = ItemStatus::InProgress;
    let setup = Setup::new(&source);
    setup
        .service()
        .acknowledge(&owner(), &command(1), at(), || id(301))
        .unwrap();
    let saved = setup.read();
    let item = &saved.items.0[&ItemRef::new("1").unwrap()];
    assert!(item
        .outcome
        .as_ref()
        .is_some_and(|text| !text.trim().is_empty()));
    assert!(item
        .why
        .as_ref()
        .is_some_and(|text| !text.trim().is_empty()));
}

#[test]
fn ack_refusals_are_atomic_and_stale_revision_reports_current_revision() {
    for case in [
        "missing_target",
        "waiting",
        "terminal",
        "unanswered_ask",
        "stale",
    ] {
        let mut source = proposed(AckTarget::Done);
        let item = source.items.0.get_mut(&ItemRef::new("1").unwrap()).unwrap();
        match case {
            "missing_target" => item.ack_to = None,
            "waiting" => {
                item.status = ItemStatus::WaitingOnMe;
                item.ask = Some("Please choose".into());
                item.waiting_since = Some(at());
                item.recipient_binding_id = Some(id(3));
            }
            "terminal" => {
                item.status = ItemStatus::Done;
                item.ack_to = None;
                item.outcome = Some("Complete".into());
                item.why = Some("Finished".into());
            }
            "unanswered_ask" => item.ask = Some("Please choose".into()),
            _ => {}
        }
        let setup = Setup::new(&source);
        let before = setup.bytes();
        let err = refused(setup.service().acknowledge(
            &owner(),
            &command(if case == "stale" { 9 } else { 1 }),
            at(),
            || panic!("guard precedes allocation"),
        ));
        assert_eq!(
            err.code,
            if case == "stale" {
                CoreErrorCode::RevisionConflict
            } else {
                CoreErrorCode::InvalidTransition
            }
        );
        if case == "stale" {
            assert_eq!(err.current_revision, Some(p(1)));
        }
        assert_eq!(setup.bytes(), before);
    }
}

#[test]
fn current_question_reply_suppresses_ask_guard_but_open_items_stay_out_of_waiting_queue() {
    let mut source = proposed(AckTarget::Done);
    let key = ItemRef::new("1").unwrap();
    let item = source.items.0.get_mut(&key).unwrap();
    item.ask = Some("Please choose".into());
    item.question_revision = p(2);
    item.current_round_id = Some(id(30));
    source.rounds.0.insert(
        id(30),
        Round {
            id: id(30),
            item_id: key.clone(),
            ordinal: p(1),
            opened_message_id: id(6),
            question_snapshot: item.question.clone(),
            ask_snapshot: item.ask.clone(),
            options_snapshot: item.options.clone(),
            question_revision: p(1),
            owner_message_ids: vec![],
            agent_message_ids: vec![],
            result_input_ids: vec![],
            fork_item_ids: vec![],
            closed_at: None,
            origin: None,
        },
    );
    assert!(
        source.answers.is_empty(),
        "no earlier answer can suppress the guard"
    );
    let setup = Setup::new(&source);
    let submit = OwnerCommand::InputSubmit {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(310),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: id(5),
                item_id: Some(key.clone()),
            },
            kind: InputKind::Reply,
            text: "Accepted.".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    let mut next = 320;
    ariadne_core::inputs::InputService::new(&setup.registry)
        .execute(
            &owner(),
            &submit,
            || {
                next += 1;
                id(next)
            },
            at(),
        )
        .unwrap();
    let before = setup.read();
    let reply = before.inputs.0.values().next().unwrap();
    assert_eq!(reply.payload.target_snapshot.question_revision, Some(p(2)));
    assert_eq!(before.rounds.0[&id(30)].question_revision, p(1));
    assert_eq!(before.messages.last().unwrap().round_id, Some(id(30)));
    assert!(before.answers.is_empty());
    assert!(!ariadne_core::queries::waiting_unanswered(
        &before,
        &before.items.0[&key]
    ));
    setup
        .service()
        .acknowledge(
            &owner(),
            &command(before.items.0[&key].revision.value()),
            at(),
            || id(301),
        )
        .unwrap();
    assert_eq!(
        setup.read().inputs,
        before.inputs,
        "Ack leaves the owner's reply delivery intact"
    );
}
#[test]
fn session_snapshot_and_bounded_item_read_expose_the_same_ack_proposal() {
    let source = proposed(AckTarget::Decided);
    let setup = Setup::new(&source);
    let context = QueryContext::owner(owner());
    let service = ariadne_core::queries::QueryService::new(&setup.registry);
    let QueryResult::SessionGet(snapshot) = service
        .query(&context, &QueryRequest::SessionGet {})
        .unwrap()
    else {
        panic!("snapshot")
    };
    assert_eq!(
        snapshot.session.items.0[&ItemRef::new("1").unwrap()].ack_to,
        Some(AckTarget::Decided)
    );
    let QueryResult::SessionRead(SessionReadResult::Items(page)) = service
        .query(
            &context,
            &QueryRequest::SessionRead(SessionReadRequest {
                selection: ReadView::Items {
                    topic_id: None,
                    item_id: Some(ItemRef::new("1").unwrap()),
                    parent_item_id: None,
                    statuses: vec![],
                    archived: None,
                },
                cursor: None,
                limit: PageLimit::new(10).unwrap(),
                item_pages: vec![],
            }),
        )
        .unwrap()
    else {
        panic!("items")
    };
    assert_eq!(page.items[0].item.ack_to, Some(AckTarget::Decided));
}

#[test]
fn legacy_open_ask_without_a_round_can_receive_a_reply_then_ack() {
    let mut source = proposed(AckTarget::Done);
    let key = ItemRef::new("1").unwrap();
    let item = source.items.0.get_mut(&key).unwrap();
    item.ask = Some("Please confirm the retained draft.".into());
    item.current_round_id = None;
    let setup = Setup::new(&source);
    let reply = OwnerCommand::InputSubmit {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(350),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: id(5),
                item_id: Some(key.clone()),
            },
            kind: InputKind::Reply,
            text: "Keep every word in the draft.".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    let mut next = 360;
    ariadne_core::inputs::InputService::new(&setup.registry)
        .execute(
            &owner(),
            &reply,
            || {
                next += 1;
                id(next)
            },
            at(),
        )
        .unwrap();
    let before = setup.read();
    assert_eq!(before.items.0[&key].status, ItemStatus::Open);
    let round = &before.rounds.0[before.items.0[&key].current_round_id.as_ref().unwrap()];
    assert_eq!(round.ask_snapshot, source.items.0[&key].ask);
    assert!(!round.owner_message_ids.is_empty());
    let input = before.inputs.0.values().next().unwrap();
    assert_eq!(input.payload.text, "Keep every word in the draft.");
    setup
        .service()
        .acknowledge(
            &owner(),
            &command(before.items.0[&key].revision.value()),
            at(),
            || id(301),
        )
        .unwrap();
    let after = setup.read();
    assert_eq!(after.items.0[&key].status, ItemStatus::Done);
    assert_eq!(
        after.inputs, before.inputs,
        "Ack preserves the queued reply and sends nothing new"
    );
}
