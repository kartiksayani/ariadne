use ariadne_core::inputs::InputService;
use ariadne_core::queries::{QueryError, QueryService};
use ariadne_core::*;
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
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
fn reference(s: &str) -> ItemRef {
    ItemRef::new(s).unwrap()
}
fn seed() -> Session {
    serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap()
}
fn removal_source(session: &mut Session, item_id: Option<ItemRef>) -> AgentRemovalSource {
    let mut message = session.messages[0].clone();
    message.id = id(80);
    message.number = session.counters.next_message;
    session.counters.next_message = p(message.number.value() + 1);
    message.author = MessageAuthor::System;
    message.kind = MessageKind::Lifecycle;
    message.body = "Agent removed saved entries".into();
    message.topic_id = Some(
        item_id
            .as_ref()
            .map(|id| session.items.0[id].topic_id.clone())
            .unwrap_or_else(|| id(5)),
    );
    message.item_id = item_id;
    message.created_at = session.updated_at.clone();
    message.items_touched.clear();
    session.messages.push(message);
    AgentRemovalSource {
        binding_id: id(3),
        message_id: id(80),
    }
}
fn limit(n: u64) -> PageLimit {
    PageLimit::new(n).unwrap()
}
fn owner() -> QueryContext {
    QueryContext::owner(owner_context())
}
fn owner_context() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
    ))
}
fn registry_owner() -> QueryContext {
    QueryContext::owner(OwnerContext::from_trusted_entrypoint(OwnerScope::Registry))
}
fn agent(grant: u64) -> QueryContext {
    QueryContext::agent(AgentContext::from_trusted_entrypoint(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        id(3),
        id(4),
        AgentReadScope::Terminal {
            issued_through_message_number: NonnegativeSafeInteger::new(grant).unwrap(),
        },
    ))
}
fn error(error: QueryError) -> CoreError {
    let QueryError::Core(error) = error else {
        panic!("core error: {error:?}")
    };
    error
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
            next: AtomicU64::new(1000),
        }
    }
    fn path(&self) -> std::path::PathBuf {
        store_dir(self._home.path(), 1).join(format!("sessions/{}.json", id(2).as_str()))
    }
    fn query(
        &self,
        context: &QueryContext,
        request: &QueryRequest,
    ) -> Result<QueryResult, QueryError> {
        QueryService::new(&self.registry).query(context, request)
    }
    fn saved(&self) -> Session {
        Store::read_registered(&self.registry.project_dir(&id(1)), &id(1), &id(2)).unwrap()
    }
    fn replace(&self, session: &Session) {
        fs::write(self.path(), serde_json::to_vec_pretty(session).unwrap()).unwrap();
    }
    fn submit(&self, op: u64, target: &str, text: &str) -> SavedReceipt {
        let command = OwnerCommand::InputSubmit {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(op),
            params: InputSubmitParams {
                binding_id: id(3),
                target: InputTarget {
                    topic_id: id(5),
                    item_id: Some(reference(target)),
                },
                kind: InputKind::Reply,
                text: text.into(),
                selected_option_id: None,
                expected_question_revision: None,
                supersedes_answer_id: None,
            },
        };
        let receipt = InputService::new(&self.registry)
            .execute(
                &owner_context(),
                &command,
                || id(self.next.fetch_add(1, Ordering::SeqCst)),
                UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap(),
            )
            .unwrap();
        let MutationReceipt::Session(receipt) = receipt else {
            panic!("receipt")
        };
        *receipt
    }
}
fn message_request(cursor: Option<QueryCursor>, n: u64) -> QueryRequest {
    QueryRequest::SessionRead(SessionReadRequest {
        selection: ReadView::Messages {
            topic_id: None,
            item_id: None,
        },
        cursor,
        limit: limit(n),
        item_pages: vec![],
    })
}
fn messages(result: QueryResult) -> Page<Message> {
    let QueryResult::SessionRead(SessionReadResult::Messages(page)) = result else {
        panic!("messages")
    };
    page
}
fn projects(result: QueryResult) -> ProjectListResult {
    let QueryResult::ProjectList(result) = result else {
        panic!("projects")
    };
    result
}
fn sessions(result: QueryResult) -> SessionListResult {
    let QueryResult::SessionList(result) = result else {
        panic!("sessions")
    };
    result
}

#[test]
fn keyset_messages_preserve_complete_exact_text_and_stale_snapshot_fails() {
    let setup = Setup::new(&seed());
    setup.submit(10, "1", "First owner body.\nExact whitespace.  ");
    setup.submit(11, "2", "Second full body");
    let before = fs::read(setup.path()).unwrap();
    let first = messages(setup.query(&owner(), &message_request(None, 1)).unwrap());
    let second = messages(
        setup
            .query(&owner(), &message_request(first.next_cursor.clone(), 1))
            .unwrap(),
    );
    let third = messages(
        setup
            .query(&owner(), &message_request(second.next_cursor.clone(), 1))
            .unwrap(),
    );
    assert_eq!(
        second.items[0].body,
        "First owner body.\nExact whitespace.  "
    );
    assert_eq!(third.items[0].body, "Second full body");
    assert!(third.next_cursor.is_none());
    assert_eq!(fs::read(setup.path()).unwrap(), before);
    setup.submit(12, "1", "A later update");
    assert_eq!(
        error(
            setup
                .query(&owner(), &message_request(first.next_cursor, 1))
                .unwrap_err()
        )
        .code,
        CoreErrorCode::SnapshotChanged
    );
}

#[test]
fn aggregate_cursor_detects_session_only_changes_and_changed_filter() {
    let setup = Setup::new(&seed());
    let mut second = seed();
    second.id = id(20);
    Store::open_registered(&store_dir(setup._home.path(), 1), id(1))
        .unwrap()
        .create(&second)
        .unwrap();
    let request = |cursor, state| {
        QueryRequest::SessionList(SessionListRequest {
            project_id: None,
            state,
            cursor,
            limit: limit(1),
        })
    };
    let first = sessions(
        setup
            .query(&registry_owner(), &request(None, None))
            .unwrap(),
    );
    assert_eq!(first.active_total.value(), 2);
    assert_eq!(first.counts.items_by_status.open.value(), 2);
    let revision = first.sessions.snapshot_revision;
    assert_eq!(
        error(
            setup
                .query(
                    &registry_owner(),
                    &request(
                        first.sessions.next_cursor.clone(),
                        Some(SessionState::Closed)
                    )
                )
                .unwrap_err()
        )
        .code,
        CoreErrorCode::SnapshotChanged
    );
    setup.submit(10, "1", "Changes session only");
    let current = sessions(
        setup
            .query(&registry_owner(), &request(None, None))
            .unwrap(),
    );
    assert_eq!(current.sessions.snapshot_revision, revision);
    assert_eq!(
        error(
            setup
                .query(
                    &registry_owner(),
                    &request(first.sessions.next_cursor, None)
                )
                .unwrap_err()
        )
        .code,
        CoreErrorCode::SnapshotChanged
    );
}

