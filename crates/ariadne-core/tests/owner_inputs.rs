use ariadne_core::inputs::{InputError, InputService};
use ariadne_core::*;
use ariadne_domain::history::open_ask_round;
use ariadne_domain::models::*;
use ariadne_domain::transitions::{transition_item, ItemChange, TransitionContext};
use ariadne_store::registry::Registry;
use ariadne_store::session::{Store, StoreError};
use std::fs;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tempfile::TempDir;

/// Project store directory under a data-root home, as `Registry::project_dir` derives it.
fn store_dir(home: &std::path::Path, project: u64) -> std::path::PathBuf {
    home.join(".ariadne/projects").join(id(project).as_str())
}
fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn p(n: u64) -> PositiveSafeInteger {
    PositiveSafeInteger::new(n).unwrap()
}
fn item(n: &str) -> ItemRef {
    ItemRef::new(n).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn seed() -> Session {
    serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap()
}
fn route() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
    ))
}
fn submit(target: &str, kind: InputKind, op: u64) -> OwnerCommand {
    OwnerCommand::InputSubmit {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(op),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: seed().items.0[&item(target)].topic_id.clone(),
                item_id: Some(item(target)),
            },
            kind,
            text: "Complete owner text.\nPreserve exact trailing whitespace.  ".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    }
}
fn params(command: &mut OwnerCommand) -> &mut InputSubmitParams {
    let OwnerCommand::InputSubmit { params, .. } = command else {
        panic!("submit")
    };
    params
}
fn cancel(input_id: UuidV4, revision: u64, op: u64) -> OwnerCommand {
    cancel_for(input_id, revision, op, None)
}
fn cancel_for(
    input_id: UuidV4,
    revision: u64,
    op: u64,
    purpose: Option<CancelPurpose>,
) -> OwnerCommand {
    OwnerCommand::InputCancel {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(op),
        params: InputCancelParams {
            input_id,
            expected_revision: p(revision),
            purpose,
        },
    }
}
fn receipt(result: MutationReceipt) -> SavedReceipt {
    let MutationReceipt::Session(saved) = result else {
        panic!("session receipt")
    };
    *saved
}
fn input_id(saved: &SavedReceipt) -> UuidV4 {
    let SavedReceiptData::InputSubmit { input_id, .. } = &saved.data else {
        panic!("input receipt")
    };
    input_id.clone()
}
fn core_error(error: InputError) -> CoreError {
    let InputError::Core(error) = error else {
        panic!("expected core error: {error:?}")
    };
    error
}

struct Setup {
    home: TempDir,
    root: TempDir,
    registry: Registry,
    next: AtomicU64,
}
impl Setup {
    fn new(session: &Session) -> Self {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        Store::open_registered(&store_dir(home.path(), 1), id(1))
            .unwrap()
            .create(session)
            .unwrap();
        Self {
            home,
            root,
            registry,
            next: AtomicU64::new(1000),
        }
    }
    fn store(&self) -> Store {
        Store::open_registered(&store_dir(self.home.path(), 1), id(1)).unwrap()
    }
    fn saved(&self) -> Session {
        self.store().read(&id(2)).unwrap()
    }
    fn path(&self) -> std::path::PathBuf {
        store_dir(self.home.path(), 1).join(format!("sessions/{}.json", id(2).as_str()))
    }
    fn execute(&self, command: &OwnerCommand) -> Result<SavedReceipt, InputError> {
        InputService::new(&self.registry)
            .execute(
                &route(),
                command,
                || id(self.next.fetch_add(1, Ordering::Relaxed)),
                at(),
            )
            .map(receipt)
    }
    fn edit(&self, op: u64, update: impl FnOnce(&mut Session)) {
        self.store()
            .transact(
                &id(2),
                &ReceiptActorScope::Owner {},
                &id(op),
                &serde_json::json!({"test_update":op}),
                |session| {
                    update(session);
                    Ok::<_, ()>(SavedReceiptData::InputCancel {
                        input_id: id(999),
                        state: InputState::Cancelled,
                    })
                },
            )
            .unwrap();
    }
    fn rejected(&self, command: &OwnerCommand, code: CoreErrorCode) -> CoreError {
        let before = fs::read(self.path()).unwrap();
        let error = core_error(self.execute(command).unwrap_err());
        assert_eq!(error.code, code);
        assert_eq!(fs::read(self.path()).unwrap(), before);
        error
    }
}

fn asked() -> Session {
    let mut session = seed();
    let mut activity = session.messages[0].clone();
    activity.id = id(101);
    activity.number = session.counters.next_message;
    activity.created_at = at();
    activity.body = "Explicit agent Ask activity".into();
    activity.items_touched = vec![item("1")];
    session.counters.next_message = p(3);
    session.messages.push(activity);
    let candidate = transition_item(
        &session,
        &item("1"),
        &ItemChange::Ask {
            ask: "Choose exactly.\nKeep the full request.".into(),
            options: vec![ItemOption {
                id: "yes".into(),
                label: "Keep it".into(),
                consequence: "Full consequence.\nSecond line.".into(),
                recommended: true,
            }],
            recipient_binding_id: id(3),
            round_id: id(201),
        },
        &TransitionContext {
            binding_id: id(3),
            generation: id(4),
            cause_message_id: id(101),
            at: at(),
            handled_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
            expected_revision: p(1),
            expected_question_revision: None,
        },
    )
    .unwrap();
    open_ask_round(&session, candidate, &id(101), at()).unwrap()
}
fn answer(op: u64) -> OwnerCommand {
    let mut command = submit("1", InputKind::Answer, op);
    params(&mut command).expected_question_revision = Some(p(2));
    command
}

