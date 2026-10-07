use ariadne_core::{
    apply::{ApplyError, ApplyService},
    inputs::InputService,
    *,
};
use ariadne_domain::models::*;
use ariadne_store::{
    registry::Registry,
    session::{Store, StoreError},
};
use sha2::{Digest, Sha256 as Hasher};
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
};
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
fn existing(n: &str) -> EntityRef {
    EntityRef::Existing(ExistingRef { id: item(n) })
}
fn local(n: &str) -> EntityRef {
    EntityRef::Local(LocalRef {
        r#ref: RequestRef::new(n).unwrap(),
    })
}
fn uuid(n: u64) -> UuidRef {
    UuidRef::Existing(ExistingUuidRef { id: id(n) })
}
fn uuid_local(n: &str) -> UuidRef {
    UuidRef::Local(LocalRef {
        r#ref: RequestRef::new(n).unwrap(),
    })
}
fn request(op: u64) -> ApplyRequest {
    ApplyRequest {
        op_id: id(op),
        source_input_id: None,
        attempt_id: None,
        expected_item_revisions: UniqueMap(Default::default()),
        expected_topic_revisions: UniqueMap(Default::default()),
        summary: String::new(),
        operations: vec![],
        input_result: None,
    }
}
fn guarded(op: u64, target: &str, revision: u64) -> ApplyRequest {
    let mut r = request(op);
    r.expected_item_revisions
        .0
        .insert(item(target), p(revision));
    r
}
fn reply(target: EntityRef, name: &str, text: &str) -> Operation {
    Operation::Reply {
        r#ref: RequestRef::new(name).unwrap(),
        item: target,
        text: text.into(),
        round_id: None,
    }
}
fn add(name: &str, topic: UuidRef, parent: Option<EntityRef>, waiting: bool) -> Operation {
    Operation::ItemAdd(Box::new(ItemAddOperation {
        r#ref: RequestRef::new(name).unwrap(),
        topic,
        parent,
        question: "Complete new question?".into(),
        short: None,
        item_type: ItemType::Question,
        status: if waiting {
            ItemStatus::WaitingOnMe
        } else {
            ItemStatus::Open
        },
        owner: if waiting {
            ItemOwner::Me {}
        } else {
            ItemOwner::Agent { binding_id: id(3) }
        },
        ask: waiting.then(|| "Choose deliberately.".into()),
        options: Some(vec![]),
        note: None,
        links: None,
        outcome: None,
        why: None,
        replaced_by: None,
        source_round_id: None,
    }))
}
fn result() -> ResultDraft {
    ResultDraft {
        outcome: ResultOutcome::Answered,
        explanation: "Published the complete response.".into(),
        reply_refs: vec![uuid_local("response")],
        followup_item_refs: vec![],
        handled_through_message_number: p(2),
    }
}
fn core_error(error: ApplyError) -> CoreError {
    match error {
        ApplyError::Core(e) => e,
        other => panic!("Core error expected: {other:?}"),
    }
}
struct Setup {
    _home: TempDir,
    _root: TempDir,
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
            _home: home,
            _root: root,
            registry,
            next: AtomicU64::new(10000),
        }
    }
    fn store(&self) -> Store {
        Store::open_registered(&store_dir(self._home.path(), 1), id(1)).unwrap()
    }
    fn saved(&self) -> Session {
        self.store().read(&id(2)).unwrap()
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(
            store_dir(self._home.path(), 1)
                .join("sessions")
                .join(format!("{}.json", id(2).as_str())),
        )
        .unwrap()
    }
    fn context(&self, source: Option<&UuidV4>) -> AgentContext {
        let session = self.saved();
        let binding = &session.bindings.0[&id(3)];
        let scope = if let Some(input) = source {
            AgentReadScope::Dispatched {
                source_input_id: input.clone(),
                attempt_id: id(800),
                issued_through_message_number: binding.issued_through_message_number,
            }
        } else {
            AgentReadScope::Terminal {
                issued_through_message_number: binding.issued_through_message_number,
            }
        };
        AgentContext::from_trusted_entrypoint(
            RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
            id(3),
            binding.generation.clone(),
            scope,
        )
    }
    fn execute(&self, r: &ApplyRequest) -> Result<SavedReceipt, ApplyError> {
        ApplyService::new(&self.registry).execute(
            &self.context(r.source_input_id.as_ref()),
            r,
            || id(self.next.fetch_add(1, Ordering::SeqCst)),
            at(),
        )
    }
    fn rejected(&self, r: &ApplyRequest, code: CoreErrorCode) {
        let before = self.bytes();
        let e = core_error(self.execute(r).unwrap_err());
        assert_eq!(e.code, code, "{e:?}");
        assert_eq!(self.bytes(), before);
    }
    fn write(&self, op: u64, work: impl FnOnce(&mut Session)) {
        self.store()
            .transact(
                &id(2),
                &ReceiptActorScope::Adapter { binding_id: id(3) },
                &id(op),
                &serde_json::json!({"test":op}),
                |s| {
                    work(s);
                    Ok::<_, ()>(SavedReceiptData::Event {
                        event_id: format!("test:{op}"),
                        input_id: None,
                        attempt_id: None,
                        durable_effect: true,
                    })
                },
            )
            .unwrap();
    }
    fn prepare(&self, turn: TurnState) -> UuidV4 {
        let command = OwnerCommand::InputSubmit {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(700),
            params: InputSubmitParams {
                binding_id: id(3),
                target: InputTarget {
                    topic_id: id(5),
                    item_id: Some(item("1")),
                },
                kind: InputKind::Reply,
                text: "Original immutable owner message.".into(),
                selected_option_id: None,
                expected_question_revision: None,
                supersedes_answer_id: None,
            },
        };
        let receipt = InputService::new(&self.registry)
            .execute(
                &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
                    RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
                )),
                &command,
                || id(self.next.fetch_add(1, Ordering::SeqCst)),
                at(),
            )
            .unwrap();
        let MutationReceipt::Session(receipt) = receipt else {
            panic!("session")
        };
        let SavedReceiptData::InputSubmit { input_id, .. } = &receipt.data else {
            panic!("input")
        };
        let input_id = input_id.clone();
        self.write(701, |s| {
            let input = s.inputs.0.get_mut(&input_id).unwrap();
            let marker = format!("[ARIADNE_INPUT:{}:{}]", input_id.as_str(), id(800).as_str());
            let payload = format!("{marker}\nOriginal immutable owner message.\n");
            input.state = InputState::InFlight;
            input.active_attempt_id = Some(id(800));
            input.attempts.push(Attempt {
                id: id(800),
                purpose: AttemptPurpose::Work,
                repair_for_attempt_id: None,
                claim_request_id: id(801),
                binding_generation: id(4),
                prepared_at: at(),
                payload_sha256: Sha256::new(format!("{:x}", Hasher::digest(payload.as_bytes())))
                    .unwrap(),
                formatted_payload: payload,
                wire_marker: marker,
                acceptance: AcceptanceState::Accepted,
                acceptance_receipt: None,
                acceptance_observed_at: Some(at()),
                host_turn_id: Some("actual-host-turn".into()),
                turn_state: turn,
                turn_observed_at: Some(at()),
                domain_result: None,
                result_state: ResultState::Pending,
                sealed_at: None,
                error: None,
                reconciliation_checkpoint: None,
            });
            let binding = s.bindings.0.get_mut(&id(3)).unwrap();
            binding.active_input_id = Some(input_id.clone());
            binding.issued_through_message_number = NonnegativeSafeInteger::new(2).unwrap();
        });
        input_id
    }
    fn dispatched(&self, op: u64, source: &UuidV4) -> ApplyRequest {
        let mut r = guarded(op, "1", self.saved().items.0[&item("1")].revision.value());
        r.source_input_id = Some(source.clone());
        r.attempt_id = Some(id(800));
        r.operations.push(reply(
            existing("1"),
            "response",
            "Exact full reply.\nWith trailing spaces.  ",
        ));
        r.input_result = Some(result());
        r
    }
}