#[test]
fn unavailable_metadata_and_known_bad_session_are_truthful_partial_rows() {
    let setup = Setup::new(&seed());
    let request = QueryRequest::ProjectList(ProjectListRequest {
        cursor: None,
        limit: limit(100),
    });
    let mut future = serde_json::to_value(setup.saved()).unwrap();
    future["schema_version"] = serde_json::json!(2);
    let bytes = serde_json::to_vec(&future).unwrap();
    fs::write(setup.path(), &bytes).unwrap();
    let result = projects(setup.query(&registry_owner(), &request).unwrap());
    assert_eq!(
        result.projects.items[0].availability,
        ProjectAvailability::Unavailable
    );
    assert!(result.projects.items[0].project.is_some());
    assert_eq!(result.counts.completeness, Completeness::Partial);
    assert_eq!(result.counts.unavailable_session_ids, vec![id(2)]);
    assert_eq!(fs::read(setup.path()).unwrap(), bytes);
    let metadata = store_dir(setup._home.path(), 1).join("project.json");
    fs::write(&metadata, b"unreadable canonical metadata").unwrap();
    let result = projects(setup.query(&registry_owner(), &request).unwrap());
    assert_eq!(result.projects.items[0].project_id, id(1));
    assert!(result.projects.items[0].project.is_none());
    assert_eq!(result.counts.completeness, Completeness::Partial);
    assert!(result.counts.unavailable_session_ids.is_empty());
    assert_eq!(
        fs::read(metadata).unwrap(),
        b"unreadable canonical metadata"
    );
}

#[test]
fn genuinely_absent_session_catalogue_is_empty_without_directory_creation() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let result = projects(
        QueryService::new(&registry)
            .query(
                &registry_owner(),
                &QueryRequest::ProjectList(ProjectListRequest {
                    cursor: None,
                    limit: limit(100),
                }),
            )
            .unwrap(),
    );
    assert_eq!(result.counts.completeness, Completeness::Complete);
    assert_eq!(result.counts.items_by_status.open.value(), 0);
    assert!(!store_dir(home.path(), 1).join("sessions").exists());
    assert!(!store_dir(home.path(), 1).join("backups").exists());
    fs::write(
        store_dir(home.path(), 1).join("sessions"),
        b"directory replaced by ordinary file",
    )
    .unwrap();
    let result = projects(
        QueryService::new(&registry)
            .query(
                &registry_owner(),
                &QueryRequest::ProjectList(ProjectListRequest {
                    cursor: None,
                    limit: limit(100),
                }),
            )
            .unwrap(),
    );
    assert_eq!(result.counts.completeness, Completeness::Partial);
    assert_eq!(
        result.projects.items[0].availability,
        ProjectAvailability::Unavailable
    );
}

#[test]
fn direct_item_timeline_does_not_union_activity_or_other_items_backlinks() {
    let setup = Setup::new(&seed());
    setup.submit(10, "1", "Direct reply one");
    setup.submit(11, "2", "Other item reply");
    let mut session = setup.saved();
    session
        .messages
        .last_mut()
        .unwrap()
        .items_touched
        .push(reference("1"));
    setup.replace(&session);
    let QueryResult::ItemMessages(result) = setup
        .query(
            &owner(),
            &QueryRequest::ItemMessages(ItemMessagesRequest {
                item_id: reference("1"),
                cursor: None,
                limit: limit(100),
            }),
        )
        .unwrap()
    else {
        panic!("timeline")
    };
    assert_eq!(result.messages.items.len(), 1);
    assert_eq!(result.messages.items[0].body, "Direct reply one");
    assert_eq!(
        result.timeline_context.created_message.unwrap().kind,
        MessageKind::Activity
    );
}

#[test]
fn agent_narrow_read_grant_hides_owner_bodies_and_round_and_item_backlinks() {
    let setup = Setup::new(&seed());
    setup.submit(10, "1", "Owner secret one");
    setup.submit(11, "1", "Owner future secret two");
    let mut session = setup.saved();
    session
        .bindings
        .0
        .get_mut(&id(3))
        .unwrap()
        .issued_through_message_number = NonnegativeSafeInteger::new(3).unwrap();
    setup.replace(&session);
    let read = messages(setup.query(&agent(2), &message_request(None, 100)).unwrap());
    assert!(read
        .items
        .iter()
        .any(|message| message.body == "Owner secret one"));
    assert!(!read
        .items
        .iter()
        .any(|message| message.body == "Owner future secret two"));
    let QueryResult::ItemRounds(result) = setup
        .query(
            &agent(2),
            &QueryRequest::ItemRounds(ItemRoundsRequest {
                item_id: reference("1"),
                cursor: None,
                limit: limit(100),
                round_pages: vec![],
            }),
        )
        .unwrap()
    else {
        panic!("rounds")
    };
    assert_eq!(result.rounds.items[0].owner_messages.items.len(), 1);
    let QueryResult::SessionRead(SessionReadResult::InputsQueue(queue)) = setup
        .query(
            &agent(0),
            &QueryRequest::SessionRead(SessionReadRequest {
                selection: ReadView::Inputs {
                    topic_id: None,
                    item_id: None,
                    states: vec![],
                },
                cursor: None,
                limit: limit(100),
                item_pages: vec![],
            }),
        )
        .unwrap()
    else {
        panic!("queue")
    };
    assert_eq!(queue.items.len(), 2);
    assert!(!serde_json::to_string(&queue).unwrap().contains("secret"));
    assert_eq!(
        error(
            setup
                .query(&agent(4), &message_request(None, 100))
                .unwrap_err()
        )
        .code,
        CoreErrorCode::InvalidArgument
    );
}

#[test]
fn item_status_filter_remains_literal_and_global_counts_match_session_counts() {
    let setup = Setup::new(&seed());
    setup.submit(10, "1", "Queued one");
    let global = projects(
        setup
            .query(
                &registry_owner(),
                &QueryRequest::ProjectList(ProjectListRequest {
                    cursor: None,
                    limit: limit(100),
                }),
            )
            .unwrap(),
    );
    let local = sessions(
        setup
            .query(
                &registry_owner(),
                &QueryRequest::SessionList(SessionListRequest {
                    project_id: Some(id(1)),
                    state: None,
                    cursor: None,
                    limit: limit(100),
                }),
            )
            .unwrap(),
    );
    assert_eq!(global.counts, local.counts);
    assert_eq!(local.counts, local.sessions.items[0].counts);
    // Every topic counts, archived included; archived_topics is the subset.
    let seeded = seed();
    assert_eq!(
        local.sessions.items[0].topic_count.value(),
        seeded.topics.0.len() as u64
    );
    assert!(
        local.sessions.items[0].counts.archived_topics.value()
            <= local.sessions.items[0].topic_count.value()
    );
    let QueryResult::SessionRead(SessionReadResult::Items(items)) = setup
        .query(
            &owner(),
            &QueryRequest::SessionRead(SessionReadRequest {
                selection: ReadView::Items {
                    topic_id: None,
                    item_id: None,
                    parent_item_id: None,
                    statuses: vec![ItemStatus::Done],
                    archived: None,
                },
                cursor: None,
                limit: limit(100),
                item_pages: vec![],
            }),
        )
        .unwrap()
    else {
        panic!("items")
    };
    assert_eq!(items.items.len(), 1);
    assert_eq!(items.items[0].item.id, reference("2"));
}