#[test]
fn submission_atomically_saves_full_history_frozen_context_fifo_and_receipt() {
    let setup = Setup::new(&seed());
    let before = setup.saved();
    let command = submit("1", InputKind::Bring, 10);
    let first = setup.execute(&command).unwrap();
    let second = setup.execute(&submit("2", InputKind::Reply, 11)).unwrap();
    let saved = setup.saved();
    assert_eq!(saved.revision, p(3));
    assert_eq!(saved.operation_receipts.0.len(), 2);
    assert_eq!(
        (saved.counters.next_input, saved.counters.next_message),
        (p(3), p(4))
    );
    assert_eq!(saved.counters.next_answer, p(1));
    for (receipt, target, sequence) in [(&first, "1", 1), (&second, "2", 2)] {
        let input = &saved.inputs.0[&input_id(receipt)];
        let message = saved
            .messages
            .iter()
            .find(|m| m.id == input.message_id)
            .unwrap();
        assert_eq!(input.seq, p(sequence));
        assert_eq!(input.state, InputState::Queued);
        assert_eq!(message.author, MessageAuthor::Owner);
        assert_eq!(message.kind, MessageKind::OwnerInput);
        assert_eq!(message.body, input.payload.text);
        assert!(message.body.ends_with("  "));
        assert_eq!(message.items_touched, vec![item(target)]);
        assert_eq!(input.payload.context.item_ids, vec![item(target)]);
        assert!(input.payload.context.message_ids.is_empty());
        assert!(input.payload.context.continuation_operation_id.is_none());
        assert_eq!(input.payload.context.round_id, message.round_id);
        assert_eq!(
            input.payload.target_snapshot.item_question.as_ref(),
            Some(&before.items.0[&item(target)].question)
        );
        assert_eq!(
            saved.items.0[&item(target)].status,
            before.items.0[&item(target)].status
        );
        assert_eq!(saved.items.0[&item(target)].revision, p(2));
    }
    let backup: Session = serde_json::from_slice(
        &fs::read(
            store_dir(setup.home.path(), 1)
                .join(format!("backups/{}.previous.json", id(2).as_str())),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(backup.revision, p(2));
    assert_eq!(backup.inputs.0.len(), 1);
}

#[test]
fn selected_option_answers_preserve_empty_and_whitespace_bytes_and_correction_chain() {
    let setup = Setup::new(&asked());
    let frozen = setup.saved().items.0[&item("1")].clone();
    let mut first_command = answer(10);
    params(&mut first_command).text.clear();
    params(&mut first_command).selected_option_id = Some("yes".into());
    let first = setup.execute(&first_command).unwrap();
    let first_answer = setup.saved().answers[0].id.clone();
    let mut correction = answer(11);
    params(&mut correction).text = " \n\t ".into();
    params(&mut correction).selected_option_id = Some("yes".into());
    params(&mut correction).supersedes_answer_id = Some(first_answer.clone());
    setup.execute(&correction).unwrap();
    let saved = setup.saved();
    assert_eq!(saved.answers.len(), 2);
    for (answer, exact) in saved.answers.iter().zip(["", " \n\t "]) {
        assert_eq!(answer.text, exact);
        assert_eq!(answer.question_snapshot, frozen.question);
        assert_eq!(answer.ask_snapshot, frozen.ask);
        assert_eq!(answer.options_snapshot, frozen.options);
        assert_eq!(answer.question_revision, frozen.question_revision);
        assert_eq!(saved.inputs.0[&answer.input_id].payload.text, exact);
        assert_eq!(
            saved
                .messages
                .iter()
                .find(|m| m.id == answer.message_id)
                .unwrap()
                .body,
            exact
        );
    }
    assert_eq!(saved.answers[1].supersedes_answer_id, Some(first_answer));
    assert_eq!(saved.items.0[&item("1")].status, ItemStatus::WaitingOnMe);
    assert_eq!(saved.items.0[&item("1")].question_revision, p(2));
    assert_eq!(saved.counters.next_answer, p(3));
    assert_eq!(setup.execute(&first_command).unwrap(), first);
    let stale = setup.rejected(&answer(12), CoreErrorCode::RevisionConflict);
    assert_eq!(stale.current_revision, Some(p(3)));
    assert!(stale.hint.contains("current eligible Answer"));
}

#[test]
fn stale_question_option_recipient_and_invalid_correction_leave_no_effects() {
    let setup = Setup::new(&asked());
    let mut stale = answer(10);
    params(&mut stale).expected_question_revision = Some(p(1));
    setup.rejected(&stale, CoreErrorCode::QuestionChanged);
    let mut invalid_option = answer(11);
    params(&mut invalid_option).selected_option_id = Some("not-a-choice".into());
    setup.rejected(&invalid_option, CoreErrorCode::InvalidArgument);
    let mut correction = answer(12);
    params(&mut correction).supersedes_answer_id = Some(id(88));
    setup.rejected(&correction, CoreErrorCode::RevisionConflict);
    setup.edit(80, |s| {
        let mut historical = s.bindings.0[&id(3)].clone();
        historical.id = id(90);
        historical.generation = id(91);
        s.bindings.0.insert(id(90), historical);
        s.items.0.get_mut(&item("1")).unwrap().recipient_binding_id = Some(id(90));
    });
    setup.rejected(&answer(13), CoreErrorCode::BindingMismatch);
}

#[test]
fn replay_precedes_closed_archived_binding_and_capacity_guards_and_allocation() {
    let setup = Setup::new(&seed());
    let command = submit("1", InputKind::Note, 10);
    let saved = setup.execute(&command).unwrap();
    setup.edit(80, |s| {
        s.state = SessionState::Closed;
        s.closed_at = Some(at());
        s.active_binding_id = None;
        s.topics.0.values_mut().next().unwrap().archived_at = Some(at());
    });
    let before = fs::read(setup.path()).unwrap();
    let replay = InputService::new(&setup.registry)
        .execute(
            &route(),
            &command,
            || panic!("replay must not allocate"),
            at(),
        )
        .unwrap();
    assert_eq!(receipt(replay), saved);
    assert_eq!(fs::read(setup.path()).unwrap(), before);
    let mut changed = command.clone();
    params(&mut changed).text.push('!');
    assert!(matches!(
        setup.execute(&changed),
        Err(InputError::Store(StoreError::OperationReused))
    ));
    let mut changed_kind = command;
    params(&mut changed_kind).kind = InputKind::Reply;
    assert!(matches!(
        setup.execute(&changed_kind),
        Err(InputError::Store(StoreError::OperationReused))
    ));
}

#[test]
fn terminal_intents_are_legal_and_never_apply_status_transitions() {
    for kind in [
        InputKind::Bring,
        InputKind::Reply,
        InputKind::Note,
        InputKind::Followup,
        InputKind::Reopen,
        InputKind::Drop,
    ] {
        let setup = Setup::new(&seed());
        let before = setup.saved().items.0[&item("2")].clone();
        setup.execute(&submit("2", kind, 10)).unwrap();
        let after = setup.saved().items.0[&item("2")].clone();
        assert_eq!(after.status, before.status);
        assert_eq!(after.outcome, before.outcome);
        assert_eq!(after.why, before.why);
        assert_eq!(after.status_history, before.status_history);
    }
}

#[test]
fn replaced_reopen_is_rejected_but_followup_retains_replacement_history() {
    let mut session = seed();
    let replacement = session.items.0.get_mut(&item("2")).unwrap();
    replacement.status = ItemStatus::Replaced;
    replacement.replaced_by = Some(item("1"));
    let setup = Setup::new(&session);
    setup.rejected(
        &submit("2", InputKind::Reopen, 10),
        CoreErrorCode::InvalidArgument,
    );
    setup
        .execute(&submit("2", InputKind::Followup, 11))
        .unwrap();
    assert_eq!(
        setup.saved().items.0[&item("2")].replaced_by,
        Some(item("1"))
    );
}

#[test]
fn paused_or_disconnected_bindings_still_save_without_delivery() {
    let mut session = seed();
    let binding = session.bindings.0.get_mut(&id(3)).unwrap();
    binding.owner_paused = true;
    binding.dispatch_state = DispatchState::Disconnected;
    binding.connection_state = ConnectionState::Disconnected;
    let setup = Setup::new(&session);
    setup.execute(&submit("1", InputKind::Note, 10)).unwrap();
    let saved = setup.saved();
    assert_eq!(saved.bindings, session.bindings);
    assert!(saved
        .inputs
        .0
        .values()
        .all(|i| i.state == InputState::Queued && i.attempts.is_empty()));
}

#[test]
fn owner_scope_target_binding_and_continue_guards_are_honest() {
    let setup = Setup::new(&seed());
    for scope in [
        OwnerScope::Registry,
        OwnerScope::Project(id(1)),
        OwnerScope::Preferences,
    ] {
        let result = InputService::new(&setup.registry).execute(
            &OwnerContext::from_trusted_entrypoint(scope),
            &submit("1", InputKind::Note, 10),
            || panic!("invalid scope"),
            at(),
        );
        assert_eq!(
            core_error(result.unwrap_err()).code,
            CoreErrorCode::PermissionDenied
        );
    }
    let mut command = submit("1", InputKind::Note, 10);
    params(&mut command).binding_id = id(90);
    setup.rejected(&command, CoreErrorCode::BindingMismatch);
    params(&mut command).binding_id = id(3);
    params(&mut command).target.item_id = Some(item("90"));
    setup.rejected(&command, CoreErrorCode::NotFound);
    params(&mut command).target.item_id = Some(item("1"));
    params(&mut command).target.topic_id = id(90);
    setup.rejected(&command, CoreErrorCode::InvalidArgument);
    let continuation = submit("1", InputKind::Continue, 11);
    assert!(setup
        .rejected(&continuation, CoreErrorCode::InvalidArgument)
        .message
        .contains("topic_continue"));
    let mut topic_only = submit("1", InputKind::Note, 12);
    params(&mut topic_only).target.item_id = None;
    setup.rejected(&topic_only, CoreErrorCode::InvalidArgument);
}

#[test]
fn cancellation_is_durable_preserves_every_historical_byte_and_replays_first() {
    let setup = Setup::new(&asked());
    let submitted = setup.execute(&answer(10)).unwrap();
    let before = setup.saved();
    let command = cancel(input_id(&submitted), before.revision.value(), 11);
    let cancelled = setup.execute(&command).unwrap();
    let after = setup.saved();
    assert_eq!(after.revision, p(before.revision.value() + 1));
    assert_eq!(after.messages, before.messages);
    assert_eq!(after.answers, before.answers);
    assert_eq!(after.items, before.items);
    assert_eq!(after.rounds, before.rounds);
    assert_eq!(after.counters, before.counters);
    let mut expected_input = before.inputs.0[&input_id(&submitted)].clone();
    expected_input.state = InputState::Cancelled;
    expected_input.cancel_cause = Some(CancelCause::Owner);
    assert_eq!(after.inputs.0[&expected_input.id], expected_input);
    assert!(expected_input.resolution_history.is_empty());
    assert!(matches!(
        cancelled.data,
        SavedReceiptData::InputCancel {
            state: InputState::Cancelled,
            ..
        }
    ));
    assert_eq!(setup.execute(&command).unwrap(), cancelled);
    assert_eq!(setup.saved(), after);
    setup.rejected(
        &cancel(expected_input.id.clone(), after.revision.value(), 12),
        CoreErrorCode::InvalidTransition,
    );
    let mut changed = command;
    if let OwnerCommand::InputCancel { params, .. } = &mut changed {
        params.expected_revision = after.revision;
    }
    assert!(matches!(
        setup.execute(&changed),
        Err(InputError::Store(StoreError::OperationReused))
    ));
}

#[test]
fn cancellation_of_work_past_the_queue_requires_current_session_revision_and_an_existing_input() {
    let setup = Setup::new(&seed());
    let saved = setup.execute(&submit("1", InputKind::Note, 10)).unwrap();
    let id_ = input_id(&saved);
    // Handed to the agent (the claim bumped the revision): the reviewed revision must match.
    setup.edit(80, |s| {
        s.inputs.0.get_mut(&id_).unwrap().state = InputState::InFlight
    });
    let error = setup.rejected(&cancel(id_.clone(), 2, 11), CoreErrorCode::RevisionConflict);
    assert_eq!(error.current_revision, Some(p(3)));
    assert_eq!(setup.saved().inputs.0[&id_].state, InputState::InFlight);
    setup.rejected(&cancel(id(999), 3, 12), CoreErrorCode::NotFound);
    // The same holds for one that needs attention.
    setup.edit(81, |s| {
        s.inputs.0.get_mut(&id_).unwrap().state = InputState::NeedsAttention
    });
    setup.rejected(&cancel(id_, 3, 13), CoreErrorCode::RevisionConflict);
}

#[test]
fn a_queued_input_cancels_after_unrelated_session_changes() {
    let setup = Setup::new(&seed());
    let saved = setup.execute(&submit("1", InputKind::Note, 10)).unwrap();
    let queued = input_id(&saved);
    // Revision 2 was reviewed; an agent report and another submit moved the session on.
    setup.edit(80, |_| {});
    setup.execute(&submit("1", InputKind::Note, 12)).unwrap();
    assert_eq!(setup.saved().revision, p(4));
    let receipt = setup.execute(&cancel(queued.clone(), 2, 11)).unwrap();
    assert!(matches!(
        receipt.data,
        SavedReceiptData::InputCancel {
            state: InputState::Cancelled,
            ..
        }
    ));
    let input = &setup.saved().inputs.0[&queued];
    assert_eq!(input.state, InputState::Cancelled);
    assert_eq!(input.cancel_cause, Some(CancelCause::Owner));
}

#[test]
fn a_requeued_input_with_attempt_history_cancels_after_unrelated_changes() {
    let setup = Setup::new(&seed());
    let saved = setup.execute(&submit("1", InputKind::Note, 10)).unwrap();
    let requeued = input_id(&saved);
    // A first attempt was sealed (a resend put the input back in the queue): still queued.
    setup.edit(80, |s| {
        let input = s.inputs.0.get_mut(&requeued).unwrap();
        let mut attempt = prepared_attempt(&requeued);
        attempt.sealed_at = Some(at());
        input.attempts.push(attempt);
        input.state = InputState::Queued;
    });
    setup.edit(81, |_| {});
    // Revision 2 was reviewed; the session is at 4.
    setup.execute(&cancel(requeued.clone(), 2, 11)).unwrap();
    let saved = setup.saved();
    let input = &saved.inputs.0[&requeued];
    assert_eq!(input.state, InputState::Cancelled);
    assert_eq!(input.cancel_cause, Some(CancelCause::Owner));
    assert_eq!(input.attempts.len(), 1);
}

#[test]
fn the_cancel_purpose_maps_to_its_cause_and_defaults_to_delete() {
    assert_eq!(CancelPurpose::Delete.cause(), CancelCause::Owner);
    assert_eq!(CancelPurpose::Edit.cause(), CancelCause::OwnerEdit);
    for (op, purpose, cause) in [
        (10, None, CancelCause::Owner),
        (20, Some(CancelPurpose::Delete), CancelCause::Owner),
        (30, Some(CancelPurpose::Edit), CancelCause::OwnerEdit),
    ] {
        let setup = Setup::new(&seed());
        let queued = input_id(&setup.execute(&submit("1", InputKind::Note, op)).unwrap());
        // A queued input skips the revision guard whatever the purpose.
        setup.edit(80, |_| {});
        setup
            .execute(&cancel_for(queued.clone(), 2, op + 1, purpose))
            .unwrap();
        let input = &setup.saved().inputs.0[&queued];
        assert_eq!(input.state, InputState::Cancelled, "{purpose:?}");
        assert_eq!(input.cancel_cause, Some(cause), "{purpose:?}");
    }
    // The wire: absent and "delete" mean delete; "edit" is the take-back.
    let wire = |purpose: serde_json::Value| {
        let mut params = serde_json::json!({ "input_id": id(5), "expected_revision": 2 });
        if !purpose.is_null() {
            params["purpose"] = purpose;
        }
        serde_json::from_value::<InputCancelParams>(params)
            .unwrap()
            .purpose
    };
    assert_eq!(wire(serde_json::Value::Null), None);
    assert_eq!(wire("delete".into()), Some(CancelPurpose::Delete));
    assert_eq!(wire("edit".into()), Some(CancelPurpose::Edit));
    let plain = serde_json::to_value(match cancel(id(5), 2, 1) {
        OwnerCommand::InputCancel { params, .. } => params,
        _ => unreachable!(),
    })
    .unwrap();
    assert!(plain.get("purpose").is_none());
}

#[test]
fn edit_takes_back_only_a_queued_input() {
    let setup = Setup::new(&seed());
    let saved = setup.execute(&submit("1", InputKind::Note, 10)).unwrap();
    let id_ = input_id(&saved);
    // A claim won the race: the message is on its way, and the owner's revision is current.
    setup.edit(80, |s| {
        s.inputs.0.get_mut(&id_).unwrap().state = InputState::InFlight
    });
    let current = setup.saved().revision.value();
    setup.rejected(
        &cancel_for(id_.clone(), current, 11, Some(CancelPurpose::Edit)),
        CoreErrorCode::InvalidTransition,
    );
    assert_eq!(setup.saved().inputs.0[&id_].state, InputState::InFlight);
    assert_eq!(setup.saved().inputs.0[&id_].cancel_cause, None);
    // Delete still cancels it.
    setup.execute(&cancel(id_.clone(), current, 12)).unwrap();
    assert_eq!(
        setup.saved().inputs.0[&id_].cancel_cause,
        Some(CancelCause::Owner)
    );
    // An already cancelled one is refused for edit too.
    setup.rejected(
        &cancel_for(id_, current + 1, 13, Some(CancelPurpose::Edit)),
        CoreErrorCode::InvalidTransition,
    );
}

#[test]
fn an_edit_cancel_replays_and_a_changed_purpose_is_another_operation() {
    let setup = Setup::new(&seed());
    let queued = input_id(&setup.execute(&submit("1", InputKind::Note, 10)).unwrap());
    let command = cancel_for(queued.clone(), 2, 11, Some(CancelPurpose::Edit));
    let first = setup.execute(&command).unwrap();
    assert_eq!(setup.execute(&command).unwrap(), first);
    assert!(matches!(
        setup.execute(&cancel_for(queued, 2, 11, None)),
        Err(InputError::Store(StoreError::OperationReused))
    ));
}

#[test]
fn capacity_replay_and_cancelled_slots_do_not_lose_saved_inputs() {
    let setup = Setup::new(&seed());
    let first_command = submit("1", InputKind::Note, 2000);
    let first = setup.execute(&first_command).unwrap();
    for op in 2001..2100 {
        setup.execute(&submit("1", InputKind::Note, op)).unwrap();
    }
    assert_eq!(setup.saved().inputs.0.len(), 100);
    setup.rejected(
        &submit("1", InputKind::Note, 2100),
        CoreErrorCode::QueueFull,
    );
    assert_eq!(setup.execute(&first_command).unwrap(), first);
    setup.execute(&cancel(input_id(&first), 101, 2101)).unwrap();
    setup.execute(&submit("1", InputKind::Note, 2102)).unwrap();
    assert_eq!(setup.saved().inputs.0.len(), 101);
    assert_eq!(setup.saved().counters.next_input, p(102));
}

fn prepared_attempt(input_id: &UuidV4) -> Attempt {
    use sha2::{Digest, Sha256 as Hasher};
    let marker = format!("[ARIADNE_INPUT:{}:{}]", input_id.as_str(), id(900).as_str());
    let payload = format!("{marker}\nExact immutable prepared payload");
    Attempt {
        id: id(900),
        purpose: AttemptPurpose::Work,
        repair_for_attempt_id: None,
        claim_request_id: id(901),
        binding_generation: id(4),
        prepared_at: at(),
        payload_sha256: Sha256::new(format!("{:x}", Hasher::digest(payload.as_bytes()))).unwrap(),
        formatted_payload: payload,
        wire_marker: marker,
        acceptance: AcceptanceState::Prepared,
        acceptance_receipt: None,
        acceptance_observed_at: None,
        host_turn_id: None,
        turn_state: TurnState::Unknown,
        turn_observed_at: None,
        domain_result: None,
        result_state: ResultState::Pending,
        sealed_at: None,
        error: None,
        reconciliation_checkpoint: None,
    }
}
#[test]
fn cancellation_abandons_pending_work_and_refuses_only_settled_inputs() {
    // Owner rule: cancel works for queued, in-flight and needs-attention
    // inputs, abandoning any attempt; settled inputs stay as they are.
    for case in 0..7 {
        let setup = Setup::new(&seed());
        let saved = setup.execute(&submit("1", InputKind::Note, 10)).unwrap();
        let input_id = input_id(&saved);
        setup.edit(80, |s| {
            let input = s.inputs.0.get_mut(&input_id).unwrap();
            match case {
                0 => input.attempts.push(prepared_attempt(&input_id)),
                1 => {
                    input.attempts.push(prepared_attempt(&input_id));
                    input.active_attempt_id = Some(id(900));
                }
                2 => input.state = InputState::InFlight,
                3 => input.state = InputState::Handled,
                4 => input.state = InputState::NeedsAttention,
                5 => input.state = InputState::Skipped,
                6 => input.state = InputState::Cancelled,
                _ => unreachable!(),
            }
        });
        if matches!(case, 3 | 5 | 6) {
            setup.rejected(&cancel(input_id, 3, 11), CoreErrorCode::InvalidTransition);
            continue;
        }
        let receipt = setup.execute(&cancel(input_id.clone(), 3, 11)).unwrap();
        assert!(matches!(
            receipt.data,
            SavedReceiptData::InputCancel {
                state: InputState::Cancelled,
                ..
            }
        ));
        let saved = setup.saved();
        let input = &saved.inputs.0[&input_id];
        assert_eq!(input.state, InputState::Cancelled, "case {case}");
        assert!(input.active_attempt_id.is_none());
        assert!(input.attempts.iter().all(|a| a.sealed_at.is_some()));
        assert_eq!(saved.bindings.0[&id(3)].active_input_id, None);
    }
}

#[test]
fn closed_archived_and_nonwaiting_answer_guards_preserve_existing_bytes() {
    let setup = Setup::new(&seed());
    // An item the agent never asked is not a stale revision: distinct message.
    let not_asked = setup.rejected(&answer(10), CoreErrorCode::InvalidArgument);
    assert_eq!(
        not_asked.message,
        "The question is not waiting on you; the agent has not asked it yet."
    );
    // A stale answer to an item that was asked and then decided stays `question_changed`.
    let decided = Setup::new(&seed());
    decided.edit(80, |s| {
        let item = s.items.0.get_mut(&item("1")).unwrap();
        item.status = ItemStatus::Decided;
        item.outcome = Some("Decided.".into());
        item.why = Some("Because.".into());
    });
    decided.rejected(&answer(13), CoreErrorCode::QuestionChanged);
    setup.edit(80, |s| {
        s.state = SessionState::Closed;
        s.closed_at = Some(at());
    });
    setup.rejected(
        &submit("1", InputKind::Note, 11),
        CoreErrorCode::InvalidTransition,
    );
    let setup = Setup::new(&seed());
    setup.edit(80, |s| {
        s.topics.0.values_mut().next().unwrap().archived_at = Some(at())
    });
    setup.rejected(
        &submit("1", InputKind::Note, 12),
        CoreErrorCode::InvalidTransition,
    );
}

#[test]
fn generic_input_reuses_open_round_and_allocates_fresh_after_closed_round() {
    let setup = Setup::new(&asked());
    setup.execute(&submit("1", InputKind::Note, 10)).unwrap();
    assert_eq!(setup.saved().rounds.0.len(), 1);
    let setup = Setup::new(&seed());
    setup.execute(&submit("1", InputKind::Note, 10)).unwrap();
    let first_round = setup.saved().items.0[&item("1")]
        .current_round_id
        .clone()
        .unwrap();
    setup.edit(80, |s| {
        s.rounds.0.get_mut(&first_round).unwrap().closed_at = Some(at())
    });
    setup.execute(&submit("1", InputKind::Note, 11)).unwrap();
    let saved = setup.saved();
    assert_eq!(saved.rounds.0.len(), 2);
    assert_ne!(
        saved.items.0[&item("1")].current_round_id.as_ref(),
        Some(&first_round)
    );
    assert_eq!(saved.rounds.0[&first_round].closed_at, Some(at()));
}

#[test]
fn replay_is_owner_and_session_scoped_without_a_global_operation_namespace() {
    let setup = Setup::new(&seed());
    let command = submit("1", InputKind::Note, 10);
    let first = setup.execute(&command).unwrap();
    let mut another = seed();
    another.id = id(20);
    setup.store().create(&another).unwrap();
    let context = OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(1), id(20)),
    ));
    let mut next = 5000;
    let second = receipt(
        InputService::new(&setup.registry)
            .execute(
                &context,
                &command,
                || {
                    next += 1;
                    id(next)
                },
                at(),
            )
            .unwrap(),
    );
    assert_ne!(first, second);
    assert_eq!(setup.store().read(&id(20)).unwrap().inputs.0.len(), 1);
    assert_eq!(setup.saved().inputs.0.len(), 1);
    let bad_route = OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(77), id(2)),
    ));
    assert!(matches!(
        InputService::new(&setup.registry).execute(
            &bad_route,
            &command,
            || panic!("unregistered route"),
            at()
        ),
        Err(InputError::Registry(_))
    ));
}

