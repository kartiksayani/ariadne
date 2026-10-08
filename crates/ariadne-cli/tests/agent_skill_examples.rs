//! The worked examples in the generated agent skill (the core `SKILL.md` and the
//! on-demand files, for Claude and for Codex) are the only model-facing apply
//! samples. They are lifted from the generated files and sent to the real
//! `ariadne apply`, so the CLI's own lenient expansion and core's full validation
//! judge them: each one passes `--dry-run`, and the terminal-originated ones also
//! commit against a seeded session and leave the state the rules describe.
use ariadne_core::{inputs::InputService, *};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use serde_json::{json, Value};
use sha2::Digest;
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    process::{Command, Output, Stdio},
};

const RULES: &str = include_str!("../../../integrations/rules/source.md");
const SKILL: &str = include_str!("../../../integrations/rules/skill.md");
const INPUTS: &str = include_str!("../../../integrations/rules/inputs.md");
const ERRORS: &str = include_str!("../../../integrations/rules/errors.md");
const RECONNECT: &str = include_str!("../../../integrations/rules/reconnect.md");
const REPORT: &str = include_str!("../../../integrations/rules/report.md");
const REVIEW: &str = include_str!("../../../integrations/rules/review.md");
const CHECKLIST: &str = include_str!("../../../integrations/rules/checklist.md");
const FOLLOW_UP: &str = include_str!("../../../integrations/rules/follow-up.md");

const ON_DEMAND: [&str; 7] = [
    "inputs.md",
    "errors.md",
    "reconnect.md",
    "report.md",
    "review.md",
    "checklist.md",
    "follow-up.md",
];
const SKILL_DIRECTORIES: [&str; 2] = ["claude/plugin/skills/ariadne", "codex/skills/ariadne"];

/// Every file one agent loads, core first: `(name, text)`.
fn generated(directory: &str) -> Vec<(String, String)> {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../integrations/");
    ["SKILL.md"]
        .into_iter()
        .chain(ON_DEMAND)
        .map(|name| {
            let path = format!("{root}{directory}/{name}");
            let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
            (name.to_owned(), text)
        })
        .collect()
}

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

/// The examples of one agent's files, in loading order.
fn agent_examples(directory: &str) -> Vec<String> {
    generated(directory)
        .iter()
        .flat_map(|(_, text)| examples(text))
        .collect()
}

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}