#[test]
fn large_escaped_round_history_is_complete_through_independent_continuations() {
    use ariadne_domain::history::{append_reply, AgentHistoryContext, ReplyDraft};
    let setup = Setup::new(&seed());
    let owner_text = format!("x{}", "\u{0001}".repeat(16 * 1024 - 1));
    for op in 10..14 {
        setup.submit(op, "1", &owner_text);
    }
    let mut session = setup.saved();
    let round_id = session.items.0[&reference("1")]
        .current_round_id
        .clone()
        .unwrap();
    let agent_text = format!("x{}", "\u{0001}".repeat(64 * 1024 - 1));
    for n in 0..3 {
        session = append_reply(
            &session,
            &AgentHistoryContext {
                binding_id: id(3),
                generation: id(4),
                source_input_id: None,
                attempt_id: None,
            },
            ReplyDraft {
                message_id: id(500 + n),
                item_id: reference("1"),
                text: agent_text.clone(),
                round_id: Some(round_id.clone()),
                at: session.updated_at.clone(),
            },
        )
        .unwrap();
    }
    setup.replace(&session);
    let request = |round_pages| {
        QueryRequest::ItemRounds(ItemRoundsRequest {
            item_id: reference("1"),
            cursor: None,
            limit: limit(1),
            round_pages,
        })
    };
    let QueryResult::ItemRounds(first) = setup.query(&owner(), &request(vec![])).unwrap() else {
        panic!("rounds")
    };
    assert!(serde_json::to_vec(&first.rounds.items[0]).unwrap().len() <= 768 * 1024);
    assert!(first.rounds.items[0].agent_messages.items.is_empty());
    let mut cursor = first.rounds.items[0].agent_messages.next_cursor.clone();
    assert!(cursor.as_ref().unwrap().after.is_none());
    let mut ids = Vec::new();
    while cursor.is_some() {
        let QueryResult::ItemRounds(result) = setup
            .query(
                &owner(),
                &request(vec![RoundPageRequest::RoundAgentMessages {
                    round_id: round_id.clone(),
                    cursor,
                    limit: limit(100),
                }]),
            )
            .unwrap()
        else {
            panic!("rounds")
        };
        let messages = &result.rounds.items[0].agent_messages;
        assert!(!messages.items.is_empty());
        for message in &messages.items {
            assert_eq!(message.body, agent_text);
            ids.push(message.id.clone());
        }
        cursor = messages.next_cursor.clone();
    }
    assert_eq!(ids, vec![id(500), id(501), id(502)]);
    let mut outer_cursor = None;
    let mut all = Vec::new();
    loop {
        let page = messages(
            setup
                .query(&owner(), &message_request(outer_cursor, 100))
                .unwrap(),
        );
        all.extend(page.items.into_iter().map(|message| message.id));
        outer_cursor = page.next_cursor;
        if outer_cursor.is_none() {
            break;
        }
    }
    assert_eq!(
        all,
        session
            .messages
            .iter()
            .map(|message| message.id.clone())
            .collect::<Vec<_>>()
    );
}

fn ask(mut session: Session, round_id: u64, cause_id: u64) -> Session {
    use ariadne_domain::{
        history::open_ask_round,
        transitions::{transition_item, ItemChange, TransitionContext},
    };
    let mut activity = session.messages[0].clone();
    activity.id = id(cause_id);
    activity.number = session.counters.next_message;
    activity.body = "Explicit new question episode".into();
    activity.items_touched = vec![reference("1")];
    session.counters.next_message = p(activity.number.value() + 1);
    session.messages.push(activity);
    let candidate = transition_item(
        &session,
        &reference("1"),
        &ItemChange::Ask {
            ask: "Choose the complete saved option".into(),
            options: vec![ItemOption {
                id: "yes".into(),
                label: "Full label".into(),
                consequence: "Full consequence".into(),
                recommended: true,
            }],
            recipient_binding_id: id(3),
            round_id: id(round_id),
        },
        &TransitionContext {
            binding_id: id(3),
            generation: id(4),
            cause_message_id: id(cause_id),
            at: session.updated_at.clone(),
            handled_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
            expected_revision: session.items.0[&reference("1")].revision,
            expected_question_revision: None,
        },
    )
    .unwrap();
    open_ask_round(
        &session,
        candidate,
        &id(cause_id),
        session.updated_at.clone(),
    )
    .unwrap()
}
fn answer(setup: &Setup, op: u64, supersedes: Option<UuidV4>) -> SavedReceipt {
    let revision = setup.saved().items.0[&reference("1")].question_revision;
    let command = OwnerCommand::InputSubmit {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(op),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: id(5),
                item_id: Some(reference("1")),
            },
            kind: InputKind::Answer,
            text: "".into(),
            selected_option_id: Some("yes".into()),
            expected_question_revision: Some(revision),
            supersedes_answer_id: supersedes,
        },
    };
    let MutationReceipt::Session(receipt) = InputService::new(&setup.registry)
        .execute(
            &owner_context(),
            &command,
            || id(setup.next.fetch_add(1, Ordering::SeqCst)),
            setup.saved().updated_at,
        )
        .unwrap()
    else {
        panic!("answer receipt")
    };
    *receipt
}
fn input_answer(receipt: &SavedReceipt) -> (UuidV4, UuidV4) {
    let SavedReceiptData::InputSubmit {
        input_id,
        answer_id,
        ..
    } = &receipt.data
    else {
        panic!("input receipt")
    };
    (input_id.clone(), answer_id.clone().unwrap())
}
fn waiting_count(setup: &Setup) -> u64 {
    projects(
        setup
            .query(
                &registry_owner(),
                &QueryRequest::ProjectList(ProjectListRequest {
                    cursor: None,
                    limit: limit(100),
                }),
            )
            .unwrap(),
    )
    .counts
    .waiting_unanswered
    .value()
}
#[test]
fn waiting_uses_current_unsuperseded_eligible_answer_without_changing_status_filter() {
    let setup = Setup::new(&ask(seed(), 201, 101));
    assert_eq!(waiting_count(&setup), 1);
    let first = answer(&setup, 10, None);
    let (_, first_answer) = input_answer(&first);
    assert_eq!(waiting_count(&setup), 0);
    let QueryResult::SessionRead(SessionReadResult::Items(items)) = setup
        .query(
            &owner(),
            &QueryRequest::SessionRead(SessionReadRequest {
                selection: ReadView::Items {
                    topic_id: None,
                    item_id: None,
                    parent_item_id: None,
                    statuses: vec![ItemStatus::WaitingOnMe],
                    archived: None,
                },
                cursor: None,
                limit: limit(100),
                item_pages: vec![],
            }),
        )
        .unwrap()
    else {
        panic!("items")
    };
    assert_eq!(items.items.len(), 1);
    assert_eq!(items.items[0].item.status, ItemStatus::WaitingOnMe);
    let replacement = answer(&setup, 11, Some(first_answer));
    let (replacement_input, _) = input_answer(&replacement);
    let command = OwnerCommand::InputCancel {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(12),
        params: InputCancelParams {
            input_id: replacement_input,
            expected_revision: setup.saved().revision,
            purpose: None,
        },
    };
    InputService::new(&setup.registry)
        .execute(
            &owner_context(),
            &command,
            || id(9999),
            setup.saved().updated_at,
        )
        .unwrap();
    assert_eq!(waiting_count(&setup), 1); // Earlier Answer was superseded, not reactivated.
    let current = setup.saved();
    assert_eq!(
        current.items.0[&reference("1")].status,
        ItemStatus::WaitingOnMe
    );
    assert_eq!(
        current
            .inputs
            .0
            .values()
            .filter(|input| input.state == InputState::Queued)
            .count(),
        1
    );
    setup.replace(&ask(current, 202, 102));
    assert_eq!(waiting_count(&setup), 1);
}

