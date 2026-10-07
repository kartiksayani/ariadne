//! Real installed processes over bounded stdio; no provider or scripted Core.
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Barrier},
    thread,
    time::Duration,
};
fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
struct Setup {
    _home: tempfile::TempDir,
    _root: tempfile::TempDir,
    store_dir: std::path::PathBuf,
    data: std::path::PathBuf,
}
impl Setup {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        let session: Session =
            serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json"))
                .unwrap();
        let store_dir = registry.project_dir(&id(1));
        Store::open_registered(&store_dir, id(1))
            .unwrap()
            .create(&session)
            .unwrap();
        let data = home.path().join(".ariadne");
        Self {
            _home: home,
            _root: root,
            store_dir,
            data,
        }
    }
    fn store(&self) -> Store {
        Store::open_registered(&self.store_dir, id(1)).unwrap()
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(
            self.store_dir
                .join(format!("sessions/{}.json", id(2).as_str())),
        )
        .unwrap()
    }
}
struct Peer {
    child: Child,
    input: Option<ChildStdin>,
    read: Option<mpsc::Receiver<Result<Value, String>>>,
    reader: Option<thread::JoinHandle<()>>,
    errors: Option<thread::JoinHandle<Vec<u8>>>,
}
impl Peer {
    fn new(binary: &str, args: &[&str], setup: &Setup) -> Self {
        let mut child = Command::new(binary)
            .args(args)
            .env("ARIADNE_HOME", &setup.data)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (send, read) = mpsc::sync_channel(16);
        let reader = thread::spawn(move || {
            let mut read = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                // SDK duplicates a validated <=1MiB application envelope as text
                // and structured content. This test reader also bounds wrapping.
                let outcome = match read
                    .by_ref()
                    .take(4 * 1024 * 1024 + 4096 + 1)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) => Err("EOF".into()),
                    Ok(_) if line.len() > 4 * 1024 * 1024 + 4096 => {
                        Err("unbounded SDK output".into())
                    }
                    Ok(_) => serde_json::from_slice(&line).map_err(|_| "non-JSON stdout".into()),
                    Err(error) => Err(error.to_string()),
                };
                let done = outcome.is_err();
                if send.send(outcome).is_err() || done {
                    break;
                }
            }
        });
        let errors = thread::spawn(move || {
            let mut bytes = Vec::new();
            stderr.take(8192).read_to_end(&mut bytes).unwrap();
            bytes
        });
        let mut peer = Self {
            child,
            input,
            read: Some(read),
            reader: Some(reader),
            errors: Some(errors),
        };
        peer.send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"installed-contract","version":"1"}}}));
        let initialized = peer.result();
        assert_eq!(initialized["id"], 1);
        assert_eq!(initialized["result"]["serverInfo"]["name"], "ariadne");
        peer.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
        peer
    }
    fn send(&mut self, value: Value) {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        self.input.as_mut().unwrap().write_all(&bytes).unwrap();
    }
    fn result(&self) -> Value {
        self.read
            .as_ref()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .expect("bounded stdio response")
            .expect("stdout contains only JSON-RPC")
    }
    fn call(&mut self, request_id: u64, tool: &str, arguments: Value) {
        self.send(json!({"jsonrpc":"2.0","id":request_id,"method":"tools/call","params":{"name":tool,"arguments":arguments}}));
    }
    fn envelope(&self, request_id: u64) -> Value {
        let result = self.result();
        assert_eq!(result["id"], request_id);
        assert!(result.get("error").is_none(), "{result}");
        let envelope = &result["result"]["structuredContent"];
        assert_eq!(
            &serde_json::from_str::<Value>(
                result["result"]["content"][0]["text"].as_str().unwrap()
            )
            .unwrap(),
            envelope
        );
        assert_eq!(envelope["api_version"], 1);
        assert_eq!(result["result"]["isError"], envelope["ok"] == false);
        envelope.clone()
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.input.take();
        self.read.take();
        let _ = self.child.kill();
        self.child.wait().unwrap();
        self.reader.take().unwrap().join().unwrap();
        let _ = self.errors.take().unwrap().join().unwrap();
    }
}
struct CliChild(Option<Child>);
impl Drop for CliChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn arguments(params: Value) -> Value {
    json!({"binding_id":id(3),"generation":id(4),"source_input_id":null,"attempt_id":null,"params":params})
}
fn read(cursor: Value) -> Value {
    json!({"selection":{"view":"items","filters":{"topic_id":null,"item_id":null,"parent_item_id":null,"statuses":[],"archived":null}},"cursor":cursor,"limit":1,"item_pages":[]})
}
fn apply(op: u64) -> Value {
    json!({"op_id":id(op),"source_input_id":null,"attempt_id":null,"expected_item_revisions":{"1":1},"expected_topic_revisions":{},"summary":"  Exact activity\nsecond line  ","operations":[{"op":"reply","ref":"response","item":{"id":"1"},"text":format!("Full reply\n  including exact whitespace  {}","complete body ".repeat(4000)),"round_id":null}],"input_result":null})
}
fn apply_arguments(request: Value) -> Value {
    json!({"binding_id":id(3),"generation":id(4),"request":request})
}

