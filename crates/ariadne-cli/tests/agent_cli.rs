use ariadne_core::{inputs::InputService, *};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    os::unix::{
        fs::{symlink, PermissionsExt},
        net::UnixListener,
    },
    process::{Command, Output, Stdio},
};
use tempfile::TempDir;

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn seed() -> Session {
    serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap()
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
        Store::open_registered(&registry.project_dir(&id(1)), id(1))
            .unwrap()
            .create(session)
            .unwrap();
        Self {
            home,
            _root: root,
            registry,
        }
    }
    fn data(&self) -> std::path::PathBuf {
        self.home.path().join(".ariadne")
    }
    fn store(&self) -> Store {
        Store::open_registered(&self.registry.project_dir(&id(1)), id(1)).unwrap()
    }
    fn path(&self) -> std::path::PathBuf {
        self.registry
            .project_dir(&id(1))
            .join(format!("sessions/{}.json", id(2).as_str()))
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(self.path()).unwrap()
    }
    fn call(&self, args: &[&str], input: Option<&[u8]>) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ariadne"));
        command
            .args(args)
            .env("ARIADNE_HOME", self.data())
            .env("HOME", self.home.path());
        invoke(command, input)
    }
    fn agent(&self, method: &[&str], flags: &[&str], input: Option<&[u8]>) -> Output {
        let binding = id(3);
        let generation = id(4);
        let mut args = method.to_vec();
        args.extend([
            "--binding",
            binding.as_str(),
            "--generation",
            generation.as_str(),
        ]);
        args.extend(flags);
        self.call(&args, input)
    }
    fn apply(&self, request: &Value) -> Output {
        self.agent(
            &["apply"],
            &["--json-stdin", "--json"],
            Some(&serde_json::to_vec(request).unwrap()),
        )
    }
    fn change(&self, work: impl FnOnce(&mut Session)) {
        self.store()
            .transact(
                &id(2),
                &ReceiptActorScope::Adapter { binding_id: id(3) },
                &id(777),
                &json!({"test":"authority change"}),
                |session| {
                    work(session);
                    Ok::<_, ()>(SavedReceiptData::Event {
                        event_id: "test:authority".into(),
                        input_id: None,
                        attempt_id: None,
                        durable_effect: true,
                    })
                },
            )
            .unwrap();
    }
    fn submit(&self, text: &str, op: u64) {
        let context = OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
            RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        ));
        let command = OwnerCommand::InputSubmit {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(op),
            params: InputSubmitParams {
                binding_id: id(3),
                target: InputTarget {
                    topic_id: id(5),
                    item_id: Some(ItemRef::new("1").unwrap()),
                },
                kind: InputKind::Reply,
                text: text.into(),
                selected_option_id: None,
                expected_question_revision: None,
                supersedes_answer_id: None,
            },
        };
        let mut next = op + 1000;
        InputService::new(&self.registry)
            .execute(
                &context,
                &command,
                || {
                    next += 1;
                    id(next)
                },
                UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap(),
            )
            .unwrap();
    }
}
fn invoke(mut command: Command, input: Option<&[u8]>) -> Output {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(input) = input {
        child.stdin.take().unwrap().write_all(input).unwrap();
    }
    // Drop the pipe even when no payload was provided; readers must observe EOF.
    child.stdin.take();
    child.wait_with_output().unwrap()
}
fn envelope(output: &Output, exit: i32) -> Value {
    assert_eq!(output.status.code(), Some(exit), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["api_version"], 1);
    assert_eq!(value["ok"], exit == 0);
    value
}
fn repaired_full_envelope(output: &Output) -> Value {
    let notes = String::from_utf8(output.stderr.clone()).unwrap();
    assert_eq!(notes.lines().count(), 2, "{notes}");
    for line in notes.lines() {
        assert!(line.starts_with("Repair: operations[1]"), "{line}");
        assert!(line.contains("created open with ack_to `done`"), "{line}");
    }
    let mut clean = output.clone();
    clean.stderr.clear();
    envelope(&clean, 0)
}
fn request(op: u64) -> Value {
    json!({"op_id":id(op),"source_input_id":null,"attempt_id":null,"expected_item_revisions":{},"expected_topic_revisions":{},"summary":"","operations":[],"input_result":null})
}
fn read_params(view: &str, limit: u64) -> Value {
    let filters = match view {
        "items" => {
            json!({"topic_id":null,"item_id":null,"parent_item_id":null,"statuses":[],"archived":null})
        }
        "topics" => json!({"archived":null}),
        "messages" => json!({"topic_id":null,"item_id":null}),
        "inputs" => json!({"topic_id":null,"item_id":null,"states":[]}),
        _ => unreachable!(),
    };
    json!({"selection":{"view":view,"filters":filters},"cursor":null,"limit":limit,"item_pages":[]})
}

#[test]
fn help_has_executable_examples_and_invalid_routing_is_rejected_without_filesystem() {
    let help = invoke(Command::new(env!("CARGO_BIN_EXE_ariadne")), None);
    assert!(help.status.success());
    let text = String::from_utf8(help.stdout).unwrap();
    assert!(text.contains("--json-stdin"));
    assert!(text.contains("Invalid:"));
    assert!(text.contains("ARIADNE_HOME"));
    for text in [ariadne_cli::agent::HELP, ariadne_cli::owner::HELP] {
        assert!(text.contains("Bin"));
    }
    assert!(ariadne_cli::agent::HELP.contains("item.delete"));
    assert!(ariadne_cli::agent::HELP.contains("topic.delete"));
    assert!(ariadne_cli::agent::HELP.contains("removed items not shown"));
    assert!(ariadne_cli::owner::HELP.contains("topic restore-removed"));
    let setup = Setup::new(&seed());
    for args in [
        vec!["read", "--json"],
        vec![
            "read",
            "--binding",
            "not-a-uuid",
            "--generation",
            id(4).as_str(),
            "--json",
        ],
        vec![
            "apply",
            "--binding",
            id(3).as_str(),
            "--generation",
            id(4).as_str(),
            "--json",
        ],
    ] {
        assert_eq!(
            envelope(&setup.call(&args, None), 2)["error"]["code"],
            "invalid_argument"
        );
    }
}

#[test]
fn delete_root_hides_inherited_children_and_read_reports_counts_without_removed_content() {
    let setup = Setup::new(&seed());
    let created = envelope(&setup.apply(&json!({"operations":[
        {"op":"topic.add","name":"Duplicate findings","ref":"duplicates"},
        {"op":"item.add","ref":"duplicate","question":"Accidental duplicate root","type":"finding","ack_to":"open",
         "children":[{"question":"Accidental duplicate child","type":"question","ask":"Keep this duplicate?"}]}
    ]})), 0);
    let topic = created["data"]["topics"][0]["id"].as_str().unwrap();
    let item = created["data"]["items"][0]["id"].as_str().unwrap();
    let child = created["data"]["items"][1]["id"].as_str().unwrap();
    let revision = created["data"]["items"][0]["revision"].clone();
    let mut guards = serde_json::Map::new();
    guards.insert(item.to_string(), revision);
    let request = json!({"expected_item_revisions":guards,"operations":[
        {"op":"reply","item":{"id":item},"text":"Deleted this accidental duplicate and its child; the real finding is already filed."},
        {"op":"item.delete","item":item}
    ]});
    let deleted = envelope(&setup.apply(&request), 0);
    assert_eq!(
        deleted["data"]["agent_removals"][0]["item_ids"],
        json!([item, child])
    );
    assert_eq!(deleted["data"]["agent_removals"][0]["waiting_questions"], 1);
    let saved = setup.store().read(&id(2)).unwrap();
    assert!(saved.items.0[&ItemRef::new(item).unwrap()]
        .removed_at
        .is_some());
    assert!(saved.items.0[&ItemRef::new(child).unwrap()]
        .removed_at
        .is_none());
    assert_eq!(
        saved.items.0[&ItemRef::new(child).unwrap()].status,
        ItemStatus::WaitingOnMe
    );
    assert!(saved
        .messages
        .iter()
        .any(|m| m.body.starts_with("Deleted this accidental duplicate")));
    let before = setup.bytes();
    let read = envelope(
        &setup.agent(
            &["read"],
            &["--view", "items", "--topic", topic, "--json"],
            None,
        ),
        0,
    );
    assert_eq!(
        read["data"]["notices"],
        json!(["2 removed items not shown"])
    );
    let serialized = serde_json::to_string(&read).unwrap();
    assert!(!serialized.contains("Accidental duplicate"));
    assert!(!serialized.contains("Keep this duplicate?"));
    assert_eq!(setup.bytes(), before);
    let replay = envelope(&setup.apply(&request), 0);
    assert_eq!(replay["data"]["replayed"], true);
    assert_eq!(
        replay["data"]["agent_removals"],
        deleted["data"]["agent_removals"]
    );
    assert_eq!(setup.bytes(), before);
}

#[test]
fn missing_ack_repairs_survive_same_batch_item_and_topic_deletion_and_restore() {
    for delete_topic in [false, true] {
        let setup = Setup::new(&seed());
        let body = serde_json::to_vec(&json!({"operations": [
            {"op": "topic.add", "ref": "duplicates", "name": "Duplicate report"},
            {"op": "item.add", "ref": "duplicate", "type": "finding",
                "question": "Duplicate summary", "status": "in_progress",
                "outcome": "Saved report.", "why": "Already filed elsewhere.",
                "children": [{"ref": "detail", "type": "explanation",
                    "question": "Duplicate detail", "status": "open"}]},
            {"op": "reply", "item": {"ref": "duplicate"}, "text": "Deleted this duplicate report and its detail."},
            if delete_topic { json!({"op": "topic.delete", "topic": "duplicates"}) }
                else { json!({"op": "item.delete", "item": "duplicate"}) }
        ]})).unwrap();
        let before = setup.bytes();
        let preview = envelope(&setup.apply_with(&["--dry-run"], &body), 0);
        assert_eq!(setup.bytes(), before);
        assert_eq!(preview["data"]["repairs"].as_array().unwrap().len(), 2);
        assert!(preview["data"]["repairs"][0]
            .as_str()
            .unwrap()
            .contains("repaired to `in_progress`"));
        assert!(preview["data"]["repairs"][1]
            .as_str()
            .unwrap()
            .contains("repaired to `open`"));
        let filed = envelope(&setup.apply_with(&[], &body), 0);
        let mut expected = preview;
        expected["data"].as_object_mut().unwrap().remove("dry_run");
        // Preview allocations are discarded; the committed topic and notice get fresh identities.
        expected["data"]["topics"][0]["id"] = filed["data"]["topics"][0]["id"].clone();
        for field in ["topic_id", "message_id"] {
            expected["data"]["agent_removals"][0][field] =
                filed["data"]["agent_removals"][0][field].clone();
        }
        assert_eq!(filed, expected);
        assert_eq!(
            filed["data"]["agent_removals"][0]["item_ids"],
            json!(["3", "3.1"])
        );
        let saved = setup.store().read(&id(2)).unwrap();
        for (number, status, target) in [
            ("3", ItemStatus::InProgress, AckTarget::InProgress),
            ("3.1", ItemStatus::Open, AckTarget::Open),
        ] {
            let item = &saved.items.0[&ItemRef::new(number).unwrap()];
            assert_eq!(item.status, status);
            assert_eq!(item.ack_to, Some(target));
            assert!(ariadne_domain::visibility::item_is_removed(&saved, item));
        }
        assert!(saved
            .messages
            .iter()
            .any(|message| message.body == "Deleted this duplicate report and its detail."));
        let bytes = setup.bytes();
        assert_eq!(
            envelope(&setup.apply_with(&[], &body), 0),
            as_replay(&filed)
        );
        assert_eq!(setup.bytes(), bytes);
        let ack = |revision: PositiveSafeInteger| {
            json!({"session": {"project_id": id(1), "session_id": id(2)},
            "command": {"command": "ack", "api_version": 1, "op_id": id(1800),
                "params": {"item_id": "3", "expected_revision": revision}}})
        };
        let rejected = envelope(
            &setup.call(
                &["item", "ack", "--json-stdin", "--json"],
                Some(
                    &serde_json::to_vec(&ack(saved.items.0[&ItemRef::new("3").unwrap()].revision))
                        .unwrap(),
                ),
            ),
            3,
        );
        assert_eq!(rejected["error"]["code"], "invalid_transition");
        assert!(rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Restore"));
        assert_eq!(setup.bytes(), bytes);
        let command = if delete_topic {
            let topic = &saved.topics.0[&saved.items.0[&ItemRef::new("3").unwrap()].topic_id];
            OwnerCommand::TopicRemovedRestore {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(1801),
                params: TopicLifecycleParams {
                    topic_id: topic.id.clone(),
                    expected_revision: topic.revision,
                },
            }
        } else {
            OwnerCommand::ItemRestore {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(1801),
                params: ItemRemoveParams {
                    item_id: ItemRef::new("3").unwrap(),
                    expected_revision: saved.items.0[&ItemRef::new("3").unwrap()].revision,
                },
            }
        };
        ariadne_core::history_actions::HistoryActionService::new(&setup.registry)
            .execute(
                &OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
                    RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
                )),
                &command,
                UtcMillis::new("2026-10-09T12:00:00.000Z").unwrap(),
            )
            .unwrap();
        let restored = setup.store().read(&id(2)).unwrap();
        envelope(
            &setup.call(
                &["item", "ack", "--json-stdin", "--json"],
                Some(
                    &serde_json::to_vec(&ack(
                        restored.items.0[&ItemRef::new("3").unwrap()].revision
                    ))
                    .unwrap(),
                ),
            ),
            0,
        );
        let acknowledged = setup.store().read(&id(2)).unwrap();
        assert_eq!(
            acknowledged.items.0[&ItemRef::new("3").unwrap()].status,
            ItemStatus::InProgress
        );
        assert_eq!(
            acknowledged.items.0[&ItemRef::new("3").unwrap()].ack_to,
            None
        );
        assert_eq!(
            acknowledged.items.0[&ItemRef::new("3").unwrap()]
                .outcome
                .as_deref(),
            Some("Saved report.")
        );
        assert_eq!(
            acknowledged.items.0[&ItemRef::new("3.1").unwrap()].ack_to,
            Some(AckTarget::Open)
        );
        assert_eq!(acknowledged.inputs, restored.inputs);
    }
}

