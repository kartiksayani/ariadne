//! The worked examples in the shared agent rules and the on-demand playbook are
//! the only model-facing ApplyRequest samples. They are extracted from the
//! authored sources so they cannot drift from the real request type, and every
//! terminal-originated playbook request is executed against a seeded session.
use ariadne_core::{apply::ApplyService, *};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use sha2::Digest;
use std::collections::BTreeSet;

const RULES: &str = include_str!("../../../integrations/rules/source.md");
const PLAYBOOK: &str = include_str!("../../../integrations/rules/playbook.md");

fn examples(text: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        match (&mut current, line) {
            (None, "```json") => current = Some(String::new()),
            (Some(_), "```") => blocks.push(current.take().unwrap()),
            (Some(text), _) => text.push_str(line),
            _ => {}
        }
    }
    assert!(current.is_none(), "unterminated json fence");
    blocks
}

/// Parse, wire-validate and round-trip one example, and hold it to the rules it
/// teaches: every created topic and item is labelled, and a `note` (shown only
/// as an in-progress line) is set only on an item that starts in progress.
fn checked(block: &str) -> ApplyRequest {
    let request: ApplyRequest = serde_json::from_str(block)
        .unwrap_or_else(|error| panic!("example does not deserialize: {error}\n{block}"));
    request.validate_wire().unwrap();
    // Strict round trip: no field the type would silently add or drop.
    assert_eq!(
        serde_json::to_value(&request).unwrap(),
        serde_json::from_str::<serde_json::Value>(block).unwrap(),
        "example is not canonical"
    );
    for operation in &request.operations {
        let value = serde_json::to_value(operation).unwrap();
        if value["op"] == "topic.add" || value["op"] == "item.add" {
            let short = value["short"]
                .as_str()
                .unwrap_or_else(|| panic!("{} example has no short label\n{block}", value["op"]));
            let words = short.split_whitespace().count();
            assert!((1..=4).contains(&words) && short.chars().count() <= 40);
        }
        if value["op"] == "item.add" && !value["note"].is_null() {
            assert_eq!(value["status"], "in_progress", "note on a closed item");
        }
    }
    request
}

#[test]
fn every_rule_example_is_a_valid_apply_request_and_together_they_cover_the_surface() {
    let blocks = examples(RULES);
    assert!(blocks.len() >= 7, "expected the worked examples");
    let mut ops = BTreeSet::new();
    let mut outcomes = BTreeSet::new();
    let mut owners = BTreeSet::new();
    let (mut local_ref, mut child, mut local_topic) = (false, false, false);
    let mut removed_ack = false;
    for block in &blocks {
        let request = checked(block);
        for operation in &request.operations {
            let value = serde_json::to_value(operation).unwrap();
            ops.insert(value["op"].as_str().unwrap().to_owned());
            if value["op"] == "item.add" {
                owners.insert(value["owner"]["kind"].as_str().unwrap().to_owned());
                child |= !value["parent"].is_null();
                local_topic |= value["topic"].get("ref").is_some();
            }
        }
        if let Some(result) = &request.input_result {
            // A `removed` notice is acknowledged with nothing but the result.
            removed_ack |= request.operations.is_empty()
                && result.outcome == ResultOutcome::Answered
                && result.reply_refs.is_empty()
                && result.followup_item_refs.is_empty();
            outcomes.insert(
                serde_json::to_value(&result.outcome)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
            for reference in &result.reply_refs {
                // A result cites replies the agent wrote in this request; an
                // existing message id would be someone else's text.
                assert!(
                    matches!(reference, UuidRef::Local(_)),
                    "reply_refs must cite this request's replies"
                );
                local_ref = true;
            }
        }
    }
    // The core rules stand alone: the playbook is read only on demand.
    for op in [
        "topic.add",
        "item.add",
        "item.edit",
        "item.ask",
        "item.status",
        "reply",
        "round.close",
    ] {
        assert!(ops.contains(op), "no example for {op}");
    }
    for outcome in ["answered", "deferred", "unable"] {
        assert!(outcomes.contains(outcome), "{outcome}");
    }
    assert!(owners.contains("agent") && owners.contains("other"));
    assert!(child && local_ref && local_topic);
    assert!(removed_ack, "no example acknowledges a removed input");
}

/// The archived-topic read command in the rules is the real read request, and
/// the refusal reason it teaches is the one core returns.
#[test]
fn the_archived_topic_read_example_is_a_valid_read_request() {
    let line = RULES
        .lines()
        .find(|line| line.starts_with("printf '%s' '") && line.contains("\"archived\":true"))
        .expect("no archived-topic read example");
    let json = line
        .strip_prefix("printf '%s' '")
        .and_then(|rest| rest.split_once("' | ariadne read "))
        .map(|(json, _)| json.replace("<TOPIC_ID>", id(5).as_str()))
        .expect("example is not `printf ... | ariadne read`");
    let request: SessionReadRequest = serde_json::from_str(&json)
        .unwrap_or_else(|error| panic!("read example does not deserialize: {error}\n{json}"));
    assert_eq!(
        serde_json::to_value(&request).unwrap(),
        serde_json::from_str::<serde_json::Value>(&json).unwrap(),
        "read example is not canonical"
    );
    assert!(matches!(
        request.selection,
        ReadView::Items {
            topic_id: Some(_),
            archived: Some(true),
            ..
        }
    ));
    assert!(RULES.contains("\"topic_archived\""));
    assert_eq!(
        serde_json::to_value(BarrierReason::TopicArchived).unwrap(),
        "topic_archived"
    );
}

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}

