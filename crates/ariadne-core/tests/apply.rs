use ariadne_core::{
    apply::{ApplyError, ApplyService},
    history_actions::HistoryActionService,
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

fn agent_removals(receipt: &SavedReceipt) -> &[AgentRemoval] {
    let SavedReceiptData::Apply { agent_removals, .. } = &receipt.data else {
        panic!("apply receipt")
    };
    agent_removals
}

fn restore_item(
    setup: &Setup,
    target: &str,
    revision: PositiveSafeInteger,
    op: u64,
) -> Result<MutationReceipt, ariadne_core::history_actions::HistoryActionError> {
    HistoryActionService::new(&setup.registry).execute(
        &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
            RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        )),
        &OwnerCommand::ItemRestore {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(op),
            params: ItemRemoveParams {
                item_id: item(target),
                expected_revision: revision,
            },
        },
        at(),
    )
}

#[test]
fn agent_delete_preserves_subtree_and_redelete_and_restore_exact_marker() {
    let setup = Setup::new(&seed());
    let mut children = guarded(
        1500,
        "1",
        setup.saved().items.0[&item("1")].revision.value(),
    );
    children
        .operations
        .push(add("child", uuid(5), Some(existing("1")), true));
    setup.execute(&children).unwrap();
    let before = setup.saved();
    let mut delete = guarded(1501, "1", before.items.0[&item("1")].revision.value());
    delete.operations.push(Operation::ItemDelete {
        item: existing("1"),
    });
    let receipt = setup.execute(&delete).unwrap();
    let removal = &agent_removals(&receipt)[0];
    assert_eq!(removal.item_ids, vec![item("1"), item("1.1")]);
    assert_eq!(removal.waiting_questions.value(), 1);
    assert!(removal.cancelled_input_ids.is_empty());
    let deleted = setup.saved();
    let root = &deleted.items.0[&item("1")];
    assert!(root.removed_at.is_some());
    assert_eq!(root.status, before.items.0[&item("1")].status);
    assert_eq!(root.question, before.items.0[&item("1")].question);
    assert_eq!(
        root.status_history,
        before.items.0[&item("1")].status_history
    );
    assert_eq!(deleted.items.0[&item("1.1")], before.items.0[&item("1.1")]);
    assert!(ariadne_domain::visibility::item_is_removed(
        &deleted,
        &deleted.items.0[&item("1.1")]
    ));
    let notice = deleted
        .messages
        .iter()
        .find(|m| m.id == removal.message_id)
        .unwrap();
    assert!(notice.body.contains(&deleted.topics.0[&id(5)].name));
    assert!(notice.body.contains("1 waiting question"));
    assert!(!notice.body.contains(id(3).as_str()));
    let summary = ApplyService::new(&setup.registry)
        .summary(&setup.context(None), &receipt)
        .unwrap();
    assert_eq!(summary.agent_removals, agent_removals(&receipt));
    let mut again = guarded(1502, "1.1", deleted.items.0[&item("1.1")].revision.value());
    again.operations.push(Operation::ItemDelete {
        item: existing("1.1"),
    });
    assert!(agent_removals(&setup.execute(&again).unwrap()).is_empty());
    let redeleted = setup.saved();
    assert_eq!(redeleted.items, deleted.items);
    assert!(restore_item(
        &setup,
        "1.1",
        redeleted.items.0[&item("1.1")].revision,
        1503
    )
    .is_err());
    assert!(restore_item(&setup, "1", before.items.0[&item("1")].revision, 1504).is_err());
    let message_count = setup.saved().messages.len();
    restore_item(&setup, "1", root.revision, 1505).unwrap();
    let restored = setup.saved();
    assert_eq!(restored.messages.len(), message_count);
    assert!(!ariadne_domain::visibility::item_is_removed(
        &restored,
        &restored.items.0[&item("1.1")]
    ));
    assert!(restored.items.0[&item("1")].removed_by.is_none());
    assert_eq!(restored.items.0[&item("1.1")], before.items.0[&item("1.1")]);
}

#[test]
fn agent_delete_source_with_valid_result_handles_it_and_keeps_full_reply() {
    for turn in [TurnState::Running, TurnState::Completed] {
        let setup = Setup::new(&seed());
        let source = setup.prepare(turn);
        let mut request = setup.dispatched(1510, &source);
        request.operations.push(Operation::ItemDelete {
            item: existing("1"),
        });
        let receipt = setup.execute(&request).unwrap();
        assert!(agent_removals(&receipt)[0].cancelled_input_ids.is_empty());
        let saved = setup.saved();
        let input = &saved.inputs.0[&source];
        assert_eq!(input.state, InputState::Handled);
        assert!(input.attempts[0].sealed_at.is_some());
        assert_eq!(input.attempts[0].result_state, ResultState::Committed);
        assert_eq!(input.cancel_cause, None);
        assert_eq!(saved.bindings.0[&id(3)].active_input_id, None);
        assert!(saved
            .messages
            .iter()
            .any(|message| message.kind == MessageKind::Reply
                && message.body == "Exact full reply.\nWith trailing spaces.  "));
        restore_item(&setup, "1", saved.items.0[&item("1")].revision, 1511).unwrap();
        ariadne_domain::history::validate_session_history(&setup.saved()).unwrap();
        assert_eq!(setup.execute(&request).unwrap(), receipt);
    }
}

#[test]
fn agent_delete_source_without_result_cancels_and_seals_and_retains_owner_text() {
    for needs_attention in [false, true] {
        let setup = Setup::new(&seed());
        let source = setup.prepare(TurnState::Running);
        if needs_attention {
            setup.write(1519, |session| {
                session.inputs.0.get_mut(&source).unwrap().state = InputState::NeedsAttention;
                let binding = session.bindings.0.get_mut(&id(3)).unwrap();
                binding.dispatch_state = DispatchState::RecoveryRequired;
                binding.pause_reason = Some(PauseReason::Uncertain);
            });
        }
        let before = setup.saved();
        let mut request = setup.dispatched(1520, &source);
        request.operations.clear();
        request.operations.push(Operation::ItemDelete {
            item: existing("1"),
        });
        request.input_result = None;
        let receipt = setup.execute(&request).unwrap();
        assert_eq!(
            agent_removals(&receipt)[0].cancelled_input_ids,
            vec![source.clone()]
        );
        let saved = setup.saved();
        let input = &saved.inputs.0[&source];
        assert_eq!(input.state, InputState::Cancelled);
        assert_eq!(input.cancel_cause, Some(CancelCause::AgentRemoved));
        assert!(input.active_attempt_id.is_none());
        assert!(input.attempts[0].sealed_at.is_some());
        assert_eq!(input.payload, before.inputs.0[&source].payload);
        assert_eq!(
            saved.messages.iter().find(|m| m.id == input.message_id),
            before.messages.iter().find(|m| m.id == input.message_id)
        );
        assert_eq!(saved.bindings.0[&id(3)].active_input_id, None);
        assert_eq!(saved.bindings.0[&id(3)].pause_reason, None);
        restore_item(&setup, "1", saved.items.0[&item("1")].revision, 1521).unwrap();
        assert_eq!(setup.saved().inputs.0[&source].state, InputState::Cancelled);
    }
}

#[test]
fn agent_delete_invalid_empty_source_result_is_atomic() {
    let setup = Setup::new(&seed());
    let source = setup.prepare(TurnState::Running);
    let mut request = setup.dispatched(1530, &source);
    request.operations.clear();
    request.operations.push(Operation::ItemDelete {
        item: existing("1"),
    });
    request.input_result.as_mut().unwrap().reply_refs.clear();
    setup.rejected(&request, CoreErrorCode::InvalidArgument);
}

