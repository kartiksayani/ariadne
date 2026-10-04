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
    root: TempDir,
    registry: Registry,
}
impl Setup {
    fn new(session: &Session) -> Self {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        Store::open_registered(root.path(), id(1))
            .unwrap()
            .create(session)
            .unwrap();
        Self {
            home,
            root,
            registry,
        }
    }
    fn data(&self) -> std::path::PathBuf {
        self.home.path().join(".ariadne")
    }
    fn store(&self) -> Store {
        Store::open_registered(self.root.path(), id(1)).unwrap()
    }
    fn path(&self) -> std::path::PathBuf {
        self.root
            .path()
            .join(format!(".ariadne/sessions/{}.json", id(2).as_str()))
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
    assert_eq!(envelope(&setup.apply(&command), 0), first);
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
    assert_eq!(envelope(&setup.apply(&command), 0), saved);
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
    assert_eq!(envelope(&setup.apply(&command), 0), saved);
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
    fs::remove_file(unavailable.path().join(".ariadne/project.json")).unwrap();
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
    fs::remove_file(setup.root.path().join(".ariadne/project.json")).unwrap();
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