#[test]
fn ordered_local_topics_children_and_replies_commit_one_batch_activity() {
    let setup = Setup::new(&seed());
    let mut r = request(10);
    r.summary = "Exact batch summary.  \n".into();
    r.operations = vec![
        Operation::TopicAdd {
            r#ref: RequestRef::new("topic").unwrap(),
            name: "New topic".into(),
            short: None,
        },
        add("parent", uuid_local("topic"), None, false),
        add("child", uuid_local("topic"), Some(local("parent")), true),
        reply(local("child"), "reply", "Complete child reply.  \n"),
    ];
    let receipt = setup.execute(&r).unwrap();
    let s = setup.saved();
    assert_eq!(s.revision, p(2));
    assert_eq!(s.messages.len(), 3);
    assert_eq!(s.messages[1].body, r.summary);
    assert_eq!(s.messages[1].kind, MessageKind::Activity);
    assert_eq!(s.messages[2].body, "Complete child reply.  \n");
    assert_eq!(s.messages[2].item_id, Some(item("3.1")));
    let round = &s.rounds.0[s.items.0[&item("3.1")].current_round_id.as_ref().unwrap()];
    assert_eq!(round.ordinal, p(1));
    assert_eq!(round.question_revision, p(1));
    assert_eq!(round.agent_message_ids, vec![s.messages[2].id.clone()]);
    assert_eq!(s.items.0[&item("3")].next_child, p(2));
    assert_eq!(s.items.0[&item("3")].revision, p(2));
    let SavedReceiptData::Apply {
        allocated_refs,
        messages,
        ..
    } = receipt.data
    else {
        panic!("apply")
    };
    assert_eq!(allocated_refs.0.len(), 4);
    assert_eq!(messages.len(), 2);
}
#[test]
fn original_expected_guard_covers_sequential_edits_and_implicit_parent_allocation() {
    let setup = Setup::new(&seed());
    let mut r = guarded(10, "1", 1);
    r.operations = vec![
        Operation::ItemEdit {
            item: existing("1"),
            patch: ItemPatch {
                question: None,
                item_type: None,
                note: Some(Some("First".into())),
                links: None,
                short: None,
            },
        },
        add("one", uuid(5), Some(existing("1")), false),
        add("two", uuid(5), Some(existing("1")), false),
        Operation::ItemEdit {
            item: existing("1"),
            patch: ItemPatch {
                question: None,
                item_type: None,
                note: Some(None),
                links: Some(vec![]),
                short: None,
            },
        },
    ];
    setup.execute(&r).unwrap();
    let s = setup.saved();
    assert_eq!(s.items.0[&item("1")].revision, p(5));
    assert_eq!(s.items.0[&item("1")].next_child, p(3));
    assert!(s.items.0[&item("1")].note.is_none());
    assert_eq!(s.messages.len(), 2);
    assert_eq!(
        s.messages[1].items_touched,
        vec![item("1"), item("1.1"), item("1.2")]
    );
    assert!(r.expected_topic_revisions.0.is_empty());
}
#[test]
fn late_invalid_operation_rolls_back_all_allocations_messages_counters_and_receipts() {
    let setup = Setup::new(&seed());
    let mut r = request(10);
    r.operations = vec![
        Operation::TopicAdd {
            r#ref: RequestRef::new("topic").unwrap(),
            name: "Never saved".into(),
            short: None,
        },
        add("new", uuid_local("topic"), None, false),
        reply(local("missing"), "reply", "No forward references"),
    ];
    setup.rejected(&r, CoreErrorCode::InvalidRef);
    assert_eq!(setup.saved(), seed());
}
#[test]
fn refs_are_ordered_unique_and_kind_checked() {
    let setup = Setup::new(&seed());
    for operations in [
        vec![
            add("a", uuid_local("later"), None, false),
            Operation::TopicAdd {
                r#ref: RequestRef::new("later").unwrap(),
                name: "Later".into(),
                short: None,
            },
        ],
        vec![
            Operation::TopicAdd {
                r#ref: RequestRef::new("x").unwrap(),
                name: "First".into(),
                short: None,
            },
            Operation::TopicAdd {
                r#ref: RequestRef::new("x").unwrap(),
                name: "Second".into(),
                short: None,
            },
        ],
        vec![
            Operation::TopicAdd {
                r#ref: RequestRef::new("x").unwrap(),
                name: "Topic".into(),
                short: None,
            },
            reply(local("x"), "reply", "Wrong kind"),
        ],
    ] {
        let mut r = request(10);
        r.operations = operations;
        setup.rejected(&r, CoreErrorCode::InvalidRef);
    }
}
#[test]
fn all_supplied_guards_apply_even_to_untouched_entities_and_missing_implicit_guards_reject() {
    let setup = Setup::new(&seed());
    let mut r = guarded(10, "2", 2);
    setup.rejected(&r, CoreErrorCode::RevisionConflict);
    r.expected_item_revisions.0.clear();
    r.expected_topic_revisions.0.insert(id(5), p(2));
    setup.rejected(&r, CoreErrorCode::RevisionConflict);
    r.expected_topic_revisions.0.clear();
    r.operations = vec![add("child", uuid(5), Some(existing("1")), false)];
    setup.rejected(&r, CoreErrorCode::RevisionConflict);
}
#[test]
fn exact_replay_precedes_mutable_revisions_generation_session_and_attempt_guards() {
    let setup = Setup::new(&seed());
    let mut r = guarded(10, "1", 1);
    r.summary = "Original".into();
    r.operations = vec![reply(existing("1"), "response", "Full response")];
    let context = setup.context(None);
    let receipt = setup.execute(&r).unwrap();
    setup.write(11, |s| {
        s.state = SessionState::Closed;
        s.closed_at = Some(at());
        let b = s.bindings.0.get_mut(&id(3)).unwrap();
        b.generation = id(40);
        b.connection_state = ConnectionState::Disconnected;
        b.dispatch_state = DispatchState::Disconnected;
    });
    let before = setup.bytes();
    let replay = ApplyService::new(&setup.registry)
        .execute(&context, &r, || panic!("replay allocates nothing"), at())
        .unwrap();
    assert_eq!(replay, receipt);
    assert_eq!(setup.bytes(), before);
    r.summary = "Changed".into();
    assert!(matches!(
        ApplyService::new(&setup.registry).execute(
            &context,
            &r,
            || panic!("digest conflict"),
            at()
        ),
        Err(ApplyError::Store(StoreError::OperationReused))
    ));
}
#[test]
fn first_waiting_round_and_later_ask_are_distinct_immutable_episodes() {
    let setup = Setup::new(&seed());
    let mut r = request(10);
    r.operations = vec![
        add("waiting", uuid(5), None, true),
        Operation::ItemAsk {
            item: local("waiting"),
            ask: "Second ask".into(),
            options: vec![],
            recipient_binding_id: id(3),
        },
    ];
    setup.execute(&r).unwrap();
    let s = setup.saved();
    let rounds: Vec<_> = s
        .rounds
        .0
        .values()
        .filter(|r| r.item_id == item("3"))
        .collect();
    assert_eq!(rounds.len(), 2);
    let first = rounds.iter().find(|r| r.ordinal == p(1)).unwrap();
    let second = rounds.iter().find(|r| r.ordinal == p(2)).unwrap();
    assert_eq!(first.ask_snapshot.as_deref(), Some("Choose deliberately."));
    assert!(first.closed_at.is_some());
    assert_eq!(first.question_revision, p(1));
    assert_eq!(second.question_revision, p(2));
    assert_eq!(s.items.0[&item("3")].revision, p(2));
    assert_eq!(s.messages.len(), 2);
}
#[test]
fn explicit_round_close_needs_original_item_guard_and_preserves_history() {
    let setup = Setup::new(&seed());
    let input = setup.prepare(TurnState::Running);
    let s = setup.saved();
    let round = s.inputs.0[&input].payload.context.round_id.clone().unwrap();
    let mut r = request(10);
    r.operations = vec![Operation::RoundClose {
        round_id: round.clone(),
    }];
    setup.rejected(&r, CoreErrorCode::RevisionConflict);
    r.expected_item_revisions
        .0
        .insert(item("1"), s.items.0[&item("1")].revision);
    setup.execute(&r).unwrap();
    let current = setup.saved();
    assert!(current.rounds.0[&round].closed_at.is_some());
    assert!(current.items.0[&item("1")].current_round_id.is_none());
    assert_eq!(
        current.rounds.0[&round].owner_message_ids,
        s.rounds.0[&round].owner_message_ids
    );
}
#[test]
fn completion_first_result_commits_full_reply_children_provenance_and_joins() {
    let setup = Setup::new(&seed());
    let input = setup.prepare(TurnState::Completed);
    let before = setup.saved();
    let mut r = setup.dispatched(10, &input);
    r.operations
        .push(add("child", uuid(5), Some(existing("1")), true));
    r.input_result
        .as_mut()
        .unwrap()
        .followup_item_refs
        .push(local("child"));
    let receipt = setup.execute(&r).unwrap();
    let s = setup.saved();
    let i = &s.inputs.0[&input];
    let a = &i.attempts[0];
    assert_eq!(i.payload, before.inputs.0[&input].payload);
    assert_eq!(i.state, InputState::Handled);
    assert!(i.active_attempt_id.is_none());
    assert!(a.sealed_at.is_some());
    assert_eq!(
        a.domain_result.as_ref().unwrap().committed_revision,
        s.revision
    );
    assert_eq!(a.turn_state, TurnState::Completed);
    assert!(s.bindings.0[&id(3)].active_input_id.is_none());
    let round = before.inputs.0[&input]
        .payload
        .context
        .round_id
        .as_ref()
        .unwrap();
    assert_eq!(
        s.items.0[&item("1.1")].source_round_id.as_ref(),
        Some(round)
    );
    assert!(s.rounds.0[round].fork_item_ids.contains(&item("1.1")));
    assert!(s.rounds.0[round].result_input_ids.contains(&input));
    assert!(s.rounds.0[round].closed_at.is_none());
    let SavedReceiptData::Apply {
        queue_join_state,
        input_result_state,
        ..
    } = receipt.data
    else {
        panic!("apply")
    };
    assert_eq!(queue_join_state, Some(InputState::Handled));
    assert_eq!(input_result_state, Some(ResultState::Committed));
}
#[test]
fn result_first_stays_inflight_and_new_post_result_edits_reject_while_exact_replay_works() {
    let setup = Setup::new(&seed());
    let input = setup.prepare(TurnState::Running);
    let r = setup.dispatched(10, &input);
    let receipt = setup.execute(&r).unwrap();
    let s = setup.saved();
    assert_eq!(s.inputs.0[&input].state, InputState::InFlight);
    assert!(s.inputs.0[&input].attempts[0].sealed_at.is_none());
    assert_eq!(s.bindings.0[&id(3)].active_input_id, Some(input.clone()));
    assert_eq!(setup.execute(&r).unwrap(), receipt);
    let mut next = r.clone();
    next.op_id = id(11);
    setup.rejected(&next, CoreErrorCode::ResultAlreadyCommitted);
}
#[test]
fn deferred_unable_require_explicit_reply_and_summary_is_never_reply() {
    for outcome in [
        ResultOutcome::Answered,
        ResultOutcome::Deferred,
        ResultOutcome::Unable,
    ] {
        let setup = Setup::new(&seed());
        let input = setup.prepare(TurnState::Completed);
        let mut r = setup.dispatched(10, &input);
        r.operations.clear();
        r.summary = "A summary is insufficient result evidence".into();
        r.input_result.as_mut().unwrap().outcome = outcome.clone();
        r.input_result.as_mut().unwrap().reply_refs.clear();
        setup.rejected(&r, CoreErrorCode::InvalidArgument);
        r.operations
            .push(reply(existing("1"), "response", "Explains the outcome"));
        r.input_result
            .as_mut()
            .unwrap()
            .reply_refs
            .push(uuid_local("response"));
        setup.execute(&r).unwrap();
        assert_eq!(setup.saved().inputs.0[&input].state, InputState::Handled);
    }
}
#[test]
fn incremental_same_attempt_effects_qualify_but_unrelated_existing_items_do_not() {
    let setup = Setup::new(&seed());
    let input = setup.prepare(TurnState::Running);
    let mut r = setup.dispatched(10, &input);
    r.input_result = None;
    r.operations
        .push(add("followup", uuid(5), Some(existing("1")), false));
    let receipt = setup.execute(&r).unwrap();
    let SavedReceiptData::Apply { allocated_refs, .. } = receipt.data else {
        panic!("apply")
    };
    let AllocatedRef::Message { id: reply_id } =
        &allocated_refs.0[&RequestRef::new("response").unwrap()]
    else {
        panic!("message")
    };
    let mut final_r = setup.dispatched(11, &input);
    final_r.operations.clear();
    final_r.expected_item_revisions.0.clear();
    let result = final_r.input_result.as_mut().unwrap();
    result.reply_refs = vec![UuidRef::Existing(ExistingUuidRef {
        id: reply_id.clone(),
    })];
    result.followup_item_refs = vec![existing("1")];
    setup.rejected(&final_r, CoreErrorCode::InvalidArgument);
    final_r.input_result.as_mut().unwrap().followup_item_refs = vec![existing("1.1")];
    setup.execute(&final_r).unwrap();
}
#[test]
fn failed_interrupted_or_uncertain_turn_keeps_published_domain_data_without_handling() {
    for turn in [
        TurnState::Failed,
        TurnState::Interrupted,
        TurnState::Completed,
    ] {
        let setup = Setup::new(&seed());
        let input = setup.prepare(turn.clone());
        if turn == TurnState::Completed {
            setup.write(702, |s| {
                s.inputs.0.get_mut(&input).unwrap().attempts[0].acceptance =
                    AcceptanceState::Uncertain;
            });
        }
        setup.execute(&setup.dispatched(10, &input)).unwrap();
        let s = setup.saved();
        let i = &s.inputs.0[&input];
        assert_eq!(i.state, InputState::NeedsAttention);
        assert!(i.attempts[0].domain_result.is_some());
        assert!(i.attempts[0].sealed_at.is_none());
        assert_eq!(
            s.bindings.0[&id(3)].dispatch_state,
            DispatchState::RecoveryRequired
        );
        assert!(s
            .messages
            .iter()
            .any(|m| m.kind == MessageKind::Reply && m.input_id.as_ref() == Some(&input)));
    }
}
#[test]
fn late_result_clears_only_resultmissing_pause_and_preserves_owner_pause_other_reasons() {
    for (paused, reason, expected) in [
        (false, PauseReason::ResultMissing, DispatchState::Enabled),
        (true, PauseReason::ResultMissing, DispatchState::Paused),
        (
            false,
            PauseReason::StoreError,
            DispatchState::RecoveryRequired,
        ),
    ] {
        let setup = Setup::new(&seed());
        let input = setup.prepare(TurnState::Completed);
        setup.write(702, |s| {
            s.inputs.0.get_mut(&input).unwrap().state = InputState::NeedsAttention;
            let b = s.bindings.0.get_mut(&id(3)).unwrap();
            b.owner_paused = paused;
            b.pause_reason = Some(reason.clone());
            b.dispatch_state = DispatchState::RecoveryRequired;
        });
        setup.execute(&setup.dispatched(10, &input)).unwrap();
        let s = setup.saved();
        assert_eq!(s.inputs.0[&input].state, InputState::Handled);
        let b = &s.bindings.0[&id(3)];
        assert_eq!(b.dispatch_state, expected);
        assert_eq!(b.owner_paused, paused);
        assert_eq!(
            b.pause_reason,
            if reason == PauseReason::ResultMissing {
                None
            } else {
                Some(reason)
            }
        );
    }
}
#[test]
fn exact_actor_attempt_generation_and_trusted_watermark_are_rechecked_under_lock() {
    let setup = Setup::new(&seed());
    let input = setup.prepare(TurnState::Running);
    let r = setup.dispatched(10, &input);
    let before = setup.bytes();
    let context = AgentContext::from_trusted_entrypoint(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        id(3),
        id(4),
        AgentReadScope::Dispatched {
            source_input_id: input.clone(),
            attempt_id: id(800),
            issued_through_message_number: NonnegativeSafeInteger::new(1).unwrap(),
        },
    );
    assert_eq!(
        core_error(
            ApplyService::new(&setup.registry)
                .execute(&context, &r, || panic!("guard before allocations"), at())
                .unwrap_err()
        )
        .code,
        CoreErrorCode::InvalidArgument
    );
    assert_eq!(setup.bytes(), before);
    let mut future = r.clone();
    future
        .input_result
        .as_mut()
        .unwrap()
        .handled_through_message_number = p(3);
    setup.rejected(&future, CoreErrorCode::InvalidArgument);
    setup.write(702, |s| {
        s.bindings.0.get_mut(&id(3)).unwrap().generation = id(40);
    });
    setup.rejected(&r, CoreErrorCode::StaleGeneration);
}
#[test]
fn empty_and_whitespace_summary_use_valid_fallback_only_for_actual_changes() {
    let setup = Setup::new(&seed());
    let mut r = request(10);
    r.summary = "  \n".into();
    let receipt = setup.execute(&r).unwrap();
    assert_eq!(setup.saved().messages, seed().messages);
    let SavedReceiptData::Apply { messages, .. } = receipt.data else {
        panic!("apply")
    };
    assert!(messages.is_empty());
    r.op_id = id(11);
    r.expected_item_revisions.0.insert(item("1"), p(1));
    r.operations = vec![reply(existing("1"), "response", "A full reply")];
    setup.execute(&r).unwrap();
    assert_eq!(
        setup.saved().messages[1].body,
        "Agent applied domain changes."
    );
}