#[test]
fn agent_delete_guarded_and_archived_redelete_is_refused() {
    let setup = Setup::new(&seed());
    let mut unguarded = request(1540);
    unguarded.operations.push(Operation::ItemDelete {
        item: existing("1"),
    });
    setup.rejected(&unguarded, CoreErrorCode::RevisionConflict);
    let mut delete = guarded(
        1541,
        "1",
        setup.saved().items.0[&item("1")].revision.value(),
    );
    delete.operations = unguarded.operations.clone();
    setup.execute(&delete).unwrap();
    let mut edit = guarded(
        1542,
        "1",
        setup.saved().items.0[&item("1")].revision.value(),
    );
    edit.operations
        .push(reply(existing("1"), "hidden", "Reply to removed work"));
    setup.rejected(&edit, CoreErrorCode::InvalidTransition);
    setup.write(1543, |session| {
        session.topics.0.get_mut(&id(5)).unwrap().archived_at = Some(at())
    });
    edit.op_id = id(1544);
    edit.operations = unguarded.operations;
    setup.rejected(&edit, CoreErrorCode::InvalidTransition);
}

fn owner_route() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
    ))
}

fn queued_input(setup: &Setup, topic_id: UuidV4, item_id: Option<ItemRef>, op: u64) -> UuidV4 {
    let receipt = InputService::new(&setup.registry)
        .execute(
            &owner_route(),
            &OwnerCommand::InputSubmit {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(op),
                params: InputSubmitParams {
                    binding_id: id(3),
                    kind: if item_id.is_some() {
                        InputKind::Reply
                    } else {
                        InputKind::TopicReply
                    },
                    target: InputTarget { topic_id, item_id },
                    text: "Owner's full pending message".into(),
                    selected_option_id: None,
                    expected_question_revision: None,
                    supersedes_answer_id: None,
                },
            },
            || id(setup.next.fetch_add(1, Ordering::SeqCst)),
            at(),
        )
        .unwrap();
    let MutationReceipt::Session(saved) = receipt else {
        panic!("session")
    };
    let SavedReceiptData::InputSubmit { input_id, .. } = saved.data else {
        panic!("submit")
    };
    input_id
}

#[test]
fn agent_topic_delete_cancels_targeted_inputs_and_restore_keeps_separate_item_bin() {
    let setup = Setup::new(&seed());
    let mut add_work = guarded(
        1550,
        "1",
        setup.saved().items.0[&item("1")].revision.value(),
    );
    add_work.operations = vec![
        add("child", uuid(5), Some(existing("1")), true),
        Operation::TopicAdd {
            r#ref: RequestRef::new("other").unwrap(),
            name: "Other topic".into(),
            short: None,
        },
        add("other_item", uuid_local("other"), None, false),
    ];
    let receipt = setup.execute(&add_work).unwrap();
    let SavedReceiptData::Apply { allocated_refs, .. } = receipt.data else {
        panic!("apply")
    };
    let AllocatedRef::Topic { id: other_topic } =
        &allocated_refs.0[&RequestRef::new("other").unwrap()]
    else {
        panic!("topic")
    };
    let AllocatedRef::Item { id: other_item } =
        &allocated_refs.0[&RequestRef::new("other_item").unwrap()]
    else {
        panic!("item")
    };
    let unaffected = queued_input(&setup, other_topic.clone(), Some(other_item.clone()), 1551);
    let item_input = queued_input(&setup, id(5), Some(item("1")), 1552);
    let topic_input = queued_input(&setup, id(5), None, 1553);
    let mut child_delete = guarded(
        1554,
        "1.1",
        setup.saved().items.0[&item("1.1")].revision.value(),
    );
    child_delete.operations.push(Operation::ItemDelete {
        item: existing("1.1"),
    });
    setup.execute(&child_delete).unwrap();
    let before = setup.saved();
    let mut delete = request(1555);
    delete
        .expected_topic_revisions
        .0
        .insert(id(5), before.topics.0[&id(5)].revision);
    delete
        .operations
        .push(Operation::TopicDelete { topic: uuid(5) });
    let receipt = setup.execute(&delete).unwrap();
    let removal = &agent_removals(&receipt)[0];
    assert_eq!(removal.item_id, None);
    assert_eq!(removal.waiting_questions.value(), 0);
    assert_eq!(removal.cancelled_input_ids.len(), 2);
    assert!(removal.cancelled_input_ids.contains(&item_input));
    assert!(removal.cancelled_input_ids.contains(&topic_input));
    let deleted = setup.saved();
    assert_eq!(deleted.inputs.0[&unaffected], before.inputs.0[&unaffected]);
    assert_eq!(deleted.items, before.items);
    assert!(ariadne_domain::visibility::item_is_removed(
        &deleted,
        &deleted.items.0[&item("1")]
    ));
    let mut redelete = request(1556);
    redelete
        .expected_topic_revisions
        .0
        .insert(id(5), deleted.topics.0[&id(5)].revision);
    redelete.operations = delete.operations;
    assert!(agent_removals(&setup.execute(&redelete).unwrap()).is_empty());
    let restored_receipt = HistoryActionService::new(&setup.registry)
        .execute(
            &owner_route(),
            &OwnerCommand::TopicRemovedRestore {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(1557),
                params: TopicLifecycleParams {
                    topic_id: id(5),
                    expected_revision: deleted.topics.0[&id(5)].revision,
                },
            },
            at(),
        )
        .unwrap();
    let MutationReceipt::Session(restored_receipt) = restored_receipt else {
        panic!("session")
    };
    assert!(matches!(
        restored_receipt.data,
        SavedReceiptData::BinRestore { item_id: None, .. }
    ));
    let restored = setup.saved();
    assert!(!ariadne_domain::visibility::item_is_removed(
        &restored,
        &restored.items.0[&item("1")]
    ));
    assert!(ariadne_domain::visibility::item_is_removed(
        &restored,
        &restored.items.0[&item("1.1")]
    ));
    assert_eq!(restored.inputs.0[&item_input].state, InputState::Cancelled);
    assert_eq!(restored.inputs.0[&topic_input].state, InputState::Cancelled);
}

#[test]
fn agent_delete_forever_reuses_owner_removal_and_backup() {
    let setup = Setup::new(&seed());
    let mut delete = guarded(
        1560,
        "1",
        setup.saved().items.0[&item("1")].revision.value(),
    );
    delete.operations.push(Operation::ItemDelete {
        item: existing("1"),
    });
    setup.execute(&delete).unwrap();
    let receipt = HistoryActionService::new(&setup.registry)
        .remove(
            &owner_route(),
            &OwnerCommand::ItemRemove {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(1561),
                params: ItemRemoveParams {
                    item_id: item("1"),
                    expected_revision: setup.saved().items.0[&item("1")].revision,
                },
            },
            || id(setup.next.fetch_add(1, Ordering::SeqCst)),
            at(),
        )
        .unwrap();
    let MutationReceipt::Session(receipt) = receipt else {
        panic!("session")
    };
    let SavedReceiptData::Removal { backup, .. } = receipt.data else {
        panic!("removal")
    };
    assert!(std::path::Path::new(&backup).is_file());
    assert!(!setup.saved().items.0.contains_key(&item("1")));
    assert!(restore_item(&setup, "1", p(1), 1562).is_err());
}