/// Execute one terminal-originated request against a fresh copy of the seed
/// session (topic `...0005`, binding `...0003`, items `1` and `2` at revision 1).
fn execute(request: &ApplyRequest) -> Session {
    let seeded = Seeded::new();
    let binding = seeded.session().bindings.0[&id(3)].clone();
    seeded.apply(
        request,
        AgentReadScope::Terminal {
            issued_through_message_number: binding.issued_through_message_number,
        },
    );
    seeded.session()
}

fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}

/// A registered project holding a fresh copy of the seed session.
struct Seeded {
    _home: tempfile::TempDir,
    _root: tempfile::TempDir,
    registry: Registry,
    store: std::path::PathBuf,
    next: std::sync::atomic::AtomicU64,
}
impl Seeded {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        let store = home.path().join(".ariadne/projects").join(id(1).as_str());
        let seed: Session =
            serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json"))
                .unwrap();
        Store::open_registered(&store, id(1))
            .unwrap()
            .create(&seed)
            .unwrap();
        Self {
            _home: home,
            _root: root,
            registry,
            store,
            next: std::sync::atomic::AtomicU64::new(10000),
        }
    }
    fn session(&self) -> Session {
        Store::open_registered(&self.store, id(1))
            .unwrap()
            .read(&id(2))
            .unwrap()
    }
    fn allocate(&self) -> UuidV4 {
        id(self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst))
    }
    fn apply(&self, request: &ApplyRequest, scope: AgentReadScope) {
        let generation = self.session().bindings.0[&id(3)].generation.clone();
        let context = AgentContext::from_trusted_entrypoint(
            RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
            id(3),
            generation,
            scope,
        );
        ApplyService::new(&self.registry)
            .execute(&context, request, || self.allocate(), at())
            .unwrap_or_else(|error| panic!("playbook example does not commit: {error:?}"));
    }
    /// The owner replies on item `1`, and the reply is delivered: the input is
    /// in flight under attempt `...0011`. Returns the input and the owner
    /// message number that the agent's result has to handle.
    fn deliver_reply(&self) -> (UuidV4, u64) {
        let command = OwnerCommand::InputSubmit {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(700),
            params: InputSubmitParams {
                binding_id: id(3),
                target: InputTarget {
                    topic_id: id(5),
                    item_id: Some(ItemRef::new("1").unwrap()),
                },
                kind: InputKind::Reply,
                text: "What are Q10 and Q11?".into(),
                selected_option_id: None,
                expected_question_revision: None,
                supersedes_answer_id: None,
            },
        };
        let receipt = ariadne_core::inputs::InputService::new(&self.registry)
            .execute(
                &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
                    RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
                )),
                &command,
                || self.allocate(),
                at(),
            )
            .unwrap();
        let MutationReceipt::Session(receipt) = receipt else {
            panic!("session receipt")
        };
        let SavedReceiptData::InputSubmit {
            input_id,
            message_number,
            ..
        } = receipt.data
        else {
            panic!("input receipt")
        };
        let attempt = id(0x11);
        Store::open_registered(&self.store, id(1))
            .unwrap()
            .transact(
                &id(2),
                &ReceiptActorScope::Adapter { binding_id: id(3) },
                &id(701),
                &serde_json::json!({"test": 701}),
                |session| {
                    let marker =
                        format!("[ARIADNE_INPUT:{}:{}]", input_id.as_str(), attempt.as_str());
                    let payload = format!("{marker}\nWhat are Q10 and Q11?\n");
                    let input = session.inputs.0.get_mut(&input_id).unwrap();
                    input.state = InputState::InFlight;
                    input.active_attempt_id = Some(attempt.clone());
                    input.attempts.push(Attempt {
                        id: attempt.clone(),
                        purpose: AttemptPurpose::Work,
                        repair_for_attempt_id: None,
                        claim_request_id: id(0x12),
                        binding_generation: id(4),
                        prepared_at: at(),
                        payload_sha256: Sha256::new(format!(
                            "{:x}",
                            sha2::Sha256::digest(payload.as_bytes())
                        ))
                        .unwrap(),
                        formatted_payload: payload,
                        wire_marker: marker,
                        acceptance: AcceptanceState::Accepted,
                        acceptance_receipt: None,
                        acceptance_observed_at: Some(at()),
                        host_turn_id: Some("host-turn".into()),
                        turn_state: TurnState::Running,
                        turn_observed_at: Some(at()),
                        domain_result: None,
                        result_state: ResultState::Pending,
                        sealed_at: None,
                        error: None,
                        reconciliation_checkpoint: None,
                    });
                    let binding = session.bindings.0.get_mut(&id(3)).unwrap();
                    binding.active_input_id = Some(input_id.clone());
                    binding.issued_through_message_number =
                        NonnegativeSafeInteger::new(message_number.value()).unwrap();
                    Ok::<_, ()>(SavedReceiptData::Event {
                        event_id: "test:701".into(),
                        input_id: None,
                        attempt_id: None,
                        durable_effect: true,
                    })
                },
            )
            .unwrap();
        (input_id, message_number.value())
    }
}