#[test]
fn terminal_status_watermark_and_reopen_replace_history_use_domain_guards() {
    let setup = Setup::new(&seed());
    setup.prepare(TurnState::Running);
    let mut r = guarded(10, "1", setup.saved().items.0[&item("1")].revision.value());
    r.operations = vec![Operation::ItemStatus {
        item: existing("1"),
        status: ItemStatus::Done,
        outcome: Some("Resolved explicitly".into()),
        why: Some("Evidence inspected".into()),
        reason: None,
    }];
    let narrow = AgentContext::from_trusted_entrypoint(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        id(3),
        id(4),
        AgentReadScope::Terminal {
            issued_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
        },
    );
    let before = setup.bytes();
    assert_eq!(
        core_error(
            ApplyService::new(&setup.registry)
                .execute(&narrow, &r, || id(30000), at())
                .unwrap_err()
        )
        .code,
        CoreErrorCode::UnhandledOwnerMessage
    );
    assert_eq!(before, setup.bytes());
    setup.execute(&r).unwrap();
    let mut next = guarded(11, "1", setup.saved().items.0[&item("1")].revision.value());
    next.operations = vec![
        Operation::ItemStatus {
            item: existing("1"),
            status: ItemStatus::Open,
            outcome: None,
            why: None,
            reason: Some("Revisit the decision".into()),
        },
        Operation::ItemReplace {
            item: existing("1"),
            replacement: existing("2"),
            outcome: "Use the reference".into(),
            why: "The reference is authoritative".into(),
        },
    ];
    setup.execute(&next).unwrap();
    let s = setup.saved();
    let target = &s.items.0[&item("1")];
    assert_eq!(target.status, ItemStatus::Replaced);
    assert_eq!(
        target.status_history[1].previous_outcome.as_deref(),
        Some("Resolved explicitly")
    );
    assert_eq!(target.replaced_by, Some(item("2")));
    next.op_id = id(12);
    next.expected_item_revisions
        .0
        .insert(item("1"), target.revision);
    next.operations.truncate(1);
    setup.rejected(&next, CoreErrorCode::InvalidTransition);
}