#[test]
fn future_or_invalid_snapshot_is_never_overwritten_by_owner_submission() {
    let setup = Setup::new(&seed());
    let mut value = serde_json::to_value(seed()).unwrap();
    value["schema_version"] = serde_json::json!(2);
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::write(setup.path(), &bytes).unwrap();
    assert!(matches!(
        setup.execute(&submit("1", InputKind::Note, 10)),
        Err(InputError::Store(StoreError::FutureSchema))
    ));
    assert_eq!(fs::read(setup.path()).unwrap(), bytes);
    fs::write(setup.path(), b"{invalid").unwrap();
    assert!(matches!(
        setup.execute(&submit("1", InputKind::Note, 10)),
        Err(InputError::Store(StoreError::InvalidSnapshot))
    ));
    assert_eq!(fs::read(setup.path()).unwrap(), b"{invalid");
}

#[test]
fn nonanswer_optional_question_guard_and_correction_kind_are_not_silently_ignored() {
    let setup = Setup::new(&asked());
    let mut command = submit("1", InputKind::Note, 10);
    params(&mut command).expected_question_revision = Some(p(1));
    setup.rejected(&command, CoreErrorCode::QuestionChanged);
    params(&mut command).expected_question_revision = Some(p(2));
    params(&mut command).supersedes_answer_id = Some(id(500));
    setup.rejected(&command, CoreErrorCode::InvalidArgument);
    params(&mut command).supersedes_answer_id = None;
    let saved = setup.execute(&command).unwrap();
    assert_eq!(
        setup.saved().inputs.0[&input_id(&saved)].expected_question_revision,
        Some(p(2))
    );
}