#[test]
fn dispatched_historical_attempt_read_uses_current_generation_and_narrow_source_ceiling() {
    let mut session: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json")).unwrap();
    let input_id = UuidV4::new("00000000-0000-4000-8000-000000000070").unwrap();
    let binding_id = session.active_binding_id.clone().unwrap();
    let attempt_id = session.inputs.0[&input_id].attempts[0].id.clone();
    let original_generation = session.inputs.0[&input_id].attempts[0]
        .binding_generation
        .clone();
    let current_generation = id(777);
    session.bindings.0.get_mut(&binding_id).unwrap().generation = current_generation.clone();
    let setup = Setup::new(&session);
    let context = |generation, grant, attempt_id, source_input_id| {
        QueryContext::agent(AgentContext::from_trusted_entrypoint(
            RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
            binding_id.clone(),
            generation,
            AgentReadScope::Dispatched {
                source_input_id,
                attempt_id,
                issued_through_message_number: NonnegativeSafeInteger::new(grant).unwrap(),
            },
        ))
    };
    let read = messages(
        setup
            .query(
                &context(
                    current_generation.clone(),
                    1,
                    attempt_id.clone(),
                    input_id.clone(),
                ),
                &message_request(None, 100),
            )
            .unwrap(),
    );
    assert!(read
        .items
        .iter()
        .all(|message| message.author != MessageAuthor::Owner || message.number.value() <= 1));
    assert_eq!(
        setup.saved().inputs.0[&input_id].attempts[0].binding_generation,
        original_generation
    );
    assert_eq!(
        error(
            setup
                .query(
                    &context(original_generation, 1, attempt_id.clone(), input_id.clone()),
                    &message_request(None, 100)
                )
                .unwrap_err()
        )
        .code,
        CoreErrorCode::StaleGeneration
    );
    assert_eq!(
        error(
            setup
                .query(
                    &context(
                        current_generation.clone(),
                        3,
                        attempt_id.clone(),
                        input_id.clone()
                    ),
                    &message_request(None, 100)
                )
                .unwrap_err()
        )
        .code,
        CoreErrorCode::InvalidArgument
    );
    assert_eq!(
        error(
            setup
                .query(
                    &context(current_generation, 1, id(999), input_id),
                    &message_request(None, 100)
                )
                .unwrap_err()
        )
        .code,
        CoreErrorCode::InvalidArgument
    );
}

#[test]
fn every_message_and_independent_item_history_page_is_reachable_and_scoped() {
    use ariadne_domain::history::{append_reply, AgentHistoryContext, ReplyDraft};
    let mut session = seed();
    for n in 0..130 {
        session = append_reply(
            &session,
            &AgentHistoryContext {
                binding_id: id(3),
                generation: id(4),
                source_input_id: None,
                attempt_id: None,
            },
            ReplyDraft {
                message_id: id(500 + n),
                item_id: reference("1"),
                text: format!("Full independent reply {n}.\nSecond line."),
                round_id: None,
                at: session.updated_at.clone(),
            },
        )
        .unwrap();
    }
    let setup = Setup::new(&session);
    let first = messages(setup.query(&owner(), &message_request(None, 100)).unwrap());
    assert_eq!(first.items.len(), 100);
    let next = messages(
        setup
            .query(&owner(), &message_request(first.next_cursor.clone(), 100))
            .unwrap(),
    );
    assert_eq!(next.items.len(), 31);
    assert!(next.next_cursor.is_none());
    let request = |item_id, item_pages| {
        QueryRequest::SessionRead(SessionReadRequest {
            selection: ReadView::Items {
                topic_id: None,
                item_id: Some(item_id),
                parent_item_id: None,
                statuses: vec![],
                archived: None,
            },
            cursor: None,
            limit: limit(1),
            item_pages,
        })
    };
    let QueryResult::SessionRead(SessionReadResult::Items(items)) = setup
        .query(&owner(), &request(reference("1"), vec![]))
        .unwrap()
    else {
        panic!("items")
    };
    assert_eq!(items.items[0].updated_messages.items.len(), 100);
    let nested = items.items[0].updated_messages.next_cursor.clone();
    let QueryResult::SessionRead(SessionReadResult::Items(items)) = setup
        .query(
            &owner(),
            &request(
                reference("1"),
                vec![ItemPageRequest::ItemUpdatedMessages {
                    item_id: reference("1"),
                    cursor: nested.clone(),
                    limit: limit(100),
                }],
            ),
        )
        .unwrap()
    else {
        panic!("items")
    };
    assert_eq!(items.items[0].updated_messages.items.len(), 30);
    assert!(items.items[0].updated_messages.next_cursor.is_none());
    assert_eq!(
        error(
            setup
                .query(
                    &owner(),
                    &request(
                        reference("2"),
                        vec![ItemPageRequest::ItemUpdatedMessages {
                            item_id: reference("2"),
                            cursor: nested,
                            limit: limit(100)
                        }]
                    )
                )
                .unwrap_err()
        )
        .code,
        CoreErrorCode::InvalidArgument
    );
    assert_eq!(
        error(
            setup
                .query(
                    &owner(),
                    &request(
                        reference("1"),
                        vec![ItemPageRequest::ItemStatusHistory {
                            item_id: reference("2"),
                            cursor: None,
                            limit: limit(1)
                        }]
                    )
                )
                .unwrap_err()
        )
        .code,
        CoreErrorCode::InvalidArgument
    );
    let mut wrong = first.next_cursor.unwrap();
    wrong.after = Some(CursorPosition::History {
        index: NonnegativeSafeInteger::new(1).unwrap(),
    });
    assert_eq!(
        error(
            setup
                .query(&owner(), &message_request(Some(wrong), 100))
                .unwrap_err()
        )
        .code,
        CoreErrorCode::InvalidArgument
    );
}