#[test]
fn archived_closed_wrong_topic_and_invalid_waiting_candidates_have_no_effects() {
    let setup = Setup::new(&seed());
    let mut r = guarded(10, "1", 1);
    r.operations = vec![add("child", uuid(90), Some(existing("1")), false)];
    setup.rejected(&r, CoreErrorCode::InvalidRef);
    r.operations = vec![add("waiting", uuid(5), None, true)];
    let Operation::ItemAdd(draft) = &mut r.operations[0] else {
        unreachable!()
    };
    draft.ask = None;
    setup.rejected(&r, CoreErrorCode::InvalidArgument);
    setup.write(11, |s| {
        s.topics.0.get_mut(&id(5)).unwrap().archived_at = Some(at())
    });
    r.operations = vec![reply(existing("1"), "response", "Archived")];
    setup.rejected(&r, CoreErrorCode::InvalidTransition);
    setup.write(12, |s| {
        s.state = SessionState::Closed;
        s.closed_at = Some(at());
    });
    setup.rejected(&r, CoreErrorCode::InvalidTransition);
}

#[test]
fn source_context_cross_binding_sealed_future_and_wire_bounds_reject() {
    let setup = Setup::new(&seed());
    let input = setup.prepare(TurnState::Running);
    let r = setup.dispatched(10, &input);
    let before = setup.bytes();
    let terminal = setup.context(None);
    assert_eq!(
        core_error(
            ApplyService::new(&setup.registry)
                .execute(&terminal, &r, || panic!("scope guard"), at())
                .unwrap_err()
        )
        .code,
        CoreErrorCode::BindingMismatch
    );
    assert_eq!(setup.bytes(), before);
    let mut bad = r.clone();
    bad.attempt_id = Some(id(900));
    setup.rejected(&bad, CoreErrorCode::BindingMismatch);
    let mut bad = r.clone();
    bad.attempt_id = None;
    setup.rejected(&bad, CoreErrorCode::InvalidArgument);
    let mut bad = r.clone();
    bad.source_input_id = None;
    bad.attempt_id = None;
    setup.rejected(&bad, CoreErrorCode::InvalidArgument);
    let future = AgentContext::from_trusted_entrypoint(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        id(3),
        id(4),
        AgentReadScope::Dispatched {
            source_input_id: input.clone(),
            attempt_id: id(800),
            issued_through_message_number: NonnegativeSafeInteger::new(3).unwrap(),
        },
    );
    assert_eq!(
        core_error(
            ApplyService::new(&setup.registry)
                .execute(&future, &r, || panic!("future scope"), at())
                .unwrap_err()
        )
        .code,
        CoreErrorCode::InvalidArgument
    );
    setup.write(11, |s| {
        s.inputs.0.get_mut(&input).unwrap().attempts[0].sealed_at = Some(at())
    });
    setup.rejected(&r, CoreErrorCode::AttemptSealed);
    let mut many = request(12);
    many.operations = (0..101)
        .map(|_| Operation::RoundClose { round_id: id(90) })
        .collect();
    setup.rejected(&many, CoreErrorCode::InvalidArgument);
}