#[test]
fn later_live_question_edits_keep_original_payload_and_exact_replay() {
    let setup = Setup::new(&seed());
    let mut command = submit("1", InputKind::Note, 10);
    params(&mut command).expected_question_revision = Some(p(1));
    let saved = setup.execute(&command).unwrap();
    let frozen = setup.saved().inputs.0[&input_id(&saved)].payload.clone();
    setup.edit(80, |session| {
        let target = session.items.0.get_mut(&item("1")).unwrap();
        target.question = "Later live question with different text".into();
        target.question_revision = p(2);
    });
    assert_eq!(setup.saved().inputs.0[&input_id(&saved)].payload, frozen);
    assert_eq!(setup.execute(&command).unwrap(), saved);
    let mut new_command = submit("1", InputKind::Note, 11);
    params(&mut new_command).expected_question_revision = Some(p(1));
    setup.rejected(&new_command, CoreErrorCode::QuestionChanged);
}

#[test]
fn invalid_text_allocator_and_counter_overflow_never_publish_partial_history() {
    let setup = Setup::new(&seed());
    for text in [
        " \n ".to_owned(),
        "x".repeat(16 * 1024 + 1),
        "a\0b".to_owned(),
    ] {
        let mut command = submit("1", InputKind::Note, 10);
        params(&mut command).text = text;
        setup.rejected(&command, CoreErrorCode::InvalidArgument);
    }
    let before = fs::read(setup.path()).unwrap();
    let error = InputService::new(&setup.registry)
        .execute(&route(), &submit("1", InputKind::Note, 10), || id(6), at())
        .unwrap_err();
    assert_eq!(core_error(error).code, CoreErrorCode::InvalidArgument);
    assert_eq!(fs::read(setup.path()).unwrap(), before);
    let mut limit = seed();
    limit.counters.next_input = p(9_007_199_254_740_991);
    let setup = Setup::new(&limit);
    setup.rejected(
        &submit("1", InputKind::Note, 10),
        CoreErrorCode::CapacityExceeded,
    );
}