/// Every operation of a raw example, with nested `children` flattened. A child
/// has no `op`: it is an `item.add`.
fn operations(request: &Value) -> Vec<&Value> {
    fn walk<'a>(list: &'a [Value], out: &mut Vec<&'a Value>) {
        for operation in list {
            out.push(operation);
            if let Some(children) = operation.get("children").and_then(Value::as_array) {
                walk(children, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(request["operations"].as_array().unwrap(), &mut out);
    out
}
fn kind(operation: &Value) -> &str {
    operation
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or("item.add")
}

/// Hold one raw example to the rules it teaches: every created topic and item is
/// labelled, and a `note` (shown only as an in-progress line) is set only on an
/// item that starts in progress.
fn checked(block: &str) -> Value {
    let request: Value = serde_json::from_str(block)
        .unwrap_or_else(|error| panic!("example is not JSON: {error}\n{block}"));
    for operation in operations(&request) {
        if matches!(kind(operation), "topic.add" | "item.add") {
            let short = operation["short"].as_str().unwrap_or_else(|| {
                panic!("{} example has no short label\n{block}", kind(operation))
            });
            let words = short.split_whitespace().count();
            assert!((1..=4).contains(&words) && short.chars().count() <= 40);
        }
        if kind(operation) == "item.add" && operation.get("note").is_some() {
            assert_eq!(operation["status"], "in_progress", "note on a closed item");
        }
    }
    request
}

/// A registered project holding a fresh copy of the seed session (topic `...0005`,
/// binding `...0003`, items `1` open and `2` done, both at revision 1).
struct Seeded {
    home: tempfile::TempDir,
    _root: tempfile::TempDir,
    registry: Registry,
    next: std::sync::atomic::AtomicU64,
}
impl Seeded {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        let seed: Session =
            serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json"))
                .unwrap();
        Store::open_registered(&registry.project_dir(&id(1)), id(1))
            .unwrap()
            .create(&seed)
            .unwrap();
        Self {
            home,
            _root: root,
            registry,
            next: std::sync::atomic::AtomicU64::new(10000),
        }
    }
    fn store(&self) -> Store {
        Store::open_registered(&self.registry.project_dir(&id(1)), id(1)).unwrap()
    }
    fn session(&self) -> Session {
        self.store().read(&id(2)).unwrap()
    }
    fn allocate(&self) -> UuidV4 {
        id(self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst))
    }
    fn revision(&self, item: &str) -> u64 {
        self.session().items.0[&ItemRef::new(item).unwrap()]
            .revision
            .value()
    }

    /// `ariadne apply --json-stdin --json` with `flags`, exactly as an agent runs
    /// it. The request goes in as the example's own bytes.
    fn apply(&self, flags: &[&str], body: &[u8]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ariadne"));
        command
            .args(["apply", "--binding", id(3).as_str(), "--generation"])
            .args([id(4).as_str(), "--json-stdin", "--json"])
            .args(flags)
            .env("ARIADNE_HOME", self.home.path().join(".ariadne"))
            .env("HOME", self.home.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        child.stdin.take().unwrap().write_all(body).unwrap();
        child.wait_with_output().unwrap()
    }
    /// The receipt `data` of a successful run, or a panic that shows the output.
    fn succeeds(&self, flags: &[&str], request: &Value) -> Value {
        let output = self.apply(flags, &serde_json::to_vec(request).unwrap());
        assert_eq!(
            output.status.code(),
            Some(0),
            "example is refused by the CLI:\n{request}\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(envelope["ok"], true);
        envelope["data"].clone()
    }

    /// Bind an example's placeholders to this session: the revision of every
    /// existing item it guards becomes the current one, and an example that
    /// answers a dispatched input gets that input delivered first (item `1`
    /// replied to, the input in flight under attempt `...0011`).
    fn bound(&self, mut request: Value) -> Value {
        if !request["source_input_id"].is_null() {
            assert_eq!(request["source_input_id"], id(0x10).as_str());
            assert_eq!(request["attempt_id"], id(0x11).as_str());
            let (input, number) = self.deliver_reply();
            request["source_input_id"] = json!(input.as_str());
            request["input_result"]["handled_through_message_number"] = json!(number);
        }
        // The closing-parent example settles the last open child `1.1` of item
        // `1`; the seed has no child, so file one that waits on the owner.
        if request["expected_item_revisions"].get("1.1").is_some() {
            let child = json!({
                "expected_item_revisions": {"1": self.revision("1")},
                "operations": [{"op": "item.add", "topic": {"id": id(5)}, "parent": {"id": "1"},
                    "question": "Which cache?", "short": "Cache choice", "type": "decision",
                    "ask": "Which cache should it use?",
                    "options": [{"label": "A", "consequence": "Fast"}]}]});
            self.succeeds(&[], &child);
        }
        if let Some(guards) = request
            .get_mut("expected_item_revisions")
            .and_then(Value::as_object_mut)
        {
            for (item, revision) in guards.iter_mut() {
                *revision = json!(self.revision(item));
            }
        }
        request
    }

    /// The owner replies on item `1`, and the reply is delivered: the input is in
    /// flight under attempt `...0011`. Returns the input and the owner message
    /// number that the agent's result has to handle.
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
        let receipt = InputService::new(&self.registry)
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
        self.store()
            .transact(
                &id(2),
                &ReceiptActorScope::Adapter { binding_id: id(3) },
                &id(701),
                &json!({"test": 701}),
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

    /// Run one example through `--dry-run` on a fresh copy of the seed. The
    /// preview shows what would change and commits nothing.
    fn previewed(block: &str) -> Value {
        let seeded = Self::new();
        let request = seeded.bound(checked(block));
        let before = seeded.session();
        let data = seeded.succeeds(&["--dry-run"], &request);
        assert_eq!(data["dry_run"], true, "{block}");
        assert_eq!(seeded.session(), before, "a dry run wrote: {block}");
        request
    }
    /// Commit one example on a fresh copy of the seed; the session afterwards.
    fn committed(block: &str) -> (Self, Value, Value) {
        let seeded = Self::new();
        let request = seeded.bound(checked(block));
        let data = seeded.succeeds(&[], &request);
        (seeded, request, data)
    }
}

#[test]
fn every_skill_example_passes_the_real_cli_and_together_they_cover_the_surface() {
    let sources: Vec<String> = [
        SKILL, RULES, INPUTS, ERRORS, RECONNECT, REPORT, REVIEW, CHECKLIST, FOLLOW_UP,
    ]
    .into_iter()
    .flat_map(examples)
    .collect();
    // Both agents load the same examples, and they are the authored ones.
    for directory in SKILL_DIRECTORIES {
        assert_eq!(agent_examples(directory), sources, "{directory}");
    }
    assert!(sources.len() >= 7, "expected the worked examples");
    let mut ops = BTreeSet::new();
    let mut outcomes = BTreeSet::new();
    let mut owners = BTreeSet::new();
    let (mut local_ref, mut child, mut asked) = (false, false, false);
    for block in &sources {
        let request = Seeded::previewed(block);
        for operation in operations(&request) {
            ops.insert(kind(operation).to_owned());
            if kind(operation) == "item.add" {
                asked |= operation.get("ask").is_some();
                child |= operation.get("parent").is_some() || operation.get("children").is_some();
                if let Some(owner) = operation.get("owner") {
                    owners.insert(owner["kind"].as_str().unwrap().to_owned());
                }
            }
        }
        if let Some(result) = request.get("input_result").filter(|r| !r.is_null()) {
            outcomes.insert(result["outcome"].as_str().unwrap().to_owned());
            for reference in result["reply_refs"].as_array().into_iter().flatten() {
                // A result cites replies the agent wrote in this request; an
                // existing message id would be someone else's text.
                assert!(
                    reference.get("ref").is_some(),
                    "reply_refs must cite this request's replies"
                );
                local_ref = true;
            }
        }
    }
    for op in ["topic.add", "item.add", "item.status", "reply"] {
        assert!(ops.contains(op), "no example for {op}");
    }
    // The core table names every operation the request type has.
    for op in [
        "topic.add",
        "item.add",
        "item.edit",
        "item.ask",
        "item.status",
        "item.replace",
        "reply",
        "round.close",
    ] {
        assert!(RULES.contains(&format!("| `{op}` |")), "core omits {op}");
    }
    assert!(outcomes.contains("answered"));
    assert!(owners.contains("other") && asked);
    assert!(child && local_ref);
}

/// The skill describes the CLI as it is: nothing it names is a field or a receipt
/// shape the CLI no longer has.
#[test]
fn the_skill_text_names_no_retired_field_or_receipt_shape() {
    for directory in SKILL_DIRECTORIES {
        for (name, text) in generated(directory) {
            for retired in ["allocated_refs", "recipient_binding_id", "uuidgen"] {
                assert!(
                    !text.contains(retired),
                    "{directory}/{name} names {retired}"
                );
            }
        }
    }
    // The lenient defaults the core teaches are the ones the CLI applies.
    for needle in [
        "`owner`: you; `{\"kind\":\"me\"}`",
        "`ref`: r1, r2, ...",
        "Option `id`: 1, 2",
    ] {
        assert!(RULES.contains(needle), "{needle}");
    }
}

/// The archived-topic refusal the errors file teaches is the one core returns.
#[test]
fn the_archived_topic_refusal_is_the_one_core_returns() {
    assert!(ERRORS.contains("\"topic_archived\""));
    assert!(ERRORS.contains("--archived"));
    assert!(RULES.contains("--archived"));
    assert_eq!(
        serde_json::to_value(BarrierReason::TopicArchived).unwrap(),
        "topic_archived"
    );
}

/// The skill stays cheap: the core and every kind-of-work file are size-capped,
/// each on-demand file is pointed at, and nothing duplicates the read-once rule.
#[test]
fn the_core_and_on_demand_files_stay_small_and_are_each_pointed_at() {
    for directory in SKILL_DIRECTORIES {
        let files = generated(directory);
        let skill = &files[0].1;
        assert!(
            skill.len() <= 10_000,
            "{directory} core skill is {} bytes",
            skill.len()
        );
        let description = skill.lines().nth(2).unwrap();
        assert!(
            description.len() <= "description: ".len() + 200,
            "{description}"
        );
        for (name, text) in &files[1..] {
            assert!(text.len() <= 5 * 1024, "{name} is {} bytes", text.len());
            if ["report.md", "review.md", "checklist.md", "follow-up.md"].contains(&name.as_str()) {
                assert!(text.len() <= 3 * 1024, "{name} is {} bytes", text.len());
                assert!(
                    examples(text).len() <= 1,
                    "{name} has more than one example"
                );
            }
        }
    }
    for name in ON_DEMAND {
        assert!(SKILL.contains(&format!("`{name}`")), "core omits {name}");
    }
    assert!(!SKILL.contains("playbook") && !RULES.contains("playbook"));
    let all = [
        SKILL, RULES, INPUTS, ERRORS, RECONNECT, REPORT, REVIEW, CHECKLIST, FOLLOW_UP,
    ];
    let read_once = all
        .iter()
        .filter(|text| text.contains("`ariadne read` once"))
        .count();
    assert_eq!(
        read_once, 1,
        "the read-once rule belongs in reconnect.md only"
    );
    assert!(RECONNECT.contains("`ariadne read` once"));
}

/// The compact receipt names the values the next request needs.
fn assert_compact(data: &Value) {
    UuidV4::new(data["op_id"].as_str().unwrap()).unwrap();
    for hidden in ["allocated_refs", "messages", "item_revisions", "kind"] {
        assert!(data.get(hidden).is_none(), "{hidden} in {data}");
    }
}

#[test]
fn every_terminal_example_commits_on_a_seeded_session() {
    // The core's two examples and every kind-of-work example that does not
    // answer a dispatched input.
    let blocks: Vec<String> = [RULES, REPORT, REVIEW, CHECKLIST]
        .into_iter()
        .flat_map(examples)
        .collect();
    assert_eq!(blocks.len(), 5, "expected five terminal examples");
    for block in &blocks {
        let (seeded, request, data) = Seeded::committed(block);
        assert!(request["source_input_id"].is_null());
        assert_compact(&data);
        // Each receipt row carries the revision the session now holds.
        let session = seeded.session();
        for row in data["items"].as_array().unwrap() {
            let item = &session.items.0[&ItemRef::new(row["id"].as_str().unwrap()).unwrap()];
            assert_eq!(row["revision"], item.revision.value(), "{row}");
        }
    }
}

fn topic_items<'a>(session: &'a Session, name: &str) -> (&'a Topic, Vec<&'a Item>) {
    let topic = session
        .topics
        .0
        .values()
        .find(|t| t.name.starts_with(name))
        .unwrap();
    let items = session
        .items
        .0
        .values()
        .filter(|i| i.topic_id == topic.id)
        .collect();
    (topic, items)
}
fn by_short<'a>(items: &[&'a Item], short: &str) -> &'a Item {
    items
        .iter()
        .copied()
        .find(|i| i.short.as_deref() == Some(short))
        .unwrap_or_else(|| panic!("no item {short}"))
}