#[test]
fn result_refs_are_distinct_and_preserve_exact_current_attempt_scope() {
    let setup = Setup::new(&seed());
    let input = setup.prepare(TurnState::Completed);
    let mut r = setup.dispatched(10, &input);
    r.input_result
        .as_mut()
        .unwrap()
        .reply_refs
        .push(uuid_local("response"));
    setup.rejected(&r, CoreErrorCode::InvalidArgument);
    r.input_result.as_mut().unwrap().reply_refs = vec![uuid(6)];
    setup.rejected(&r, CoreErrorCode::InvalidArgument);
    r.input_result.as_mut().unwrap().reply_refs = vec![uuid(999)];
    setup.rejected(&r, CoreErrorCode::InvalidRef);
    r.input_result.as_mut().unwrap().reply_refs = vec![uuid_local("response")];
    r.input_result.as_mut().unwrap().followup_item_refs = vec![existing("99")];
    setup.rejected(&r, CoreErrorCode::InvalidRef);
}

#[test]
fn explicit_bad_fork_round_and_allocator_counter_failures_do_not_commit() {
    let setup = Setup::new(&seed());
    let input = setup.prepare(TurnState::Running);
    let mut r = guarded(10, "2", 1);
    let round = setup.saved().inputs.0[&input]
        .payload
        .context
        .round_id
        .clone()
        .unwrap();
    r.operations = vec![add("child", uuid(5), Some(existing("2")), false)];
    let Operation::ItemAdd(draft) = &mut r.operations[0] else {
        unreachable!()
    };
    draft.source_round_id = Some(round);
    setup.rejected(&r, CoreErrorCode::InvalidRef);
    let r = guarded(11, "1", setup.saved().items.0[&item("1")].revision.value());
    let mut duplicate = r.clone();
    duplicate.operations = vec![reply(existing("1"), "response", "Duplicate native ID")];
    let before = setup.bytes();
    assert_eq!(
        core_error(
            ApplyService::new(&setup.registry)
                .execute(&setup.context(None), &duplicate, || id(6), at())
                .unwrap_err()
        )
        .code,
        CoreErrorCode::InvalidArgument
    );
    assert_eq!(setup.bytes(), before);
    setup.write(12, |s| s.counters.next_root = p(9_007_199_254_740_991));
    let mut overflow = request(13);
    overflow.operations = vec![add("root", uuid(5), None, false)];
    setup.rejected(&overflow, CoreErrorCode::CapacityExceeded);
}