#[test]
fn agent_delete_blocks_new_work_owner_inputs_and_ack_until_restored() {
    let setup = Setup::new(&seed());
    let mut delete = guarded(
        1570,
        "1",
        setup.saved().items.0[&item("1")].revision.value(),
    );
    delete.operations.push(Operation::ItemDelete {
        item: existing("1"),
    });
    setup.execute(&delete).unwrap();
    let mut child = guarded(
        1571,
        "1",
        setup.saved().items.0[&item("1")].revision.value(),
    );
    child
        .operations
        .push(add("hidden_child", uuid(5), Some(existing("1")), false));
    setup.rejected(&child, CoreErrorCode::InvalidTransition);
    let before = setup.bytes();
    let submit = OwnerCommand::InputSubmit {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(1572),
        params: InputSubmitParams {
            binding_id: id(3),
            kind: InputKind::Reply,
            target: InputTarget {
                topic_id: id(5),
                item_id: Some(item("1")),
            },
            text: "Do more work".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    let error = InputService::new(&setup.registry)
        .execute(&owner_route(), &submit, || id(20000), at())
        .unwrap_err();
    assert!(
        matches!(error, ariadne_core::inputs::InputError::Core(error) if error.code == CoreErrorCode::InvalidTransition && error.message.contains("Restore"))
    );
    let ack = OwnerCommand::Ack {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(1573),
        params: ItemAckParams {
            item_id: item("1"),
            expected_revision: setup.saved().items.0[&item("1")].revision,
        },
    };
    let error = HistoryActionService::new(&setup.registry)
        .acknowledge(&owner_route(), &ack, at(), || id(20001))
        .unwrap_err();
    assert!(
        matches!(error, ariadne_core::history_actions::HistoryActionError::Core(error) if error.code == CoreErrorCode::InvalidTransition)
    );
    assert_eq!(setup.bytes(), before);
    restore_item(
        &setup,
        "1",
        setup.saved().items.0[&item("1")].revision,
        1574,
    )
    .unwrap();
    InputService::new(&setup.registry)
        .execute(
            &owner_route(),
            &submit,
            || id(setup.next.fetch_add(1, Ordering::SeqCst)),
            at(),
        )
        .unwrap();
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
        ack_to: None,
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
        related: None,
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
        self.prepare_kind(turn, InputKind::Reply, "Original immutable owner message.")
    }
    fn prepare_kind(&self, turn: TurnState, kind: InputKind, text: &str) -> UuidV4 {
        let expected_question_revision =
            (kind == InputKind::Answer).then(|| self.saved().items.0[&item("1")].question_revision);
        let command = OwnerCommand::InputSubmit {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(700),
            params: InputSubmitParams {
                binding_id: id(3),
                target: InputTarget {
                    topic_id: id(5),
                    item_id: Some(item("1")),
                },
                kind,
                text: text.into(),
                selected_option_id: None,
                expected_question_revision,
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
        let number = self.saved().messages.last().unwrap().number.value();
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
            binding.issued_through_message_number = NonnegativeSafeInteger::new(number).unwrap();
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
        let mut result = result();
        result.handled_through_message_number = p(self
            .context(Some(source))
            .read_scope()
            .issued_through_message_number()
            .value());
        r.input_result = Some(result);
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
                related: None,
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
                related: None,
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
fn committed_result_handles_input_after_failed_interrupted_or_uncertain_turn() {
    // Owner rule: a committed input_result wins over any host turn status.
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
        assert_eq!(i.state, InputState::Handled, "{turn:?}");
        assert!(i.attempts[0].domain_result.is_some());
        assert!(i.attempts[0].sealed_at.is_some());
        let binding = &s.bindings.0[&id(3)];
        assert_ne!(binding.dispatch_state, DispatchState::RecoveryRequired);
        assert_eq!(binding.pause_reason, None);
        assert_eq!(binding.active_input_id, None);
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
        ack_to: None,
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
            ack_to: None,
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
fn agent_writes_to_an_archived_topic_refuse_with_topic_archived_until_restore() {
    // Owner rule: an archived topic takes no agent edits, status changes,
    // replies or new items; restore reopens it to the agent.
    let setup = Setup::new(&seed());
    setup.write(11, |s| {
        s.topics.0.get_mut(&id(5)).unwrap().archived_at = Some(at())
    });
    let mut status = guarded(20, "1", 1);
    status.operations = vec![Operation::ItemStatus {
        ack_to: None,
        item: existing("1"),
        status: ItemStatus::Done,
        outcome: Some("Resolved explicitly".into()),
        why: Some("Evidence inspected".into()),
        reason: None,
    }];
    let mut answer = guarded(21, "1", 1);
    answer.operations = vec![reply(existing("1"), "response", "Archived")];
    let mut added = request(22);
    added.operations = vec![add("new", uuid(5), None, false)];
    for r in [&status, &answer, &added] {
        let before = setup.bytes();
        let e = core_error(setup.execute(r).unwrap_err());
        assert_eq!(e.code, CoreErrorCode::InvalidTransition, "{e:?}");
        assert_eq!(
            e.details.unwrap().reason,
            Some(BarrierReason::TopicArchived)
        );
        assert_eq!(setup.bytes(), before);
    }
    setup.write(12, |s| {
        s.topics.0.get_mut(&id(5)).unwrap().archived_at = None
    });
    setup.execute(&answer).unwrap();
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

#[test]
fn item_links_are_saved_by_add_and_patch_even_when_targets_are_missing() {
    let setup = Setup::new(&seed());
    let links = vec![ItemLinkTarget {
        kind: LinkKind::Item,
        label: "Earlier item".into(),
        target: "99.2".into(),
    }];
    let mut create = request(10);
    let mut operation = add("linked", uuid(5), None, false);
    if let Operation::ItemAdd(draft) = &mut operation {
        draft.links = Some(links.clone());
    }
    create.operations = vec![operation];
    create.validate_wire().unwrap();
    setup.execute(&create).unwrap();
    assert_eq!(setup.saved().items.0[&item("3")].links, links);

    let mut edit = guarded(11, "1", 1);
    edit.operations = vec![Operation::ItemEdit {
        item: existing("1"),
        patch: ItemPatch {
            question: None,
            item_type: None,
            note: None,
            links: Some(links.clone()),
            related: None,
            short: None,
        },
    }];
    edit.validate_wire().unwrap();
    setup.execute(&edit).unwrap();
    assert_eq!(setup.saved().items.0[&item("1")].links, links);
}

#[test]
fn malformed_item_links_are_rejected_on_add_and_patch_without_saving_anything() {
    let setup = Setup::new(&seed());
    for target in ["item:3.2", "0", "01", "3..2", "9007199254740992", "3.2\n"] {
        let links = vec![ItemLinkTarget {
            kind: LinkKind::Item,
            label: "Related item".into(),
            target: target.into(),
        }];
        let mut create = request(10);
        let mut operation = add("linked", uuid(5), None, false);
        if let Operation::ItemAdd(draft) = &mut operation {
            draft.links = Some(links.clone());
        }
        create.operations = vec![operation];
        let mut edit = guarded(11, "1", 1);
        edit.operations = vec![Operation::ItemEdit {
            item: existing("1"),
            patch: ItemPatch {
                question: None,
                item_type: None,
                note: None,
                links: Some(links),
                related: None,
                short: None,
            },
        }];
        for request in [create, edit] {
            assert_eq!(
                request.validate_wire().unwrap_err().code,
                CoreErrorCode::InvalidArgument,
                "{target:?}"
            );
            setup.rejected(&request, CoreErrorCode::InvalidArgument);
        }
    }
    assert_eq!(setup.saved(), seed());
}

fn short_patch(short: Option<Option<&str>>) -> Operation {
    Operation::ItemEdit {
        item: existing("1"),
        patch: ItemPatch {
            question: None,
            item_type: None,
            note: None,
            links: None,
            related: None,
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
    let before = revision(&setup);
    setup.execute(&set).unwrap();
    // A `short`-only edit still bumps the item revision.
    assert_eq!(revision(&setup), before + 1);
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

fn related_patch(target: EntityRef, related: Option<Vec<EntityRef>>) -> Operation {
    Operation::ItemEdit {
        item: target,
        patch: ItemPatch {
            question: None,
            item_type: None,
            note: None,
            links: None,
            related,
            short: None,
        },
    }
}

#[test]
fn related_links_resolve_existing_and_earlier_local_items_across_topics() {
    let setup = Setup::new(&seed());
    let mut r = guarded(10, "1", 1);
    let mut linked = add("linked", uuid_local("other_topic"), None, false);
    if let Operation::ItemAdd(draft) = &mut linked {
        draft.related = Some(vec![existing("1"), local("earlier")]);
    }
    r.operations = vec![
        Operation::TopicAdd {
            r#ref: RequestRef::new("other_topic").unwrap(),
            name: "Cross-topic links".into(),
            short: None,
        },
        add("earlier", uuid(5), None, false),
        linked,
        related_patch(existing("1"), Some(vec![local("linked")])),
    ];
    setup.execute(&r).unwrap();
    let saved = setup.saved();
    assert_eq!(
        saved.items.0[&item("4")].related,
        Some(vec![item("1"), item("3")])
    );
    assert_eq!(saved.items.0[&item("1")].related, Some(vec![item("4")]));
    assert_ne!(
        saved.items.0[&item("1")].topic_id,
        saved.items.0[&item("4")].topic_id
    );
    // A link reads its target without changing or revision-guarding it.
    assert_eq!(saved.items.0[&item("3")].revision, p(1));
    assert_eq!(saved.items.0[&item("2")], seed().items.0[&item("2")]);
}

#[test]
fn related_patch_omitted_or_null_keeps_and_empty_list_clears() {
    let mut session = seed();
    session.items.0.get_mut(&item("1")).unwrap().related = Some(vec![item("99")]);
    let setup = Setup::new(&session);
    for (op, patch_json) in [(10, "{}"), (11, r#"{"related":null}"#)] {
        let patch: ItemPatch = serde_json::from_str(patch_json).unwrap();
        let mut r = guarded(op, "1", op - 9);
        r.operations = vec![Operation::ItemEdit {
            item: existing("1"),
            patch,
        }];
        setup.execute(&r).unwrap();
        assert_eq!(
            setup.saved().items.0[&item("1")].related,
            Some(vec![item("99")])
        );
    }
    let mut r = guarded(12, "1", 3);
    r.operations = vec![related_patch(existing("1"), Some(vec![]))];
    setup.execute(&r).unwrap();
    assert_eq!(setup.saved().items.0[&item("1")].related, Some(vec![]));
}

#[test]
fn related_links_reject_self_duplicates_missing_and_forward_refs_atomically() {
    for references in [
        vec![existing("3")], // allocated source itself
        vec![local("linked")],
        vec![existing("1"), existing("1")],
        vec![existing("99")],
        vec![local("later")],
    ] {
        let setup = Setup::new(&seed());
        let mut r = request(10);
        let mut operation = add("linked", uuid(5), None, false);
        if let Operation::ItemAdd(draft) = &mut operation {
            draft.related = Some(references);
        }
        r.operations = vec![operation, add("later", uuid(5), None, false)];
        setup.rejected(&r, CoreErrorCode::InvalidRef);
    }
    for references in [
        vec![existing("1")],
        vec![existing("2"), existing("2")],
        vec![existing("99")],
    ] {
        let setup = Setup::new(&seed());
        let mut r = guarded(10, "1", 1);
        r.operations = vec![related_patch(existing("1"), Some(references))];
        setup.rejected(&r, CoreErrorCode::InvalidRef);
    }
    let setup = Setup::new(&seed());
    let mut aliases = request(10);
    let mut linked = add("linked", uuid(5), None, false);
    if let Operation::ItemAdd(draft) = &mut linked {
        draft.related = Some(vec![existing("3"), local("earlier")]);
    }
    aliases.operations = vec![add("earlier", uuid(5), None, false), linked];
    setup.rejected(&aliases, CoreErrorCode::InvalidRef);
}

#[test]
fn related_targets_in_another_session_do_not_resolve() {
    let setup = Setup::new(&seed());
    let mut other = seed();
    other.id = id(20);
    let mut third = other.items.0[&item("2")].clone();
    third.id = item("3");
    third.ordinal = p(3);
    other.counters.next_root = p(4);
    other
        .messages
        .iter_mut()
        .find(|message| message.id == third.created_message_id)
        .unwrap()
        .items_touched
        .push(item("3"));
    other.items.0.insert(item("3"), third);
    setup.store().create(&other).unwrap();
    let mut r = guarded(10, "1", 1);
    r.operations = vec![related_patch(existing("1"), Some(vec![existing("3")]))];
    let before = setup.bytes();
    let error = core_error(setup.execute(&r).unwrap_err());
    assert_eq!(error.code, CoreErrorCode::InvalidRef);
    assert_eq!(
        error.message,
        "item.edit: related item 3 does not exist in this session; remove that link"
    );
    assert_eq!(setup.bytes(), before);
    assert_eq!(setup.store().read(&id(20)).unwrap(), other);
}

#[test]
fn old_session_reads_keep_the_original_bytes_and_omit_related() {
    let setup = Setup::new(&seed());
    let path = store_dir(setup._home.path(), 1)
        .join("sessions")
        .join(format!("{}.json", id(2).as_str()));
    let original = include_bytes!("../../../fixtures/domain/history/seed.json");
    fs::write(path, original).unwrap();
    let loaded = setup.saved();
    assert!(loaded.items.0.values().all(|item| item.related.is_none()));
    assert_eq!(setup.bytes(), original);
    let emitted = serde_json::to_value(loaded).unwrap();
    assert!(emitted["items"]
        .as_object()
        .unwrap()
        .values()
        .all(|item| item.get("related").is_none()));
}

#[test]
fn resending_declared_missing_targets_prunes_and_reports_them_in_saved_and_compact_receipts() {
    let mut session = seed();
    session.items.0.get_mut(&item("1")).unwrap().related = Some(vec![item("2"), item("99")]);
    let setup = Setup::new(&session);
    let mut r = guarded(10, "1", 1);
    r.operations = vec![related_patch(
        existing("1"),
        Some(vec![existing("99"), existing("2")]),
    )];
    let receipt = setup.execute(&r).unwrap();
    let saved = setup.saved();
    assert_eq!(saved.items.0[&item("1")].related, Some(vec![item("2")]));
    let expected = Some(UniqueMap(std::collections::BTreeMap::from([(
        item("1"),
        vec![item("99")],
    )])));
    let SavedReceiptData::Apply { pruned_related, .. } = &receipt.data else {
        panic!("apply")
    };
    assert_eq!(pruned_related, &expected);
    assert_eq!(
        ariadne_core::apply::summarize(&saved, &receipt)
            .unwrap()
            .pruned_related,
        expected
    );
    // Replays retain the pruning evidence even though the target is no longer declared.
    assert_eq!(setup.execute(&r).unwrap(), receipt);
    // A newly introduced missing number still refuses the whole batch without losing data.
    let mut new_missing = guarded(11, "1", 2);
    new_missing.operations = vec![related_patch(existing("1"), Some(vec![existing("98")]))];
    setup.rejected(&new_missing, CoreErrorCode::InvalidRef);
}

#[test]
fn related_refusals_identify_operation_and_target_number_or_batch_ref() {
    for (references, target, reason) in [
        (vec![existing("1")], "1", "itself"),
        (vec![existing("2"), existing("2")], "2", "more than once"),
        (vec![existing("99")], "99", "does not exist"),
        (
            vec![local("notse")],
            "notse",
            "no item in this batch has ref 'notse'",
        ),
    ] {
        let setup = Setup::new(&seed());
        let mut r = guarded(10, "1", 1);
        r.operations = vec![related_patch(existing("1"), Some(references))];
        let error = core_error(setup.execute(&r).unwrap_err());
        assert!(error.message.contains("item.edit"), "{error:?}");
        assert!(error.message.contains(target), "{error:?}");
        assert!(error.message.contains(reason), "{error:?}");
    }
    for (references, target) in [
        (vec![existing("3")], "3"),
        (vec![local("linked")], "linked"),
        (vec![existing("2"), existing("2")], "2"),
        (vec![existing("99")], "99"),
        (vec![local("notes")], "notes"),
    ] {
        let setup = Setup::new(&seed());
        let mut r = request(10);
        let mut operation = add("linked", uuid(5), None, false);
        if let Operation::ItemAdd(draft) = &mut operation {
            draft.related = Some(references);
        }
        r.operations = vec![operation];
        let error = core_error(setup.execute(&r).unwrap_err());
        assert!(error.message.contains("item.add"), "{error:?}");
        assert!(error.message.contains(target), "{error:?}");
    }
}

#[test]
fn batch_caps_related_at_32_on_add_and_edit_before_resolving_targets() {
    for edit in [true, false] {
        let setup = Setup::new(&seed());
        let mut r = guarded(10, "1", 1);
        let references = (10..43).map(|n| existing(&n.to_string())).collect();
        if edit {
            r.operations = vec![related_patch(existing("1"), Some(references))];
        } else {
            let mut operation = add("linked", uuid(5), None, false);
            if let Operation::ItemAdd(draft) = &mut operation {
                draft.related = Some(references);
            }
            r.operations = vec![operation];
        }
        let before = setup.bytes();
        let error = core_error(setup.execute(&r).unwrap_err());
        assert_eq!(error.code, CoreErrorCode::InvalidArgument);
        assert!(error
            .message
            .contains(if edit { "item.edit" } else { "item.add" }));
        assert!(error.message.contains("at most 32"));
        assert_eq!(setup.bytes(), before);
    }
}
#[test]
fn strict_creation_rejects_every_terminal_state_without_touching_store() {
    let setup = Setup::new(&seed());
    for status in [
        ItemStatus::Decided,
        ItemStatus::Done,
        ItemStatus::Dropped,
        ItemStatus::Replaced,
    ] {
        let mut request = request(990);
        let mut operation = add("new", uuid(5), None, false);
        let Operation::ItemAdd(draft) = &mut operation else {
            unreachable!()
        };
        draft.status = status;
        draft.related = Some(vec![existing("2")]);
        draft.outcome = Some("Proposed outcome".into());
        draft.why = Some("Reason".into());
        request.operations.push(operation);
        assert_eq!(
            request.validate_wire().unwrap_err().code,
            CoreErrorCode::InvalidArgument
        );
        let before = setup.bytes();
        assert_eq!(
            core_error(setup.execute(&request).unwrap_err()).code,
            CoreErrorCode::InvalidArgument
        );
        assert_eq!(setup.bytes(), before);
    }
}

#[test]
fn batch_cannot_complete_an_item_created_in_that_batch() {
    let setup = Setup::new(&seed());
    for status in [ItemStatus::Decided, ItemStatus::Done, ItemStatus::Dropped] {
        let mut r = request(990);
        r.operations.push(add("new", uuid(5), None, false));
        r.operations.push(Operation::ItemStatus {
            ack_to: None,
            item: local("new"),
            status,
            outcome: Some("Outcome".into()),
            why: Some("Reason".into()),
            reason: None,
        });
        let before = setup.bytes();
        assert_eq!(
            core_error(setup.execute(&r).unwrap_err()).code,
            CoreErrorCode::InvalidArgument
        );
        assert_eq!(setup.bytes(), before);
    }
    let mut r = guarded(990, "2", 1);
    r.operations.push(add("new", uuid(5), None, false));
    r.operations.push(Operation::ItemReplace {
        item: local("new"),
        replacement: existing("2"),
        outcome: "Outcome".into(),
        why: "Reason".into(),
    });
    assert_eq!(
        core_error(setup.execute(&r).unwrap_err()).code,
        CoreErrorCode::InvalidArgument
    );
}

#[test]
fn open_creation_with_ack_proposal_preserves_completion_prose() {
    let setup = Setup::new(&seed());
    let mut r = request(990);
    let mut op = add("new", uuid(5), None, false);
    let Operation::ItemAdd(draft) = &mut op else {
        unreachable!()
    };
    draft.ack_to = Some(AckTarget::Done);
    draft.outcome = Some("Exact complete result.".into());
    draft.why = Some("Exact justification.".into());
    r.operations.push(op);
    let result = setup.execute(&r).unwrap();
    let SavedReceiptData::Apply { allocated_refs, .. } = result.data else {
        unreachable!()
    };
    let AllocatedRef::Item { id } = &allocated_refs.0[&RequestRef::new("new").unwrap()] else {
        unreachable!()
    };
    let saved = setup.saved();
    let item = &saved.items.0[id];
    assert_eq!(item.status, ItemStatus::Open);
    assert_eq!(item.ack_to, Some(AckTarget::Done));
    assert_eq!(item.outcome.as_deref(), Some("Exact complete result."));
    assert_eq!(item.why.as_deref(), Some("Exact justification."));
}

#[test]
fn agents_finish_summaries_by_proposing_ack_and_cannot_close_them() {
    for status in [ItemStatus::Open, ItemStatus::InProgress] {
        let mut source = seed();
        let summary = source.items.0.get_mut(&item("1")).unwrap();
        summary.status = ItemStatus::InProgress;
        summary.ask = None;
        summary.waiting_since = None;
        let setup = Setup::new(&source);
        let mut r = guarded(991, "1", 1);
        r.operations.push(Operation::ItemStatus {
            item: existing("1"),
            status: status.clone(),
            ack_to: Some(AckTarget::Done),
            outcome: Some("Exact finished summary\nwith all details.".into()),
            why: Some("Verified locally.".into()),
            reason: Some("Finished work.".into()),
        });
        setup.execute(&r).unwrap();
        let saved = setup.saved();
        let summary = &saved.items.0[&item("1")];
        assert_eq!(summary.status, status);
        assert_eq!(summary.ack_to, Some(AckTarget::Done));
        for target in [ItemStatus::Decided, ItemStatus::Done, ItemStatus::Dropped] {
            let mut close = guarded(992, "1", summary.revision.value());
            close.operations.push(Operation::ItemStatus {
                item: existing("1"),
                status: target,
                ack_to: None,
                outcome: Some("Agent tried to finish.".into()),
                why: Some("Done.".into()),
                reason: None,
            });
            let err = core_error(setup.execute(&close).unwrap_err());
            assert_eq!(err.code, CoreErrorCode::InvalidTransition);
            assert!(err.message.contains("owner's Ack"));
            assert_eq!(setup.saved(), saved);
        }
        let mut replace = guarded(993, "1", summary.revision.value());
        replace.operations.push(Operation::ItemReplace {
            item: existing("1"),
            replacement: existing("2"),
            outcome: "Replaced.".into(),
            why: "Newer.".into(),
        });
        // Superseding work uses its explicit replacement link, clearing Ack.
        let replacement_setup = Setup::new(&saved);
        replacement_setup.next.store(20000, Ordering::SeqCst);
        replacement_setup.execute(&replace).unwrap();
        assert_eq!(replacement_setup.saved().items.0[&item("1")].ack_to, None);
        let mut progress = guarded(994, "1", summary.revision.value());
        progress.operations.push(Operation::ItemStatus {
            item: existing("1"),
            status: ItemStatus::InProgress,
            ack_to: None,
            outcome: None,
            why: None,
            reason: Some("Rechecking.".into()),
        });
        setup.execute(&progress).unwrap();
        let retained = setup.saved();
        let retained = &retained.items.0[&item("1")];
        assert_eq!(retained.ack_to, summary.ack_to);
        assert_eq!(retained.outcome, summary.outcome);
        assert_eq!(retained.why, summary.why);
    }
}

#[test]
fn strict_filing_requires_an_answer_round_and_ack_never_hides_an_unanswered_question() {
    let setup = Setup::new(&seed());
    for status in [ItemStatus::Open, ItemStatus::InProgress] {
        let mut r = request(995);
        let mut op = add("ask", uuid(5), None, true);
        let Operation::ItemAdd(draft) = &mut op else {
            unreachable!()
        };
        draft.status = status;
        draft.ack_to = Some(AckTarget::Done);
        r.operations.push(op);
        setup.rejected(&r, CoreErrorCode::InvalidArgument);
    }
    let mut r = request(996);
    let mut op = add("ask", uuid(5), None, true);
    let Operation::ItemAdd(draft) = &mut op else {
        unreachable!()
    };
    draft.ack_to = Some(AckTarget::Done);
    draft.outcome = Some("Proposed result.".into());
    r.operations.push(op);
    let receipt = setup.execute(&r).unwrap();
    let SavedReceiptData::Apply { allocated_refs, .. } = receipt.data else {
        unreachable!()
    };
    let AllocatedRef::Item { id: ask } = &allocated_refs.0[&RequestRef::new("ask").unwrap()] else {
        unreachable!()
    };
    let saved = setup.saved();
    assert!(saved.items.0[ask].current_round_id.is_some());
    assert!(ariadne_core::queries::waiting_unanswered(
        &saved,
        &saved.items.0[ask]
    ));
    let mut hide = guarded(997, ask.as_str(), 1);
    hide.operations.push(Operation::ItemStatus {
        item: existing(ask.as_str()),
        status: ItemStatus::Open,
        ack_to: Some(AckTarget::Done),
        outcome: None,
        why: None,
        reason: Some("Finished.".into()),
    });
    setup.rejected(&hide, CoreErrorCode::InvalidTransition);
}

#[test]
fn owner_drop_and_close_reply_can_finish_existing_ack_questions() {
    for (kind, text, status) in [
        (InputKind::Drop, "Drop this question.", ItemStatus::Dropped),
        (InputKind::Reply, "close it", ItemStatus::Done),
    ] {
        for lenient in [false, true] {
            let setup = Setup::new(&seed());
            let mut ask = guarded(1001, "1", 1);
            ask.operations.push(Operation::ItemAsk {
                item: existing("1"),
                ask: "Keep this question?".into(),
                options: vec![],
                recipient_binding_id: id(3),
            });
            setup.execute(&ask).unwrap();
            setup.write(1002, |s| {
                s.items.0.get_mut(&item("1")).unwrap().ack_to = Some(AckTarget::Done)
            });
            let source = setup.prepare_kind(TurnState::Completed, kind.clone(), text);
            let mut close = setup.dispatched(1003, &source);
            close.operations.push(Operation::ItemStatus {
                item: existing("1"),
                status: status.clone(),
                ack_to: None,
                outcome: Some("Closed at your request.".into()),
                why: Some("The owner directed it.".into()),
                reason: None,
            });
            if lenient {
                let (_, replayed, repairs) = ApplyService::new(&setup.registry)
                    .execute_lenient(
                        &setup.context(Some(&source)),
                        &close,
                        || id(setup.next.fetch_add(1, Ordering::SeqCst)),
                        at(),
                    )
                    .unwrap();
                assert!(!replayed && repairs.is_empty());
            } else {
                setup.execute(&close).unwrap();
            }
            let saved = setup.saved();
            assert_eq!(saved.items.0[&item("1")].status, status);
            assert_eq!(saved.items.0[&item("1")].ack_to, None);
            assert_eq!(saved.inputs.0[&source].state, InputState::Handled);
        }
    }
}

#[test]
fn owner_input_on_another_item_or_noncompletion_kind_cannot_bypass_ack() {
    for (kind, target) in [
        (InputKind::Drop, "2"),
        (InputKind::Reply, "2"),
        (InputKind::Note, "1"),
        (InputKind::Followup, "1"),
    ] {
        for terminal in [AckTarget::Decided, AckTarget::Done, AckTarget::Dropped] {
            let mut source = seed();
            let proposal = source.items.0.get_mut(&item(target)).unwrap();
            proposal.status = ItemStatus::Open;
            proposal.ack_to = Some(AckTarget::Done);
            proposal.outcome = Some("Original proposal.".into());
            proposal.why = Some("Original evidence.".into());
            assert!(proposal.ask.is_none());
            let setup = Setup::new(&source);
            let input = setup.prepare_kind(TurnState::Completed, kind.clone(), "Owner context.");
            let mut close = setup.dispatched(1015, &input);
            close
                .expected_item_revisions
                .0
                .insert(item(target), setup.saved().items.0[&item(target)].revision);
            close.operations.push(Operation::ItemStatus {
                item: existing(target),
                status: terminal.status(),
                ack_to: None,
                outcome: Some("Revised proposal.".into()),
                why: Some("Revised evidence.".into()),
                reason: None,
            });
            let before = setup.bytes();
            let error = core_error(setup.execute(&close).unwrap_err());
            assert_eq!(error.code, CoreErrorCode::InvalidTransition);
            assert!(error.message.contains("owner's Ack"));
            assert_eq!(setup.bytes(), before);

            let (_, replayed, repairs) = ApplyService::new(&setup.registry)
                .execute_lenient(
                    &setup.context(Some(&input)),
                    &close,
                    || id(setup.next.fetch_add(1, Ordering::SeqCst)),
                    at(),
                )
                .unwrap();
            assert!(!replayed);
            assert_eq!(repairs.len(), 1);
            let saved = setup.saved();
            let proposal = &saved.items.0[&item(target)];
            assert_eq!(proposal.status, ItemStatus::Open);
            assert_eq!(proposal.ack_to, Some(terminal));
            assert_eq!(proposal.outcome.as_deref(), Some("Revised proposal."));
            assert_eq!(proposal.why.as_deref(), Some("Revised evidence."));
            assert_eq!(saved.inputs.0[&input].state, InputState::Handled);
        }
    }
}

#[test]
fn agent_can_drop_its_unanswered_question_without_an_ack_target() {
    let setup = Setup::new(&seed());
    let mut ask = guarded(1004, "1", 1);
    ask.operations.push(Operation::ItemAsk {
        item: existing("1"),
        ask: "Proceed?".into(),
        options: vec![],
        recipient_binding_id: id(3),
    });
    setup.execute(&ask).unwrap();
    let mut hide = guarded(
        1014,
        "1",
        setup.saved().items.0[&item("1")].revision.value(),
    );
    hide.operations.push(Operation::ItemStatus {
        item: existing("1"),
        status: ItemStatus::Open,
        ack_to: None,
        outcome: None,
        why: None,
        reason: Some("Question pending.".into()),
    });
    let error = core_error(setup.execute(&hide).unwrap_err());
    assert_eq!(error.code, CoreErrorCode::InvalidTransition);
    for guidance in [
        "item.ask",
        "waiting_on_me",
        "ack_to \"dropped\"",
        "new item",
        "item.replace",
    ] {
        assert!(error.message.contains(guidance), "{}", error.message);
    }
    let mut close = guarded(
        1005,
        "1",
        setup.saved().items.0[&item("1")].revision.value(),
    );
    close.operations.push(Operation::ItemStatus {
        item: existing("1"),
        status: ItemStatus::Dropped,
        ack_to: None,
        outcome: Some("Question withdrawn.".into()),
        why: Some("No longer needed.".into()),
        reason: None,
    });
    setup.execute(&close).unwrap();
    assert_eq!(
        setup.saved().items.0[&item("1")].status,
        ItemStatus::Dropped
    );
}

#[test]
fn lenient_ack_repair_is_locked_state_aware_and_replays_after_owner_ack() {
    for target in [AckTarget::Decided, AckTarget::Done, AckTarget::Dropped] {
        let mut source = seed();
        source.items.0.get_mut(&item("1")).unwrap().ack_to = Some(AckTarget::Done);
        let setup = Setup::new(&source);
        let mut close = guarded(1006, "1", 1);
        close.operations.push(Operation::ItemStatus {
            item: existing("1"),
            status: target.status(),
            ack_to: None,
            outcome: Some("Exact outcome.".into()),
            why: Some("Exact evidence.".into()),
            reason: None,
        });
        let service = ApplyService::new(&setup.registry);
        let context = setup.context(None);
        let (preview, repairs) = service
            .preview_lenient(
                &context,
                &close,
                || id(setup.next.fetch_add(1, Ordering::SeqCst)),
                at(),
            )
            .unwrap();
        assert_eq!(repairs.len(), 1);
        assert_eq!(setup.saved(), source);
        assert_eq!(preview.session.items.0[&item("1")].ack_to, Some(target));
        let (receipt, replayed, repairs) = service
            .execute_lenient(
                &context,
                &close,
                || id(setup.next.fetch_add(1, Ordering::SeqCst)),
                at(),
            )
            .unwrap();
        assert!(!replayed && repairs.len() == 1);
        let saved = setup.saved();
        assert_eq!(saved.items.0[&item("1")].status, ItemStatus::Open);
        assert_eq!(
            saved.items.0[&item("1")].outcome.as_deref(),
            Some("Exact outcome.")
        );
        ariadne_core::history_actions::HistoryActionService::new(&setup.registry)
            .acknowledge(
                &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
                    RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
                )),
                &OwnerCommand::Ack {
                    api_version: SchemaVersion::new(1).unwrap(),
                    op_id: id(1007),
                    params: ItemAckParams {
                        item_id: item("1"),
                        expected_revision: saved.items.0[&item("1")].revision,
                    },
                },
                at(),
                || id(1008),
            )
            .unwrap();
        let after_ack = setup.saved();
        let (replay, replayed, repairs) = service
            .execute_lenient(
                &context,
                &close,
                || panic!("replay allocates nothing"),
                at(),
            )
            .unwrap();
        assert_eq!(replay, receipt);
        assert!(replayed && repairs.is_empty());
        assert_eq!(setup.saved(), after_ack);
        assert_eq!(after_ack.items.0[&item("1")].status, target.status());
    }
}

#[test]
fn handled_clarification_cannot_abandon_an_unanswered_waiting_question() {
    for kind in [InputKind::Reply, InputKind::Followup] {
        for status in [ItemStatus::Open, ItemStatus::InProgress] {
            for ack_to in [None, Some(AckTarget::Done)] {
                let setup = Setup::new(&seed());
                let mut ask = guarded(1016, "1", 1);
                ask.operations.push(Operation::ItemAsk {
                    item: existing("1"),
                    ask: "Choose A or B?".into(),
                    options: vec![],
                    recipient_binding_id: id(3),
                });
                setup.execute(&ask).unwrap();
                let source =
                    setup.prepare_kind(TurnState::Completed, kind.clone(), "What does B mean?");
                let mut explanation = setup.dispatched(1017, &source);
                explanation.operations = vec![reply(
                    existing("1"),
                    "response",
                    "B means keeping the existing behavior. Which do you choose?",
                )];
                setup.execute(&explanation).unwrap();
                let saved = setup.saved();
                let question = &saved.items.0[&item("1")];
                assert_eq!(question.status, ItemStatus::WaitingOnMe);
                assert!(question.current_round_id.is_some());
                assert_eq!(saved.inputs.0[&source].state, InputState::Handled);
                assert!(saved.answers.is_empty());
                assert!(ariadne_core::queries::waiting_unanswered(&saved, question));

                let mut hide = guarded(1018, "1", question.revision.value());
                hide.operations.push(Operation::ItemStatus {
                    item: existing("1"),
                    status: status.clone(),
                    ack_to,
                    outcome: ack_to.map(|_| "Explained B.".into()),
                    why: ack_to.map(|_| "The clarification was handled.".into()),
                    reason: Some("Finished explaining.".into()),
                });
                setup.rejected(&hide, CoreErrorCode::InvalidTransition);
            }
        }
    }
}

#[test]
fn same_turn_followup_note_or_bring_cannot_abandon_an_unanswered_waiting_question() {
    for kind in [InputKind::Followup, InputKind::Note, InputKind::Bring] {
        for status in [ItemStatus::Open, ItemStatus::InProgress] {
            for ack_to in [None, Some(AckTarget::Done)] {
                for lenient in [false, true] {
                    let setup = Setup::new(&seed());
                    let mut ask = guarded(1019, "1", 1);
                    ask.operations.push(Operation::ItemAsk {
                        item: existing("1"),
                        ask: "Choose A or B?".into(),
                        options: vec![],
                        recipient_binding_id: id(3),
                    });
                    setup.execute(&ask).unwrap();
                    let source =
                        setup.prepare_kind(TurnState::Completed, kind.clone(), "What does B mean?");
                    let mut hide = setup.dispatched(1020, &source);
                    hide.operations.push(Operation::ItemStatus {
                        item: existing("1"),
                        status: status.clone(),
                        ack_to,
                        outcome: ack_to.map(|_| "Explained B.".into()),
                        why: ack_to.map(|_| "The follow-up was handled.".into()),
                        reason: Some("Finished explaining.".into()),
                    });
                    let before = setup.bytes();
                    let error = if lenient {
                        ApplyService::new(&setup.registry)
                            .execute_lenient(
                                &setup.context(Some(&source)),
                                &hide,
                                || id(setup.next.fetch_add(1, Ordering::SeqCst)),
                                at(),
                            )
                            .unwrap_err()
                    } else {
                        setup.execute(&hide).unwrap_err()
                    };
                    let error = core_error(error);
                    assert_eq!(error.code, CoreErrorCode::InvalidTransition);
                    assert!(error.message.contains("question still waits"), "{error:?}");
                    assert!(error.message.contains("item.ask"), "{error:?}");
                    assert_eq!(setup.bytes(), before);
                    let saved = setup.saved();
                    assert_eq!(saved.items.0[&item("1")].status, ItemStatus::WaitingOnMe);
                    assert_eq!(saved.inputs.0[&source].state, InputState::InFlight);
                }
            }
        }
    }
}

#[test]
fn owner_bring_or_reopen_can_reopen_terminal_questions() {
    for kind in [InputKind::Bring, InputKind::Reopen] {
        for answered in [false, true] {
            for status in [ItemStatus::Open, ItemStatus::InProgress] {
                for lenient in [false, true] {
                    let setup = Setup::new(&seed());
                    let mut ask = guarded(1024, "1", 1);
                    ask.operations.push(Operation::ItemAsk {
                        item: existing("1"),
                        ask: "Choose A or B?".into(),
                        options: vec![],
                        recipient_binding_id: id(3),
                    });
                    setup.execute(&ask).unwrap();
                    if answered {
                        InputService::new(&setup.registry)
                            .execute(
                                &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
                                    RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
                                )),
                                &OwnerCommand::InputSubmit {
                                    api_version: SchemaVersion::new(1).unwrap(),
                                    op_id: id(1025),
                                    params: InputSubmitParams {
                                        binding_id: id(3),
                                        target: InputTarget {
                                            topic_id: id(5),
                                            item_id: Some(item("1")),
                                        },
                                        kind: InputKind::Answer,
                                        text: "Choose B.".into(),
                                        selected_option_id: None,
                                        expected_question_revision: Some(
                                            setup.saved().items.0[&item("1")].question_revision,
                                        ),
                                        supersedes_answer_id: None,
                                    },
                                },
                                || id(setup.next.fetch_add(1, Ordering::SeqCst)),
                                at(),
                            )
                            .unwrap();
                        setup.write(1026, |s| {
                            s.bindings
                                .0
                                .get_mut(&id(3))
                                .unwrap()
                                .issued_through_message_number = NonnegativeSafeInteger::new(
                                s.messages.last().unwrap().number.value(),
                            )
                            .unwrap();
                        });
                    }
                    let saved = setup.saved();
                    assert_eq!(
                        ariadne_core::queries::waiting_unanswered(
                            &saved,
                            &saved.items.0[&item("1")]
                        ),
                        !answered,
                    );
                    let mut close = guarded(1027, "1", saved.items.0[&item("1")].revision.value());
                    close.operations.push(Operation::ItemStatus {
                        item: existing("1"),
                        status: ItemStatus::Done,
                        ack_to: None,
                        outcome: Some("Finished.".into()),
                        why: Some("No further work needed.".into()),
                        reason: None,
                    });
                    setup.execute(&close).unwrap();
                    assert_eq!(setup.saved().items.0[&item("1")].status, ItemStatus::Done);
                    let source =
                        setup.prepare_kind(TurnState::Completed, kind.clone(), "Revisit this.");
                    let mut reopen = setup.dispatched(1028, &source);
                    reopen.operations.push(Operation::ItemStatus {
                        item: existing("1"),
                        status: status.clone(),
                        ack_to: None,
                        outcome: None,
                        why: None,
                        reason: Some("Owner requested revisiting this.".into()),
                    });
                    if lenient {
                        let (_, replayed, repairs) = ApplyService::new(&setup.registry)
                            .execute_lenient(
                                &setup.context(Some(&source)),
                                &reopen,
                                || id(setup.next.fetch_add(1, Ordering::SeqCst)),
                                at(),
                            )
                            .unwrap();
                        assert!(!replayed && repairs.is_empty());
                    } else {
                        setup.execute(&reopen).unwrap();
                    }
                    let saved = setup.saved();
                    let question = &saved.items.0[&item("1")];
                    assert_eq!(question.status, status);
                    assert_eq!(question.ask.as_deref(), Some("Choose A or B?"));
                    assert_eq!(saved.inputs.0[&source].state, InputState::Handled);
                    assert_eq!(saved.answers.len(), usize::from(answered));
                }
            }
        }
    }
}

#[test]
fn same_turn_reply_answer_or_drop_can_leave_waiting_for_ack() {
    for kind in [InputKind::Reply, InputKind::Answer, InputKind::Drop] {
        for status in [ItemStatus::Open, ItemStatus::InProgress] {
            for lenient in [false, true] {
                let setup = Setup::new(&seed());
                let mut ask = guarded(1021, "1", 1);
                ask.operations.push(Operation::ItemAsk {
                    item: existing("1"),
                    ask: "Choose A or B?".into(),
                    options: vec![],
                    recipient_binding_id: id(3),
                });
                setup.execute(&ask).unwrap();
                let source = setup.prepare_kind(TurnState::Completed, kind.clone(), "Choose B.");
                let mut finished = setup.dispatched(1022, &source);
                finished.operations.push(Operation::ItemStatus {
                    item: existing("1"),
                    status: status.clone(),
                    ack_to: Some(AckTarget::Done),
                    outcome: Some("Ready.".into()),
                    why: Some("Owner replied.".into()),
                    reason: Some("Ready for Ack.".into()),
                });
                if lenient {
                    let (_, replayed, repairs) = ApplyService::new(&setup.registry)
                        .execute_lenient(
                            &setup.context(Some(&source)),
                            &finished,
                            || id(setup.next.fetch_add(1, Ordering::SeqCst)),
                            at(),
                        )
                        .unwrap();
                    assert!(!replayed && repairs.is_empty());
                } else {
                    setup.execute(&finished).unwrap();
                }
                let saved = setup.saved();
                let question = &saved.items.0[&item("1")];
                assert_eq!(question.status, status);
                assert_eq!(question.ack_to, Some(AckTarget::Done));
                assert_eq!(question.outcome.as_deref(), Some("Ready."));
                assert_eq!(saved.inputs.0[&source].state, InputState::Handled);
                assert!(!ariadne_core::queries::waiting_unanswered(&saved, question));
            }
        }
    }
}

#[test]
fn same_turn_bring_or_reopen_cannot_leave_an_open_ask_unanswered() {
    for kind in [InputKind::Bring, InputKind::Reopen] {
        for status in [ItemStatus::Open, ItemStatus::InProgress] {
            for edit in [false, true] {
                for lenient in [false, true] {
                    // Older stored items may already contain an Open ask.
                    let mut session = seed();
                    let question = session.items.0.get_mut(&item("1")).unwrap();
                    question.status = status.clone();
                    question.ask = Some("Choose A or B?".into());
                    let setup = Setup::new(&session);
                    let source =
                        setup.prepare_kind(TurnState::Completed, kind.clone(), "Revisit this.");
                    let mut change = setup.dispatched(1023, &source);
                    change.operations.push(if edit {
                        Operation::ItemEdit {
                            item: existing("1"),
                            patch: ItemPatch {
                                question: None,
                                item_type: None,
                                short: None,
                                note: Some(Some("Revisited.".into())),
                                links: None,
                                related: Some(vec![existing("2")]),
                            },
                        }
                    } else {
                        Operation::ItemStatus {
                            item: existing("1"),
                            status: status.clone(),
                            ack_to: Some(AckTarget::Done),
                            outcome: Some("Revisited.".into()),
                            why: None,
                            reason: Some("Finished revisiting.".into()),
                        }
                    });
                    let before = setup.bytes();
                    let error = if lenient {
                        ApplyService::new(&setup.registry)
                            .execute_lenient(
                                &setup.context(Some(&source)),
                                &change,
                                || id(setup.next.fetch_add(1, Ordering::SeqCst)),
                                at(),
                            )
                            .unwrap_err()
                    } else {
                        setup.execute(&change).unwrap_err()
                    };
                    let error = core_error(error);
                    assert_eq!(error.code, CoreErrorCode::InvalidTransition);
                    assert!(error.message.contains("question still waits"), "{error:?}");
                    assert_eq!(setup.bytes(), before);
                }
            }
        }
    }
}

#[test]
fn handled_reply_keeps_a_proposed_completion_ackable_and_new_questions_answerable() {
    let setup = Setup::new(&seed());
    let mut ask = guarded(1009, "1", 1);
    ask.operations.push(Operation::ItemAsk {
        item: existing("1"),
        ask: "Proceed?".into(),
        options: vec![],
        recipient_binding_id: id(3),
    });
    setup.execute(&ask).unwrap();
    let source = setup.prepare(TurnState::Completed);
    let mut finished = setup.dispatched(1010, &source);
    finished.operations.push(Operation::ItemStatus {
        item: existing("1"),
        status: ItemStatus::Open,
        ack_to: Some(AckTarget::Done),
        outcome: Some("Ready.".into()),
        why: Some("Owner replied.".into()),
        reason: Some("Ready for Ack.".into()),
    });
    setup.execute(&finished).unwrap();
    let saved = setup.saved();
    assert_eq!(saved.inputs.0[&source].state, InputState::Handled);
    let mut edit = guarded(1011, "1", saved.items.0[&item("1")].revision.value());
    edit.operations.push(Operation::ItemEdit {
        item: existing("1"),
        patch: ItemPatch {
            question: Some("A new question?".into()),
            short: None,
            item_type: None,
            note: None,
            links: None,
            related: None,
        },
    });
    setup.rejected(&edit, CoreErrorCode::InvalidTransition);
    ariadne_core::history_actions::HistoryActionService::new(&setup.registry)
        .acknowledge(
            &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
                RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
            )),
            &OwnerCommand::Ack {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(1012),
                params: ItemAckParams {
                    item_id: item("1"),
                    expected_revision: saved.items.0[&item("1")].revision,
                },
            },
            at(),
            || id(1013),
        )
        .unwrap();
    assert_eq!(setup.saved().items.0[&item("1")].status, ItemStatus::Done);
}