#[test]
fn every_round_and_its_full_answer_snapshot_remains_reachable() {
    let setup = Setup::new(&ask(seed(), 201, 101));
    for n in 0..5 {
        if n != 0 {
            setup.replace(&ask(setup.saved(), 201 + n, 101 + n));
        }
        answer(&setup, 10 + n, None);
    }
    let mut cursor = None;
    let mut rounds = Vec::new();
    let mut answers = Vec::new();
    loop {
        let QueryResult::ItemRounds(result) = setup
            .query(
                &owner(),
                &QueryRequest::ItemRounds(ItemRoundsRequest {
                    item_id: reference("1"),
                    cursor,
                    limit: limit(2),
                    round_pages: vec![],
                }),
            )
            .unwrap()
        else {
            panic!("rounds")
        };
        for round in &result.rounds.items {
            rounds.push(round.round.id.clone());
            assert_eq!(round.answers.items.len(), 1);
            let answer = &round.answers.items[0];
            assert_eq!(answer.text, "");
            assert_eq!(answer.selected_option_id.as_deref(), Some("yes"));
            assert_eq!(answer.options_snapshot[0].consequence, "Full consequence");
            answers.push(answer.id.clone());
        }
        cursor = result.rounds.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(rounds, (201..206).map(id).collect::<Vec<_>>());
    assert_eq!(answers.len(), 5);
    let hidden = setup
        .query(
            &agent(0),
            &QueryRequest::ItemRounds(ItemRoundsRequest {
                item_id: reference("1"),
                cursor: None,
                limit: limit(100),
                round_pages: vec![],
            }),
        )
        .unwrap();
    let QueryResult::ItemRounds(hidden) = hidden else {
        panic!("rounds")
    };
    assert!(hidden
        .rounds
        .items
        .iter()
        .all(|round| round.answers.items.is_empty() && round.owner_messages.items.is_empty()));
}

#[test]
fn concurrent_writer_and_reads_never_expose_partly_saved_owner_history() {
    let setup = Setup::new(&seed());
    std::thread::scope(|threads| {
        let writer = threads.spawn(|| {
            for op in 10..30 {
                setup.submit(op, "1", &format!("Atomic owner text {op}"));
            }
        });
        for _ in 0..30 {
            let QueryResult::SessionGet(snapshot) =
                setup.query(&owner(), &QueryRequest::SessionGet {}).unwrap()
            else {
                panic!("snapshot")
            };
            let session = snapshot.session;
            assert_eq!(session.messages.len(), session.inputs.0.len() + 1);
            assert_eq!(session.revision.value(), session.inputs.0.len() as u64 + 1);
            for input in session.inputs.0.values() {
                let message = session
                    .messages
                    .iter()
                    .find(|message| message.id == input.message_id)
                    .unwrap();
                assert_eq!(message.body, input.payload.text);
                assert_eq!(message.input_id.as_ref(), Some(&input.id));
            }
        }
        writer.join().unwrap();
    });
    assert_eq!(setup.saved().inputs.0.len(), 20);
}

#[test]
fn canonical_result_fork_status_and_ordinal_pages_use_stored_links() {
    let session: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json")).unwrap();
    let setup = Setup::new(&session);
    let QueryResult::ItemRounds(result) = setup
        .query(
            &owner(),
            &QueryRequest::ItemRounds(ItemRoundsRequest {
                item_id: reference("1"),
                cursor: None,
                limit: limit(100),
                round_pages: vec![],
            }),
        )
        .unwrap()
    else {
        panic!("rounds")
    };
    let round = &result.rounds.items[0];
    let original = session
        .rounds
        .0
        .values()
        .find(|round| round.item_id == reference("1"))
        .unwrap();
    assert_eq!(
        round
            .owner_messages
            .items
            .iter()
            .map(|message| &message.id)
            .collect::<Vec<_>>(),
        original.owner_message_ids.iter().collect::<Vec<_>>()
    );
    assert_eq!(
        round
            .agent_messages
            .items
            .iter()
            .map(|message| &message.id)
            .collect::<Vec<_>>(),
        original.agent_message_ids.iter().collect::<Vec<_>>()
    );
    assert_eq!(round.forks.items[0].item_id, reference("1.1"));
    let input = session
        .inputs
        .0
        .values()
        .find(|input| original.result_input_ids.contains(&input.id))
        .unwrap();
    let attempt = input
        .attempts
        .iter()
        .find(|attempt| attempt.domain_result.is_some())
        .unwrap();
    assert_eq!(
        &round.results.items[0].result,
        attempt.domain_result.as_ref().unwrap()
    );
    assert_eq!(round.results.items[0].attempt_id, attempt.id);
    let request = |cursor| {
        QueryRequest::SessionRead(SessionReadRequest {
            selection: ReadView::Items {
                topic_id: None,
                item_id: None,
                parent_item_id: None,
                statuses: vec![],
                archived: None,
            },
            cursor,
            limit: limit(1),
            item_pages: vec![],
        })
    };
    let QueryResult::SessionRead(SessionReadResult::Items(first)) =
        setup.query(&owner(), &request(None)).unwrap()
    else {
        panic!("items")
    };
    assert_eq!(first.items[0].item.id, reference("1"));
    assert_eq!(
        first.items[0].status_history.items,
        session.items.0[&reference("1")].status_history
    );
    assert!(
        matches!(first.next_cursor.as_ref().unwrap().after, Some(CursorPosition::Item { ref ordinals, .. }) if ordinals == &vec![p(1)])
    );
    let QueryResult::SessionRead(SessionReadResult::Items(child)) =
        setup.query(&owner(), &request(first.next_cursor)).unwrap()
    else {
        panic!("items")
    };
    assert_eq!(child.items[0].item.id, reference("1.1"));
    assert!(
        matches!(child.next_cursor.as_ref().unwrap().after, Some(CursorPosition::Item { ref ordinals, .. }) if ordinals == &vec![p(1), p(1)])
    );
}

#[test]
fn ordinary_queries_observe_topics_owner_input_snapshots_and_explicit_missing_items() {
    let setup = Setup::new(&seed());
    setup.submit(10, "1", "Frozen owner input snapshot");
    let QueryResult::SessionRead(SessionReadResult::Topics(topics)) = setup
        .query(
            &owner(),
            &QueryRequest::SessionRead(SessionReadRequest {
                selection: ReadView::Topics {
                    archived: Some(false),
                },
                cursor: None,
                limit: limit(100),
                item_pages: vec![],
            }),
        )
        .unwrap()
    else {
        panic!("topics")
    };
    assert_eq!(
        topics.items,
        setup.saved().topics.0.values().cloned().collect::<Vec<_>>()
    );
    let QueryResult::SessionRead(SessionReadResult::Inputs(inputs)) = setup
        .query(
            &owner(),
            &QueryRequest::SessionRead(SessionReadRequest {
                selection: ReadView::Inputs {
                    topic_id: Some(id(5)),
                    item_id: Some(reference("1")),
                    states: vec![InputState::Queued],
                },
                cursor: None,
                limit: limit(100),
                item_pages: vec![],
            }),
        )
        .unwrap()
    else {
        panic!("inputs")
    };
    assert_eq!(
        inputs.items[0],
        *setup.saved().inputs.0.values().next().unwrap()
    );
    let QueryResult::RevealItem(route) = setup
        .query(
            &owner(),
            &QueryRequest::RevealItem {
                item_id: reference("2"),
            },
        )
        .unwrap()
    else {
        panic!("route")
    };
    assert_eq!(route.item_id, reference("2"));
    assert_eq!(
        error(
            setup
                .query(
                    &owner(),
                    &QueryRequest::RevealItem {
                        item_id: reference("99")
                    }
                )
                .unwrap_err()
        )
        .code,
        CoreErrorCode::NotFound
    );
    assert_eq!(
        error(
            setup
                .query(&registry_owner(), &QueryRequest::PreferencesGet {})
                .unwrap_err()
        )
        .code,
        CoreErrorCode::Unsupported
    );
    assert_eq!(
        error(
            setup
                .query(&agent(0), &QueryRequest::SessionGet {})
                .unwrap_err()
        )
        .code,
        CoreErrorCode::PermissionDenied
    );
}

#[test]
fn empty_registry_uses_positive_revision_without_persisting_a_registry_snapshot() {
    let home = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    let request = QueryRequest::ProjectList(ProjectListRequest {
        cursor: None,
        limit: limit(100),
    });
    let result = projects(
        QueryService::new(&registry)
            .query(&registry_owner(), &request)
            .unwrap(),
    );
    assert_eq!(result.projects.snapshot_revision, p(1));
    assert!(result.projects.items.is_empty());
    assert!(result.projects.next_cursor.is_none());
    assert_eq!(result.counts.completeness, Completeness::Complete);
    assert!(!home.path().join(".ariadne/projects.json").exists());
    assert!(!home.path().join(".ariadne/bindings.json").exists());
}

#[test]
fn state_filtered_session_page_keeps_unfiltered_scope_counts_and_both_totals() {
    let setup = Setup::new(&seed());
    let mut closed = seed();
    closed.id = id(20);
    closed.state = SessionState::Closed;
    closed.closed_at = Some(closed.updated_at.clone());
    let item = closed.items.0.get_mut(&reference("1")).unwrap();
    item.status = ItemStatus::Done;
    item.outcome = Some("Finished before closing".into());
    item.why = Some("The completed outcome is durable".into());
    let binding = closed.bindings.0.get_mut(&id(3)).unwrap();
    binding.owner_paused = true;
    binding.dispatch_state = DispatchState::Paused;
    binding.pause_reason = None;
    Store::open_registered(&store_dir(setup._home.path(), 1), id(1))
        .unwrap()
        .create(&closed)
        .unwrap();
    let request = QueryRequest::SessionList(SessionListRequest {
        project_id: Some(id(1)),
        state: Some(SessionState::Active),
        cursor: None,
        limit: limit(100),
    });
    let result = sessions(setup.query(&registry_owner(), &request).unwrap());
    assert_eq!(result.sessions.items.len(), 1);
    assert_eq!(result.active_total.value(), 1);
    assert_eq!(result.closed_total.value(), 1);
    assert_eq!(result.counts.items_by_status.open.value(), 1);
    assert_eq!(result.counts.items_by_status.done.value(), 3);
    let scoped = QueryContext::owner(OwnerContext::from_trusted_entrypoint(OwnerScope::Project(
        id(1),
    )));
    assert_eq!(
        sessions(setup.query(&scoped, &request).unwrap()).counts,
        result.counts
    );
    let invalid = QueryRequest::SessionList(SessionListRequest {
        project_id: Some(id(9)),
        state: None,
        cursor: None,
        limit: limit(100),
    });
    assert_eq!(
        error(setup.query(&scoped, &invalid).unwrap_err()).code,
        CoreErrorCode::InvalidArgument
    );
}

#[test]
fn project_summary_validator_rejects_fabricated_available_or_wrong_identity_rows() {
    let setup = Setup::new(&seed());
    let request = QueryRequest::ProjectList(ProjectListRequest {
        cursor: None,
        limit: limit(100),
    });
    let original = setup.query(&registry_owner(), &request).unwrap();
    for case in 0..3 {
        let QueryResult::ProjectList(mut result) = original.clone() else {
            panic!("projects")
        };
        match case {
            0 => result.projects.items[0].project = None,
            1 => result.projects.items[0].project.as_mut().unwrap().id = id(9),
            _ => result.projects.items[0].availability = ProjectAvailability::Unavailable,
        }
        assert_eq!(
            QueryResult::ProjectList(result)
                .validate_for(&registry_owner(), &request)
                .unwrap_err()
                .code,
            CoreErrorCode::InvalidArgument
        );
    }
}

#[test]
fn projection_writer_child() {
    let Some(home) = std::env::var_os("ARIADNE_QUERY_WRITER_HOME") else {
        return;
    };
    let ready = std::path::PathBuf::from(std::env::var_os("ARIADNE_QUERY_WRITER_READY").unwrap());
    let release =
        std::path::PathBuf::from(std::env::var_os("ARIADNE_QUERY_WRITER_RELEASE").unwrap());
    let registry = Registry::open(std::path::Path::new(&home)).unwrap();
    let command = OwnerCommand::InputSubmit {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(10),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: id(5),
                item_id: Some(reference("1")),
            },
            kind: InputKind::Reply,
            text: "Complete separate-process owner save".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    let mut next = 1000;
    let mut gated = false;
    InputService::new(&registry)
        .execute(
            &owner_context(),
            &command,
            || {
                if !gated {
                    gated = true;
                    fs::write(&ready, b"session transaction lock held").unwrap();
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                    while !release.exists() {
                        assert!(std::time::Instant::now() < deadline, "release timed out");
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                }
                let result = id(next);
                next += 1;
                result
            },
            UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap(),
        )
        .unwrap();
}

#[test]
fn read_waits_for_a_separate_process_transaction_then_returns_its_complete_save() {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let setup = Setup::new(&seed());
    let ready = setup._home.path().join("writer-ready");
    let release = setup._home.path().join("writer-release");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "projection_writer_child", "--nocapture"])
        .env("ARIADNE_QUERY_WRITER_HOME", setup._home.path())
        .env("ARIADNE_QUERY_WRITER_READY", &ready)
        .env("ARIADNE_QUERY_WRITER_RELEASE", &release)
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready.exists() {
        assert!(Instant::now() < deadline, "writer did not hold lock");
        assert!(child.try_wait().unwrap().is_none(), "writer exited early");
        std::thread::sleep(Duration::from_millis(5));
    }
    std::thread::scope(|threads| {
        let (tx, rx) = std::sync::mpsc::channel();
        let setup_ref = &setup;
        let reader = threads.spawn(move || {
            tx.send(setup_ref.query(&owner(), &QueryRequest::SessionGet {}))
                .unwrap();
        });
        assert!(matches!(
            rx.recv_timeout(Duration::from_millis(50)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        fs::write(&release, b"release test-owned transaction").unwrap();
        let result = rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        reader.join().unwrap();
        let QueryResult::SessionGet(snapshot) = result else {
            panic!("snapshot")
        };
        assert_eq!(snapshot.session.revision, p(2));
        assert_eq!(snapshot.session.inputs.0.len(), 1);
        let input = snapshot.session.inputs.0.values().next().unwrap();
        let message = snapshot
            .session
            .messages
            .iter()
            .find(|message| message.id == input.message_id)
            .unwrap();
        assert_eq!(message.body, "Complete separate-process owner save");
        assert_eq!(message.body, input.payload.text);
    });
    assert!(child.wait().unwrap().success());
}

#[test]
fn session_summary_carries_the_owner_name_and_description_only_when_set() {
    let list = |session: &Session| {
        sessions(
            Setup::new(session)
                .query(
                    &registry_owner(),
                    &QueryRequest::SessionList(SessionListRequest {
                        project_id: Some(id(1)),
                        state: None,
                        cursor: None,
                        limit: limit(100),
                    }),
                )
                .unwrap(),
        )
    };
    let mut named = seed();
    named.name = Some("Sync fixes".into());
    named.description = Some("Sorting out the undo rules".into());
    let named_list = list(&named);
    let summary = &named_list.sessions.items[0];
    assert_eq!(summary.name.as_deref(), Some("Sync fixes"));
    assert_eq!(
        summary.description.as_deref(),
        Some("Sorting out the undo rules")
    );
    let plain = list(&seed());
    let summary = &plain.sessions.items[0];
    assert!(summary.name.is_none() && summary.description.is_none());
    let json = serde_json::to_string(summary).unwrap();
    assert!(!json.contains("\"name\"") && !json.contains("\"description\""));
}

#[test]
fn archived_sessions_have_separate_totals_readable_history_and_no_aggregate_waiting_counts() {
    let setup = Setup::new(&seed());
    let mut archived = seed();
    archived.id = id(20);
    archived.state = SessionState::Closed;
    archived.closed_at = Some(archived.updated_at.clone());
    archived.archived_at = Some(archived.updated_at.clone());
    let binding = archived.bindings.0.get_mut(&id(3)).unwrap();
    binding.owner_paused = true;
    binding.dispatch_state = DispatchState::Paused;
    Store::open_registered(&store_dir(setup._home.path(), 1), id(1))
        .unwrap()
        .create(&archived)
        .unwrap();
    let result = sessions(
        setup
            .query(
                &registry_owner(),
                &QueryRequest::SessionList(SessionListRequest {
                    project_id: Some(id(1)),
                    state: None,
                    cursor: None,
                    limit: limit(100),
                }),
            )
            .unwrap(),
    );
    assert_eq!(result.sessions.items.len(), 2);
    assert_eq!(result.active_total.value(), 1);
    assert_eq!(result.closed_total.value(), 0);
    assert_eq!(result.archived_total.value(), 1);
    for state in [SessionState::Active, SessionState::Closed] {
        let filtered = sessions(
            setup
                .query(
                    &registry_owner(),
                    &QueryRequest::SessionList(SessionListRequest {
                        project_id: Some(id(1)),
                        state: Some(state.clone()),
                        cursor: None,
                        limit: limit(100),
                    }),
                )
                .unwrap(),
        );
        assert!(filtered
            .sessions
            .items
            .iter()
            .all(|session| session.archived_at.is_none()));
        assert_eq!(
            filtered.sessions.items.len(),
            if state == SessionState::Active { 1 } else { 0 }
        );
        assert_eq!(filtered.archived_total.value(), 1);
        assert_eq!(filtered.counts, result.counts);
    }

    let archived_summary = result
        .sessions
        .items
        .iter()
        .find(|s| s.session_id == id(20))
        .unwrap();
    assert!(archived_summary.archived_at.is_some());
    assert_eq!(
        result.counts,
        result
            .sessions
            .items
            .iter()
            .find(|s| s.session_id == id(2))
            .unwrap()
            .counts
    );
    let project = projects(
        setup
            .query(
                &registry_owner(),
                &QueryRequest::ProjectList(ProjectListRequest {
                    cursor: None,
                    limit: limit(100),
                }),
            )
            .unwrap(),
    );
    assert_eq!(project.counts, result.counts);
    let owner = QueryContext::owner(OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(1), id(20)),
    )));
    let history = messages(setup.query(&owner, &message_request(None, 100)).unwrap());
    assert_eq!(history.items, archived.messages);
    let agent = QueryContext::agent(AgentContext::from_trusted_entrypoint(
        RegisteredSession::from_trusted_entrypoint(id(1), id(20)),
        id(3),
        id(4),
        AgentReadScope::Terminal {
            issued_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
        },
    ));
    assert!(setup.query(&agent, &message_request(None, 100)).is_ok());
}