#[test]
fn result_repair_can_cite_verified_original_work_effects_and_rejects_uncompleted_original() {
    let setup = Setup::new(&seed());
    let input = setup.prepare(TurnState::Running);
    let mut incremental = setup.dispatched(10, &input);
    incremental.input_result = None;
    let receipt = setup.execute(&incremental).unwrap();
    let SavedReceiptData::Apply { allocated_refs, .. } = receipt.data else {
        unreachable!()
    };
    let AllocatedRef::Message { id: reply_id } =
        &allocated_refs.0[&RequestRef::new("response").unwrap()]
    else {
        unreachable!()
    };
    let reply_id = reply_id.clone();
    // Test-owned fixture models an explicit result-repair preparation; no repair
    // dispatch/recovery implementation is claimed by this apply task.
    setup.write(11, |s| {
        let i = s.inputs.0.get_mut(&input).unwrap();
        let original = &mut i.attempts[0];
        original.id = id(799);
        original.sealed_at = Some(at());
        let mut repair = original.clone();
        repair.id = id(800);
        repair.purpose = AttemptPurpose::ResultRepair;
        repair.repair_for_attempt_id = Some(id(799));
        repair.sealed_at = None;
        repair.claim_request_id = id(803);
        i.attempts.push(repair);
        for attempt in &mut i.attempts {
            let body = attempt
                .formatted_payload
                .split_once('\n')
                .unwrap()
                .1
                .to_owned();
            attempt.wire_marker =
                format!("[ARIADNE_INPUT:{}:{}]", input.as_str(), attempt.id.as_str());
            attempt.formatted_payload = format!("{}\n{body}", attempt.wire_marker);
            attempt.payload_sha256 = Sha256::new(format!(
                "{:x}",
                Hasher::digest(attempt.formatted_payload.as_bytes())
            ))
            .unwrap();
        }
        for m in &mut s.messages {
            if m.attempt_id.as_ref() == Some(&id(800)) {
                m.attempt_id = Some(id(799));
            }
        }
    });
    let mut r = setup.dispatched(12, &input);
    r.operations.clear();
    r.expected_item_revisions.0.clear();
    r.input_result.as_mut().unwrap().reply_refs =
        vec![UuidRef::Existing(ExistingUuidRef { id: reply_id })];
    setup.rejected(&r, CoreErrorCode::InvalidArgument);
    setup.write(13, |s| {
        s.inputs.0.get_mut(&input).unwrap().attempts[0].turn_state = TurnState::Completed
    });
    setup.execute(&r).unwrap();
    assert_eq!(
        setup.saved().inputs.0[&input].attempts[1].result_state,
        ResultState::Committed
    );
}