/// The follow-up example answers a reply on item `1`: two explanation children
/// of that item, a one-line reply and a result that lists both children.
#[test]
fn the_followup_playbook_example_files_two_children_for_a_delivered_reply() {
    let block = examples(PLAYBOOK)
        .into_iter()
        .find(|block| block.contains("\"summary\":\"Explained Q10 and Q11\""))
        .expect("no follow-up example");
    let seeded = Seeded::new();
    let (input, number) = seeded.deliver_reply();
    // Bind the example's placeholder input, message number and item revision
    // to the delivery (an owner reply bumps item `1`).
    let revision = seeded.session().items.0[&ItemRef::new("1").unwrap()]
        .revision
        .value();
    let bound = block
        .replace(id(0x10).as_str(), input.as_str())
        .replace(
            "\"expected_item_revisions\":{\"1\":1}",
            &format!("\"expected_item_revisions\":{{\"1\":{revision}}}"),
        )
        .replace(
            "\"handled_through_message_number\":7",
            &format!("\"handled_through_message_number\":{number}"),
        );
    let request = checked(&bound);
    seeded.apply(
        &request,
        AgentReadScope::Dispatched {
            source_input_id: input.clone(),
            attempt_id: id(0x11),
            issued_through_message_number: seeded.session().bindings.0[&id(3)]
                .issued_through_message_number,
        },
    );
    let session = seeded.session();
    let parent = ItemRef::new("1").unwrap();
    let children: Vec<&Item> = session
        .items
        .0
        .values()
        .filter(|item| item.parent.as_ref() == Some(&parent))
        .collect();
    assert_eq!(children.len(), 2);
    for child in &children {
        assert_eq!(child.item_type, ItemType::Explanation);
        assert_eq!(child.status, ItemStatus::Done);
    }
    let result = session.inputs.0[&input].attempts[0]
        .domain_result
        .as_ref()
        .expect("the input has a committed result");
    assert_eq!(result.followup_item_ids.len(), 2);
}