pub fn persisted_race_and_parity(binary: &str, args: &[&str], cli: Option<&str>) {
    let setup = Setup::new();
    let mut first = Peer::new(binary, args, &setup);
    let mut second = Peer::new(binary, args, &setup);
    first.send(json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}));
    let tools = first.result();
    assert_eq!(
        tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["session_read", "item_messages", "item_rounds", "apply"]
    );
    first.call(3, "session_read", arguments(read(Value::Null)));
    let page = first.envelope(3);
    assert_eq!(
        page["data"]["data"]["page"]["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let cursor = page["data"]["data"]["page"]["next_cursor"].clone();
    assert!(cursor.is_object());
    first.call(4, "session_read", arguments(read(cursor.clone())));
    let next = first.envelope(4);
    assert_eq!(next["data"]["data"]["page"]["items"][0]["item"]["id"], "2");
    let request = apply(500);
    let mut cli = CliChild(cli.map(|binary| {
        Command::new(binary)
            .args([
                "apply",
                "--binding",
                id(3).as_str(),
                "--generation",
                id(4).as_str(),
                "--json-stdin",
                "--json",
            ])
            .env("ARIADNE_HOME", &setup.data)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }));
    let barrier = Arc::new(Barrier::new(2));
    let b = barrier.clone();
    let root = setup.store_dir.clone();
    let writer = thread::spawn(move || {
        b.wait();
        Store::open_registered(&root, id(1))
            .unwrap()
            .transact(
                &id(2),
                &ReceiptActorScope::Owner {},
                &id(600),
                &json!({"test":"concurrent title"}),
                |session| {
                    session.title = "Concurrent owner title".into();
                    Ok::<_, ()>(SavedReceiptData::Event {
                        event_id: "test:owner-writer".into(),
                        input_id: None,
                        attempt_id: None,
                        durable_effect: true,
                    })
                },
            )
            .unwrap();
    });
    barrier.wait();
    first.call(5, "apply", apply_arguments(request.clone()));
    second.call(5, "apply", apply_arguments(request.clone()));
    if let Some(child) = cli.0.as_mut() {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&request).unwrap())
            .unwrap();
    }
    let receipt = first.envelope(5);
    assert_eq!(receipt["ok"], true);
    assert_eq!(receipt, second.envelope(5));
    writer.join().unwrap();
    if let Some(child) = cli.0.take() {
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{output:?}");
        assert!(output.stderr.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            receipt
        );
    }

    let session = setup.store().read(&id(2)).unwrap();
    assert_eq!(session.title, "Concurrent owner title");
    assert_eq!(session.revision.value(), 3);
    assert_eq!(session.operation_receipts.0[&id(500)].len(), 1);
    assert_eq!(session.operation_receipts.0[&id(600)].len(), 1);
    let reply = request["operations"][0]["text"].as_str().unwrap();
    assert_eq!(
        session.messages.iter().filter(|m| m.body == reply).count(),
        1
    );
    let bytes = setup.bytes();
    first.call(6, "apply", apply_arguments(request.clone()));
    assert_eq!(first.envelope(6), receipt);
    assert_eq!(setup.bytes(), bytes);
    first.call(
        7,
        "item_messages",
        arguments(json!({"item_id":"1","cursor":null,"limit":100})),
    );
    let history = first.envelope(7);
    assert!(history["data"]["data"]["messages"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["body"] == reply));
    first.call(
        8,
        "item_rounds",
        arguments(json!({"item_id":"1","cursor":null,"limit":100,"round_pages":[]})),
    );
    assert_eq!(first.envelope(8)["ok"], true);
    first.call(9, "session_read", arguments(read(cursor)));
    assert_eq!(first.envelope(9)["error"]["code"], "snapshot_changed");
    let mut reused = request;
    reused["summary"] = json!("different exact bytes");
    first.call(10, "apply", apply_arguments(reused));
    assert_eq!(first.envelope(10)["error"]["code"], "operation_reused");
    assert_eq!(setup.bytes(), bytes);
    first.call(
        11,
        "apply",
        json!({"binding_id":id(3),"generation":id(4),"request":{},"actor":"owner"}),
    );
    assert_eq!(first.envelope(11)["error"]["code"], "invalid_argument");
    assert_eq!(setup.bytes(), bytes);
}