#[test]
fn actual_prepared_completion_is_sufficient_and_warning_history_is_retained() {
    let setup = Setup::new(&seed());
    let input = setup.prepare(TurnState::Completed);
    setup.write(11, |s| {
        let a = &mut s.inputs.0.get_mut(&input).unwrap().attempts[0];
        a.acceptance = AcceptanceState::Prepared;
        a.acceptance_observed_at = None;
        a.result_state = ResultState::Missing;
        a.error = Some(AttemptError {
            code: "result_missing".into(),
            reason: "Completed without result during the grace window".into(),
            retryable: false,
            observed_at: at(),
        });
        let b = s.bindings.0.get_mut(&id(3)).unwrap();
        b.pause_reason = Some(PauseReason::ResultMissing);
        b.dispatch_state = DispatchState::RecoveryRequired;
    });
    let warning = setup.saved().inputs.0[&input].attempts[0].error.clone();
    setup.execute(&setup.dispatched(10, &input)).unwrap();
    let s = setup.saved();
    assert_eq!(s.inputs.0[&input].state, InputState::Handled);
    assert_eq!(s.inputs.0[&input].attempts[0].error, warning);
    assert_eq!(
        s.inputs.0[&input].attempts[0].acceptance,
        AcceptanceState::Prepared
    );
}