#[test]
fn every_playbook_request_is_valid_and_each_terminal_one_commits_on_a_seeded_session() {
    let blocks = examples(PLAYBOOK);
    assert!(blocks.len() >= 5, "expected the playbook's worked requests");
    let mut executed = 0;
    let mut report = None;
    for block in &blocks {
        let request = checked(block);
        if request.source_input_id.is_none() {
            let session = execute(&request);
            executed += 1;
            if request.summary.contains("report") {
                report = Some(session);
            }
        }
    }
    assert!(executed >= 4, "only {executed} playbook requests executed");
    // The report example is the shape the playbook teaches: summary first and
    // closed, and nothing left dangling: every open item is either work owned
    // by someone else or a parent grouping asks that wait on the owner.
    let session = report.expect("a report example");
    let topic = session
        .topics
        .0
        .values()
        .find(|t| t.name.starts_with("Load test"))
        .unwrap();
    let items: Vec<&Item> = session
        .items
        .0
        .values()
        .filter(|i| i.topic_id == topic.id)
        .collect();
    let first = items
        .iter()
        .filter(|i| i.parent.is_none())
        .min_by_key(|i| i.ordinal)
        .unwrap();
    assert_eq!(first.short.as_deref(), Some("Result summary"));
    assert_eq!(first.status, ItemStatus::Done);
    let waiting = items
        .iter()
        .filter(|i| i.status == ItemStatus::WaitingOnMe)
        .count();
    assert!(first.question.contains(&format!("{waiting} choices wait")));
    for item in &items {
        if item.status == ItemStatus::Open {
            let groups_asks = items.iter().any(|child| {
                child.parent.as_ref() == Some(&item.id) && child.status == ItemStatus::WaitingOnMe
            });
            assert!(
                matches!(item.owner, ItemOwner::Other { .. }) || groups_asks,
                "{} is open with nothing waiting below it",
                item.id.as_str()
            );
        }
    }
}

fn kind_name(kind: &InputKind) -> &'static str {
    // Exhaustive on purpose: a new input kind fails to compile until it is named here.
    match kind {
        InputKind::Answer => "answer",
        InputKind::Bring => "bring",
        InputKind::Reply => "reply",
        InputKind::Note => "note",
        InputKind::Followup => "followup",
        InputKind::Reopen => "reopen",
        InputKind::Drop => "drop",
        InputKind::Continue => "continue",
        InputKind::Removed => "removed",
        InputKind::TopicReply => "topic_reply",
    }
}

#[test]
fn rules_explain_every_input_kind_the_owner_can_send() {
    for kind in [
        InputKind::Answer,
        InputKind::Bring,
        InputKind::Reply,
        InputKind::Note,
        InputKind::Followup,
        InputKind::Reopen,
        InputKind::Drop,
        InputKind::Continue,
        InputKind::Removed,
        InputKind::TopicReply,
    ] {
        let name = kind_name(&kind);
        assert_eq!(serde_json::to_value(&kind).unwrap(), name);
        assert!(
            RULES.contains(&format!("- `{name}`")) || RULES.contains(&format!(", `{name}`")),
            "rules omit input kind {name}"
        );
    }
}

#[test]
fn rules_explain_the_envelope_fields_and_every_error_code_they_name_exists() {
    for needle in [
        "`attempt_id`",
        "`owner_message_number`",
        "`handled_through_message_number`",
        "[ARIADNE_INPUT:",
        "SAME `op_id`",
        "`short` label",
        "at most 40 characters",
        "`playbook.md`",
    ] {
        assert!(RULES.contains(needle), "{needle}");
    }
    for code in [
        "stale_generation",
        "attempt_sealed",
        "result_already_committed",
        "commit_uncertain",
        "store_busy",
        "io_error",
        "revision_conflict",
        "invalid_transition",
        "binding_mismatch",
        "operation_reused",
        "invalid_argument",
        "invalid_ref",
        "unsupported",
        "future_schema",
    ] {
        serde_json::from_value::<CoreErrorCode>(serde_json::json!(code))
            .unwrap_or_else(|_| panic!("rules name unknown error code {code}"));
        assert!(RULES.contains(&format!("`{code}`")), "{code}");
    }
}

#[test]
fn error_table_exit_codes_match_the_real_cli_exit_mapping() {
    // Only the error table: the rules hold other tables too.
    let table = RULES
        .lines()
        .skip_while(|line| *line != "| Code | Exit | Do |")
        .take_while(|line| line.starts_with('|'));
    let mut rows = 0;
    for line in table.filter(|line| line.starts_with("| `") || line.starts_with("| any")) {
        let cells: Vec<&str> = line.split('|').map(str::trim).collect();
        let exit: i32 = cells[2].parse().unwrap();
        for code in cells[1].split('`').skip(1).step_by(2) {
            if let Ok(code) = serde_json::from_value::<CoreErrorCode>(serde_json::json!(code)) {
                assert_eq!(code.cli_exit(), exit, "{line}");
                rows += 1;
            }
        }
    }
    assert!(rows >= 8, "table rows not found");
    // The catch-all exit 4 row names examples of codes outside the named rows.
    for code in [
        CoreErrorCode::CapacityExceeded,
        CoreErrorCode::HostUnreachable,
    ] {
        assert_eq!(code.cli_exit(), 4);
    }
}