pub fn native_scope_and_historical_replay(binary: &str, args: &[&str]) {
    use ariadne_core::{inputs::InputService, *};
    let setup = Setup::new();
    let mut peer = Peer::new(binary, args, &setup);
    let request = apply(700);
    peer.call(2, "apply", apply_arguments(request.clone()));
    let receipt = peer.envelope(2);
    assert_eq!(receipt["ok"], true);
    let registry = Registry::open_data_directory(&setup.data).unwrap();
    let context = OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
    ));
    let command = OwnerCommand::InputSubmit {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(701),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: id(5),
                item_id: Some(ItemRef::new("1").unwrap()),
            },
            kind: InputKind::Reply,
            text: "PRIVATE future owner body  \n".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    let mut next = 710;
    InputService::new(&registry)
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
    peer.call(3,"session_read",arguments(json!({"selection":{"view":"messages","filters":{"topic_id":null,"item_id":null}},"cursor":null,"limit":100,"item_pages":[]})));
    let messages = peer.envelope(3);
    assert_eq!(messages["ok"], true);
    assert!(!messages.to_string().contains("PRIVATE future owner body"));
    let before = setup.bytes();
    let mut mismatch = arguments(read(Value::Null));
    mismatch["source_input_id"] = json!(id(799));
    mismatch["attempt_id"] = json!(id(798));
    peer.call(4, "session_read", mismatch);
    assert_eq!(peer.envelope(4)["error"]["code"], "invalid_argument");
    assert_eq!(setup.bytes(), before);
    setup
        .store()
        .transact(
            &id(2),
            &ReceiptActorScope::Owner {},
            &id(702),
            &json!({"test":"generation rotation"}),
            |session| {
                session.bindings.0.get_mut(&id(3)).unwrap().generation = id(703);
                Ok::<_, ()>(SavedReceiptData::Event {
                    event_id: "test:generation".into(),
                    input_id: None,
                    attempt_id: None,
                    durable_effect: true,
                })
            },
        )
        .unwrap();
    let rotated = setup.bytes();
    peer.call(5, "apply", apply_arguments(request.clone()));
    assert_eq!(peer.envelope(5), receipt);
    assert_eq!(setup.bytes(), rotated);
    peer.call(6, "session_read", arguments(read(Value::Null)));
    assert_eq!(peer.envelope(6)["error"]["code"], "stale_generation");
    let mut new_operation = request;
    new_operation["op_id"] = json!(id(704));
    peer.call(7, "apply", apply_arguments(new_operation));
    assert_eq!(peer.envelope(7)["error"]["code"], "stale_generation");
    assert_eq!(setup.bytes(), rotated);
    let oversized = json!({"binding_id":id(3),"generation":id(703),"request":{"op_id":id(705),"summary":"x".repeat(512*1024)}});
    peer.call(8, "apply", oversized);
    assert_eq!(peer.envelope(8)["error"]["code"], "invalid_argument");
    assert_eq!(setup.bytes(), rotated);
}

pub fn raw_frame_contract(binary: &str, args: &[&str]) {
    let setup = Setup::new();
    let before = setup.bytes();
    {
        let mut peer = Peer::new(binary, args, &setup);
        let mut exact =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":2,"method":"ping"})).unwrap();
        exact.resize(1024 * 1024, b' ');
        exact.push(b'\n');
        for chunk in exact.chunks(7777) {
            peer.input.as_mut().unwrap().write_all(chunk).unwrap();
        }
        peer.send(json!({"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}));
        let one = peer.result();
        let two = peer.result();
        assert_eq!(
            std::collections::BTreeSet::from([
                one["id"].as_u64().unwrap(),
                two["id"].as_u64().unwrap()
            ]),
            std::collections::BTreeSet::from([2, 3])
        );
        assert!(one.get("error").is_none() && two.get("error").is_none());
    }
    for overflow in [false, true] {
        let mut peer = Peer::new(binary, args, &setup);
        let frame = if overflow {
            let mut frame = vec![b' '; 1024 * 1024 + 1];
            frame.extend_from_slice(b"\n{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/call\",\"params\":{\"name\":\"apply\",\"arguments\":{}}}\n");
            frame
        } else {
            b"{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":".to_vec()
        };
        let _ = peer.input.as_mut().unwrap().write_all(&frame);
        peer.input.take();
        assert!(peer
            .read
            .as_ref()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .is_err());
        assert_eq!(setup.bytes(), before);
    }
}