/// The report example is the shape report.md teaches: summary first and closed,
/// and nothing left dangling: every open item is either work owned by someone
/// else or a parent grouping asks that wait on the owner.
#[test]
fn the_report_example_files_the_tree_report_md_teaches() {
    let (seeded, _, _) = Seeded::committed(&examples(REPORT)[0]);
    let session = seeded.session();
    let (_, items) = topic_items(&session, "Load test");
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
    assert!(first.question.contains(&format!("{waiting} choice waits")));
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
    // An ask defaults its owner to `me`, not the agent, and numbers its options.
    let cleanup = by_short(&items, "Fixture cleanup");
    assert_eq!(cleanup.owner, ItemOwner::Me {});
    assert_eq!(cleanup.status, ItemStatus::WaitingOnMe);
    assert_eq!(cleanup.parent.as_ref(), Some(&first.id));
    let options: Vec<_> = cleanup
        .options
        .iter()
        .map(|o| (o.id.as_str(), o.recommended))
        .collect();
    assert_eq!(options, [("1", false), ("2", true)]);
}

#[test]
fn the_review_and_checklist_examples_default_owner_and_status_as_the_rules_say() {
    let (seeded, _, data) = Seeded::committed(&examples(REVIEW)[0]);
    assert_eq!(data["topics"][0]["number"], 2);
    let session = seeded.session();
    let (_, items) = topic_items(&session, "Review: PR #812");
    // The parent is a summary with no blanket ask; each decision is its own child.
    let summary = by_short(&items, "PR #812 review");
    assert_eq!(summary.status, ItemStatus::Open);
    assert_eq!(summary.item_type, ItemType::Explanation);
    assert_eq!(summary.owner, ItemOwner::Agent { binding_id: id(3) });
    assert!(summary.ask.is_none() && summary.options.is_empty());
    assert_eq!(summary.links.len(), 1);
    let verdict = by_short(&items, "PR #812 verdict");
    assert_eq!(verdict.parent.as_ref(), Some(&summary.id));
    assert_eq!(verdict.owner, ItemOwner::Me {});
    assert_eq!(verdict.status, ItemStatus::WaitingOnMe);
    assert_eq!(verdict.item_type, ItemType::Decision);
    assert_eq!(verdict.options.len(), 2);
    let comment = by_short(&items, "No jitter");
    assert_eq!(comment.parent.as_ref(), Some(&summary.id));
    assert_eq!(comment.owner, ItemOwner::Me {});
    assert_eq!(comment.status, ItemStatus::WaitingOnMe);
    assert_eq!(comment.item_type, ItemType::Decision);
    let labels: Vec<_> = comment.options.iter().map(|o| o.label.as_str()).collect();
    assert_eq!(labels, ["Post it", "Skip", "Edit first"]);
    let fine = by_short(&items, "Checked, fine");
    assert_eq!(fine.status, ItemStatus::Done);
    assert_eq!(fine.owner, ItemOwner::Agent { binding_id: id(3) });

    let (seeded, _, _) = Seeded::committed(&examples(CHECKLIST)[0]);
    let session = seeded.session();
    let (_, items) = topic_items(&session, "Migrate the sessions");
    let backfill = by_short(&items, "Backfill v2");
    assert_eq!(backfill.status, ItemStatus::InProgress);
    assert_eq!(backfill.owner, ItemOwner::Agent { binding_id: id(3) });
    assert_eq!(
        backfill.note.as_deref(),
        Some("Backfilling: 1.2M of 4M rows")
    );
    let switch = by_short(&items, "Switch reads");
    assert_eq!(switch.status, ItemStatus::WaitingOnMe);
    assert_eq!(switch.owner, ItemOwner::Me {});
    let drop = by_short(&items, "Drop v1");
    assert_eq!(drop.status, ItemStatus::Open);
    assert!(matches!(drop.owner, ItemOwner::Other { .. }));
}

