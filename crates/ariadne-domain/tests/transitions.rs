use ariadne_domain::models::*;
use ariadne_domain::transitions::*;
use ariadne_domain::validation::*;
use serde_json::json;

const TIME: &str = "2026-10-03T12:34:56.789Z";

#[test]
fn merged_canonical_demo_and_source_sessions_pass_item_validation() {
    for (name, text) in [
        (
            "demo",
            include_str!("../../../fixtures/domain/demo/session.json"),
        ),
        (
            "source",
            include_str!("../../../fixtures/domain/demo/source-session.json"),
        ),
    ] {
        let session: Session = serde_json::from_str(text).unwrap();
        validate_session_items(&session).unwrap_or_else(|error| panic!("{name}: {error}"));
    }
}

#[test]
fn activity_round_context_can_touch_multiple_items_without_single_item_target() {
    let mut s = session();
    apply(&mut s, &ask(10));
    s.counters.next_root = positive(3);
    s.items.0.insert(reference("2"), item("2", None, 2));
    s.messages[0].item_id = None;
    s.messages[0].items_touched = vec![reference("1"), reference("2")];
    s.messages[0].round_id = Some(uuid(10));
    validate_session_items(&s).unwrap();
    s.messages[0].item_id = Some(reference("2"));
    invalid(&s, ValidationErrorKind::MissingReference);
}