#[test]
fn message_answer_and_item_counter_failures_leave_no_partial_input_or_receipt() {
    for case in 0..3 {
        let mut session = asked();
        let limit = p(9_007_199_254_740_991);
        match case {
            0 => session.counters.next_message = limit,
            1 => session.counters.next_answer = limit,
            2 => session.items.0.get_mut(&item("1")).unwrap().revision = limit,
            _ => unreachable!(),
        }
        let setup = Setup::new(&session);
        setup.rejected(&answer(10), CoreErrorCode::CapacityExceeded);
        assert!(setup.saved().inputs.0.is_empty());
        assert!(setup.saved().operation_receipts.0.is_empty());
    }
}

#[test]
fn nongeneric_answer_fields_and_missing_required_question_guard_fail_atomically() {
    let setup = Setup::new(&asked());
    let mut missing_question = answer(10);
    params(&mut missing_question).expected_question_revision = None;
    setup.rejected(&missing_question, CoreErrorCode::QuestionChanged);
    let mut blank = answer(11);
    params(&mut blank).text = " \n ".into();
    setup.rejected(&blank, CoreErrorCode::InvalidArgument);
    let mut option_on_note = submit("1", InputKind::Note, 12);
    params(&mut option_on_note).selected_option_id = Some("yes".into());
    setup.rejected(&option_on_note, CoreErrorCode::InvalidArgument);
}