#[test]
fn related_projection_skips_missing_targets_without_changing_saved_data() {
    let mut session = seed();
    let related = Some(vec![reference("2"), reference("99")]);
    session.items.0.get_mut(&reference("1")).unwrap().related = related.clone();
    let setup = Setup::new(&session);
    let QueryResult::SessionRead(SessionReadResult::Items(items)) = setup
        .query(
            &owner(),
            &QueryRequest::SessionRead(SessionReadRequest {
                selection: ReadView::Items {
                    topic_id: None,
                    item_id: Some(reference("1")),
                    parent_item_id: None,
                    statuses: vec![],
                    archived: None,
                },
                cursor: None,
                limit: limit(100),
                item_pages: vec![],
            }),
        )
        .unwrap()
    else {
        panic!("items")
    };
    assert_eq!(items.items[0].item.related, Some(vec![reference("2")]));
    assert_eq!(setup.saved().items.0[&reference("1")].related, related);
}

#[test]
fn archived_related_reads_stay_in_the_same_session_and_create_no_owner_input() {
    let mut session = seed();
    let related = Some(vec![reference("2"), reference("99")]);
    session.items.0.get_mut(&reference("1")).unwrap().related = related.clone();
    let setup = Setup::new(&session);
    let mut other = seed();
    other.id = id(20);
    let mut foreign = other.items.0[&reference("2")].clone();
    foreign.id = reference("99");
    foreign.ordinal = p(99);
    foreign.question = "This item exists only in the other session".into();
    other
        .messages
        .iter_mut()
        .find(|message| message.id == foreign.created_message_id)
        .unwrap()
        .items_touched
        .push(foreign.id.clone());
    other.items.0.insert(foreign.id.clone(), foreign);
    other.counters.next_root = p(100);
    Store::open_registered(&store_dir(setup._home.path(), 1), id(1))
        .unwrap()
        .create(&other)
        .unwrap();
    ariadne_core::history_actions::HistoryActionService::new(&setup.registry)
        .execute(
            &owner_context(),
            &OwnerCommand::SessionArchive {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(100),
                params: SessionLifecycleParams {
                    expected_revision: p(1),
                },
            },
            UtcMillis::new("2026-10-09T12:00:00.000Z").unwrap(),
        )
        .unwrap();
    let before = fs::read(setup.path()).unwrap();
    let request = QueryRequest::SessionRead(SessionReadRequest {
        selection: ReadView::Items {
            topic_id: None,
            item_id: Some(reference("1")),
            parent_item_id: None,
            statuses: vec![],
            archived: None,
        },
        cursor: None,
        limit: limit(100),
        item_pages: vec![],
    });
    for context in [owner(), agent(0)] {
        let QueryResult::SessionRead(SessionReadResult::Items(items)) =
            setup.query(&context, &request).unwrap()
        else {
            panic!("items")
        };
        assert_eq!(items.items[0].item.related, Some(vec![reference("2")]));
    }
    let archived = setup.saved();
    assert!(archived.archived_at.is_some());
    assert_eq!(archived.items.0[&reference("1")].related, related);
    assert!(archived.inputs.0.is_empty());
    assert_eq!(fs::read(setup.path()).unwrap(), before);
    let submit = OwnerCommand::InputSubmit {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(101),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: id(5),
                item_id: Some(reference("2")),
            },
            kind: InputKind::Note,
            text: "Keep the related item readable".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    assert!(matches!(
        InputService::new(&setup.registry).execute(
            &owner_context(),
            &submit,
            || panic!("archived input cannot allocate"),
            UtcMillis::new("2026-10-09T12:00:00.000Z").unwrap(),
        ),
        Err(ariadne_core::inputs::InputError::Core(CoreError {
            code: CoreErrorCode::InvalidTransition,
            ..
        }))
    ));
    assert_eq!(fs::read(setup.path()).unwrap(), before);
}