fn uuid(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn reference(value: &str) -> ItemRef {
    ItemRef::new(value).unwrap()
}
fn positive(n: u64) -> PositiveSafeInteger {
    PositiveSafeInteger::new(n).unwrap()
}
fn time() -> UtcMillis {
    UtcMillis::new(TIME).unwrap()
}
fn item(id: &str, parent: Option<&str>, ordinal: u64) -> Item {
    Item {
        id: reference(id),
        ordinal: positive(ordinal),
        topic_id: uuid(1),
        parent: parent.map(reference),
        question: "Which approach?\nPreserve this exact text.".into(),
        short: None,
        item_type: ItemType::Question,
        status: ItemStatus::Open,
        owner: ItemOwner::Agent {
            binding_id: uuid(2),
        },
        revision: positive(1),
        question_revision: positive(1),
        next_child: positive(1),
        ask: None,
        note: None,
        options: vec![],
        links: vec![],
        outcome: None,
        why: None,
        replaced_by: None,
        created_at: time(),
        updated_at: time(),
        created_message_id: uuid(3),
        updated_message_ids: vec![],
        status_history: vec![],
        waiting_since: None,
        recipient_binding_id: None,
        current_round_id: None,
        source_round_id: None,
        origin: None,
    }
}
fn message(id: u64, number: u64, author: MessageAuthor) -> Message {
    let owner = author == MessageAuthor::Owner;
    Message {
        id: uuid(id),
        number: positive(number),
        author,
        kind: if owner {
            MessageKind::OwnerInput
        } else {
            MessageKind::Activity
        },
        body: "Complete original message\nwith newline.".into(),
        created_at: time(),
        item_id: Some(reference("1")),
        topic_id: Some(uuid(1)),
        items_touched: vec![reference("1")],
        binding_id: if owner { None } else { Some(uuid(2)) },
        input_id: owner.then(|| uuid(id + 100)),
        attempt_id: None,
        host_turn_id: None,
        round_id: None,
        origin: None,
    }
}
fn session() -> Session {
    let capability = json!({"supported":true,"conditions":[]});
    let binding: Binding = serde_json::from_value(json!({
        "id":uuid(2),"adapter_id":"example.local","adapter_version":"1.0",
        "protocol_major":1,"config_version":1,"external_session_id":"host-thread",
        "endpoint":{"kind":"local_bridge","name":"test"},"endpoint_fingerprint":"identity",
        "generation":uuid(4),"created_at":TIME,"dispatch_state":"enabled",
        "owner_paused":false,"pause_reason":null,"connection_state":"connected",
        "capabilities":{"existing_session":capability,"deferred_delivery":capability,
          "turn_correlation":capability,"turn_completion":capability,"domain_cli":capability,
          "domain_mcp":capability,"history_reconcile":capability,"streaming_output":capability,
          "final_text_read":capability,"discover_sessions":capability,"delivery_mode":"pull"},
        "active_input_id":null,"issued_through_message_number":10,
        "adapter_config":{"namespace":"example.local","values":{}}
    }))
    .unwrap();
    Session {
        schema_version: SchemaVersion::new(1).unwrap(),
        id: uuid(5),
        project_id: uuid(6),
        title: "Validation test session".into(),
        state: SessionState::Active,
        created_at: time(),
        updated_at: time(),
        revision: positive(1),
        closed_at: None,
        counters: SessionCounters {
            next_root: positive(2),
            next_topic_order: positive(2),
            next_message: positive(2),
            next_input: positive(1),
            next_answer: positive(1),
        },
        active_binding_id: Some(uuid(2)),
        topics: UniqueMap(
            [(
                uuid(1),
                Topic {
                    id: uuid(1),
                    name: "Topic".into(),
                    short: None,
                    order: positive(1),
                    revision: positive(1),
                    created_at: time(),
                    archived_at: None,
                    origin: None,
                },
            )]
            .into(),
        ),
        items: UniqueMap([(reference("1"), item("1", None, 1))].into()),
        messages: vec![message(3, 1, MessageAuthor::Agent)],
        rounds: UniqueMap(Default::default()),
        answers: vec![],
        bindings: UniqueMap([(uuid(2), binding)].into()),
        inputs: UniqueMap(Default::default()),
        operation_receipts: UniqueMap(Default::default()),
        continuations: UniqueMap(Default::default()),
    }
}

fn context(session: &Session) -> TransitionContext {
    let item = &session.items.0[&reference("1")];
    TransitionContext {
        binding_id: uuid(2),
        generation: uuid(4),
        cause_message_id: uuid(3),
        at: time(),
        handled_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
        expected_revision: item.revision,
        expected_question_revision: Some(item.question_revision),
    }
}
fn add_owner_input(session: &mut Session, id: u64, number: u64, state: InputState) {
    let message = message(id, number, MessageAuthor::Owner);
    let input_id = message.input_id.clone().unwrap();
    let item = &session.items.0[&reference("1")];
    session.inputs.0.insert(
        input_id.clone(),
        Input {
            id: input_id,
            seq: positive(number),
            binding_id: uuid(2),
            kind: InputKind::Reply,
            target: InputTarget {
                topic_id: uuid(1),
                item_id: Some(reference("1")),
            },
            message_id: message.id.clone(),
            answer_id: None,
            created_at: time(),
            expected_question_revision: None,
            payload: InputPayload {
                text: message.body.clone(),
                intent: InputKind::Reply,
                target_snapshot: InputTargetSnapshot {
                    topic_name: "Topic".into(),
                    item_question: Some(item.question.clone()),
                    question_revision: Some(item.question_revision),
                    ask: item.ask.clone(),
                    options: item.options.clone(),
                },
                selected_option_id: None,
                context: InputContext {
                    message_ids: vec![],
                    item_ids: vec![],
                    round_id: None,
                    continuation_operation_id: None,
                },
                removed: None,
            },
            state,
            attempts: vec![],
            active_attempt_id: None,
            resolution_history: vec![],
        },
    );
    session.messages.push(message);
    session.counters.next_message = positive(number + 1);
    session.counters.next_input = positive(number + 1);
}
fn status(status: ItemStatus) -> ItemChange {
    let terminal = matches!(
        status,
        ItemStatus::Decided | ItemStatus::Done | ItemStatus::Dropped | ItemStatus::Replaced
    );
    ItemChange::Status {
        status,
        outcome: terminal.then(|| "Completed result\nwithout truncation.".into()),
        why: terminal.then(|| "Reason for completion.".into()),
        reason: (!terminal).then(|| "Agent chose this transition.".into()),
    }
}
fn ask(round: u64) -> ItemChange {
    ItemChange::Ask {
        ask: "Choose an approach.".into(),
        options: vec![ItemOption {
            id: "yes".into(),
            label: "Keep it".into(),
            consequence: "Preserves history".into(),
            recommended: true,
        }],
        recipient_binding_id: uuid(2),
        round_id: uuid(round),
    }
}
fn edit() -> ItemChange {
    ItemChange::Edit {
        question: None,
        item_type: None,
        note: Some(Some("Progress".into())),
        links: None,
        short: None,
    }
}
fn insert_round(session: &mut Session, item: &Item) {
    let id = item.current_round_id.clone().unwrap();
    let ordinal = session.rounds.0.len() as u64 + 1;
    session.rounds.0.insert(
        id.clone(),
        Round {
            id,
            item_id: item.id.clone(),
            ordinal: positive(ordinal),
            opened_message_id: uuid(3),
            question_snapshot: item.question.clone(),
            ask_snapshot: item.ask.clone(),
            options_snapshot: item.options.clone(),
            question_revision: item.question_revision,
            owner_message_ids: vec![],
            agent_message_ids: vec![],
            result_input_ids: vec![],
            fork_item_ids: vec![],
            closed_at: None,
            origin: None,
        },
    );
}
fn apply(session: &mut Session, change: &ItemChange) -> Item {
    let item = transition_item(session, &reference("1"), change, &context(session)).unwrap();
    if matches!(change, ItemChange::Ask { .. }) {
        insert_round(session, &item);
    }
    session.items.0.insert(item.id.clone(), item.clone());
    validate_session_items(session).unwrap();
    item
}
fn reject(session: &Session, change: &ItemChange, context: &TransitionContext) -> TransitionError {
    let before = session.clone();
    let error = transition_item(session, &reference("1"), change, context).unwrap_err();
    assert_eq!(session, &before, "rejection modified borrowed state");
    error
}
fn invalid(session: &Session, kind: ValidationErrorKind) {
    let before = session.clone();
    let error = validate_session_items(session).unwrap_err();
    assert_eq!(error.kind, kind, "{error}");
    assert_eq!(session, &before);
}

#[test]
fn canonical_tree_uses_explicit_parents_and_never_cascades() {
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().next_child = positive(11);
    s.items
        .0
        .insert(reference("1.2"), item("1.2", Some("1"), 2));
    s.items
        .0
        .insert(reference("1.10"), item("1.10", Some("1"), 10));
    validate_session_items(&s).unwrap();
    let closed = apply(&mut s, &status(ItemStatus::Done));
    assert_eq!(closed.status, ItemStatus::Done);
    assert_eq!(s.items.0[&reference("1.2")].status, ItemStatus::Open);
    assert_eq!(s.items.0[&reference("1.10")].status, ItemStatus::Open);
    assert_eq!(
        closed.question,
        "Which approach?\nPreserve this exact text."
    );
}

#[test]
fn hierarchy_missing_links_map_identity_and_cycles_are_rejected() {
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().parent = Some(reference("9"));
    invalid(&s, ValidationErrorKind::MissingReference);
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().parent = Some(reference("1"));
    invalid(&s, ValidationErrorKind::Cycle);
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().parent = Some(reference("2"));
    s.items.0.insert(reference("2"), item("2", Some("1"), 2));
    invalid(&s, ValidationErrorKind::Cycle);
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().topic_id = uuid(999);
    invalid(&s, ValidationErrorKind::MissingReference);
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().id = reference("3");
    invalid(&s, ValidationErrorKind::IdentityMismatch);
    let mut s = session();
    s.counters.next_root = positive(3);
    s.items.0.insert(reference("2"), item("2", Some("1"), 1));
    s.items.0.get_mut(&reference("1")).unwrap().next_child = positive(2);
    invalid(&s, ValidationErrorKind::HierarchyMismatch);
    let mut s = session();
    let mut topic = s.topics.0[&uuid(1)].clone();
    topic.id = uuid(9);
    topic.order = positive(2);
    s.topics.0.insert(uuid(9), topic);
    s.counters.next_topic_order = positive(3);
    s.items.0.get_mut(&reference("1")).unwrap().next_child = positive(2);
    let mut child = item("1.1", Some("1"), 1);
    child.topic_id = uuid(9);
    s.items.0.insert(reference("1.1"), child);
    invalid(&s, ValidationErrorKind::HierarchyMismatch);
}

#[test]
fn counters_and_duplicate_ordinals_or_messages_are_rejected() {
    let mut s = session();
    s.counters.next_root = positive(1);
    invalid(&s, ValidationErrorKind::CounterNotAhead);
    let mut s = session();
    s.counters.next_topic_order = positive(1);
    invalid(&s, ValidationErrorKind::CounterNotAhead);
    let mut s = session();
    s.counters.next_message = positive(1);
    invalid(&s, ValidationErrorKind::CounterNotAhead);
    let mut s = session();
    s.items
        .0
        .insert(reference("1.1"), item("1.1", Some("1"), 1));
    invalid(&s, ValidationErrorKind::CounterNotAhead);
    let mut s = session();
    let mut topic = s.topics.0[&uuid(1)].clone();
    topic.id = uuid(9);
    s.topics.0.insert(uuid(9), topic);
    invalid(&s, ValidationErrorKind::Duplicate);
    let mut s = session();
    s.messages.push(s.messages[0].clone());
    invalid(&s, ValidationErrorKind::Duplicate);
    let mut s = session();
    s.messages.push(message(9, 1, MessageAuthor::Agent));
    invalid(&s, ValidationErrorKind::Duplicate);
    let mut s = session();
    s.messages[0].items_touched.push(reference("1"));
    invalid(&s, ValidationErrorKind::Duplicate);
    let mut s = session();
    s.items
        .0
        .get_mut(&reference("1"))
        .unwrap()
        .updated_message_ids = vec![uuid(3), uuid(3)];
    invalid(&s, ValidationErrorKind::Duplicate);
}

#[test]
fn child_counters_keep_numeric_maximum_and_stored_error_precedence() {
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().next_child = positive(10);
    s.items
        .0
        .insert(reference("1.2"), item("1.2", Some("1"), 2));
    s.items
        .0
        .insert(reference("1.10"), item("1.10", Some("1"), 10));
    assert_eq!(
        validate_session_items(&s),
        Err(ValidationError {
            path: "items.1.next_child".into(),
            kind: ValidationErrorKind::CounterNotAhead,
        })
    );
    s.items.0.get_mut(&reference("1")).unwrap().next_child = positive(11);
    validate_session_items(&s).unwrap();

    // A later malformed identity still occupies its actual parent's counter.
    let mut s = session();
    s.items.0.insert(reference("2"), item("9", Some("1"), 2));
    s.items.0.get_mut(&reference("1")).unwrap().question.clear();
    assert_eq!(
        validate_session_items(&s),
        Err(ValidationError {
            path: "items.1.next_child".into(),
            kind: ValidationErrorKind::CounterNotAhead,
        })
    );
    s.items.0.get_mut(&reference("1")).unwrap().next_child = positive(3);
    assert_eq!(
        validate_session_items(&s),
        Err(ValidationError {
            path: "items.1.question".into(),
            kind: ValidationErrorKind::Blank,
        })
    );
    s.items.0.get_mut(&reference("1")).unwrap().question = "Valid question".into();
    assert_eq!(
        validate_session_items(&s),
        Err(ValidationError {
            path: "items.id".into(),
            kind: ValidationErrorKind::IdentityMismatch,
        })
    );
}

#[test]
fn child_counters_use_actual_parent_even_when_id_spelling_disagrees() {
    let mut s = session();
    s.counters.next_root = positive(3);
    let mut second = item("2", None, 2);
    second.next_child = positive(2);
    s.items.0.insert(reference("2"), second);
    s.items
        .0
        .insert(reference("1.1"), item("1.1", Some("2"), 1));
    validate_item(&s, &s.items.0[&reference("1")]).unwrap();
    assert_eq!(
        validate_session_items(&s),
        Err(ValidationError {
            path: "items.1.1.id".into(),
            kind: ValidationErrorKind::HierarchyMismatch,
        })
    );
}

#[test]
fn candidate_validation_uses_current_children_messages_and_candidate_links() {
    let mut s = session();
    let mut candidate = s.items.0[&reference("1")].clone();
    candidate.next_child = positive(2);
    s.items
        .0
        .insert(reference("1.1"), item("1.1", Some("1"), 1));
    // The supplied candidate's counter replaces the stored item's counter.
    validate_item(&s, &candidate).unwrap();
    s.items.0.get_mut(&reference("1.1")).unwrap().ordinal = positive(2);
    assert_eq!(
        validate_item(&s, &candidate),
        Err(ValidationError {
            path: "items.1.next_child".into(),
            kind: ValidationErrorKind::CounterNotAhead,
        })
    );
    s.items.0.remove(&reference("1.1"));
    candidate.created_message_id = uuid(99);
    assert_eq!(
        validate_item(&s, &candidate),
        Err(ValidationError {
            path: "items.1.created_message_id".into(),
            kind: ValidationErrorKind::MissingReference,
        })
    );
    s.messages.push(message(99, 2, MessageAuthor::Agent));
    validate_item(&s, &candidate).unwrap();
    s.messages.push(s.messages[1].clone());
    // Standalone item checks establish membership, not message uniqueness.
    validate_item(&s, &candidate).unwrap();
    assert_eq!(
        validate_session_items(&s),
        Err(ValidationError {
            path: "messages.id".into(),
            kind: ValidationErrorKind::Duplicate,
        })
    );

    s.items.0.get_mut(&reference("1")).unwrap().parent = Some(reference("2"));
    s.items.0.insert(reference("2"), item("2", Some("1"), 1));
    // The stored cycle is broken by the candidate's actual null parent.
    validate_item(&s, &candidate).unwrap();
    candidate.parent = Some(reference("2"));
    assert_eq!(
        validate_item(&s, &candidate),
        Err(ValidationError {
            path: "items.1.parent".into(),
            kind: ValidationErrorKind::Cycle,
        })
    );
}

#[test]
fn text_bounds_count_utf8_bytes_and_preserve_optional_empty_note() {
    for good in ["a".repeat(4096), "é".repeat(2048), "😀".repeat(1024)] {
        let mut s = session();
        s.items.0.get_mut(&reference("1")).unwrap().question = good.clone();
        validate_session_items(&s).unwrap();
        assert_eq!(s.items.0[&reference("1")].question, good);
    }
    for bad in ["a".repeat(4097), "é".repeat(2049), "😀".repeat(1025)] {
        let mut s = session();
        s.items.0.get_mut(&reference("1")).unwrap().question = bad;
        invalid(
            &s,
            ValidationErrorKind::TooLong {
                maximum_bytes: 4096,
            },
        );
    }
    for bad in ["", " \n\t"] {
        let mut s = session();
        s.items.0.get_mut(&reference("1")).unwrap().question = bad.into();
        invalid(&s, ValidationErrorKind::Blank);
    }
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().question = "bad\0text".into();
    invalid(&s, ValidationErrorKind::Nul);
    let mut s = session();
    for note in [None, Some(String::new()), Some(" \n".into())] {
        s.items.0.get_mut(&reference("1")).unwrap().note = note;
        validate_session_items(&s).unwrap();
    }
    s.title = "title".repeat(2000);
    s.topics.0.get_mut(&uuid(1)).unwrap().name = "topic".repeat(2000);
    validate_session_items(&s).unwrap(); // no invented metadata cap
    s.bindings
        .0
        .get_mut(&uuid(2))
        .unwrap()
        .endpoint_fingerprint
        .0 = "é".repeat(2048);
    validate_session_items(&s).unwrap();
    s.bindings
        .0
        .get_mut(&uuid(2))
        .unwrap()
        .endpoint_fingerprint
        .0
        .push('x');
    invalid(
        &s,
        ValidationErrorKind::TooLong {
            maximum_bytes: 4096,
        },
    );
}

#[test]
fn option_and_link_bounds_and_duplicate_recommendations_are_rejected() {
    let ItemChange::Ask { options, .. } = ask(10) else {
        unreachable!()
    };
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().options = options.clone();
    validate_session_items(&s).unwrap();
    let mut bad = s.clone();
    bad.items
        .0
        .get_mut(&reference("1"))
        .unwrap()
        .options
        .push(options[0].clone());
    invalid(&bad, ValidationErrorKind::Duplicate);
    let mut bad = s.clone();
    let mut option = options[0].clone();
    option.id = "other".into();
    bad.items
        .0
        .get_mut(&reference("1"))
        .unwrap()
        .options
        .push(option);
    invalid(&bad, ValidationErrorKind::InvalidState);
    let mut bad = s.clone();
    bad.items.0.get_mut(&reference("1")).unwrap().options[0].label = "é".repeat(513);
    invalid(
        &bad,
        ValidationErrorKind::TooLong {
            maximum_bytes: 1024,
        },
    );
    let mut bad = s.clone();
    bad.items.0.get_mut(&reference("1")).unwrap().options[0].consequence = " ".into();
    invalid(&bad, ValidationErrorKind::Blank);
    let mut bad = s.clone();
    bad.items.0.get_mut(&reference("1")).unwrap().options = vec![options[0].clone(); 13];
    invalid(&bad, ValidationErrorKind::TooMany { maximum: 12 });
    let link = ItemLinkTarget {
        kind: LinkKind::Doc,
        label: "Documentation".into(),
        target: "d".repeat(4096),
    };
    s.items.0.get_mut(&reference("1")).unwrap().links = vec![link.clone(); 32];
    validate_session_items(&s).unwrap();
    let mut bad = s.clone();
    bad.items
        .0
        .get_mut(&reference("1"))
        .unwrap()
        .links
        .push(link);
    invalid(&bad, ValidationErrorKind::TooMany { maximum: 32 });
    s.items.0.get_mut(&reference("1")).unwrap().links[0]
        .target
        .push('x');
    invalid(
        &s,
        ValidationErrorKind::TooLong {
            maximum_bytes: 4096,
        },
    );
}

#[test]
fn every_status_pair_obeys_the_finite_matrix_and_preserves_old_fields() {
    let statuses = [
        ItemStatus::Open,
        ItemStatus::WaitingOnMe,
        ItemStatus::InProgress,
        ItemStatus::Decided,
        ItemStatus::Done,
        ItemStatus::Dropped,
        ItemStatus::Replaced,
    ];
    for old_status in &statuses {
        for new_status in &statuses {
            let mut s = session();
            s.counters.next_root = positive(3);
            s.items.0.insert(reference("2"), item("2", None, 2));
            if old_status == &ItemStatus::WaitingOnMe {
                apply(&mut s, &ask(10));
            } else if old_status == &ItemStatus::Replaced {
                apply(
                    &mut s,
                    &ItemChange::Replace {
                        replacement: reference("2"),
                        outcome: "Replaced".into(),
                        why: "Superseded".into(),
                    },
                );
            } else if old_status != &ItemStatus::Open {
                apply(&mut s, &status(old_status.clone()));
            }
            let old = s.items.0[&reference("1")].clone();
            let change = status(new_status.clone());
            if old_status == &ItemStatus::Replaced
                || matches!(new_status, ItemStatus::WaitingOnMe | ItemStatus::Replaced)
            {
                assert_eq!(
                    reject(&s, &change, &context(&s)),
                    TransitionError::InvalidTransition
                );
            } else {
                let changed = apply(&mut s, &change);
                assert_eq!(&changed.status, new_status);
                assert_eq!(changed.revision.value(), old.revision.value() + 1);
                let history = changed.status_history.last().unwrap();
                assert_eq!(history.old_status, old.status);
                assert_eq!(history.new_status, *new_status);
                assert_eq!(history.previous_outcome, old.outcome);
                assert_eq!(history.previous_why, old.why);
                assert_eq!(history.previous_replaced_by, old.replaced_by);
                assert_eq!(history.binding_id, Some(uuid(2)));
                assert_eq!(history.cause_message_id, uuid(3));
                if matches!(new_status, ItemStatus::Open | ItemStatus::InProgress) {
                    assert!(changed.outcome.is_none() && changed.why.is_none());
                }
            }
        }
    }
}

#[test]
fn asks_create_new_question_revisions_while_replies_notes_children_do_not() {
    let mut s = session();
    let first = apply(&mut s, &ask(10));
    assert_eq!(first.owner, ItemOwner::Me {});
    assert_eq!(first.question_revision.value(), 2);
    assert_eq!(first.waiting_since, Some(time()));
    assert_eq!(first.current_round_id, Some(uuid(10)));
    let second = apply(&mut s, &ask(11));
    assert_eq!(second.question_revision.value(), 3);
    assert_eq!(
        second.status_history.last().unwrap().old_status,
        ItemStatus::WaitingOnMe
    );
    let noted = apply(&mut s, &edit());
    assert_eq!(noted.question_revision, second.question_revision);
    assert_eq!(noted.updated_message_ids, vec![uuid(3)]);
    let edited = apply(
        &mut s,
        &ItemChange::Edit {
            question: Some("New question?".into()),
            item_type: Some(ItemType::Decision),
            note: Some(None),
            links: Some(vec![]),
            short: None,
        },
    );
    assert_eq!(edited.question_revision.value(), 4);
    assert_eq!(edited.item_type, ItemType::Decision);
    assert_eq!(edited.note, None);
    let same = apply(
        &mut s,
        &ItemChange::Edit {
            question: Some(edited.question.clone()),
            item_type: None,
            note: None,
            links: None,
            short: None,
        },
    );
    assert_eq!(same.question_revision, edited.question_revision);
    let closed = apply(&mut s, &status(ItemStatus::Done));
    assert_eq!(closed.waiting_since, None);
    assert_eq!(closed.question_revision.value(), 5);
    assert_eq!(
        reject(&s, &ask(12), &context(&s)),
        TransitionError::InvalidTransition
    );
    let reopened = apply(&mut s, &status(ItemStatus::Open));
    assert_eq!(
        reopened.status_history.last().unwrap().previous_outcome,
        closed.outcome
    );
    apply(&mut s, &ask(12));
}

#[test]
fn stored_waiting_ownership_remains_explicit_while_ask_sets_owner_to_me() {
    let mut s = session();
    apply(&mut s, &ask(10));
    for owner in [
        ItemOwner::Me {},
        ItemOwner::Agent {
            binding_id: uuid(2),
        },
        ItemOwner::Other {
            name: "Reviewer".into(),
        },
    ] {
        s.items.0.get_mut(&reference("1")).unwrap().owner = owner;
        validate_session_items(&s).unwrap();
    }
    let asked = apply(&mut s, &ask(11));
    assert_eq!(asked.owner, ItemOwner::Me {});
}

#[test]
fn replaced_items_accept_edits_but_cannot_reopen_or_ask() {
    let mut s = session();
    s.counters.next_root = positive(3);
    s.items.0.insert(reference("2"), item("2", None, 2));
    let replaced = apply(
        &mut s,
        &ItemChange::Replace {
            replacement: reference("2"),
            outcome: "Use item 2".into(),
            why: "New approach".into(),
        },
    );
    assert_eq!(replaced.replaced_by, Some(reference("2")));
    let edited = apply(&mut s, &edit());
    assert_eq!(edited.status, ItemStatus::Replaced);
    assert_eq!(edited.replaced_by, replaced.replaced_by);
    assert_eq!(
        reject(&s, &ask(10), &context(&s)),
        TransitionError::InvalidTransition
    );
    assert_eq!(
        reject(
            &s,
            &ItemChange::Replace {
                replacement: reference("2"),
                outcome: "Again".into(),
                why: "Again".into()
            },
            &context(&s)
        ),
        TransitionError::InvalidTransition
    );
}

#[test]
fn replacement_links_must_exist_be_different_and_remain_acyclic() {
    for target in ["1", "999"] {
        let s = session();
        let error = reject(
            &s,
            &ItemChange::Replace {
                replacement: reference(target),
                outcome: "Replacement".into(),
                why: "Reason".into(),
            },
            &context(&s),
        );
        assert!(matches!(
            error,
            TransitionError::Validation(ValidationError {
                kind: ValidationErrorKind::Cycle | ValidationErrorKind::MissingReference,
                ..
            })
        ));
    }
    let mut s = session();
    s.counters.next_root = positive(3);
    let mut other = item("2", None, 2);
    other.status = ItemStatus::Replaced;
    other.outcome = Some("Prior".into());
    other.why = Some("Prior".into());
    other.replaced_by = Some(reference("1"));
    s.items.0.insert(reference("2"), other);
    assert!(matches!(
        reject(
            &s,
            &ItemChange::Replace {
                replacement: reference("2"),
                outcome: "Loop".into(),
                why: "Reason".into()
            },
            &context(&s)
        ),
        TransitionError::Validation(ValidationError {
            kind: ValidationErrorKind::Cycle,
            ..
        })
    ));
}

#[test]
fn invalid_transition_fields_are_rejected_without_mutation() {
    let s = session();
    for change in [
        ItemChange::Status {
            status: ItemStatus::Done,
            outcome: None,
            why: Some("Why".into()),
            reason: None,
        },
        ItemChange::Status {
            status: ItemStatus::Done,
            outcome: Some(" ".into()),
            why: Some("Why".into()),
            reason: None,
        },
        ItemChange::Edit {
            question: Some("x".repeat(4097)),
            item_type: None,
            note: None,
            links: None,
            short: None,
        },
        ItemChange::Edit {
            question: None,
            item_type: None,
            note: None,
            links: None,
            short: Some(Some("x".repeat(41))),
        },
        ItemChange::Ask {
            ask: String::new(),
            options: vec![],
            recipient_binding_id: uuid(2),
            round_id: uuid(10),
        },
        ItemChange::Ask {
            ask: "Ask".into(),
            options: vec![],
            recipient_binding_id: uuid(999),
            round_id: uuid(10),
        },
    ] {
        assert!(matches!(
            reject(&s, &change, &context(&s)),
            TransitionError::Validation(_)
        ));
    }
    let change = ItemChange::Status {
        status: ItemStatus::Open,
        outcome: None,
        why: None,
        reason: None,
    };
    assert_eq!(
        reject(&s, &change, &context(&s)),
        TransitionError::MissingReason
    );
    let change = ItemChange::Status {
        status: ItemStatus::Open,
        outcome: None,
        why: None,
        reason: Some(" ".into()),
    };
    assert!(matches!(
        reject(&s, &change, &context(&s)),
        TransitionError::Validation(ValidationError {
            kind: ValidationErrorKind::Blank,
            ..
        })
    ));
    let change = ItemChange::Status {
        status: ItemStatus::Open,
        outcome: Some("Unexpected".into()),
        why: None,
        reason: Some("Reason".into()),
    };
    assert_eq!(
        reject(&s, &change, &context(&s)),
        TransitionError::InvalidTransition
    );
    let mut s = session();
    apply(&mut s, &ask(10));
    assert!(matches!(
        reject(&s, &ask(10), &context(&s)),
        TransitionError::Validation(ValidationError {
            kind: ValidationErrorKind::Duplicate,
            ..
        })
    ));
}

#[test]
fn owner_input_and_unissued_watermarks_cannot_terminalize_an_item() {
    let mut s = session();
    add_owner_input(&mut s, 9, 2, InputState::Queued);
    let before_item = s.items.0[&reference("1")].clone();
    validate_session_items(&s).unwrap();
    assert_eq!(s.items.0[&reference("1")], before_item);
    assert_eq!(
        reject(&s, &status(ItemStatus::Done), &context(&s)),
        TransitionError::UnhandledOwnerMessages {
            message_ids: vec![uuid(9)]
        }
    );
    assert!(transition_item(&s, &reference("1"), &edit(), &context(&s)).is_ok());
    let mut c = context(&s);
    c.handled_through_message_number = NonnegativeSafeInteger::new(2).unwrap();
    let changed = transition_item(&s, &reference("1"), &status(ItemStatus::Done), &c).unwrap();
    assert_eq!(
        changed.status_history[0]
            .handled_through_message_number
            .value(),
        2
    );
    c.handled_through_message_number = NonnegativeSafeInteger::new(11).unwrap();
    assert_eq!(
        reject(&s, &edit(), &c),
        TransitionError::InvalidHandledWatermark
    );
    c = context(&s);
    c.cause_message_id = uuid(9);
    assert_eq!(
        reject(&s, &status(ItemStatus::InProgress), &c),
        TransitionError::InvalidCauseMessage
    );
}

#[test]
fn agent_identity_generation_revisions_and_overflows_are_checked() {
    let s = session();
    assert_eq!(
        transition_item(&s, &reference("999"), &edit(), &context(&s)).unwrap_err(),
        TransitionError::MissingItem
    );
    let mut c = context(&s);
    c.expected_revision = positive(2);
    assert_eq!(reject(&s, &edit(), &c), TransitionError::StaleRevision);
    let mut c = context(&s);
    c.expected_question_revision = Some(positive(2));
    assert_eq!(
        reject(&s, &edit(), &c),
        TransitionError::StaleQuestionRevision
    );
    let mut c = context(&s);
    c.binding_id = uuid(999);
    assert_eq!(reject(&s, &edit(), &c), TransitionError::MissingBinding);
    let mut c = context(&s);
    c.generation = uuid(999);
    assert_eq!(reject(&s, &edit(), &c), TransitionError::StaleGeneration);
    let mut c = context(&s);
    c.cause_message_id = uuid(999);
    assert_eq!(
        reject(&s, &edit(), &c),
        TransitionError::InvalidCauseMessage
    );
    for dispatch in [false, true] {
        let mut s = session();
        let binding = s.bindings.0.get_mut(&uuid(2)).unwrap();
        if dispatch {
            binding.dispatch_state = DispatchState::Disconnected;
        } else {
            binding.connection_state = ConnectionState::Disconnected;
        }
        assert_eq!(
            reject(&s, &edit(), &context(&s)),
            TransitionError::DisconnectedBinding
        );
    }
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().revision = positive(9_007_199_254_740_991);
    assert_eq!(
        reject(&s, &edit(), &context(&s)),
        TransitionError::CounterOverflow
    );
    let mut s = session();
    s.items
        .0
        .get_mut(&reference("1"))
        .unwrap()
        .question_revision = positive(9_007_199_254_740_991);
    assert_eq!(
        reject(&s, &ask(10), &context(&s)),
        TransitionError::CounterOverflow
    );
}

#[test]
fn terminal_guard_exempts_resolved_inputs_and_copied_history_without_changing_them() {
    for state in [
        InputState::Handled,
        InputState::Cancelled,
        InputState::Skipped,
    ] {
        let mut s = session();
        add_owner_input(&mut s, 9, 2, state.clone());
        s.bindings
            .0
            .get_mut(&uuid(2))
            .unwrap()
            .issued_through_message_number = NonnegativeSafeInteger::new(1).unwrap();
        let before = s.clone();
        let changed =
            transition_item(&s, &reference("1"), &status(ItemStatus::Done), &context(&s)).unwrap();
        assert_eq!(changed.status, ItemStatus::Done);
        assert_eq!(s, before);
        assert_eq!(s.inputs.0[&uuid(109)].state, state);
        assert_eq!(
            changed
                .status_history
                .last()
                .unwrap()
                .handled_through_message_number
                .value(),
            0
        );
    }
    for state in [
        InputState::Queued,
        InputState::InFlight,
        InputState::NeedsAttention,
    ] {
        let mut s = session();
        add_owner_input(&mut s, 9, 2, state);
        assert_eq!(
            reject(&s, &status(ItemStatus::Done), &context(&s)),
            TransitionError::UnhandledOwnerMessages {
                message_ids: vec![uuid(9)]
            }
        );
    }
    let mut s = session();
    let mut copied = message(9, 2, MessageAuthor::Owner);
    copied.origin = Some(MessageOrigin {
        source_target: MessageSourceTarget {
            project_id: uuid(90),
            session_id: uuid(91),
            topic_id: Some(uuid(92)),
            item_id: copied.item_id.clone(),
            round_id: copied.round_id.clone(),
        },
        project_id: uuid(90),
        session_id: uuid(91),
        topic_id: uuid(92),
        entity_id: uuid(93),
        source_revision: positive(1),
        author: MessageAuthor::Owner,
        binding_id: None,
        adapter_id: None,
        external_session_id: None,
    });
    // Its source input ID is contextual and has no live target-session input.
    copied.binding_id = Some(uuid(94));
    s.messages.push(copied);
    s.counters.next_message = positive(3);
    validate_session_items(&s).unwrap();
    let before = s.clone();
    transition_item(&s, &reference("1"), &status(ItemStatus::Done), &context(&s)).unwrap();
    assert_eq!(s, before);
}

#[test]
fn live_owner_input_orphans_and_wrong_targets_are_invalid() {
    let mut s = session();
    s.messages.push(message(9, 2, MessageAuthor::Owner));
    s.counters.next_message = positive(3);
    invalid(&s, ValidationErrorKind::MissingReference);
    assert!(matches!(
        reject(&s, &status(ItemStatus::Done), &context(&s)),
        TransitionError::Validation(ValidationError {
            kind: ValidationErrorKind::MissingReference,
            ..
        })
    ));
    let mut s = session();
    add_owner_input(&mut s, 9, 2, InputState::Queued);
    s.inputs.0.get_mut(&uuid(109)).unwrap().target.item_id = Some(reference("2"));
    invalid(&s, ValidationErrorKind::IdentityMismatch);
    assert!(matches!(
        reject(&s, &status(ItemStatus::Done), &context(&s)),
        TransitionError::Validation(ValidationError {
            kind: ValidationErrorKind::IdentityMismatch,
            ..
        })
    ));
}

#[test]
fn full_owner_and_agent_messages_obey_distinct_limits() {
    let mut s = session();
    add_owner_input(&mut s, 9, 2, InputState::Queued);
    s.messages[1].body = "é".repeat(8192);
    s.inputs.0.get_mut(&uuid(109)).unwrap().payload.text = s.messages[1].body.clone();
    validate_session_items(&s).unwrap();
    let mut bad = s.clone();
    bad.messages[1].body.push('x');
    invalid(
        &bad,
        ValidationErrorKind::TooLong {
            maximum_bytes: 16 * 1024,
        },
    );
    let mut bad = s.clone();
    bad.inputs
        .0
        .get_mut(&uuid(109))
        .unwrap()
        .payload
        .text
        .push('x');
    invalid(
        &bad,
        ValidationErrorKind::TooLong {
            maximum_bytes: 16 * 1024,
        },
    );
    s.messages[0].kind = MessageKind::Reply;
    s.messages[0].body = "😀".repeat(16 * 1024);
    validate_session_items(&s).unwrap();
    s.messages[0].body.push('x');
    invalid(
        &s,
        ValidationErrorKind::TooLong {
            maximum_bytes: 64 * 1024,
        },
    );
    let mut s = session();
    s.messages[0].body = "x".repeat(4097);
    invalid(
        &s,
        ValidationErrorKind::TooLong {
            maximum_bytes: 4096,
        },
    );
    let mut s = session();
    s.messages[0].kind = MessageKind::Lifecycle;
    s.messages[0].author = MessageAuthor::System;
    s.messages[0].body = "x".repeat(5000);
    validate_session_items(&s).unwrap();
}

#[test]
fn stored_item_status_fields_and_provenance_references_must_be_consistent() {
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().outcome =
        Some("Terminal field on open item".into());
    invalid(&s, ValidationErrorKind::InvalidState);
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().waiting_since = Some(time());
    invalid(&s, ValidationErrorKind::InvalidState);
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().status = ItemStatus::WaitingOnMe;
    invalid(&s, ValidationErrorKind::InvalidState);
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().replaced_by = Some(reference("1"));
    invalid(&s, ValidationErrorKind::InvalidState);
    let mut s = session();
    let item = s.items.0.get_mut(&reference("1")).unwrap();
    item.status = ItemStatus::Replaced;
    item.outcome = Some("Outcome".into());
    item.why = Some("Why".into());
    invalid(&s, ValidationErrorKind::MissingReference);
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().owner = ItemOwner::Other {
        name: "Human reviewer".into(),
    };
    validate_session_items(&s).unwrap();
    s.items.0.get_mut(&reference("1")).unwrap().owner = ItemOwner::Other { name: " ".into() };
    invalid(&s, ValidationErrorKind::Blank);
    let mut s = session();
    s.items
        .0
        .get_mut(&reference("1"))
        .unwrap()
        .created_message_id = uuid(99);
    invalid(&s, ValidationErrorKind::MissingReference);
    let mut s = session();
    s.items
        .0
        .get_mut(&reference("1"))
        .unwrap()
        .updated_message_ids = vec![uuid(99)];
    invalid(&s, ValidationErrorKind::MissingReference);
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().current_round_id = Some(uuid(99));
    invalid(&s, ValidationErrorKind::MissingReference);
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().source_round_id = Some(uuid(99));
    invalid(&s, ValidationErrorKind::MissingReference);
    let mut s = session();
    apply(&mut s, &status(ItemStatus::Done));
    s.items.0.get_mut(&reference("1")).unwrap().status_history[0].cause_message_id = uuid(99);
    invalid(&s, ValidationErrorKind::MissingReference);
    let mut s = session();
    apply(&mut s, &status(ItemStatus::Done));
    s.items.0.get_mut(&reference("1")).unwrap().status_history[0].binding_id = Some(uuid(99));
    invalid(&s, ValidationErrorKind::MissingReference);
    let mut s = session();
    s.active_binding_id = Some(uuid(99));
    invalid(&s, ValidationErrorKind::MissingReference);
    let mut s = session();
    s.bindings.0.get_mut(&uuid(2)).unwrap().id = uuid(99);
    invalid(&s, ValidationErrorKind::IdentityMismatch);
    let mut s = session();
    s.topics.0.get_mut(&uuid(1)).unwrap().id = uuid(99);
    invalid(&s, ValidationErrorKind::IdentityMismatch);
}

#[test]
fn stored_round_and_answer_snapshots_obey_current_content_bounds() {
    let mut s = session();
    let waiting = apply(&mut s, &ask(10));
    s.items.0.get_mut(&reference("1")).unwrap().next_child = positive(2);
    let mut child = item("1.1", Some("1"), 1);
    child.source_round_id = Some(uuid(10));
    s.items.0.insert(child.id.clone(), child);
    validate_session_items(&s).unwrap();
    let answer = Answer {
        id: uuid(20),
        seq: positive(1),
        item_id: reference("1"),
        question_revision: waiting.question_revision,
        question_snapshot: waiting.question,
        ask_snapshot: waiting.ask,
        options_snapshot: waiting.options,
        selected_option_id: Some("yes".into()),
        text: String::new(),
        message_id: uuid(3),
        input_id: uuid(21),
        supersedes_answer_id: None,
        created_at: time(),
    };
    s.answers.push(answer);
    validate_session_items(&s).unwrap();
    let mut bad = s.clone();
    bad.answers[0].text = "x".repeat(16 * 1024 + 1);
    invalid(
        &bad,
        ValidationErrorKind::TooLong {
            maximum_bytes: 16 * 1024,
        },
    );
    let mut bad = s.clone();
    bad.answers[0].question_snapshot = "x".repeat(4097);
    invalid(
        &bad,
        ValidationErrorKind::TooLong {
            maximum_bytes: 4096,
        },
    );
    let mut bad = s.clone();
    bad.rounds.0.get_mut(&uuid(10)).unwrap().ask_snapshot = Some("x".repeat(4097));
    invalid(
        &bad,
        ValidationErrorKind::TooLong {
            maximum_bytes: 4096,
        },
    );
    let mut bad = s.clone();
    bad.rounds.0.get_mut(&uuid(10)).unwrap().id = uuid(99);
    invalid(&bad, ValidationErrorKind::IdentityMismatch);
    let mut bad = s.clone();
    bad.rounds.0.get_mut(&uuid(10)).unwrap().item_id = reference("99");
    invalid(&bad, ValidationErrorKind::MissingReference);
    let mut bad = s.clone();
    bad.messages[0].round_id = Some(uuid(99));
    invalid(&bad, ValidationErrorKind::MissingReference);
    s.messages[0].round_id = Some(uuid(10));
    validate_session_items(&s).unwrap();
}

#[test]
fn option_only_owner_answers_preserve_empty_or_whitespace_message_bodies() {
    for submitted in ["", " \n\t"] {
        let mut s = session();
        let waiting = apply(&mut s, &ask(10));
        add_owner_input(&mut s, 9, 2, InputState::Queued);
        s.messages[1].body = submitted.into();
        let input = s.inputs.0.get_mut(&uuid(109)).unwrap();
        input.kind = InputKind::Answer;
        input.answer_id = Some(uuid(20));
        input.payload.intent = InputKind::Answer;
        input.payload.text = submitted.into();
        input.payload.selected_option_id = Some("yes".into());
        s.answers.push(Answer {
            id: uuid(20),
            seq: positive(1),
            item_id: reference("1"),
            question_revision: waiting.question_revision,
            question_snapshot: waiting.question,
            ask_snapshot: waiting.ask,
            options_snapshot: waiting.options,
            selected_option_id: Some("yes".into()),
            text: submitted.into(),
            message_id: uuid(9),
            input_id: uuid(109),
            supersedes_answer_id: None,
            created_at: time(),
        });
        validate_session_items(&s).unwrap();
        assert_eq!(s.messages[1].body, submitted);
        assert_eq!(s.answers[0].text, submitted);
        assert_eq!(s.inputs.0[&uuid(109)].payload.text, submitted);
        for mismatch in ["option", "input", "message", "item"] {
            let mut bad = s.clone();
            let answer = &mut bad.answers[0];
            match mismatch {
                "option" => answer.selected_option_id = Some("unknown".into()),
                "input" => answer.input_id = uuid(99),
                "message" => answer.message_id = uuid(99),
                "item" => answer.item_id = reference("99"),
                _ => unreachable!(),
            }
            invalid(&bad, ValidationErrorKind::Blank);
        }
        let mut bad = s.clone();
        bad.answers.clear();
        invalid(&bad, ValidationErrorKind::Blank);
        let mut bad = s.clone();
        bad.messages[1].body = "\0".into();
        invalid(&bad, ValidationErrorKind::Nul);
    }
    let mut s = session();
    s.messages[0].kind = MessageKind::Reply;
    s.messages[0].body.clear();
    invalid(&s, ValidationErrorKind::Blank);
}

#[test]
fn copied_item_history_preserves_source_binding_but_new_transitions_require_target_context() {
    let mut s = session();
    apply(&mut s, &status(ItemStatus::Done));
    let item = s.items.0.get_mut(&reference("1")).unwrap();
    item.origin = Some(ItemOrigin {
        project_id: uuid(90),
        session_id: uuid(91),
        topic_id: uuid(92),
        entity_id: reference("7"),
        source_revision: positive(1),
    });
    item.status_history[0].binding_id = Some(uuid(99));
    item.status_history[0].cause_message_id = uuid(30);
    let mut copied = message(30, 2, MessageAuthor::Agent);
    copied.binding_id = Some(uuid(99));
    copied.origin = Some(MessageOrigin {
        source_target: MessageSourceTarget {
            project_id: uuid(90),
            session_id: uuid(91),
            topic_id: Some(uuid(92)),
            item_id: copied.item_id.clone(),
            round_id: copied.round_id.clone(),
        },
        project_id: uuid(90),
        session_id: uuid(91),
        topic_id: uuid(92),
        entity_id: uuid(93),
        source_revision: positive(1),
        author: MessageAuthor::Agent,
        binding_id: Some(uuid(99)),
        adapter_id: Some("source.agent".into()),
        external_session_id: Some("original-thread".into()),
    });
    s.messages.push(copied);
    s.counters.next_message = positive(3);
    validate_session_items(&s).unwrap();
    let mut c = context(&s);
    c.binding_id = uuid(99);
    assert_eq!(
        reject(&s, &status(ItemStatus::Open), &c),
        TransitionError::MissingBinding
    );
    let reopened = apply(&mut s, &status(ItemStatus::Open));
    assert_eq!(reopened.status_history[0].binding_id, Some(uuid(99)));
    assert_eq!(
        reopened.status_history.last().unwrap().binding_id,
        Some(uuid(2))
    );
    let mut unqualified = s.clone();
    unqualified.items.0.get_mut(&reference("1")).unwrap().origin = None;
    invalid(&unqualified, ValidationErrorKind::MissingReference);
}

fn short_edit(short: Option<Option<&str>>) -> ItemChange {
    ItemChange::Edit {
        question: None,
        item_type: None,
        note: None,
        links: None,
        short: short.map(|value| value.map(Into::into)),
    }
}

#[test]
fn short_labels_are_trimmed_one_line_and_at_most_forty_characters() {
    assert_eq!(
        normalize_short_label("  SDK cache PR \t", "short").unwrap(),
        "SDK cache PR"
    );
    let forty = "é".repeat(SHORT_LABEL_MAX_CHARS);
    assert_eq!(normalize_short_label(&forty, "short").unwrap(), forty);
    for (value, kind) in [
        (
            "x".repeat(41),
            ValidationErrorKind::TooManyChars { maximum_chars: 40 },
        ),
        ("two\nlines".into(), ValidationErrorKind::Multiline),
        ("carriage\rreturn".into(), ValidationErrorKind::Multiline),
        ("   ".into(), ValidationErrorKind::Blank),
        ("nul\0".into(), ValidationErrorKind::Nul),
    ] {
        let error = normalize_short_label(&value, "short").unwrap_err();
        assert_eq!(error.kind, kind, "{value:?}");
        assert_eq!(error.path, "short");
    }
    // Stored labels are checked too, including a value that skipped trimming.
    let mut s = session();
    s.topics.0.get_mut(&uuid(1)).unwrap().short = Some("x".repeat(41));
    invalid(&s, ValidationErrorKind::TooManyChars { maximum_chars: 40 });
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().short = Some(" padded".into());
    invalid(&s, ValidationErrorKind::InvalidState);
    let mut s = session();
    s.items.0.get_mut(&reference("1")).unwrap().short = Some("a\nb".into());
    invalid(&s, ValidationErrorKind::Multiline);
}

#[test]
fn short_label_edit_keeps_when_absent_sets_trimmed_and_clears_on_null() {
    let mut s = session();
    let set = apply(&mut s, &short_edit(Some(Some("  Fallback merge test  "))));
    assert_eq!(set.short.as_deref(), Some("Fallback merge test"));
    let kept = apply(&mut s, &edit());
    assert_eq!(kept.short.as_deref(), Some("Fallback merge test"));
    let kept = apply(&mut s, &short_edit(None));
    assert_eq!(kept.short.as_deref(), Some("Fallback merge test"));
    let cleared = apply(&mut s, &short_edit(Some(None)));
    assert_eq!(cleared.short, None);
    assert!(matches!(
        reject(&s, &short_edit(Some(Some(""))), &context(&s)),
        TransitionError::Validation(ValidationError {
            kind: ValidationErrorKind::Blank,
            ..
        })
    ));
}

#[test]
fn stored_records_without_short_load_and_serialize_unchanged() {
    let topic = json!({"id":uuid(1),"name":"Topic","order":1,"revision":1,
        "created_at":TIME,"archived_at":null,"origin":null});
    let parsed: Topic = serde_json::from_value(topic.clone()).unwrap();
    assert_eq!(parsed.short, None);
    assert_eq!(serde_json::to_value(&parsed).unwrap(), topic);
    let mut labelled = parsed;
    labelled.short = Some("Security".into());
    assert_eq!(
        serde_json::to_value(&labelled).unwrap()["short"],
        "Security"
    );
    let mut item = serde_json::to_value(item("1", None, 1)).unwrap();
    assert!(item.get("short").is_none());
    item["short"] = json!(null);
    assert_eq!(serde_json::from_value::<Item>(item).unwrap().short, None);
}
