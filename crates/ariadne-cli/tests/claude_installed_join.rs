//! Installed Mod -> executable CLI -> actual native activation/control -> Core/Store.
//! Only the Claude SDK and Claude version response are scripted; no paid host launch.
use ariadne_adapter_claude::ClaudeOptions;
use ariadne_core::{
    native::{AgentResolver, NativeCoreService},
    *,
};
use ariadne_domain::models::*;
use ariadne_runtime::{
    activation::{registered_announcement_resolver, NativeActivation},
    control::{ControlRoutes, ControlServer, CONTROL_TIMEOUT},
    discovery::Discovery,
    leases::DesktopOwner,
    providers::{ProjectRootResolver, ProviderFactory, ProviderInstructions},
    supervisor::NativeFacts,
};
use ariadne_store::{registry::Registry, session::Store};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-05T12:00:00.000Z").unwrap()
}
fn private(path: &std::path::Path) {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
struct Sdk {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Sdk {
    fn command(&mut self, request: Value) -> Value {
        writeln!(self.input, "{request}").unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        assert_ne!(
            self.output.read_line(&mut line).unwrap(),
            0,
            "SDK fixture exited"
        );
        let result: Value = serde_json::from_str(&line).unwrap();
        assert!(result.get("error").is_none(), "{result}");
        result
    }
}
impl Drop for Sdk {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
struct Fixture {
    _home: tempfile::TempDir,
    _install: tempfile::TempDir,
    root: tempfile::TempDir,
    data: PathBuf,
    helper: PathBuf,
    core: Arc<NativeCoreService>,
    rt: tokio::runtime::Runtime,
    activation: Option<Arc<NativeActivation>>,
    owner: Option<Arc<DesktopOwner>>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    server: Option<tokio::task::JoinHandle<Result<(), CoreError>>>,
    sdk: Sdk,
}
impl Fixture {
    fn new() -> Self {
        Self::with_announcement_barrier(false)
    }
    fn with_announcement_barrier(hold: bool) -> Self {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let install = tempfile::tempdir_in("/tmp").unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        let data = home.path().join(".ariadne");
        let mut session: Session =
            serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json"))
                .unwrap();
        let old = session.bindings.0.get_mut(&id(3)).unwrap();
        old.connection_state = ConnectionState::Disconnected;
        old.dispatch_state = DispatchState::Disconnected;
        Store::open_registered(&registry.project_dir(&id(1)), id(1))
            .unwrap()
            .create(&session)
            .unwrap();
        let version = install.path().join("0.1.0");
        fs::create_dir(&version).unwrap();
        private(&version);
        fs::create_dir(version.join("bin")).unwrap();
        private(&version.join("bin"));
        let helper = version.join("bin/ariadne");
        fs::copy(env!("CARGO_BIN_EXE_ariadne"), &helper).unwrap();
        private(&helper);
        ariadne_cli::setup::execute_in_installation(
            &["--agent", "claude", "--json"],
            false,
            &data,
            &version,
            &version.join("integrations"),
        )
        .unwrap();
        let plugin = version.join("integrations/claude-mod/plugin");
        let ids = Arc::new(AtomicU64::new(1000));
        let allocated = ids.clone();
        let core = Arc::new(NativeCoreService::new(
            AgentResolver::open_data_directory(&data).unwrap(),
            move || id(allocated.fetch_add(1, Ordering::SeqCst)),
            at,
            |_| panic!("NativeActivation owns actual qualification"),
        ));
        let root_core = core.clone();
        let roots: Arc<ProjectRootResolver> =
            Arc::new(move |project| Ok(root_core.registry().resolve_project(project)?.root));
        let discovery = Discovery::new(
            Arc::new(at),
            Some(registered_announcement_resolver(
                core.clone(),
                roots.clone(),
            )),
        );
        let factory = ProviderFactory::new(
            roots,
            discovery.clone(),
            Some(ClaudeOptions {
                installed_plugin: plugin.clone(),
                helper: helper.clone(),
                project_root: root.path().canonicalize().unwrap(),
                app_version: "0.1.0".into(),
            }),
            None,
            NativeFacts {
                next_id: Arc::new(move || id(ids.fetch_add(1, Ordering::SeqCst))),
                now: Arc::new(at),
            },
            ProviderInstructions {
                claude:
                    "Use the installed helper for structured Ariadne context and explicit results."
                        .into(),
                codex: "Unused".into(),
                cli_invocation: "ariadne".into(),
            },
        );
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(3)
            .enable_all()
            .build()
            .unwrap();
        let owner = Arc::new(DesktopOwner::acquire(&data).unwrap());
        let routes = ControlRoutes::new();
        let activation = NativeActivation::new(
            core.clone(),
            factory,
            owner.clone(),
            routes.clone(),
            rt.handle().clone(),
            Arc::new(|_| {}),
        );
        let callback = activation.announcement_callback();
        let barrier = root.path().to_owned();
        let callback: Arc<ariadne_runtime::control::NativeAnnouncement> =
            Arc::new(move |scope, deadline| {
                if hold {
                    fs::write(barrier.join("announce-entered"), "").unwrap();
                    // Hold the real callback after Discovery admitted the bound SDK
                    // announcement; the actual native activation runs on release.
                    while !barrier.join("announce-release").exists() {
                        assert!(Instant::now() < deadline, "announcement barrier timed out");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
                callback(scope, deadline)
            });
        let server = ControlServer::bind_shared(owner.clone(), core.clone(), vec![])
            .unwrap()
            .with_routes(routes)
            .with_discovery(discovery)
            .with_native_connect(activation.connect_callback())
            .with_native_announcement(callback);
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = rt.spawn(server.serve(stopped));
        let mut child = Command::new("node")
            .arg("--experimental-default-type=module")
            .arg(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../tests/integrations/claude/installed-join.js"),
            )
            .arg(&plugin)
            .arg(root.path().canonicalize().unwrap())
            .env("ARIADNE_HOME", &data)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let fixture = Self {
            _home: home,
            _install: install,
            root,
            data,
            helper,
            core,
            rt,
            activation: Some(activation),
            owner: Some(owner),
            stop: Some(stop),
            server: Some(server),
            sdk: Sdk {
                child,
                input,
                output,
            },
        };
        let historical = fixture.submit(
            &id(3),
            "Historical owner context: retain the release decision.",
            400,
        );
        fixture
            .core
            .execute_owner(
                OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
                    RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
                )),
                OwnerCommand::InputCancel {
                    api_version: SchemaVersion::new(1).unwrap(),
                    op_id: id(401),
                    params: InputCancelParams {
                        input_id: historical,
                        expected_revision: fixture.saved().revision,
                        purpose: None,
                    },
                },
            )
            .unwrap();
        fixture
    }
    fn saved(&self) -> Session {
        Store::open_registered(&self.core.registry().project_dir(&id(1)), id(1))
            .unwrap()
            .read(&id(2))
            .unwrap()
    }
    fn connect(&mut self) -> (UuidV4, UuidV4) {
        let started = self.sdk.command(json!({"action":"start"}));
        assert_eq!(started["commands"].as_array().unwrap().len(), 3);
        assert!(started["prompts"].as_array().unwrap().is_empty());
        // Readiness includes native qualification, route publication and an
        // unchanged-operation retry. Its former 3s deadline was shorter than a
        // single declared control request; bound this join by three requests.
        let until = Instant::now() + CONTROL_TIMEOUT * 3;
        let connected = loop {
            let connected = self
                .sdk
                .command(json!({"action":"connect","session":id(2)}));
            let text = connected["value"]["text"].as_str().unwrap();
            if text.starts_with("Ariadne connected: ") {
                assert!(text.contains("This resumes an earlier session"));
                break connected;
            }
            assert!(Instant::now() < until, "{connected}");
            assert!(connected["prompts"].as_array().unwrap().is_empty());
            std::thread::sleep(Duration::from_millis(10));
        };
        // The Mod prints only a short summary; the saved IDs come from the
        // helper's connect receipt, which the summary must repeat.
        let connect_receipts: Vec<Value> = connected["replies"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["argv"][1] == "binding" && r["argv"][2] == "connect")
            .map(|r| {
                serde_json::from_str::<Value>(r["result"]["stdout"].as_str().unwrap()).unwrap()
                    ["data"]
                    .clone()
            })
            .collect();
        assert!(connect_receipts
            .iter()
            .all(|receipt| receipt["operation_id"] == connect_receipts[0]["operation_id"]));
        let receipt = &connect_receipts[0];
        assert_eq!(receipt["session_id"], json!(id(2)));
        let binding: UuidV4 =
            serde_json::from_value(receipt["data"]["binding_id"].clone()).unwrap();
        let generation: UuidV4 =
            serde_json::from_value(receipt["data"]["generation"].clone()).unwrap();
        let text = connected["value"]["text"].as_str().unwrap();
        assert!(text.contains("\nCommand: /"));
        assert!(text.contains(&format!(
            "binding {}, generation {}",
            binding.as_str(),
            generation.as_str()
        )));
        assert!(!text.contains("setup_instruction") && text.len() < 1024);
        let initial = self.saved();
        assert!(initial
            .messages
            .iter()
            .any(|m| m.body == "Historical owner context: retain the release decision."));
        assert_eq!(
            initial.bindings.0[&binding]
                .issued_through_message_number
                .value(),
            2
        );
        assert!(
            initial.bindings.0[&binding]
                .capabilities
                .domain_cli
                .supported
        );
        assert!(
            !initial.bindings.0[&binding]
                .capabilities
                .domain_mcp
                .supported
        );
        assert!(connected["prompts"].as_array().unwrap().is_empty());
        self.sdk.command(json!({"action":"heartbeat"}));
        let until = Instant::now() + Duration::from_secs(3);
        while self.saved().bindings.0[&binding].connection_state != ConnectionState::Connected {
            assert!(
                Instant::now() < until,
                "native bound activation did not complete"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        (binding, generation)
    }
    fn submit(&self, binding: &UuidV4, text: &str, operation: u64) -> UuidV4 {
        self.core
            .execute_owner(
                OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
                    RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
                )),
                OwnerCommand::InputSubmit {
                    api_version: SchemaVersion::new(1).unwrap(),
                    op_id: id(operation),
                    params: InputSubmitParams {
                        binding_id: binding.clone(),
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
                },
            )
            .unwrap();
        self.saved()
            .inputs
            .0
            .values()
            .find(|i| i.payload.text == text)
            .unwrap()
            .id
            .clone()
    }
    fn call(&mut self, args: Vec<String>, stdin: Option<Value>) -> Value {
        let mut argv = vec![self.helper.to_str().unwrap().into()];
        argv.extend(args);
        let reply = self
            .sdk
            .command(json!({"action":"call","argv":argv,"stdin":stdin.map(|v| v.to_string())}));
        assert_eq!(reply["value"]["exitCode"], 0, "{reply}");
        serde_json::from_str(reply["value"]["stdout"].as_str().unwrap()).unwrap()
    }
    fn read_messages(&mut self, binding: &UuidV4, generation: &UuidV4) -> Value {
        self.call(
            vec![
                "read".into(),
                "--binding".into(),
                binding.as_str().into(),
                "--generation".into(),
                generation.as_str().into(),
                "--view".into(),
                "messages".into(),
                "--json".into(),
            ],
            None,
        )
    }
    fn close_desktop(&mut self) {
        if let Some(activation) = self.activation.take() {
            self.rt.block_on(activation.shutdown()).unwrap();
            self.stop.take().unwrap().send(()).unwrap();
            self.rt
                .block_on(self.server.take().unwrap())
                .unwrap()
                .unwrap();
            drop(activation);
            self.owner.take();
            let until = Instant::now() + Duration::from_secs(3);
            loop {
                match DesktopOwner::acquire(&self.data) {
                    Ok(owner) => {
                        drop(owner);
                        break;
                    }
                    Err(error) => {
                        assert!(
                            Instant::now() < until,
                            "desktop owner retained after shutdown: {error:?}"
                        );
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
            }
        }
    }
    fn result(&mut self, binding: &UuidV4, generation: &UuidV4, input: &UuidV4) {
        let saved = self.saved();
        let input = &saved.inputs.0[input];
        let attempt = &input.attempts[0];
        let request = json!({"op_id":id(800),"source_input_id":input.id,"attempt_id":attempt.id,
            "expected_item_revisions":{"1":saved.items.0[&ItemRef::new("1").unwrap()].revision},"expected_topic_revisions":{},
            "summary":"Complete structured reply", "operations":[{"op":"reply","ref":"reply","item":{"id":"1"},"text":"Exact complete installed reply","round_id":null}],
            "input_result":{"outcome":"answered","explanation":"Handled the exact dispatched owner input","reply_refs":[{"ref":"reply"}],"followup_item_refs":[],"handled_through_message_number":saved.messages.iter().find(|m| m.id == input.message_id).unwrap().number}});
        self.call(
            vec![
                "apply".into(),
                "--binding".into(),
                binding.as_str().into(),
                "--generation".into(),
                generation.as_str().into(),
                "--json-stdin".into(),
                "--json".into(),
            ],
            Some(request),
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.close_desktop();
    }
}

#[test]
fn installed_sdk_keeps_helper_exit_evidence_when_child_closes_stdin() {
    let mut fixture = Fixture::new();
    // Exceed the pipe capacity while the child deliberately reads no input.
    // Closing fd 0 forces EPIPE instead of depending on helper exit timing.
    let response = fixture.sdk.command(json!({
        "action": "call",
        "argv": ["node", "-e", "require('node:fs').closeSync(0); process.stdout.write('closed stdin\\n'); process.stderr.write('intentional helper failure\\n'); process.exitCode = 23;"],
        "stdin": "x".repeat(2 * 1024 * 1024)
    }));
    assert_eq!(response["value"]["exitCode"], 23);
    assert_eq!(response["value"]["stdout"], "closed stdin\n");
    assert_eq!(response["value"]["stderr"], "intentional helper failure\n");
    assert_eq!(response["replies"].as_array().unwrap().len(), 1);
    assert_eq!(response["replies"][0]["result"], response["value"]);
    let alive = fixture.sdk.command(json!({ "action": "state" }));
    assert_eq!(alive["replies"], response["replies"]);
}

#[test]
fn installed_existing_session_claim_callbacks_and_result_join_in_both_orders() {
    for result_first in [false, true] {
        let mut fixture = Fixture::new();
        let (binding, generation) = fixture.connect();
        let visible = fixture.read_messages(&binding, &generation).to_string();
        assert!(visible.contains("Historical owner context"));
        let first = fixture.submit(&binding, "First explicit installed owner input", 500);
        let second = fixture.submit(&binding, "Later unissued secret owner input", 501);
        let before_claim = fixture.read_messages(&binding, &generation).to_string();
        assert!(!before_claim.contains("First explicit installed owner input"));
        assert!(!before_claim.contains("Later unissued secret owner input"));
        assert_eq!(
            fixture.saved().bindings.0[&binding]
                .issued_through_message_number
                .value(),
            2
        );
        let claimed = fixture.sdk.command(json!({"action":"poll"}));
        assert_eq!(claimed["prompts"].as_array().unwrap().len(), 1, "{claimed}");
        let payload = claimed["prompts"][0]["text"].as_str().unwrap().to_owned();
        let prepared = fixture.saved().inputs.0[&first].attempts[0].clone();
        assert_eq!(payload, prepared.formatted_payload);
        assert_eq!(prepared.binding_generation, generation);
        assert!(fixture.saved().inputs.0[&second].attempts.is_empty());
        let issued = fixture.read_messages(&binding, &generation).to_string();
        assert!(issued.contains("First explicit installed owner input"));
        assert!(!issued.contains("Later unissued secret owner input"));
        // Claude Code frames a plugin-submitted prompt; correlation must survive the frame.
        let framed = format!("The ariadne plugin sent a message:\n{payload}\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.");
        fixture.sdk.command(json!({"action":"event","name":"turn.start","event":{"turnId":"original-installed-turn","text":framed}}));
        fixture.sdk.command(json!({"action":"settle","index":0}));
        let finish = json!({"action":"event","name":"turn.complete","event":{"turnId":"original-installed-turn","reason":"answer","isAborted":false,"answer":"Visible diagnostics only"}});
        if result_first {
            fixture.result(&binding, &generation, &first);
        } else {
            fixture.sdk.command(finish.clone());
        }
        let fenced = fixture.sdk.command(json!({"action":"poll"}));
        assert_eq!(
            fenced["prompts"].as_array().unwrap().len(),
            1,
            "One join half cannot dispatch the next input"
        );
        assert!(fixture.saved().inputs.0[&second].attempts.is_empty());
        if result_first {
            fixture.sdk.command(finish);
        } else {
            fixture.result(&binding, &generation, &first);
        }
        let saved = fixture.saved();
        let attempt = &saved.inputs.0[&first].attempts[0];
        assert_eq!(attempt.acceptance, AcceptanceState::Accepted);
        assert_eq!(attempt.turn_state, TurnState::Completed);
        assert_eq!(attempt.result_state, ResultState::Committed);
        assert_eq!(
            attempt.host_turn_id.as_deref(),
            Some("original-installed-turn")
        );
        assert_eq!(saved.inputs.0[&first].state, InputState::Handled);
        let until = Instant::now() + Duration::from_secs(3);
        let next = loop {
            let next = fixture.sdk.command(json!({"action":"poll"}));
            if next["prompts"].as_array().unwrap().len() == 2 {
                break next;
            }
            assert!(Instant::now() < until, "{next}");
        };
        assert_eq!(fixture.saved().inputs.0[&second].attempts.len(), 1);
        let reports: Vec<&Value> = next["reports"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["input_id"] == json!(first))
            .collect();
        assert_eq!(
            reports
                .iter()
                .map(|event| event["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["accepted", "turn_started", "turn_finished"]
        );
        for event in reports {
            assert_eq!(event["binding_id"], json!(binding));
            assert_eq!(event["generation"], json!(generation));
            assert_eq!(event["attempt_id"], json!(prepared.id));
            assert_eq!(event["host_turn_id"], "original-installed-turn");
        }
    }
}

#[test]
fn installed_detached_sdk_settlement_reports_original_scope_after_desktop_closes() {
    for dropped in [false, true] {
        let mut fixture = Fixture::new();
        let (binding, generation) = fixture.connect();
        let input = fixture.submit(
            &binding,
            "Captured original scope after desktop closes",
            500,
        );
        let claimed = fixture.sdk.command(json!({"action":"poll"}));
        assert_eq!(claimed["prompts"].as_array().unwrap().len(), 1, "{claimed}");
        let original = fixture.saved().inputs.0[&input].attempts[0].clone();
        fixture.close_desktop();
        let reported = fixture
            .sdk
            .command(json!({"action":"settle","index":0,"drop":dropped}));
        let saved = fixture.saved();
        let attempt = &saved.inputs.0[&input].attempts[0];
        assert_eq!(attempt.id, original.id);
        assert_eq!(attempt.binding_generation, generation);
        assert_eq!(
            attempt.acceptance,
            if dropped {
                AcceptanceState::Rejected
            } else {
                AcceptanceState::Accepted
            }
        );
        let event = reported["reports"].as_array().unwrap().last().unwrap();
        assert_eq!(event["binding_id"], json!(binding));
        assert_eq!(event["generation"], json!(generation));
        assert_eq!(event["input_id"], json!(input));
        assert_eq!(event["attempt_id"], json!(original.id));
        if !dropped {
            let payload = claimed["prompts"][0]["text"].clone();
            fixture.sdk.command(json!({"action":"event","name":"turn.start","event":{"turnId":"late-original-turn","text":payload}}));
            fixture.sdk.command(json!({"action":"event","name":"turn.complete","event":{"turnId":"late-original-turn","reason":"answer","isAborted":false,"answer":"Late captured terminal diagnostic"}}));
            let late = fixture.saved();
            let attempt = &late.inputs.0[&input].attempts[0];
            assert_eq!(attempt.host_turn_id.as_deref(), Some("late-original-turn"));
            assert_eq!(attempt.turn_state, TurnState::Completed);
            assert_eq!(attempt.result_state, ResultState::Pending);
            assert!(attempt.domain_result.is_none());
        }
        let retried = fixture.sdk.command(json!({"action":"poll"}));
        assert_eq!(
            retried["prompts"].as_array().unwrap().len(),
            1,
            "Desktop closure never authorizes blind resend"
        );
        assert_eq!(fixture.saved().inputs.0[&input].attempts.len(), 1);
    }
}

#[test]
fn missing_installed_helper_or_resource_cannot_advertise_a_qualified_connection() {
    for missing_helper in [false, true] {
        let mut fixture = Fixture::new();
        fixture.sdk.command(json!({"action":"start"}));
        let before = fixture.saved();
        let path = if missing_helper {
            fixture.helper.clone()
        } else {
            fixture
                .helper
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("integrations/claude-mod/plugin/skills/ariadne/SKILL.md")
        };
        fs::remove_file(path).unwrap();
        let failed = fixture
            .sdk
            .command(json!({"action":"connect","session":id(2)}));
        assert_eq!(failed["value"]["text"],"Ariadne operation did not complete. See the local status message; retain original operation IDs.");
        assert!(!failed["logs"].as_array().unwrap().is_empty());
        assert!(failed["prompts"].as_array().unwrap().is_empty());
        assert!(failed["reports"].as_array().unwrap().is_empty());
        assert_eq!(fixture.saved(), before);
        assert!(failed["replies"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|reply| reply["argv"][1] == "binding")
            .all(|reply| reply["result"]["exitCode"] != 0));
    }
}

#[test]
fn installed_session_end_reports_saved_scope_after_sdk_loses_actual_status_result() {
    let mut fixture = Fixture::new();
    fixture.sdk.command(json!({"action":"start"}));
    fixture.sdk.command(json!({"action":"lose-status-ack"}));
    let pending = fixture
        .sdk
        .command(json!({"action":"connect","session":id(2)}));
    assert!(pending["logs"].as_array().unwrap().iter().any(|log| log
        .as_str()
        .unwrap()
        .contains("was saved; connection status remains pending")));
    assert!(pending["prompts"].as_array().unwrap().is_empty());
    let saved = fixture.saved();
    let binding = saved.active_binding_id.as_ref().unwrap();
    assert_ne!(binding, &id(3));
    let generation = &saved.bindings.0[binding].generation;
    let ended = fixture
        .sdk
        .command(json!({"action":"event","name":"session.end","event":{}}));
    assert!(!ended["reports"].as_array().unwrap().is_empty(), "{ended}");
    let event = ended["reports"].as_array().unwrap().last().unwrap();
    assert_eq!(event["kind"], "disconnected");
    assert_eq!(event["binding_id"], json!(binding));
    assert_eq!(event["generation"], json!(generation));
    assert!(event["input_id"].is_null());
    assert!(event["attempt_id"].is_null());
    assert!(ended["prompts"].as_array().unwrap().is_empty());
    assert_eq!(
        fixture.saved().bindings.0[binding].connection_state,
        ConnectionState::Disconnected
    );
    assert!(ended["replies"]
        .as_array()
        .unwrap()
        .iter()
        .all(|reply| reply["argv"][2] != "claim"));
}

#[test]
fn installed_session_end_fences_the_original_delayed_native_announcement() {
    let mut fixture = Fixture::with_announcement_barrier(true);
    fixture.sdk.command(json!({"action":"start"}));
    fixture
        .sdk
        .command(json!({"action":"connect-detached","session":id(2)}));
    let deadline = Instant::now() + Duration::from_secs(3);
    while !fixture.root.path().join("announce-entered").exists() {
        assert!(
            Instant::now() < deadline,
            "real bound announcement never entered"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let saved = fixture.saved();
    let binding = saved.active_binding_id.unwrap();
    let generation = saved.bindings.0[&binding].generation.clone();
    let ended = fixture
        .sdk
        .command(json!({"action":"event","name":"session.end","event":{}}));
    let event = ended["reports"].as_array().unwrap().last().unwrap();
    assert_eq!(
        event["event_id"],
        json!(format!(
            "claude:session-ended:{}:{}",
            binding.as_str(),
            generation.as_str()
        ))
    );
    assert_eq!(event["binding_id"], json!(binding));
    assert_eq!(event["generation"], json!(generation));
    assert_eq!(
        fixture.saved().bindings.0[&binding].connection_state,
        ConnectionState::Disconnected
    );
    fs::write(fixture.root.path().join("announce-release"), "").unwrap();
    let settled = fixture.sdk.command(json!({"action":"connect-settled"}));
    assert!(settled["prompts"].as_array().unwrap().is_empty());
    assert!(settled["replies"]
        .as_array()
        .unwrap()
        .iter()
        .all(|reply| reply["argv"][2] != "claim"));
    let scope = ariadne_runtime::control::BindingScope {
        binding_id: binding.clone(),
        generation,
    };
    assert_eq!(
        fixture
            .activation
            .as_ref()
            .unwrap()
            .activate_registered_before(scope, Instant::now() + Duration::from_secs(2))
            .unwrap_err()
            .code,
        CoreErrorCode::HostUnreachable
    );
    // The real original callback has now completed, and replay/startup cannot
    // resurrect the ended generation or publish dispatch authority.
    let saved = fixture.saved();
    assert_eq!(
        saved.bindings.0[&binding].connection_state,
        ConnectionState::Disconnected
    );
    assert_eq!(
        saved.bindings.0[&binding].dispatch_state,
        DispatchState::Disconnected
    );
}