#[test]
fn removed_subtrees_leave_live_reads_counts_and_links_but_restore_saved_declarations() {
    let mut session = seed();
    let removed = reference("2");
    let child_id = reference("2.1");
    let mut child = session.items.0[&removed].clone();
    child.id = child_id.clone();
    child.parent = Some(removed.clone());
    child.ordinal = p(1);
    session.items.0.insert(child_id.clone(), child);
    session.items.0.get_mut(&removed).unwrap().next_child = p(2);
    session.messages[0].items_touched.push(child_id);
    let declaring = session.items.0.get_mut(&reference("1")).unwrap();
    declaring.related = Some(vec![removed.clone()]);
    declaring.status = ItemStatus::Replaced;
    declaring.outcome = Some("The replacement is retained in saved history".into());
    declaring.why = Some("The replacement remains useful after restore".into());
    declaring.replaced_by = Some(removed.clone());
    let provenance = removal_source(&mut session, Some(removed.clone()));
    let removed_item = session.items.0.get_mut(&removed).unwrap();
    removed_item.removed_at = Some(session.updated_at.clone());
    removed_item.removed_by = Some(provenance);
    let setup = Setup::new(&session);
    let request = QueryRequest::SessionRead(SessionReadRequest {
        selection: ReadView::Items {
            topic_id: None,
            item_id: None,
            parent_item_id: None,
            statuses: vec![],
            archived: None,
        },
        cursor: None,
        limit: limit(100),
        item_pages: vec![],
    });
    for context in [owner(), agent(0)] {
        let QueryResult::SessionRead(SessionReadResult::Items(items)) =
            setup.query(&context, &request).unwrap()
        else {
            panic!("items")
        };
        assert_eq!(items.items.len(), 1);
        assert_eq!(items.items[0].item.id, reference("1"));
        assert_eq!(items.items[0].item.related, Some(vec![]));
        assert!(items.items[0].item.replaced_by.is_none());
    }
    let list = QueryRequest::SessionList(SessionListRequest {
        project_id: None,
        state: None,
        cursor: None,
        limit: limit(100),
    });
    let counts = sessions(setup.query(&registry_owner(), &list).unwrap()).counts;
    assert_eq!(counts.items_by_status.replaced.value(), 1);
    assert_eq!(counts.items_by_status.done.value(), 0);
    let QueryResult::SessionGet(snapshot) =
        setup.query(&owner(), &QueryRequest::SessionGet {}).unwrap()
    else {
        panic!("snapshot")
    };
    assert_eq!(snapshot.session, session);
    assert_eq!(setup.saved(), session);
    assert_eq!(
        error(
            setup
                .query(
                    &owner(),
                    &QueryRequest::RevealItem {
                        item_id: removed.clone()
                    }
                )
                .unwrap_err()
        )
        .code,
        CoreErrorCode::NotFound
    );
    for request in [
        QueryRequest::ItemMessages(ItemMessagesRequest {
            item_id: removed.clone(),
            cursor: None,
            limit: limit(100),
        }),
        QueryRequest::ItemRounds(ItemRoundsRequest {
            item_id: removed.clone(),
            cursor: None,
            limit: limit(100),
            round_pages: vec![],
        }),
    ] {
        assert!(setup.query(&owner(), &request).is_ok());
        assert_eq!(
            error(setup.query(&agent(0), &request).unwrap_err()).code,
            CoreErrorCode::NotFound
        );
    }
    session.items.0.get_mut(&removed).unwrap().removed_at = None;
    session.items.0.get_mut(&removed).unwrap().removed_by = None;
    setup.replace(&session);
    let QueryResult::SessionRead(SessionReadResult::Items(items)) =
        setup.query(&agent(0), &request).unwrap()
    else {
        panic!("items")
    };
    assert_eq!(items.items.len(), 3);
    assert_eq!(items.items[0].item.related, Some(vec![removed.clone()]));
    assert_eq!(items.items[0].item.replaced_by, Some(removed));
}