fn wait_file(path: &std::path::Path) {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !path.exists() {
        assert!(
            std::time::Instant::now() < until,
            "writer signal timed out: {}",
            path.display()
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}
#[test]
fn apply_writer_child() {
    let Some(home) = std::env::var_os("ARIADNE_APPLY_TEST_HOME") else {
        return;
    };
    let registry = Registry::open(std::path::Path::new(&home)).unwrap();
    let target = std::env::var("ARIADNE_APPLY_TEST_ITEM").unwrap();
    let op = std::env::var("ARIADNE_APPLY_TEST_OP")
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let context = AgentContext::from_trusted_entrypoint(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        id(3),
        id(4),
        AgentReadScope::Terminal {
            issued_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
        },
    );
    let mut r = guarded(op, &target, 1);
    r.operations = vec![reply(
        existing(&target),
        "response",
        &format!("Writer {op} preserved full body"),
    )];
    let mut next = op * 1000;
    let mut first = true;
    if let Some(start) = std::env::var_os("ARIADNE_APPLY_TEST_STARTED") {
        fs::write(start, b"started").unwrap();
    }
    let result = ApplyService::new(&registry).execute(
        &context,
        &r,
        || {
            if first {
                first = false;
                if let Some(ready) = std::env::var_os("ARIADNE_APPLY_TEST_READY") {
                    fs::write(ready, b"locked").unwrap();
                    let release = std::env::var_os("ARIADNE_APPLY_TEST_RELEASE").unwrap();
                    wait_file(std::path::Path::new(&release));
                }
            }
            next += 1;
            id(next)
        },
        at(),
    );
    if std::env::var("ARIADNE_APPLY_TEST_CONFLICT").as_deref() == Ok("yes") {
        assert_eq!(
            core_error(result.unwrap_err()).code,
            CoreErrorCode::RevisionConflict
        );
    } else {
        result.unwrap();
    }
}
#[test]
fn separate_writers_preserve_different_item_updates_and_reject_same_item_conflict() {
    for same in [false, true] {
        let setup = Setup::new(&seed());
        let signal = tempfile::tempdir().unwrap();
        let ready = signal.path().join("ready");
        let release = signal.path().join("release");
        let started = signal.path().join("second-started");
        let spawn = |target: &str, op: &str| {
            let mut c = std::process::Command::new(std::env::current_exe().unwrap());
            c.args(["--exact", "apply_writer_child", "--nocapture"])
                .env("ARIADNE_APPLY_TEST_HOME", setup._home.path())
                .env("ARIADNE_APPLY_TEST_ITEM", target)
                .env("ARIADNE_APPLY_TEST_OP", op);
            c
        };
        let mut first = spawn("1", "100")
            .env("ARIADNE_APPLY_TEST_READY", &ready)
            .env("ARIADNE_APPLY_TEST_RELEASE", &release)
            .spawn()
            .unwrap();
        wait_file(&ready);
        let mut second = spawn(if same { "1" } else { "2" }, "101")
            .env("ARIADNE_APPLY_TEST_STARTED", &started)
            .env(
                "ARIADNE_APPLY_TEST_CONFLICT",
                if same { "yes" } else { "no" },
            )
            .spawn()
            .unwrap();
        wait_file(&started);
        assert!(second.try_wait().unwrap().is_none());
        fs::write(&release, b"publish").unwrap();
        assert!(first.wait().unwrap().success());
        assert!(second.wait().unwrap().success());
        let s = setup.saved();
        assert_eq!(s.revision, p(if same { 2 } else { 3 }));
        assert_eq!(
            s.messages
                .iter()
                .filter(|m| m.kind == MessageKind::Reply)
                .count(),
            if same { 1 } else { 2 }
        );
        assert!(s
            .messages
            .iter()
            .any(|m| m.body == "Writer 100 preserved full body"));
        assert_eq!(s.items.0[&item("1")].revision, p(2));
        assert_eq!(s.items.0[&item("2")].revision, p(if same { 1 } else { 2 }));
    }
}

fn short_patch(short: Option<Option<&str>>) -> Operation {
    Operation::ItemEdit {
        item: existing("1"),
        patch: ItemPatch {
            question: None,
            item_type: None,
            note: None,
            links: None,
            short: short.map(|value| value.map(Into::into)),
        },
    }
}

#[test]
fn short_labels_are_stored_trimmed_and_absent_keeps_null_clears() {
    let setup = Setup::new(&seed());
    let mut r = request(10);
    let mut child = add("item", uuid_local("topic"), None, false);
    if let Operation::ItemAdd(draft) = &mut child {
        draft.short = Some("  Fallback merge test ".into());
    }
    r.operations = vec![
        Operation::TopicAdd {
            r#ref: RequestRef::new("topic").unwrap(),
            name: "SDK cache pull request".into(),
            short: Some(" SDK cache PR".into()),
        },
        child,
    ];
    r.validate_wire().unwrap();
    setup.execute(&r).unwrap();
    let s = setup.saved();
    let topic = s
        .topics
        .0
        .values()
        .find(|t| t.name.starts_with("SDK"))
        .unwrap();
    assert_eq!(topic.short.as_deref(), Some("SDK cache PR"));
    assert_eq!(
        s.items.0[&item("3")].short.as_deref(),
        Some("Fallback merge test")
    );

    let revision = |setup: &Setup| setup.saved().items.0[&item("1")].revision.value();
    let mut set = guarded(11, "1", revision(&setup));
    set.operations = vec![short_patch(Some(Some("Owner choice")))];
    setup.execute(&set).unwrap();
    // A patch without `short` (the JSON omits the key) keeps the label.
    let mut keep = guarded(12, "1", revision(&setup));
    keep.operations = vec![serde_json::from_value(serde_json::json!({
        "op":"item.edit","item":{"id":"1"},
        "patch":{"question":null,"type":null,"note":"Kept label","links":null}
    }))
    .unwrap()];
    setup.execute(&keep).unwrap();
    assert_eq!(
        setup.saved().items.0[&item("1")].short.as_deref(),
        Some("Owner choice")
    );
    // An explicit `null` clears it.
    let mut clear = guarded(13, "1", revision(&setup));
    clear.operations = vec![serde_json::from_value(serde_json::json!({
        "op":"item.edit","item":{"id":"1"},
        "patch":{"question":null,"type":null,"links":null,"short":null}
    }))
    .unwrap()];
    assert_eq!(clear.operations[0], short_patch(Some(None)));
    setup.execute(&clear).unwrap();
    assert_eq!(setup.saved().items.0[&item("1")].short, None);

    // Too long, multi-line or blank labels fail on the wire and in the batch.
    for bad in ["x".repeat(41), "two\nlines".into(), "  ".into()] {
        let mut r = guarded(14, "1", revision(&setup));
        r.operations = vec![short_patch(Some(Some(&bad)))];
        assert_eq!(
            r.validate_wire().unwrap_err().code,
            CoreErrorCode::InvalidArgument
        );
        setup.rejected(&r, CoreErrorCode::InvalidArgument);
        let mut r = request(15);
        r.operations = vec![Operation::TopicAdd {
            r#ref: RequestRef::new("topic").unwrap(),
            name: "Topic".into(),
            short: Some(bad.clone()),
        }];
        assert_eq!(
            r.validate_wire().unwrap_err().code,
            CoreErrorCode::InvalidArgument
        );
        setup.rejected(&r, CoreErrorCode::InvalidArgument);
    }
}