#[test]
fn writer_worker() {
    let Ok(home) = std::env::var("ARIADNE_OWNER_TEST_HOME") else {
        return;
    };
    let root = std::env::var("ARIADNE_OWNER_TEST_ROOT").unwrap();
    let worker: u64 = std::env::var("ARIADNE_OWNER_TEST_WORKER")
        .unwrap()
        .parse()
        .unwrap();
    let same = std::env::var("ARIADNE_OWNER_TEST_SAME").unwrap() == "true";
    let registry = Registry::open(std::path::Path::new(&home)).unwrap();
    fs::write(
        std::path::Path::new(&root).join(format!("ready-{worker}")),
        b"ready",
    )
    .unwrap();
    wait_for(&std::path::Path::new(&root).join("go"));
    let mut next = worker * 10000;
    let command = submit("1", InputKind::Note, if same { 10 } else { 10 + worker });
    let saved = receipt(
        InputService::new(&registry)
            .execute(
                &route(),
                &command,
                || {
                    next += 1;
                    id(next)
                },
                at(),
            )
            .unwrap(),
    );
    fs::write(
        std::path::Path::new(&root).join(format!("saved-{worker}")),
        serde_json::to_vec(&saved).unwrap(),
    )
    .unwrap();
}
fn wait_for(path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "worker coordination timeout: {path:?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn writer(setup: &Setup, worker: u64, same: bool) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "writer_worker", "--nocapture"])
        .env("ARIADNE_OWNER_TEST_HOME", setup.home.path())
        .env("ARIADNE_OWNER_TEST_ROOT", setup.root.path())
        .env("ARIADNE_OWNER_TEST_WORKER", worker.to_string())
        .env("ARIADNE_OWNER_TEST_SAME", same.to_string())
        .spawn()
        .unwrap()
}
fn concurrent(same: bool) -> (Session, SavedReceipt, SavedReceipt) {
    let setup = Setup::new(&seed());
    let mut first = writer(&setup, 1, same);
    let mut second = writer(&setup, 2, same);
    for worker in 1..=2 {
        wait_for(&setup.root.path().join(format!("ready-{worker}")));
    }
    fs::write(setup.root.path().join("go"), b"go").unwrap();
    assert!(first.wait().unwrap().success());
    assert!(second.wait().unwrap().success());
    let read = |worker| {
        serde_json::from_slice(
            &fs::read(setup.root.path().join(format!("saved-{worker}"))).unwrap(),
        )
        .unwrap()
    };
    (setup.saved(), read(1), read(2))
}
#[test]
fn separate_process_submissions_preserve_both_full_records_and_fifo_counters() {
    let (saved, first, second) = concurrent(false);
    assert_ne!(first, second);
    assert_eq!(saved.revision, p(3));
    assert_eq!(saved.inputs.0.len(), 2);
    assert_eq!(saved.messages.len(), 3);
    assert_eq!(saved.operation_receipts.0.len(), 2);
    assert_eq!(
        (saved.counters.next_input, saved.counters.next_message),
        (p(3), p(4))
    );
    assert_eq!(saved.items.0[&item("1")].revision, p(3));
    let mut sequences: Vec<_> = saved.inputs.0.values().map(|i| i.seq).collect();
    sequences.sort();
    assert_eq!(sequences, vec![p(1), p(2)]);
}
#[test]
fn separate_process_same_operation_returns_one_identical_durable_submission() {
    let (saved, first, second) = concurrent(true);
    assert_eq!(first, second);
    assert_eq!(saved.revision, p(2));
    assert_eq!(saved.inputs.0.len(), 1);
    assert_eq!(saved.messages.len(), 2);
    assert_eq!(saved.operation_receipts.0.len(), 1);
}