#[test]
fn removed_topics_hide_items_and_totals_but_keep_cancelled_owner_message_text_readable() {
    let setup = Setup::new(&seed());
    setup.submit(10, "1", "Cancelled owner text.\nStill readable exactly.  ");
    let mut session = setup.saved();
    let provenance = removal_source(&mut session, None);
    let topic = session.topics.0.get_mut(&id(5)).unwrap();
    topic.removed_at = Some(session.updated_at.clone());
    topic.removed_by = Some(provenance);
    topic.archived_at = Some(session.updated_at.clone());
    for input in session.inputs.0.values_mut() {
        input.state = InputState::Cancelled;
    }
    session
        .bindings
        .0
        .get_mut(&id(3))
        .unwrap()
        .issued_through_message_number = NonnegativeSafeInteger::new(2).unwrap();
    setup.replace(&session);
    let request = QueryRequest::SessionRead(SessionReadRequest {
        selection: ReadView::Topics { archived: None },
        cursor: None,
        limit: limit(100),
        item_pages: vec![],
    });
    for context in [owner(), agent(2)] {
        let QueryResult::SessionRead(SessionReadResult::Topics(topics)) =
            setup.query(&context, &request).unwrap()
        else {
            panic!("topics")
        };
        assert!(topics.items.is_empty());
        let history = messages(setup.query(&context, &message_request(None, 100)).unwrap());
        assert!(history
            .items
            .iter()
            .any(|message| message.body == "Cancelled owner text.\nStill readable exactly.  "));
    }
    let QueryResult::ItemMessages(timeline) = setup
        .query(
            &owner(),
            &QueryRequest::ItemMessages(ItemMessagesRequest {
                item_id: reference("1"),
                cursor: None,
                limit: limit(100),
            }),
        )
        .unwrap()
    else {
        panic!("timeline")
    };
    assert_eq!(
        timeline.messages.items[0].body,
        "Cancelled owner text.\nStill readable exactly.  "
    );
    let list = sessions(
        setup
            .query(
                &registry_owner(),
                &QueryRequest::SessionList(SessionListRequest {
                    project_id: None,
                    state: None,
                    cursor: None,
                    limit: limit(100),
                }),
            )
            .unwrap(),
    );
    assert_eq!(list.sessions.items[0].topic_count.value(), 0);
    assert_eq!(list.counts.items_by_status.open.value(), 0);
    assert_eq!(list.counts.items_by_status.done.value(), 0);
    assert_eq!(list.counts.archived_topics.value(), 0);
    assert_eq!(setup.saved(), session);
}