#[test]
fn the_opening_example_files_a_summary_with_its_child_and_the_second_closes_it() {
    let blocks = examples(RULES);
    let (seeded, _, data) = Seeded::committed(&blocks[0]);
    let session = seeded.session();
    let (topic, items) = topic_items(&session, "Review: PR #812");
    assert_eq!(data["topics"][0]["id"], topic.id.as_str());
    let ids: Vec<_> = data["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids, ["3", "3.1"], "an item's receipt id is its number");
    let summary = by_short(&items, "Review summary");
    assert_eq!(summary.status, ItemStatus::InProgress);
    assert_eq!(
        by_short(&items, "No jitter").parent.as_ref(),
        Some(&summary.id)
    );

    // The second example finishes item `1` of the seeded session.
    let (seeded, _, _) = Seeded::committed(&blocks[1]);
    let item = seeded.session().items.0[&ItemRef::new("1").unwrap()].clone();
    assert_eq!(item.status, ItemStatus::Done);
    assert_eq!(item.outcome.as_deref(), Some("PR #812 needs one fix"));
}

/// The closing-parent example settles the last open child of a decision and
/// closes the decision in the same request, each with the guard it names.
#[test]
fn the_closing_parent_example_settles_the_last_child_and_closes_the_parent() {
    let block = &examples(INPUTS)[1];
    let (seeded, _, data) = Seeded::committed(block);
    assert_compact(&data);
    let session = seeded.session();
    let item = |name: &str| session.items.0[&ItemRef::new(name).unwrap()].clone();
    let (child, parent) = (item("1.1"), item("1"));
    assert_eq!(child.status, ItemStatus::Decided);
    assert_eq!(parent.status, ItemStatus::Decided);
    assert_eq!(child.parent.as_ref(), Some(&parent.id));
    assert!(parent.outcome.is_some() && parent.why.is_some());
    // Both items are in the receipt with the revisions the session now holds.
    let ids: Vec<_> = data["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids, ["1", "1.1"]);
}

/// The inputs example answers a reply on item `1`: a reply, a decision and a
/// result that cites the reply.
#[test]
fn the_inputs_example_replies_decides_and_commits_its_result() {
    let (seeded, request, data) = Seeded::committed(&examples(INPUTS)[0]);
    assert_compact(&data);
    assert_eq!(request["summary"], "Answered [owner choice](item:1)");
    let session = seeded.session();
    let item = &session.items.0[&ItemRef::new("1").unwrap()];
    assert_eq!(item.status, ItemStatus::Decided);
    let input = UuidV4::new(request["source_input_id"].as_str().unwrap()).unwrap();
    let result = session.inputs.0[&input].attempts[0]
        .domain_result
        .as_ref()
        .expect("the input has a committed result");
    assert_eq!(result.reply_message_ids.len(), 1);
    assert!(result.followup_item_ids.is_empty());
}

/// The follow-up example answers a reply on item `1`: two explanation children
/// of that item, a one-line reply and a result that lists both children.
#[test]
fn the_followup_example_files_two_children_for_a_delivered_reply() {
    let (seeded, request, _) = Seeded::committed(&examples(FOLLOW_UP)[0]);
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
    let input = UuidV4::new(request["source_input_id"].as_str().unwrap()).unwrap();
    let result = session.inputs.0[&input].attempts[0]
        .domain_result
        .as_ref()
        .expect("the input has a committed result");
    assert_eq!(result.followup_item_ids.len(), 2);
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
            INPUTS.contains(&format!("- `{name}`")) || INPUTS.contains(&format!(", `{name}`")),
            "inputs.md omits input kind {name}"
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
    ] {
        assert!(INPUTS.contains(needle), "{needle}");
    }
    // Blind retries also work without having received the derived ID.
    assert!(ERRORS.contains("Resend the identical request"));
    assert!(ERRORS.contains("the CLI derives the same `op_id`"));
    assert!(ERRORS.contains("A retry of the identical request is safe"));
    assert!(RULES.contains("An unexpected `\"replayed\":true` files nothing new"));
    assert!(
        RULES.contains("a fresh explicit `op_id` to deliberately file the identical request again")
    );
    assert!(RULES.contains("independent of generation"));
    for needle in ["`short` label", "at most 40 characters"] {
        assert!(RULES.contains(needle), "{needle}");
    }
    for needle in [
        "Refer to another item only as a markdown link `[short label](item:<item id>)`",
        "`[cache choice](item:3.2)`",
        "clickable navigation",
    ] {
        assert!(RULES.contains(needle), "{needle}");
    }
    assert!(SKILL.contains("[ARIADNE_INPUT:"));
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
        assert!(ERRORS.contains(&format!("`{code}`")), "{code}");
    }
}

#[test]
fn error_table_exit_codes_match_the_real_cli_exit_mapping() {
    // Only the error table: the file holds prose around it.
    let table = ERRORS
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