#[test]
fn topic_delete_uses_topic_guard_and_read_reports_removed_topics_and_items() {
    let setup = Setup::new(&seed());
    let created = envelope(
        &setup.apply(&json!({"operations":[
            {"op":"topic.add","name":"Wrong topic","ref":"wrong"},
            {"op":"item.add","question":"Wrong topic contents","type":"finding","ack_to":"open"}
        ]})),
        0,
    );
    let topic = created["data"]["topics"][0]["id"].as_str().unwrap();
    let mut guards = serde_json::Map::new();
    guards.insert(
        topic.into(),
        created["data"]["topics"][0]["revision"].clone(),
    );
    let deletion = json!({"expected_topic_revisions":guards,"operations":[{"op":"topic.delete","topic":topic}]});
    let deleted = envelope(&setup.apply(&deletion), 0);
    assert_eq!(deleted["data"]["agent_removals"][0]["topic_id"], topic);
    assert_eq!(deleted["data"]["agent_removals"][0]["item_id"], Value::Null);
    let topics = envelope(
        &setup.agent(&["read"], &["--view", "topics", "--json"], None),
        0,
    );
    assert_eq!(
        topics["data"]["notices"],
        json!(["1 removed topics not shown"])
    );
    assert!(!serde_json::to_string(&topics)
        .unwrap()
        .contains("Wrong topic"));
    let items = envelope(
        &setup.agent(&["read"], &["--view", "items", "--json"], None),
        0,
    );
    assert_eq!(
        items["data"]["notices"],
        json!(["1 removed items not shown", "1 removed topics not shown"])
    );
    assert!(!serde_json::to_string(&items)
        .unwrap()
        .contains("Wrong topic contents"));
}
#[test]
fn query_text_and_single_json_envelope_keep_complete_content_and_do_not_write_snapshots() {
    let setup = Setup::new(&seed());
    let before = setup.bytes();
    let registry = fs::read(setup.data().join("projects.json")).unwrap();
    let text = setup.agent(&["read"], &["--view", "messages"], None);
    assert!(text.status.success());
    assert!(text.stderr.is_empty());
    let json = envelope(
        &setup.agent(&["read"], &["--view", "messages", "--json"], None),
        0,
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&text.stdout).unwrap(),
        json["data"]
    );
    assert!(String::from_utf8(text.stdout)
        .unwrap()
        .contains("Every line remains"));
    assert_eq!(setup.bytes(), before);
    assert_eq!(
        fs::read(setup.data().join("projects.json")).unwrap(),
        registry
    );
}
#[test]
fn all_agent_views_and_item_history_use_canonical_core_results() {
    let setup = Setup::new(&seed());
    for view in ["topics", "items", "messages", "inputs"] {
        let result = envelope(
            &setup.agent(&["read"], &["--view", view, "--json"], None),
            0,
        );
        let expected = if view == "inputs" {
            "inputs_queue"
        } else {
            view
        };
        assert_eq!(result["data"]["data"]["view"], expected);
    }
    for method in ["messages", "rounds"] {
        let result = envelope(
            &setup.agent(&["item", method], &["--item", "1", "--json"], None),
            0,
        );
        assert_eq!(result["data"]["kind"], format!("item_{method}"));
    }
}
#[test]
fn full_stdin_filters_and_cursor_continue_then_detect_snapshot_change() {
    let setup = Setup::new(&seed());
    let mut params = read_params("items", 1);
    params["selection"]["filters"]["statuses"] = json!(["open", "done"]);
    let first = envelope(
        &setup.agent(
            &["session_read"],
            &["--json-stdin", "--json"],
            Some(&serde_json::to_vec(&params).unwrap()),
        ),
        0,
    );
    assert_eq!(first["data"]["data"]["page"]["items"][0]["item"]["id"], "1");
    params["cursor"] = first["data"]["data"]["page"]["next_cursor"].clone();
    assert!(!params["cursor"].is_null());
    let second = envelope(
        &setup.agent(
            &["read"],
            &["--json-stdin", "--json"],
            Some(&serde_json::to_vec(&params).unwrap()),
        ),
        0,
    );
    assert_eq!(
        second["data"]["data"]["page"]["items"][0]["item"]["id"],
        "2"
    );
    setup.submit("A future owner message", 600);
    assert_eq!(
        envelope(
            &setup.agent(
                &["read"],
                &["--json-stdin", "--json"],
                Some(&serde_json::to_vec(&params).unwrap())
            ),
            3
        )["error"]["code"],
        "snapshot_changed"
    );
}
#[test]
fn an_archived_topic_stays_readable_and_refuses_agent_writes_with_topic_archived() {
    let setup = Setup::new(&seed());
    setup.change(|session| {
        session.topics.0.get_mut(&id(5)).unwrap().archived_at =
            Some(UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap())
    });
    let read = |params: &Value| {
        envelope(
            &setup.agent(
                &["read"],
                &["--json-stdin", "--json"],
                Some(&serde_json::to_vec(params).unwrap()),
            ),
            0,
        )
    };
    let mut items = read_params("items", 100);
    items["selection"]["filters"]["topic_id"] = json!(id(5));
    items["selection"]["filters"]["archived"] = json!(true);
    let items = read(&items);
    let page = items["data"]["data"]["page"]["items"].as_array().unwrap();
    assert_eq!(page.len(), 2, "{items}");
    let mut messages = read_params("messages", 100);
    messages["selection"]["filters"]["topic_id"] = json!(id(5));
    let messages = read(&messages);
    assert!(
        !messages["data"]["data"]["page"]["items"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{messages}"
    );
    let topics = envelope(
        &setup.agent(&["read"], &["--view", "topics", "--json"], None),
        0,
    );
    assert!(
        !topics["data"]["data"]["page"]["items"][0]["archived_at"].is_null(),
        "{topics}"
    );
    let mut reply = request(800);
    reply["expected_item_revisions"] = json!({"1": 1});
    reply["operations"] =
        json!([{"op":"reply","ref":"r","item":{"id":"1"},"text":"Late note","round_id":null}]);
    let before = setup.bytes();
    let refused = envelope(&setup.apply(&reply), 3);
    assert_eq!(refused["error"]["code"], "invalid_transition", "{refused}");
    assert_eq!(refused["error"]["details"]["reason"], "topic_archived");
    assert_eq!(setup.bytes(), before);
}

#[test]
fn nested_history_stdin_and_parent_validation_are_preserved() {
    let session: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json")).unwrap();
    let setup = Setup::new(&session);
    let binding = id(0x20);
    let generation = id(0x22);
    let params = json!({"item_id":"1","cursor":null,"limit":1,"round_pages":[{"view":"round_answers","round_id":id(0x40),"cursor":null,"limit":1}]});
    let first = envelope(
        &setup.call(
            &[
                "item_rounds",
                "--binding",
                binding.as_str(),
                "--generation",
                generation.as_str(),
                "--json-stdin",
                "--json",
            ],
            Some(&serde_json::to_vec(&params).unwrap()),
        ),
        0,
    );
    assert_eq!(
        first["data"]["data"]["rounds"]["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut invalid = params;
    invalid["round_pages"] =
        json!([{"view":"round_answers","round_id":id(900),"cursor":null,"limit":1}]);
    let before = setup.bytes();
    assert_eq!(
        envelope(
            &setup.call(
                &[
                    "item",
                    "rounds",
                    "--binding",
                    binding.as_str(),
                    "--generation",
                    generation.as_str(),
                    "--json-stdin",
                    "--json"
                ],
                Some(&serde_json::to_vec(&invalid).unwrap())
            ),
            2
        )["error"]["code"],
        "invalid_argument"
    );
    assert_eq!(setup.bytes(), before);
}
#[test]
fn malformed_unknown_repeated_and_conflicting_flags_do_not_mutate() {
    let setup = Setup::new(&seed());
    let before = setup.bytes();
    for flags in [
        vec!["--bogus", "--json"],
        vec!["--limit", "0", "--json"],
        vec!["--limit", "101", "--json"],
        vec!["--limit", "1.5", "--json"],
        vec!["--view", "bogus", "--json"],
        vec!["--json", "--json"],
        vec!["--source-input", id(90).as_str(), "--json"],
        vec!["--item", "1", "--json"],
        vec!["--json-stdin", "--view", "items", "--json"],
    ] {
        envelope(&setup.agent(&["read"], &flags, None), 2);
    }
    for bytes in [b"null".as_slice(), b"{}", b"{} {}", b"not json"] {
        envelope(
            &setup.agent(&["read"], &["--json-stdin", "--json"], Some(bytes)),
            2,
        );
    }
    assert_eq!(setup.bytes(), before);
}
#[test]
fn apply_persists_full_reply_batch_and_exact_replay_with_no_second_write() {
    let setup = Setup::new(&seed());
    let mut command = request(500);
    command["expected_item_revisions"] = json!({"1":1});
    command["summary"] = json!("  Exact activity\nsecond line  ");
    command["operations"] = json!([{"op":"topic.add","ref":"new_topic","name":"CLI topic"},{"op":"reply","ref":"response","item":{"id":"1"},"text":"Full reply\n  including exact whitespace  ","round_id":null}]);
    let first = envelope(&setup.apply(&command), 0);
    let saved = setup.bytes();
    let session = setup.store().read(&id(2)).unwrap();
    assert_eq!(session.revision.value(), 2);
    assert!(session
        .messages
        .iter()
        .any(|m| m.body == "Full reply\n  including exact whitespace  "));
    assert!(session
        .messages
        .iter()
        .any(|m| m.body == "  Exact activity\nsecond line  "));
    assert_eq!(envelope(&setup.apply(&command), 0), as_replay(&first));
    assert_eq!(setup.bytes(), saved);
    command["summary"] = json!("  Exact activity\nsecond line ");
    assert_eq!(
        envelope(&setup.apply(&command), 3)["error"]["code"],
        "operation_reused"
    );
    assert_eq!(setup.bytes(), saved);
}
#[test]
fn atomic_invalid_batch_and_stale_revision_produce_conflict_without_partial_effects() {
    let setup = Setup::new(&seed());
    let before = setup.bytes();
    let mut command = request(500);
    command["operations"] = json!([{"op":"topic.add","ref":"would_allocate","name":"No partial topic"},{"op":"reply","ref":"reply","item":{"id":"999"},"text":"No such item","round_id":null}]);
    envelope(&setup.apply(&command), 2);
    assert_eq!(setup.bytes(), before);
    command = request(501);
    command["expected_item_revisions"] = json!({"1":2});
    let error = envelope(&setup.apply(&command), 3);
    assert_eq!(error["error"]["code"], "revision_conflict");
    assert_eq!(error["error"]["current_revision"], 1);
    assert_eq!(setup.bytes(), before);
}
#[test]
fn retained_binding_replay_survives_rebind_and_old_route_cannot_apply_new_operation() {
    let setup = Setup::new(&seed());
    let command = request(500);
    let saved = envelope(&setup.apply(&command), 0);
    setup.change(|session| {
        let mut replacement = session.bindings.0[&id(3)].clone();
        replacement.id = id(30);
        replacement.generation = id(31);
        replacement.external_session_id = "another-explicit-host".into();
        session.bindings.0.get_mut(&id(3)).unwrap().connection_state =
            ConnectionState::Disconnected;
        session.bindings.0.get_mut(&id(3)).unwrap().dispatch_state = DispatchState::Disconnected;
        session
            .bindings
            .0
            .insert(replacement.id.clone(), replacement);
        session.active_binding_id = Some(id(30));
    });
    let before = setup.bytes();
    assert_eq!(envelope(&setup.apply(&command), 0), as_replay(&saved));
    assert_eq!(setup.bytes(), before);
    assert_eq!(
        envelope(&setup.apply(&request(501)), 3)["error"]["code"],
        "binding_mismatch"
    );
    assert_eq!(setup.bytes(), before);
}
#[test]
fn generation_is_forwarded_unchanged_and_saved_apply_replays_before_current_guard() {
    let setup = Setup::new(&seed());
    let command = request(500);
    let saved = envelope(&setup.apply(&command), 0);
    setup.change(|session| session.bindings.0.get_mut(&id(3)).unwrap().generation = id(44));
    let before = setup.bytes();
    assert_eq!(envelope(&setup.apply(&command), 0), as_replay(&saved));
    assert_eq!(
        envelope(&setup.apply(&request(501)), 3)["error"]["code"],
        "stale_generation"
    );
    assert_eq!(
        envelope(&setup.agent(&["read"], &["--json"], None), 3)["error"]["code"],
        "stale_generation"
    );
    assert_eq!(setup.bytes(), before);
}
#[test]
fn owner_future_messages_and_input_payload_are_never_exposed_by_terminal_cli() {
    let setup = Setup::new(&seed());
    setup.submit("Private future owner input", 600);
    let messages = envelope(
        &setup.agent(&["read"], &["--view", "messages", "--json"], None),
        0,
    );
    assert!(!messages.to_string().contains("Private future owner input"));
    let inputs = envelope(
        &setup.agent(&["read"], &["--view", "inputs", "--json"], None),
        0,
    );
    assert_eq!(inputs["data"]["data"]["view"], "inputs_queue");
    assert_eq!(
        inputs["data"]["data"]["page"]["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(!inputs.to_string().contains("payload"));
    assert!(!inputs.to_string().contains("Private future"));
}
#[test]
fn dispatched_history_ceiling_is_derived_from_exact_source_not_later_binding_issuance() {
    let session: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json")).unwrap();
    let setup = Setup::new(&session);
    let binding = id(0x20);
    let generation = id(0x22);
    let input = id(0x71);
    let attempt = id(0x65);
    let result = envelope(
        &setup.call(
            &[
                "read",
                "--binding",
                binding.as_str(),
                "--generation",
                generation.as_str(),
                "--source-input",
                input.as_str(),
                "--attempt",
                attempt.as_str(),
                "--view",
                "messages",
                "--json",
            ],
            None,
        ),
        0,
    );
    let source = session
        .messages
        .iter()
        .find(|m| m.id == session.inputs.0[&input].message_id)
        .unwrap()
        .number
        .value();
    assert!(
        session.bindings.0[&binding]
            .issued_through_message_number
            .value()
            > source
    );
    for message in result["data"]["data"]["page"]["items"].as_array().unwrap() {
        if message["author"] == "owner" {
            assert!(message["number"].as_u64().unwrap() <= source);
        }
    }
    let invalid = envelope(
        &setup.call(
            &[
                "read",
                "--binding",
                binding.as_str(),
                "--generation",
                generation.as_str(),
                "--source-input",
                input.as_str(),
                "--attempt",
                id(900).as_str(),
                "--json",
            ],
            None,
        ),
        2,
    );
    assert_eq!(invalid["error"]["code"], "invalid_argument");
}
#[test]
fn duplicate_retained_binding_and_unavailable_other_registered_root_are_not_ignored() {
    let setup = Setup::new(&seed());
    let mut duplicate = seed();
    duplicate.id = id(200);
    setup.store().create(&duplicate).unwrap();
    assert_eq!(
        envelope(&setup.agent(&["read"], &["--json"], None), 3)["error"]["code"],
        "binding_ambiguous"
    );
    let setup = Setup::new(&seed());
    let unavailable = tempfile::tempdir().unwrap();
    setup
        .registry
        .register(unavailable.path(), &id(400), || id(401))
        .unwrap();
    fs::remove_file(setup.registry.project_dir(&id(401)).join("project.json")).unwrap();
    let error = envelope(&setup.agent(&["read"], &["--json"], None), 4);
    assert_eq!(error["error"]["code"], "io_error");
    assert!(error["error"]["message"]
        .as_str()
        .unwrap()
        .contains("project.json"));
}
#[test]
fn future_corrupt_and_ordinary_io_failures_have_canonical_exit_and_preserve_bytes() {
    let setup = Setup::new(&seed());
    let mut future = serde_json::to_value(seed()).unwrap();
    future["schema_version"] = json!(2);
    let bytes = serde_json::to_vec(&future).unwrap();
    fs::write(setup.path(), &bytes).unwrap();
    assert_eq!(
        envelope(&setup.agent(&["read"], &["--json"], None), 5)["error"]["code"],
        "future_schema"
    );
    assert_eq!(setup.bytes(), bytes);
    fs::write(setup.path(), b"bad snapshot").unwrap();
    assert_eq!(
        envelope(&setup.agent(&["read"], &["--json"], None), 4)["error"]["code"],
        "corrupt_session"
    );
    assert_eq!(setup.bytes(), b"bad snapshot");
    fs::remove_file(setup.registry.project_dir(&id(1)).join("project.json")).unwrap();
    assert_eq!(
        envelope(&setup.agent(&["read"], &["--json"], None), 4)["error"]["code"],
        "io_error"
    );
}
#[test]
fn text_errors_use_stderr_and_json_errors_use_one_stdout_envelope() {
    let setup = Setup::new(&seed());
    let text = setup.agent(&["read"], &["--limit", "0"], None);
    assert_eq!(text.status.code(), Some(2));
    assert!(text.stdout.is_empty());
    assert!(String::from_utf8(text.stderr)
        .unwrap()
        .contains("InvalidArgument"));
    envelope(
        &setup.agent(&["read"], &["--limit", "0", "--json"], None),
        2,
    );
}
#[test]
fn private_data_directory_constructor_is_shared_with_bridge_and_never_nests_or_retargets() {
    let setup = Setup::new(&seed());
    Registry::open_data_directory(&setup.data()).unwrap();
    assert!(!setup.data().join(".ariadne").exists());
    let owner_home = tempfile::tempdir().unwrap();
    fs::write(owner_home.path().join("keep"), b"owner").unwrap();
    let binding = id(3);
    let generation = id(4);
    let args = [
        "read",
        "--binding",
        binding.as_str(),
        "--generation",
        generation.as_str(),
        "--json",
    ];
    let mut command = Command::new(env!("CARGO_BIN_EXE_ariadne"));
    command
        .args(args)
        .env("ARIADNE_HOME", setup.data())
        .env("HOME", owner_home.path());
    envelope(&invoke(command, None), 0);
    assert_eq!(fs::read(owner_home.path().join("keep")).unwrap(), b"owner");
    assert!(!owner_home.path().join(".ariadne").exists());
    let mut command = Command::new(env!("CARGO_BIN_EXE_ariadne"));
    command
        .args(args)
        .env_remove("ARIADNE_HOME")
        .env("HOME", setup.home.path());
    envelope(&invoke(command, None), 0);
    let link = owner_home.path().join("link");
    symlink(setup.data(), &link).unwrap();
    assert!(Registry::open_data_directory(&link).is_err());
    let missing = owner_home.path().join("missing");
    assert!(Registry::open_data_directory(&missing).is_err());
    assert!(!missing.exists());
    fs::set_permissions(setup.data(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(Registry::open_data_directory(&setup.data()).is_err());
}
#[test]
fn malformed_apply_stdin_reports_the_parser_message_and_help_documents_it() {
    let setup = Setup::new(&seed());
    let before = setup.bytes();
    let mut command = request(501);
    command["caller_actor"] = json!("owner");
    let value = envelope(&setup.apply(&command), 2);
    let message = value["error"]["message"].as_str().unwrap();
    assert!(message.contains("ApplyRequest"), "{message}");
    assert!(message.contains("caller_actor"), "{message}");
    command = request(501);
    command["operations"] = json!([{"op": "item.nope"}]);
    let value = envelope(&setup.apply(&command), 2);
    assert!(value["error"]["message"]
        .as_str()
        .unwrap()
        .contains("item.nope"));
    // A control character echoed from the input must not turn the parse error
    // into a different error class.
    command = request(501);
    command["operations"] = json!([{"op": "\u{0}"}]);
    let value = envelope(&setup.apply(&command), 2);
    assert_eq!(value["error"]["code"], "invalid_argument");
    let message = value["error"]["message"].as_str().unwrap();
    assert!(message.starts_with("Stdin must contain one canonical ApplyRequest"));
    assert!(!message.chars().any(char::is_control), "{message}");
    assert_eq!(setup.bytes(), before);
    let help = invoke(Command::new(env!("CARGO_BIN_EXE_ariadne")), None);
    assert!(String::from_utf8(help.stdout)
        .unwrap()
        .contains("parser's message"));
}
#[test]
fn every_query_tool_named_in_the_envelope_is_a_real_cli_command() {
    for name in ariadne_core::delivery::AGENT_QUERY_TOOLS
        .iter()
        .chain(&["apply"])
    {
        assert!(ariadne_cli::agent::handles(&[name]), "{name}");
    }
}
#[test]
fn oversize_json_unknown_fields_and_source_mismatch_reject_before_write() {
    let setup = Setup::new(&seed());
    let before = setup.bytes();
    envelope(
        &setup.agent(
            &["apply"],
            &["--json-stdin", "--json"],
            Some(&vec![b' '; 512 * 1024 + 1]),
        ),
        2,
    );
    let mut command = request(500);
    command["caller_actor"] = json!("owner");
    envelope(&setup.apply(&command), 2);
    command = request(500);
    command["source_input_id"] = json!(id(800));
    envelope(&setup.apply(&command), 2);
    command["attempt_id"] = json!(id(801));
    envelope(&setup.apply(&command), 2);
    assert_eq!(setup.bytes(), before);
}

#[test]
fn agent_and_bridge_real_processes_use_one_private_application_data_root() {
    use ariadne_runtime::{
        control::{ControlMethod, ControlRequest},
        leases::DesktopOwner,
    };
    let setup = Setup::new(&seed());
    let owner = DesktopOwner::acquire(&setup.data()).unwrap();
    let listener = UnixListener::bind(owner.control_path()).unwrap();
    fs::set_permissions(owner.control_path(), fs::Permissions::from_mode(0o600)).unwrap();
    let before = setup.bytes();
    let server = std::thread::spawn(move || {
        let _owner = owner;
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        stream
            .set_write_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        let mut length = [0; 4];
        stream.read_exact(&mut length).unwrap();
        let mut bytes = vec![0; u32::from_be_bytes(length) as usize];
        stream.read_exact(&mut bytes).unwrap();
        let request: ControlRequest = serde_json::from_slice(&bytes).unwrap();
        request.validate().unwrap();
        let ControlMethod::ConnectionStatus(scope) = request.method else {
            panic!("status request")
        };
        assert_eq!(scope.binding_id, id(3));
        assert_eq!(scope.generation, id(4));
        let status = json!({"id":id(3),"generation":id(4),"adapter_id":"fake.local","external_session_id":"existing-thread","dispatch_state":"enabled","owner_paused":false,"pause_reason":null,"connection_state":"connected","presence":null});
        let bytes =
            serde_json::to_vec(&json!({"v":1,"kind":"response","id":request.id,"result":status}))
                .unwrap();
        stream
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .unwrap();
        stream.write_all(&bytes).unwrap();
    });
    envelope(&setup.agent(&["read"], &["--json"], None), 0);
    envelope(
        &setup.call(
            &[
                "bridge",
                "connection-status",
                "--binding",
                id(3).as_str(),
                "--generation",
                id(4).as_str(),
                "--request-id",
                id(90).as_str(),
            ],
            None,
        ),
        0,
    );
    server.join().unwrap();
    assert_eq!(setup.bytes(), before);
    assert!(!setup.data().join(".ariadne").exists());
}

#[test]
fn historical_attempt_reads_with_current_generation_do_not_gain_write_authority() {
    let mut session: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json")).unwrap();
    let binding = id(0x20);
    let generation = id(900);
    let input = id(0x72);
    let attempt = id(0x62);
    session.bindings.0.get_mut(&binding).unwrap().generation = generation.clone();
    let setup = Setup::new(&session);
    let before = setup.bytes();
    envelope(
        &setup.call(
            &[
                "read",
                "--binding",
                binding.as_str(),
                "--generation",
                generation.as_str(),
                "--source-input",
                input.as_str(),
                "--attempt",
                attempt.as_str(),
                "--view",
                "messages",
                "--json",
            ],
            None,
        ),
        0,
    );
    let mut command = request(500);
    command["source_input_id"] = json!(input);
    command["attempt_id"] = json!(attempt);
    let output = setup.call(
        &[
            "apply",
            "--binding",
            binding.as_str(),
            "--generation",
            generation.as_str(),
            "--json-stdin",
            "--json",
        ],
        Some(&serde_json::to_vec(&command).unwrap()),
    );
    assert_eq!(envelope(&output, 3)["error"]["code"], "stale_generation");
    assert_eq!(setup.bytes(), before);
}

#[test]
fn real_process_bounds_long_native_errors_in_json_and_text_without_claiming_no_effects() {
    let routing = [
        "read",
        "--binding",
        "00000000-0000-4000-8000-000000000003",
        "--generation",
        "00000000-0000-4000-8000-000000000004",
    ];
    let path = format!("/{}/data", "a".repeat(10_000));
    for json in [false, true] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ariadne"));
        command.args(routing).env("ARIADNE_HOME", &path);
        if json {
            command.arg("--json");
        }
        let output = invoke(command, None);
        if json {
            let value = envelope(&output, 4);
            let error: CoreError = serde_json::from_value(value["error"].clone()).unwrap();
            error.validate().unwrap();
            assert_eq!(error.code, CoreErrorCode::IoError);
            assert!(!error.retryable);
            assert!(error.message.len() <= 4096);
            assert!(error.hint.contains("original operation/event IDs"));
            assert!(error.hint.contains("no data was repaired"));
            assert!(output.stdout.len() < 8192);
        } else {
            assert_eq!(output.status.code(), Some(4));
            assert!(output.stdout.is_empty());
            let text = String::from_utf8(output.stderr).unwrap();
            assert!(text.contains("IoError"));
            assert!(text.contains("original operation/event IDs"));
            assert!(text.contains("no data was repaired"));
            assert!(text.len() < 8192);
        }
    }
}

#[test]
fn output_preserves_valid_canonical_errors_and_uncertainty_exits() {
    for (code, exit) in [
        (CoreErrorCode::InvalidArgument, 2),
        (CoreErrorCode::RevisionConflict, 3),
        (CoreErrorCode::IoError, 4),
        (CoreErrorCode::FutureSchema, 5),
        (CoreErrorCode::CommitUncertain, 4),
    ] {
        let mut error = CoreError::new(
            code,
            "Exact original error",
            "Retain the exact operation ID; inspect its saved receipt.",
        );
        error.current_revision = Some(PositiveSafeInteger::new(7).unwrap());
        error.validate().unwrap();
        for json in [false, true] {
            let mut output = vec![];
            let mut errors = vec![];
            assert_eq!(
                ariadne_cli::output::write(Err(error.clone()), json, &mut output, &mut errors),
                exit
            );
            if json {
                assert!(errors.is_empty());
                let envelope: FailureEnvelope = serde_json::from_slice(&output).unwrap();
                assert_eq!(envelope.error, error);
            } else {
                assert!(output.is_empty());
                assert_eq!(
                    String::from_utf8(errors).unwrap(),
                    format!("{:?}: {}\n{}\n", error.code, error.message, error.hint)
                );
            }
        }
    }
    let malformed = CoreError::new(
        CoreErrorCode::CommitUncertain,
        "x".repeat(4097),
        "Do not resend uncertain delivery.",
    );
    let mut output = vec![];
    let mut errors = vec![];
    assert_eq!(
        ariadne_cli::output::write(Err(malformed), true, &mut output, &mut errors),
        3
    );
    let envelope: FailureEnvelope = serde_json::from_slice(&output).unwrap();
    envelope.error.validate().unwrap();
    assert!(!envelope.error.retryable);
    assert!(envelope
        .error
        .hint
        .contains("original request, event and operation IDs"));
}

// ---- lenient apply, compact receipts, dry-run and read filters ----

const LENIENT: &str = include_str!("fixtures/lenient-apply.json");

impl Setup {
    fn apply_with(&self, flags: &[&str], bytes: &[u8]) -> Output {
        let mut all = vec!["--json-stdin", "--json"];
        all.extend(flags);
        self.agent(&["apply"], &all, Some(bytes))
    }
    fn lenient(&self, flags: &[&str]) -> Value {
        envelope(&self.apply_with(flags, LENIENT.as_bytes()), 0)
    }
    fn page(&self, flags: &[&str]) -> Vec<Value> {
        let mut all = vec!["--json"];
        all.extend(flags);
        let value = envelope(&self.agent(&["read"], &all, None), 0);
        value["data"]["data"]["page"]["items"]
            .as_array()
            .unwrap()
            .clone()
    }
}
fn listed(rows: &[Value], key: &str) -> Vec<String> {
    // An items page wraps each snapshot as `{item, ...}`; a topics page does not.
    rows.iter()
        .map(|row| {
            row.get("item").unwrap_or(row)[key]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}
/// A compact receipt as the replay of it prints: the same, plus `replayed`.
fn as_replay(receipt: &Value) -> Value {
    let mut replay = receipt.clone();
    replay["data"]["replayed"] = json!(true);
    replay
}
fn lenient_with_op(op: u64) -> Vec<u8> {
    let mut value: Value = serde_json::from_str(LENIENT).unwrap();
    value["op_id"] = json!(id(op));
    serde_json::to_vec(&value).unwrap()
}

#[test]
fn the_lenient_fixture_applies_end_to_end_and_prints_a_compact_receipt() {
    let setup = Setup::new(&seed());
    let value = setup.lenient(&[]);
    let data = &value["data"];
    UuidV4::new(data["op_id"].as_str().unwrap()).unwrap();
    assert!(data.get("dry_run").is_none());
    assert_eq!(data["topics"].as_array().unwrap().len(), 1);
    assert_eq!(data["topics"][0]["number"], 2);
    assert_eq!(data["topics"][0]["short"], "Cache PR");
    assert_eq!(data["topics"][0]["created"], true);
    assert_eq!(
        listed(data["items"].as_array().unwrap(), "id"),
        ["3", "3.1", "4"]
    );
    assert_eq!(
        listed(data["items"].as_array().unwrap(), "short"),
        ["Review result", "Fill race", "Fallback merge"]
    );
    for forbidden in ["allocated_refs", "messages", "item_revisions", "kind"] {
        assert!(data.get(forbidden).is_none(), "{forbidden} in {data}");
    }

    let session = setup.store().read(&id(2)).unwrap();
    for row in data["items"].as_array().unwrap() {
        let item = &session.items.0[&ItemRef::new(row["id"].as_str().unwrap()).unwrap()];
        assert_eq!(row["revision"], item.revision.value(), "{row}");
        assert_eq!(row["created"], true);
    }
    let topic = session
        .topics
        .0
        .values()
        .find(|t| t.order.value() == 2)
        .unwrap();
    assert_eq!(data["topics"][0]["id"], topic.id.as_str());
    assert_eq!(data["topics"][0]["revision"], topic.revision.value());
    let item = |name: &str| &session.items.0[&ItemRef::new(name).unwrap()];
    assert_eq!(item("3").owner, ItemOwner::Agent { binding_id: id(3) });
    assert_eq!(item("3").status, ItemStatus::Open);
    assert_eq!(item("3").ack_to, Some(AckTarget::Done));
    assert_eq!(item("3").outcome.as_deref(), Some("Reviewed"));
    assert_eq!(item("3").why.as_deref(), Some("Read every changed file"));
    assert_eq!(item("3.1").status, ItemStatus::Open);
    assert_eq!(item("3.1").ack_to, Some(AckTarget::Done));
    assert_eq!(data["repairs"].as_array().unwrap().len(), 2);
    assert_eq!(item("3.1").parent, Some(ItemRef::new("3").unwrap()));
    assert_eq!(item("3.1").topic_id, topic.id);
    assert_eq!(item("3").topic_id, topic.id);
    assert_eq!(item("4").status, ItemStatus::WaitingOnMe);
    assert_eq!(item("4").owner, ItemOwner::Me {});
    assert_eq!(item("4").topic_id, topic.id);
    let options: Vec<_> = item("4")
        .options
        .iter()
        .map(|o| (o.id.as_str(), o.recommended))
        .collect();
    assert_eq!(options, [("1", false), ("2", false)]);
}

#[test]
fn terminal_creation_is_repaired_recursively_and_read_exposes_the_ack_target() {
    for (status, target) in [
        ("decided", AckTarget::Decided),
        ("done", AckTarget::Done),
        ("dropped", AckTarget::Dropped),
    ] {
        let setup = Setup::new(&seed());
        let body = serde_json::to_vec(&json!({"operations": [{
            "op": "item.add", "topic": {"id": id(5)}, "type": "finding",
            "question": "Root", "status": status, "outcome": "Authored outcome",
            "why": "Authored why", "children": [{
                "type": "finding", "question": "Child", "status": status,
                "children": [{"type": "finding", "question": "Grandchild", "status": status}]
            }]
        }]}))
        .unwrap();
        let before = setup.bytes();
        let preview = envelope(&setup.apply_with(&["--dry-run"], &body), 0);
        assert_eq!(preview["data"]["repairs"].as_array().unwrap().len(), 3);
        assert_eq!(setup.bytes(), before);
        let filed = envelope(&setup.apply_with(&[], &body), 0);
        let mut expected = preview;
        expected["data"].as_object_mut().unwrap().remove("dry_run");
        assert_eq!(filed, expected);
        let saved = setup.bytes();
        assert_eq!(
            envelope(&setup.apply_with(&[], &body), 0),
            as_replay(&filed)
        );
        assert_eq!(setup.bytes(), saved);
        let session = setup.store().read(&id(2)).unwrap();
        for name in ["3", "3.1", "3.1.1"] {
            let item = &session.items.0[&ItemRef::new(name).unwrap()];
            assert_eq!(item.status, ItemStatus::Open);
            assert_eq!(item.ack_to, Some(target));
        }
        let root = &session.items.0[&ItemRef::new("3").unwrap()];
        assert_eq!(root.outcome.as_deref(), Some("Authored outcome"));
        assert_eq!(root.why.as_deref(), Some("Authored why"));
        let rows = setup.page(&["--view", "items", "--limit", "100"]);
        for row in rows
            .iter()
            .filter(|row| row["item"]["id"].as_str().unwrap().starts_with('3'))
        {
            assert_eq!(row["item"]["status"], "open");
            assert_eq!(row["item"]["ack_to"], status);
        }
    }
}

#[test]
fn missing_read_only_ack_preserves_parent_and_child_status_in_preview_commit_and_ack() {
    for item_type in ["finding", "explanation"] {
        for status in ["open", "in_progress"] {
            let setup = Setup::new(&seed());
            let child_status = if status == "open" {
                "in_progress"
            } else {
                "open"
            };
            let body = serde_json::to_vec(&json!({"operations": [{
                "op": "item.add", "topic": {"id": id(5)}, "type": item_type,
                "question": "Read the report.", "status": status,
                "outcome": "Investigation continues.", "why": "More evidence is needed.",
                "children": [{"type": item_type, "question": "Read the detail.",
                    "status": child_status}]
            }]}))
            .unwrap();
            let before = setup.bytes();
            let preview = envelope(&setup.apply_with(&["--dry-run"], &body), 0);
            assert_eq!(setup.bytes(), before);
            let repairs = preview["data"]["repairs"].as_array().unwrap();
            assert_eq!(repairs.len(), 2);
            for (repair, expected) in repairs.iter().zip([status, child_status]) {
                assert!(repair.as_str().unwrap().contains(&format!(
                    "repaired to `{expected}` to keep the current status"
                )));
            }
            let filed = envelope(&setup.apply_with(&[], &body), 0);
            let mut expected = preview;
            expected["data"].as_object_mut().unwrap().remove("dry_run");
            assert_eq!(filed, expected);
            for (number, status, op) in [("3", status, 998), ("3.1", child_status, 999)] {
                let session = setup.store().read(&id(2)).unwrap();
                let item = &session.items.0[&ItemRef::new(number).unwrap()];
                assert_eq!(serde_json::to_value(&item.status).unwrap(), status);
                assert_eq!(serde_json::to_value(item.ack_to).unwrap(), status);
                let request = json!({"session": {"project_id": id(1), "session_id": id(2)},
                    "command": {"command": "ack", "api_version": 1, "op_id": id(op),
                        "params": {"item_id": number, "expected_revision": item.revision}}});
                envelope(
                    &setup.call(
                        &["item", "ack", "--json-stdin", "--json"],
                        Some(&serde_json::to_vec(&request).unwrap()),
                    ),
                    0,
                );
                let after = setup.store().read(&id(2)).unwrap();
                let read = &after.items.0[&ItemRef::new(number).unwrap()];
                assert_eq!(read.status, item.status);
                assert_eq!(read.ack_to, None);
                assert_eq!(read.outcome, item.outcome);
                assert_eq!(read.why, item.why);
            }
        }
    }
}

#[test]
fn new_ordinary_items_with_result_prose_without_ack_are_refused_without_writes() {
    for item_type in ["task", "decision", "question"] {
        for status in ["open", "in_progress"] {
            for prose in [
                json!({"outcome": "Result"}),
                json!({"why": "Evidence"}),
                json!({"outcome": "Result", "why": "Evidence"}),
            ] {
                let setup = Setup::new(&seed());
                let mut item = json!({"op": "item.add", "topic": {"id": id(5)},
                    "type": item_type, "question": "Work remains.", "status": status});
                item.as_object_mut()
                    .unwrap()
                    .extend(prose.as_object().unwrap().clone());
                let body = serde_json::to_vec(&json!({"operations": [item]})).unwrap();
                let before = setup.bytes();
                for flags in [&["--dry-run"][..], &[][..]] {
                    let refused = envelope(&setup.apply_with(flags, &body), 2);
                    assert_eq!(refused["error"]["code"], "invalid_argument");
                    assert_eq!(setup.bytes(), before);
                }
            }
        }
    }
}

#[test]
fn strict_creation_rejects_every_terminal_status_including_nested_item_operations() {
    for status in ["decided", "done", "dropped", "replaced"] {
        let mut strict = request(650);
        strict["operations"] = json!([
            {"op": "item.add", "ref": "parent", "topic": {"id": id(5)},
             "type": "finding", "question": "Parent", "status": "open", "ack_to": "open",
             "owner": {"kind": "agent", "binding_id": id(3)}},
            {"op": "item.add", "ref": "child", "topic": {"id": id(5)},
             "parent": {"ref": "parent"}, "type": "finding", "question": "Child",
             "status": status, "owner": {"kind": "agent", "binding_id": id(3)},
             "outcome": "Authored outcome", "why": "Authored why",
             "replaced_by": {"id": "1"}}
        ]);
        let typed: ApplyRequest = serde_json::from_value(strict).unwrap();
        let error = typed.validate_wire().unwrap_err();
        assert_eq!(error.code, CoreErrorCode::InvalidArgument);
        assert!(error.message.contains("New items must start"), "{error:?}");
    }
}

#[test]
fn explicit_ack_creation_is_accepted_and_conflicts_or_replaced_are_atomic_failures() {
    let setup = Setup::new(&seed());
    for target in ["open", "in_progress", "decided", "done", "dropped"] {
        let value = envelope(
            &setup.apply(&json!({"operations": [{
                "op": "item.add", "topic": {"id": id(5)}, "type": "finding",
                "question": target, "status": "open", "ack_to": target
            }]})),
            0,
        );
        assert!(value["data"].get("repairs").is_none());
    }
    let before = setup.bytes();
    for flags in [&[][..], &["--dry-run"][..]] {
        for (status, target) in [("done", "dropped"), ("replaced", "done")] {
            let body = serde_json::to_vec(&json!({"operations": [{
                "op": "item.add", "topic": {"id": id(5)}, "type": "finding",
                "question": "Rejected", "status": status, "ack_to": target,
                "outcome": "Preserved", "why": "Preserved", "replaced_by": {"id": "1"}
            }]}))
            .unwrap();
            let refused = envelope(&setup.apply_with(flags, &body), 2);
            assert_eq!(refused["error"]["code"], "invalid_argument");
            assert!(refused["error"]["message"]
                .as_str()
                .unwrap()
                .contains("operations[0]"));
            assert_eq!(setup.bytes(), before);
        }
    }
}

#[test]
fn native_result_request_prints_a_full_raw_receipt_and_replays_without_a_second_write() {
    let session: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json")).unwrap();
    let setup = Setup::new(&session);
    let input = &session.inputs.0[&id(0x72)];
    let item = input.target.item_id.as_ref().unwrap();
    let owner = session
        .messages
        .iter()
        .find(|message| message.id == input.message_id)
        .unwrap();
    // Same explicit reply/result request and raw stdout mode as publishResult
    // in the native scripted provider. --full is required for receipt identity.
    let request = json!({
        "op_id": id(0x9000), "source_input_id": input.id,
        "attempt_id": input.active_attempt_id,
        "expected_item_revisions": {item.as_str(): session.items.0[item].revision},
        "expected_topic_revisions": {}, "summary": "",
        "operations": [{"op": "reply", "ref": "native_reply", "item": {"id": item},
            "text": "Explicit scripted reply", "round_id": null}],
        "input_result": {"outcome": "answered", "explanation": "Explicit scripted result 1",
            "reply_refs": [{"ref": "native_reply"}], "followup_item_refs": [],
            "handled_through_message_number": owner.number}
    });
    let body = serde_json::to_vec(&request).unwrap();
    let binding = &session.bindings.0[&input.binding_id];
    let args = [
        "apply",
        "--binding",
        binding.id.as_str(),
        "--generation",
        binding.generation.as_str(),
        "--json-stdin",
        "--full",
    ];
    let output = setup.call(&args, Some(&body));
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(output.stderr.is_empty());
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["session_id"], session.id.as_str());
    assert_eq!(receipt["operation_id"], id(0x9000).as_str());
    assert_eq!(receipt["data"]["kind"], "apply");
    let saved = setup.bytes();
    let committed = setup.store().read(&session.id).unwrap();
    assert_eq!(receipt["revision"], committed.revision.value());
    let reply = committed
        .messages
        .iter()
        .find(|message| message.body == "Explicit scripted reply")
        .unwrap();
    assert_eq!(
        receipt["data"]["allocated_refs"]["native_reply"]["id"],
        reply.id.as_str()
    );
    let attempt = committed.inputs.0[&input.id]
        .attempts
        .iter()
        .find(|attempt| Some(&attempt.id) == input.active_attempt_id.as_ref())
        .unwrap();
    let result = attempt.domain_result.as_ref().unwrap();
    assert_eq!(result.operation_id, id(0x9000));
    assert_eq!(result.outcome, ResultOutcome::Answered);
    assert_eq!(result.reply_message_ids, std::slice::from_ref(&reply.id));
    assert_eq!(
        result.handled_through_message_number.value(),
        owner.number.value()
    );
    let replay = setup.call(&args, Some(&body));
    assert_eq!(replay.status.code(), Some(0), "{replay:?}");
    assert!(replay.stderr.is_empty());
    assert_eq!(replay.stdout, output.stdout);
    assert_eq!(setup.bytes(), saved);
    // The tree helper requests the same saved receipt inside a JSON envelope.
    let mut enveloped_args = args.to_vec();
    enveloped_args.push("--json");
    let enveloped = envelope(&setup.call(&enveloped_args, Some(&body)), 0);
    assert_eq!(enveloped["data"], receipt);
    assert_eq!(setup.bytes(), saved);
}

#[test]
fn full_prints_the_complete_saved_receipt_and_a_stated_op_id_replays() {
    let setup = Setup::new(&seed());
    let body = lenient_with_op(600);
    let full = repaired_full_envelope(&setup.apply_with(&["--full"], &body));
    assert_eq!(full["data"]["data"]["kind"], "apply");
    assert_eq!(full["data"]["operation_id"], id(600).as_str());
    assert_eq!(
        full["data"]["data"]["allocated_refs"]
            .as_object()
            .unwrap()
            .len(),
        4
    );
    let saved = setup.bytes();
    let compact = envelope(&setup.apply_with(&[], &body), 0);
    assert_eq!(compact["data"]["op_id"], id(600).as_str());
    assert_eq!(compact["data"]["items"][0]["id"], "3");
    assert_eq!(compact["data"]["replayed"], true);
    assert_eq!(setup.bytes(), saved, "an exact replay writes nothing");
    assert_eq!(
        repaired_full_envelope(&setup.apply_with(&["--full"], &body)),
        full
    );
    assert_eq!(setup.bytes(), saved, "a full replay also writes nothing");
}

#[test]
fn an_identical_request_without_an_op_id_replays_and_files_once() {
    let setup = Setup::new(&seed());
    let first = setup.lenient(&[]);
    assert!(first["data"].get("replayed").is_none(), "{first}");
    let saved = setup.bytes();
    // A blind retry of a call that was killed or timed out: same bytes, no op_id.
    let retry = setup.lenient(&[]);
    assert_eq!(retry["data"]["op_id"], first["data"]["op_id"]);
    assert_eq!(retry["data"]["replayed"], true);
    assert_eq!(retry["data"]["topics"], first["data"]["topics"]);
    assert_eq!(retry["data"]["items"], first["data"]["items"]);
    assert_eq!(setup.bytes(), saved, "the retry writes nothing");
    // Formatting and key order also normalize to the same expanded operation.
    let request: Value = serde_json::from_str(LENIENT).unwrap();
    let formatted = serde_json::to_vec_pretty(&request).unwrap();
    assert_eq!(envelope(&setup.apply_with(&[], &formatted), 0), retry);
    assert_eq!(setup.bytes(), saved);
    let session = setup.store().read(&id(2)).unwrap();
    assert_eq!(session.topics.0.len(), 2, "the seed topic and one new one");
    assert_eq!(
        session.items.0.len(),
        5,
        "the two seed items and three new ones"
    );
    // A different request is new work.
    let other =
        serde_json::to_vec(&json!({"operations": [{"op": "topic.add", "name": "Another"}]}))
            .unwrap();
    let filed = envelope(&setup.apply_with(&[], &other), 0);
    assert_ne!(filed["data"]["op_id"], first["data"]["op_id"]);
    assert!(filed["data"].get("replayed").is_none());
    assert_eq!(setup.store().read(&id(2)).unwrap().topics.0.len(), 3);
}

#[test]
fn a_derived_op_id_replays_after_generation_rotation_and_a_fresh_explicit_id_files_again() {
    let setup = Setup::new(&seed());
    let first = setup.lenient(&[]);
    setup.change(|session| session.bindings.0.get_mut(&id(3)).unwrap().generation = id(44));
    let saved = setup.bytes();
    let binding = id(3);
    let generation = id(44);
    let apply = |flags: &[&str], body: &[u8]| {
        let mut args = vec![
            "apply",
            "--binding",
            binding.as_str(),
            "--generation",
            generation.as_str(),
            "--json-stdin",
            "--json",
        ];
        args.extend(flags);
        envelope(&setup.call(&args, Some(body)), 0)
    };

    // A lost receipt retried after reconnecting is still the saved operation.
    let replay = apply(&[], LENIENT.as_bytes());
    assert_eq!(replay, as_replay(&first));
    assert_eq!(
        setup.bytes(),
        saved,
        "the new-generation retry writes nothing"
    );
    // Core also recognizes the saved operation when its original generation is stale.
    assert_eq!(setup.lenient(&[]), replay);
    let mut dry_replay = replay.clone();
    dry_replay["data"]["dry_run"] = json!(true);
    assert_eq!(apply(&["--dry-run"], LENIENT.as_bytes()), dry_replay);
    assert_eq!(
        setup.bytes(),
        saved,
        "all replay paths leave the store unchanged"
    );
    let session = setup.store().read(&id(2)).unwrap();
    assert_eq!(session.topics.0.len(), 2);
    assert_eq!(session.items.0.len(), 5);

    // Deliberate duplicate filing uses a fresh explicit ID under current authority.
    let duplicate = apply(&[], &lenient_with_op(602));
    assert_eq!(duplicate["data"]["op_id"], id(602).as_str());
    assert!(duplicate["data"].get("replayed").is_none());
    let session = setup.store().read(&id(2)).unwrap();
    assert_eq!(session.topics.0.len(), 3);
    assert_eq!(session.items.0.len(), 8);
}

#[test]
fn dry_run_reports_what_would_change_and_commits_nothing() {
    let setup = Setup::new(&seed());
    let before = setup.bytes();
    let dry = setup.apply_with(&["--dry-run"], &lenient_with_op(601));
    let dry = envelope(&dry, 0);
    assert_eq!(dry["data"]["dry_run"], true);
    assert!(dry["data"].get("replayed").is_none());
    assert_eq!(dry["data"]["op_id"], id(601).as_str());
    assert_eq!(
        listed(dry["data"]["items"].as_array().unwrap(), "id"),
        ["3", "3.1", "4"]
    );
    assert_eq!(dry["data"]["topics"][0]["number"], 2);
    assert_eq!(setup.bytes(), before);
    assert_eq!(setup.store().read(&id(2)).unwrap().revision.value(), 1);

    // The preview is exactly what the real run then reports.
    let real = envelope(&setup.apply_with(&[], &lenient_with_op(601)), 0);
    let mut shown = dry["data"].clone();
    shown.as_object_mut().unwrap().remove("dry_run");
    // The preview's topic id is a throwaway; every other field is the commit's.
    for part in [&mut shown, &mut real.clone()["data"]] {
        part["topics"][0].as_object_mut().unwrap().remove("id");
    }
    let mut committed = real["data"].clone();
    committed["topics"][0].as_object_mut().unwrap().remove("id");
    assert_eq!(shown, committed);
    assert_ne!(setup.bytes(), before);

    // Once committed, the same bytes are reported as a replay and still write nothing.
    let saved = setup.bytes();
    let again = envelope(&setup.apply_with(&["--dry-run"], &lenient_with_op(601)), 0);
    assert_eq!(again["data"]["replayed"], true);
    assert_eq!(setup.bytes(), saved);

    // --full shows the complete would-be receipt.
    let full =
        repaired_full_envelope(&setup.apply_with(&["--dry-run", "--full"], &lenient_with_op(602)));
    assert_eq!(full["data"]["dry_run"], true);
    assert_eq!(full["data"]["data"]["kind"], "apply");
    assert_eq!(setup.bytes(), saved);
}

#[test]
fn dry_run_rejects_what_the_real_apply_would_reject_and_still_commits_nothing() {
    let setup = Setup::new(&seed());
    let before = setup.bytes();
    let dry =
        |request: Value| setup.apply_with(&["--dry-run"], &serde_json::to_vec(&request).unwrap());

    let stale = envelope(
        &dry(json!({"expected_item_revisions": {"1": 2}, "operations": []})),
        3,
    );
    assert_eq!(stale["error"]["code"], "revision_conflict");
    let missing = envelope(
        &dry(json!({"operations": [
            {"op": "topic.add", "name": "Would allocate"},
            {"op": "reply", "item": {"id": "999"}, "text": "No such item"}]})),
        2,
    );
    assert_eq!(missing["error"]["code"], "invalid_ref");
    let untouched = envelope(
        &dry(json!({"operations": [
            {"op": "reply", "item": {"id": "1"}, "text": "Needs the revision"}]})),
        3,
    );
    assert_eq!(untouched["error"]["code"], "revision_conflict");
    let wire = envelope(&dry(json!({"operations": [{"op": "item.nope"}]})), 2);
    assert!(wire["error"]["message"]
        .as_str()
        .unwrap()
        .contains("operations[0] (item.nope)"));
    let bad_label = envelope(
        &dry(json!({"operations": [
            {"op": "topic.add", "name": "T", "short": "x".repeat(41)}]})),
        2,
    );
    assert_eq!(bad_label["error"]["code"], "invalid_argument");
    assert_eq!(setup.bytes(), before);

    // Current-state guard: an archived topic refuses the write, in dry-run too.
    setup.change(|session| {
        session.topics.0.get_mut(&id(5)).unwrap().archived_at =
            Some(UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap())
    });
    let archived_bytes = setup.bytes();
    let refused = envelope(
        &dry(json!({"operations": [
            {"op": "item.add", "topic": {"id": id(5)}, "type": "finding", "question": "Late"}]})),
        3,
    );
    assert_eq!(
        refused["error"]["details"]["reason"], "topic_archived",
        "{refused}"
    );
    assert_eq!(setup.bytes(), archived_bytes);
}

#[test]
fn a_generated_op_id_follows_the_request_and_an_apply_flag_misuse_is_refused() {
    let setup = Setup::new(&seed());
    let first = envelope(
        &setup.apply_with(&["--dry-run"], br#"{"operations":[]}"#),
        0,
    );
    let second = envelope(
        &setup.apply_with(&["--dry-run"], br#"{"operations":[]}"#),
        0,
    );
    assert_eq!(first["data"]["op_id"], second["data"]["op_id"]);
    let other = envelope(
        &setup.apply_with(&["--dry-run"], br#"{"summary":"x","operations":[]}"#),
        0,
    );
    assert_ne!(first["data"]["op_id"], other["data"]["op_id"]);
    let before = setup.bytes();
    for args in [
        vec!["read", "--dry-run", "--json"],
        vec!["read", "--full", "--json"],
        vec!["read", "--view", "topics", "--topic", "1", "--json"],
        vec!["read", "--view", "messages", "--archived", "--json"],
        vec!["read", "--topic", "not-a-topic", "--json"],
        vec!["read", "--topic", "0", "--json"],
        vec!["read", "--topic", "99999999999999999999999", "--json"],
        vec!["item", "messages", "--item", "1", "--archived", "--json"],
    ] {
        let mut full: Vec<&str> = args.clone();
        let (binding, generation) = (id(3), id(4));
        full.extend([
            "--binding",
            binding.as_str(),
            "--generation",
            generation.as_str(),
        ]);
        let out = setup.call(&full, None);
        assert_eq!(
            envelope(&out, 2)["error"]["code"],
            "invalid_argument",
            "{args:?}"
        );
    }
    let conflicting = setup.agent(
        &["read"],
        &["--json-stdin", "--topic", "1", "--json"],
        Some(b"{}"),
    );
    envelope(&conflicting, 2);
    let apply_flag = setup.agent(
        &["apply"],
        &["--topic", "1", "--json-stdin", "--json"],
        Some(b"{}"),
    );
    envelope(&apply_flag, 2);
    assert_eq!(setup.bytes(), before);
}

#[test]
fn read_items_filters_by_topic_id_or_number_and_by_archived() {
    let setup = Setup::new(&seed());
    let applied = setup.lenient(&[]);
    let new_topic = applied["data"]["topics"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let everything = setup.page(&["--view", "items", "--limit", "100"]);
    assert_eq!(listed(&everything, "id"), ["1", "2", "3", "3.1", "4"]);

    let old = setup.page(&["--view", "items", "--topic", "1"]);
    assert_eq!(listed(&old, "id"), ["1", "2"]);
    let by_id = setup.page(&["--view", "items", "--topic", id(5).as_str()]);
    assert_eq!(listed(&by_id, "id"), ["1", "2"]);
    let new = setup.page(&["--view", "items", "--topic", "2"]);
    assert_eq!(listed(&new, "id"), ["3", "3.1", "4"]);
    assert_eq!(setup.page(&["--view", "items", "--topic", &new_topic]), new);
    // `items` is the default view.
    assert_eq!(setup.page(&["--topic", "2"]), new);
    let missing = setup.agent(&["read"], &["--topic", "3", "--json"], None);
    let error = envelope(&missing, 3);
    assert_eq!(error["error"]["code"], "not_found");
    assert!(error["error"]["message"]
        .as_str()
        .unwrap()
        .contains("topic number 3"));

    assert!(setup.page(&["--view", "items", "--archived"]).is_empty());
    assert_eq!(setup.page(&["--view", "topics", "--archived"]).len(), 0);
    setup.change(|session| {
        session.topics.0.get_mut(&id(5)).unwrap().archived_at =
            Some(UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap())
    });
    let archived = setup.page(&["--view", "items", "--archived"]);
    assert_eq!(listed(&archived, "id"), ["1", "2"]);
    let both = setup.page(&["--view", "items", "--archived", "--topic", "2"]);
    assert!(both.is_empty());
    let archived_topics = setup.page(&["--view", "topics", "--archived"]);
    assert_eq!(listed(&archived_topics, "id"), [id(5).as_str()]);
    assert_eq!(
        setup
            .page(&["--view", "items", "--topic", "1", "--archived"])
            .len(),
        2
    );
}

#[test]
fn the_help_example_uses_explicit_ack_targets_for_the_lenient_fixture() {
    let help = invoke(Command::new(env!("CARGO_BIN_EXE_ariadne")), None);
    let text = String::from_utf8(help.stdout).unwrap();
    let line = text
        .lines()
        .find(|line| line.starts_with("  printf '%s' '{\"operations\":[{\"op\":\"topic.add\""))
        .expect("help carries the lenient example");
    let body = line
        .strip_prefix("  printf '%s' '")
        .and_then(|rest| rest.split_once("' | ariadne apply"))
        .expect("printf form")
        .0;
    let mut expected: Value = serde_json::from_str(LENIENT).unwrap();
    expected["operations"][1]["status"] = json!("open");
    expected["operations"][1]["ack_to"] = json!("open");
    expected["operations"][1]["children"][0]["status"] = json!("open");
    expected["operations"][1]["children"][0]["ack_to"] = json!("open");
    assert_eq!(serde_json::from_str::<Value>(body).unwrap(), expected);
    for word in [
        "--dry-run",
        "--full",
        "--topic",
        "--archived",
        "children",
        "related",
        "display numbers",
    ] {
        assert!(text.contains(word), "{word}");
    }
}

#[test]
fn related_numbers_and_batch_refs_apply_and_read_as_item_numbers() {
    let setup = Setup::new(&seed());
    envelope(&setup.apply(&json!({"operations": [
        {"op":"topic.add", "name":"Another topic"},
        {"op":"item.add", "ref":"finding", "type":"finding", "question":"Evidence", "related":["1", {"id":"2"}]},
        {"op":"item.add", "type":"task", "question":"Act on evidence", "related":["finding"]}
    ]})), 0);
    let rows = setup.page(&["--view", "items", "--limit", "100"]);
    let item =
        |number: &str| rows.iter().find(|row| row["item"]["id"] == number).unwrap()["item"].clone();
    assert_eq!(item("3")["related"], json!(["1", "2"]));
    assert_eq!(item("4")["related"], json!(["3"]));
    assert!(
        item("1").get("related").is_none(),
        "omitted old fields stay omitted"
    );
    let before = setup.bytes();
    let mut params = read_params("items", 100);
    params["selection"]["filters"]["item_id"] = json!("3");
    let read = envelope(
        &setup.agent(
            &["read"],
            &["--json-stdin", "--json"],
            Some(&serde_json::to_vec(&params).unwrap()),
        ),
        0,
    );
    assert_eq!(
        read["data"]["data"]["page"]["items"][0]["item"]["related"],
        json!(["1", "2"])
    );
    assert_eq!(setup.bytes(), before, "reads never rewrite snapshots");

    let revision = item("3")["revision"].clone();
    envelope(
        &setup.apply(
            &json!({"expected_item_revisions":{"3":revision}, "operations":[
                {"op":"item.edit", "item":{"id":"3"}, "patch":{"related":["4"]}}
            ]}),
        ),
        0,
    );
    let saved = setup.store().read(&id(2)).unwrap();
    let revision = saved.items.0[&ItemRef::new("3").unwrap()].revision.value();
    envelope(
        &setup.apply(
            &json!({"expected_item_revisions":{"3":revision}, "operations":[
                {"op":"item.edit", "item":{"id":"3"}, "patch":{"note":"Kept links"}}
            ]}),
        ),
        0,
    );
    let saved = setup.store().read(&id(2)).unwrap();
    let third = &saved.items.0[&ItemRef::new("3").unwrap()];
    assert_eq!(
        third.related.as_ref().unwrap(),
        &[ItemRef::new("4").unwrap()]
    );
    envelope(
        &setup.apply(
            &json!({"expected_item_revisions":{"3":third.revision}, "operations":[
                {"op":"item.edit", "item":{"id":"3"}, "patch":{"related":[]}}
            ]}),
        ),
        0,
    );
    assert!(
        setup.store().read(&id(2)).unwrap().items.0[&ItemRef::new("3").unwrap()]
            .related
            .as_ref()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn nested_ack_proposals_keep_forward_related_links_repairs_and_retry_identity() {
    for status in ["decided", "done", "dropped", "open"] {
        let setup = Setup::new(&seed());
        let request = json!({"operations": [{
            "op": "item.add", "ref": "summary", "topic": {"id": id(5)},
            "type": "finding", "question": "Completed review", "status": status,
            "ack_to": "done", "outcome": "Exact review result.", "why": "Verified.",
            "related": ["child", "2"], "children": [{
                "ref": "child", "type": "finding", "question": "Supporting evidence",
                "status": "done", "related": ["summary"], "children": [{
                    "type": "finding", "question": "Nested evidence", "status": "done",
                    "related": ["summary", "child"]
                }]
            }]
        }]});
        // Explicit targets must agree with repaired terminal creation.
        let mut request = request;
        request["operations"][0]["ack_to"] = json!(if status == "open" { "done" } else { status });
        let applied = envelope(&setup.apply(&request), 0);
        assert_eq!(
            applied["data"]["repairs"].as_array().unwrap().len(),
            if status == "open" { 2 } else { 3 }
        );
        let saved = setup.store().read(&id(2)).unwrap();
        let summary = &saved.items.0[&ItemRef::new("3").unwrap()];
        assert_eq!(summary.status, ItemStatus::Open);
        assert_eq!(
            serde_json::to_value(summary.ack_to).unwrap(),
            request["operations"][0]["ack_to"]
        );
        assert_eq!(summary.outcome.as_deref(), Some("Exact review result."));
        assert_eq!(
            summary.related,
            Some(vec![
                ItemRef::new("3.1").unwrap(),
                ItemRef::new("2").unwrap()
            ])
        );
        for (number, targets) in [("3.1", vec!["3"]), ("3.1.1", vec!["3", "3.1"])] {
            let item = &saved.items.0[&ItemRef::new(number).unwrap()];
            assert_eq!(item.status, ItemStatus::Open);
            assert_eq!(item.ack_to, Some(AckTarget::Done));
            assert_eq!(
                item.related,
                Some(
                    targets
                        .into_iter()
                        .map(|id| ItemRef::new(id).unwrap())
                        .collect()
                )
            );
        }
        let before_retry = setup.bytes();
        assert_eq!(envelope(&setup.apply(&request), 0), as_replay(&applied));
        assert_eq!(setup.bytes(), before_retry);
        let rows = setup.page(&["--view", "items", "--limit", "100"]);
        let row = rows.iter().find(|row| row["item"]["id"] == "3").unwrap();
        assert_eq!(row["item"]["related"], json!(["3.1", "2"]));
        assert_eq!(row["item"]["ack_to"], request["operations"][0]["ack_to"]);
        let owner_request = json!({"session": {"project_id": id(1), "session_id": id(2)},
            "command": {"command": "ack", "api_version": 1, "op_id": id(999),
                "params": {"item_id": "3", "expected_revision": summary.revision}}});
        envelope(
            &setup.call(
                &["item", "ack", "--json-stdin", "--json"],
                Some(&serde_json::to_vec(&owner_request).unwrap()),
            ),
            0,
        );
        let acknowledged = setup.store().read(&id(2)).unwrap();
        assert_eq!(acknowledged.items.0[&summary.id].related, summary.related);
        assert_eq!(
            acknowledged.items.0[&ItemRef::new("3.1").unwrap()],
            saved.items.0[&ItemRef::new("3.1").unwrap()]
        );
    }
}

#[test]
fn related_reads_filter_removed_targets_and_resends_report_pruning_even_on_replay() {
    let mut session = seed();
    let source = ItemRef::new("1").unwrap();
    let related = vec![ItemRef::new("2").unwrap(), ItemRef::new("99").unwrap()];
    session.items.0.get_mut(&source).unwrap().related = Some(related);
    let setup = Setup::new(&session);
    let before = setup.bytes();
    let rows = setup.page(&["--view", "items", "--limit", "100"]);
    let projected = rows.iter().find(|row| row["item"]["id"] == "1").unwrap();
    assert_eq!(projected["item"]["related"], json!(["2"]));
    assert_eq!(
        setup.bytes(),
        before,
        "reads preserve the saved declaration"
    );

    let request = json!({"expected_item_revisions":{"1":session.items.0[&source].revision}, "operations":[
        {"op":"item.edit", "item":{"id":"1"}, "patch":{"related":["99", "2"]}}
    ]});
    let compact = envelope(&setup.apply(&request), 0);
    assert_eq!(compact["data"]["pruned_related"], json!({"1":["99"]}));
    assert_eq!(
        setup.store().read(&id(2)).unwrap().items.0[&source].related,
        Some(vec![ItemRef::new("2").unwrap()])
    );
    let written = setup.bytes();
    let replay = envelope(&setup.apply(&request), 0);
    assert_eq!(
        replay["data"]["pruned_related"],
        compact["data"]["pruned_related"]
    );
    assert_eq!(
        setup.bytes(),
        written,
        "resends replay without another write"
    );
    let full = envelope(
        &setup.agent(
            &["apply"],
            &["--json-stdin", "--json", "--full"],
            Some(&serde_json::to_vec(&request).unwrap()),
        ),
        0,
    );
    assert_eq!(full["data"]["data"]["pruned_related"], json!({"1":["99"]}));
    assert_eq!(setup.bytes(), written);
}

#[test]
fn related_forward_refs_include_nested_children_and_later_explicit_edits_win() {
    let setup = Setup::new(&seed());
    let request = json!({"operations":[
        {"op":"item.add", "ref":"parent", "topic":{"id":id(5)}, "type":"task", "question":"Parent", "related":["child"], "children":[
            {"ref":"child", "type":"finding", "question":"Child", "related":["parent"]}
        ]},
        {"op":"item.add", "ref":"pending", "topic":{"id":id(5)}, "type":"task", "question":"Pending", "related":[{"ref":"later"}]},
        {"op":"item.edit", "item":{"ref":"pending"}, "patch":{"related":["1"]}},
        {"op":"item.add", "ref":"later", "topic":{"id":id(5)}, "type":"finding", "question":"Later"},
        {"op":"item.edit", "item":{"ref":"parent"}, "patch":{"related":["2", "3.1"]}}
    ]});
    let before = setup.bytes();
    let preview = envelope(
        &setup.apply_with(&["--dry-run"], &serde_json::to_vec(&request).unwrap()),
        0,
    );
    assert_eq!(preview["data"]["dry_run"], true);
    assert_eq!(setup.bytes(), before);
    let receipt = envelope(&setup.apply(&request), 0);
    assert_eq!(preview["data"]["op_id"], receipt["data"]["op_id"]);
    assert_eq!(preview["data"]["items"], receipt["data"]["items"]);
    let saved = setup.store().read(&id(2)).unwrap();
    let related = |number: &str| {
        saved.items.0[&ItemRef::new(number).unwrap()]
            .related
            .clone()
            .unwrap()
    };
    assert_eq!(
        related("3"),
        [ItemRef::new("2").unwrap(), ItemRef::new("3.1").unwrap()]
    );
    assert_eq!(related("3.1"), [ItemRef::new("3").unwrap()]);
    assert_eq!(related("4"), [ItemRef::new("1").unwrap()]);
    let before = setup.bytes();
    let replay = envelope(&setup.apply(&request), 0);
    assert_eq!(replay["data"]["op_id"], receipt["data"]["op_id"]);
    assert_eq!(replay["data"]["replayed"], true);
    assert_eq!(setup.bytes(), before);

    let clean = Setup::new(&seed());
    envelope(&clean.apply(&json!({"operations":[
        {"op":"item.add", "ref":"parent", "topic":{"id":id(5)}, "type":"task", "question":"Parent", "related":[{"ref":"child"}], "children":[
            {"ref":"child", "type":"finding", "question":"Child"}
        ]}
    ]})), 0);
    assert_eq!(clean.page(&[])[2]["item"]["related"], json!(["3.1"]));
}

#[test]
fn related_invalid_self_duplicate_and_missing_targets_fail_atomically() {
    let setup = Setup::new(&seed());
    for (targets, message, target) in [
        (json!(["1"]), "itself", "1"),
        (json!(["2", {"id":"2"}]), "appears more than once", "2"),
        (json!(["999"]), "does not exist in this session", "999"),
        (
            json!([{"ref":"missing"}]),
            "no item in this batch has ref 'missing'",
            "missing",
        ),
        (
            json!(["bogus"]),
            "no item in this batch has ref 'bogus'",
            "bogus",
        ),
    ] {
        let before = setup.bytes();
        let error = envelope(
            &setup.apply(&json!({"expected_item_revisions":{"1":1}, "operations":[
                {"op":"topic.add", "name":"Must roll back"},
                {"op":"item.edit", "item":{"id":"1"}, "patch":{"related":targets}}
            ]})),
            2,
        );
        assert_eq!(error["error"]["code"], "invalid_ref", "{error}");
        assert!(
            error["error"]["message"]
                .as_str()
                .unwrap()
                .contains(message),
            "{error}"
        );
        let message = error["error"]["message"].as_str().unwrap();
        assert!(message.contains("item.edit"), "{error}");
        assert!(message.contains(target), "{error}");
        assert_eq!(setup.bytes(), before);
    }
    for targets in [
        json!([3]),
        json!({"id":"2"}),
        json!([{"id":"2", "ref":"two"}]),
    ] {
        let before = setup.bytes();
        let error = envelope(
            &setup.apply(&json!({"expected_item_revisions":{"1":1}, "operations":[
                {"op":"item.edit", "item":{"id":"1"}, "patch":{"related":targets}}
            ]})),
            2,
        );
        assert!(
            error["error"]["message"]
                .as_str()
                .unwrap()
                .contains("operations[0] (item.edit)"),
            "{error}"
        );
        assert_eq!(setup.bytes(), before);
    }
    // A local ref and its allocated number cannot disguise a duplicate or self link.
    for targets in [json!([{"ref":"first"}, "3"]), json!([{"ref":"second"}])] {
        let before = setup.bytes();
        let error = envelope(&setup.apply(&json!({"operations":[
            {"op":"item.add", "ref":"first", "topic":{"id":id(5)}, "type":"task", "question":"First"},
            {"op":"item.add", "ref":"second", "topic":{"id":id(5)}, "type":"task", "question":"Second", "related":targets}
        ]})), 2);
        assert_eq!(error["error"]["code"], "invalid_ref", "{error}");
        assert_eq!(setup.bytes(), before);
    }
    let before = setup.bytes();
    let malformed = envelope(&setup.apply(&json!({"operations":[
        {"op":"item.add", "ref":"first", "topic":{"id":id(5)}, "type":"task", "question":"First", "related":[{"ref":"later"}, 3]},
        {"op":"item.edit", "item":{"ref":"first"}, "patch":{"related":[]}},
        {"op":"item.add", "ref":"later", "topic":{"id":id(5)}, "type":"task", "question":"Later"}
    ]})), 2);
    assert!(malformed["error"]["message"]
        .as_str()
        .unwrap()
        .contains("operations[0] (item.add)"));
    assert_eq!(setup.bytes(), before);
}

#[test]
fn related_lists_are_limited_before_nested_and_superseded_forward_expansion() {
    let setup = Setup::new(&seed());
    let targets: Vec<_> = (0..33).map(|index| format!("target{index}")).collect();
    for (operations, path) in [
        (
            json!([
                {"op":"item.add", "topic":{"id":id(5)}, "type":"task", "question":"Linked task", "related":targets}
            ]),
            "operations[0].related",
        ),
        (
            json!([
                {"op":"item.edit", "item":{"id":"1"}, "patch":{"related":targets}}
            ]),
            "operations[0].patch.related",
        ),
        (
            json!([
                {"op":"item.add", "topic":{"id":id(5)}, "type":"task", "question":"Parent", "children":[
                    {"type":"task", "question":"Child", "related":targets}
                ]}
            ]),
            "operations[0].children[0].related",
        ),
        (
            json!([
                {"op":"item.add", "ref":"first", "topic":{"id":id(5)}, "type":"task", "question":"First", "related":targets},
                {"op":"item.edit", "item":{"ref":"first"}, "patch":{"related":[]}},
                {"op":"item.add", "ref":"target32", "topic":{"id":id(5)}, "type":"task", "question":"Later"}
            ]),
            "operations[0].related",
        ),
    ] {
        let before = setup.bytes();
        let error = envelope(&setup.apply(&json!({"operations":operations})), 2);
        assert_eq!(error["error"]["code"], "invalid_argument", "{error}");
        let message = error["error"]["message"].as_str().unwrap();
        assert!(message.contains(path), "{error}");
        if path.contains(".patch.") {
            assert!(message.contains("item.edit, item 1"), "{error}");
        } else {
            assert!(message.contains("item.add, ref '"), "{error}");
        }
        assert!(message.contains("at most 32 related items"), "{error}");
        assert_eq!(setup.bytes(), before, "refusal never changes saved items");
    }
}

#[test]
fn existing_summary_completion_waits_for_ack_and_replays_after_the_owner_acks() {
    for target in ["decided", "done", "dropped"] {
        let mut source = seed();
        let summary = source.items.0.get_mut(&ItemRef::new("1").unwrap()).unwrap();
        summary.status = ItemStatus::InProgress;
        summary.waiting_since = None;
        summary.ask = None;
        summary.ack_to = Some(AckTarget::Done);
        let setup = Setup::new(&source);
        let completion = json!({"expected_item_revisions": {"1": 1}, "operations": [{
            "op": "item.status", "item": {"id": "1"}, "status": target,
            "outcome": "Exact finished summary\nwith all text.", "why": "Verified locally."
        }]});
        let applied = envelope(&setup.apply(&completion), 0);
        assert_eq!(applied["data"]["repairs"].as_array().unwrap().len(), 1);
        let saved = setup.store().read(&id(2)).unwrap();
        let summary = &saved.items.0[&ItemRef::new("1").unwrap()];
        assert_eq!(summary.status, ItemStatus::Open);
        assert_eq!(serde_json::to_value(summary.ack_to).unwrap(), target);
        assert_eq!(
            summary.outcome.as_deref(),
            Some("Exact finished summary\nwith all text.")
        );
        assert_eq!(summary.why.as_deref(), Some("Verified locally."));
        assert_eq!(saved.inputs, source.inputs);
        let owner_request = json!({"session": {"project_id": id(1), "session_id": id(2)},
            "command": {"command": "ack", "api_version": 1, "op_id": id(999),
                "params": {"item_id": "1", "expected_revision": summary.revision}}});
        let ack = setup.call(
            &["item", "ack", "--json-stdin", "--json"],
            Some(&serde_json::to_vec(&owner_request).unwrap()),
        );
        envelope(&ack, 0);
        let before_retry = setup.bytes();
        let mut expected = as_replay(&applied);
        // Replay runs no mutation or repair, even after the target is cleared.
        expected["data"].as_object_mut().unwrap().remove("repairs");
        assert_eq!(envelope(&setup.apply(&completion), 0), expected);
        assert_eq!(setup.bytes(), before_retry);
    }
}

#[test]
fn thirty_two_related_items_are_accepted_on_add_and_edit() {
    let setup = Setup::new(&seed());
    let mut operations: Vec<_> = (0..32)
        .map(|index| {
            json!({
                "op":"item.add", "ref":format!("target{index}"), "topic":{"id":id(5)},
                "type":"finding", "question":format!("Evidence {index}")
            })
        })
        .collect();
    let targets: Vec<_> = (0..32).map(|index| format!("target{index}")).collect();
    operations.push(json!({"op":"item.add", "topic":{"id":id(5)}, "type":"task",
        "question":"Linked task", "related":targets}));
    envelope(&setup.apply(&json!({"operations":operations})), 0);
    let session = setup.store().read(&id(2)).unwrap();
    let linked = &session.items.0[&ItemRef::new("35").unwrap()];
    assert_eq!(linked.related.as_ref().unwrap().len(), 32);
    let numbers: Vec<_> = (3..35).map(|number| number.to_string()).collect();
    envelope(
        &setup.apply(&json!({"expected_item_revisions":{"1":1}, "operations":[
            {"op":"item.edit", "item":{"id":"1"}, "patch":{"related":numbers}}
        ]})),
        0,
    );
    assert_eq!(
        setup.store().read(&id(2)).unwrap().items.0[&ItemRef::new("1").unwrap()]
            .related
            .as_ref()
            .unwrap()
            .len(),
        32
    );
}

#[test]
fn related_targets_in_another_registered_session_are_not_resolved() {
    let setup = Setup::new(&seed());
    let mut other: Session = serde_json::from_str(
        &serde_json::to_string(&seed())
            .unwrap()
            .replace(id(3).as_str(), id(203).as_str()),
    )
    .unwrap();
    other.id = id(20);
    let mut third = other.items.0[&ItemRef::new("2").unwrap()].clone();
    third.id = ItemRef::new("3").unwrap();
    third.ordinal = PositiveSafeInteger::new(3).unwrap();
    other.counters.next_root = PositiveSafeInteger::new(4).unwrap();
    other.items.0.insert(third.id.clone(), third);
    other.messages[0]
        .items_touched
        .push(ItemRef::new("3").unwrap());
    setup.store().create(&other).unwrap();
    let before = setup.bytes();
    let error = envelope(
        &setup.apply(&json!({"expected_item_revisions":{"1":1}, "operations":[
            {"op":"item.edit", "item":{"id":"1"}, "patch":{"related":["3"]}}
        ]})),
        2,
    );
    assert_eq!(error["error"]["code"], "invalid_ref", "{error}");
    assert!(error["error"]["message"]
        .as_str()
        .unwrap()
        .contains("does not exist in this session"));
    assert_eq!(setup.bytes(), before);
    assert_eq!(setup.store().read(&id(20)).unwrap(), other);
}

#[test]
fn lenient_completed_asks_get_a_real_question_round_and_owner_answer_route() {
    for status in ["done", "open", "in_progress"] {
        let setup = Setup::new(&seed());
        let request = json!({"operations": [{"op": "item.add", "topic": {"id": id(5)},
            "type": "explanation", "question": "Notes cleanup result", "status": status,
            "ack_to": "done", "ask": "May I remove the obsolete draft?", "owner": {"kind": "agent"},
            "outcome": "Exact proposed result.", "why": "Exact evidence.",
            "options": [{"label": "Go ahead", "consequence": "Removes the draft."}]}]});
        envelope(&setup.apply(&request), 0);
        let saved = setup.store().read(&id(2)).unwrap();
        let ask = &saved.items.0[&ItemRef::new("3").unwrap()];
        assert_eq!(ask.status, ItemStatus::WaitingOnMe);
        assert_eq!(ask.owner, ItemOwner::Me {});
        assert_eq!(ask.ack_to, Some(AckTarget::Done));
        assert_eq!(ask.outcome.as_deref(), Some("Exact proposed result."));
        assert_eq!(ask.why.as_deref(), Some("Exact evidence."));
        let round = &saved.rounds.0[ask.current_round_id.as_ref().unwrap()];
        assert_eq!(round.ask_snapshot, ask.ask);
        assert!(ariadne_core::queries::waiting_unanswered(&saved, ask));
        let owner = OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
            RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        ));
        let answer = OwnerCommand::InputSubmit {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(990),
            params: InputSubmitParams {
                binding_id: id(3),
                target: InputTarget {
                    topic_id: id(5),
                    item_id: Some(ask.id.clone()),
                },
                kind: InputKind::Answer,
                text: "Keep the draft for now.".into(),
                selected_option_id: None,
                expected_question_revision: Some(ask.question_revision),
                supersedes_answer_id: None,
            },
        };
        let mut next = 1000;
        InputService::new(&setup.registry)
            .execute(
                &owner,
                &answer,
                || {
                    next += 1;
                    id(next)
                },
                UtcMillis::new("2026-10-09T12:00:00.000Z").unwrap(),
            )
            .unwrap();
        let answered = setup.store().read(&id(2)).unwrap();
        assert!(answered
            .answers
            .iter()
            .any(|answer| answer.item_id == ask.id && answer.text == "Keep the draft for now."));
    }
}
