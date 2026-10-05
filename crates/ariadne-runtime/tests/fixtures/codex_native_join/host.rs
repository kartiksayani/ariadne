//! Only the external daemon and installed-command transport are faked.
use ariadne_adapter_codex::CodexOptions;
use ariadne_domain::models::EndpointRef;
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::{fs::PermissionsExt, net::UnixListener},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tungstenite::Message;

pub const THREAD: &str = "selected thread:opaque";
pub fn fixture(name: &str) -> Value {
    serde_json::from_slice(
        &fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../contracts/providers/codex/0.160.0/fixtures")
                .join(name),
        )
        .unwrap(),
    )
    .unwrap()
}
pub struct Host {
    home: tempfile::TempDir,
    pub options: CodexOptions,
    pub endpoint: EndpointRef,
    pub turns: Arc<Mutex<Value>>,
    pub calls: Arc<Mutex<Vec<Value>>>,
    pub foreign_queue: Value,
    pub hold_read: Arc<AtomicBool>,
    pub read_held: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl Host {
    pub fn new(root: &Path, lose_receipt: bool) -> Self {
        let home = tempfile::Builder::new()
            .prefix("ariadne-codex-host-")
            .tempdir_in("/tmp")
            .unwrap();
        let executable = home.path().join("codex executable");
        fs::write(&executable, include_str!("sender.sh")).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        if lose_receipt {
            fs::write(home.path().join("lose-receipt"), b"").unwrap();
        }
        let socket = home.path().join("daemon.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let calls = Arc::new(Mutex::new(vec![]));
        let called = calls.clone();
        let mut anchor = fixture("turns-response.json");
        anchor["data"].as_array_mut().unwrap().truncate(1);
        anchor["data"][0]["id"] = json!("pre-submit-anchor");
        let turns = Arc::new(Mutex::new(anchor));
        let history = turns.clone();
        let foreign_queue = fixture("queue-response.json");
        let queue = foreign_queue.clone();
        let root = root.to_owned();
        let hold_read = Arc::new(AtomicBool::new(false));
        let read_held = Arc::new(AtomicBool::new(false));
        let hold = hold_read.clone();
        let held = read_held.clone();
        let worker = thread::spawn(move || {
            let mut connections = vec![];
            while !stopped.load(Ordering::Acquire) {
                let stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => panic!("fixture accept: {e}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_millis(100)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let stopped = stopped.clone();
                let called = called.clone();
                let history = history.clone();
                let queue = queue.clone();
                let root = root.clone();
                let hold = hold.clone();
                let held = held.clone();
                connections.push(thread::spawn(move || {
                    let Ok(mut ws) = tungstenite::accept(stream) else {
                        return;
                    };
                    while !stopped.load(Ordering::Acquire) {
                        let message = match ws.read() {
                            Ok(m) => m,
                            Err(tungstenite::Error::Io(e))
                                if matches!(
                                    e.kind(),
                                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                                ) =>
                            {
                                continue;
                            }
                            Err(_) => break,
                        };
                        let Message::Text(text) = message else {
                            continue;
                        };
                        let request: Value = serde_json::from_str(text.as_str()).unwrap();
                        called.lock().unwrap().push(request.clone());
                        let result = match request["method"].as_str().unwrap() {
                            "initialized" => continue,
                            "initialize" => fixture("initialize-response.json"),
                            "thread/read" => {
                                assert_eq!(request["params"]["threadId"], THREAD);
                                if hold.load(Ordering::Acquire) {
                                    held.store(true, Ordering::Release);
                                    while hold.load(Ordering::Acquire)
                                        && !stopped.load(Ordering::Acquire)
                                    {
                                        thread::sleep(Duration::from_millis(2));
                                    }
                                }
                                let mut value = fixture("read-response.json");
                                value["thread"]["id"] = json!(THREAD);
                                value["thread"]["cwd"] = json!(root);
                                value
                            }
                            "thread/queue/list" => {
                                assert_eq!(request["params"]["threadId"], THREAD);
                                queue.clone()
                            }
                            "thread/turns/list" => {
                                assert_eq!(request["params"]["threadId"], THREAD);
                                assert_eq!(request["params"]["itemsView"], "full");
                                history.lock().unwrap().clone()
                            }
                            method => panic!("unexpected provider mutation: {method}"),
                        };
                        if ws
                            .send(Message::Text(
                                json!({"id":request["id"],"result":result})
                                    .to_string()
                                    .into(),
                            ))
                            .is_err()
                        {
                            break;
                        }
                    }
                }));
            }
            for connection in connections {
                connection.join().unwrap();
            }
        });
        Self {
            options: CodexOptions::new(executable, home.path().into()).unwrap(),
            endpoint: EndpointRef::UnixSocket {
                path: socket.to_str().unwrap().into(),
            },
            home,
            turns,
            calls,
            foreign_queue,
            hold_read,
            read_held,
            stop,
            worker: Some(worker),
        }
    }
    pub fn sends(&self) -> usize {
        fs::read_to_string(self.home.path().join("sends"))
            .unwrap_or_default()
            .lines()
            .count()
    }
    pub fn argv(&self) -> Vec<String> {
        fs::read(self.home.path().join("argv"))
            .unwrap_or_default()
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8(s.to_vec()).unwrap())
            .collect()
    }
    pub fn turn(id: &str, payload: &str, status: &str) -> Value {
        let mut turn = fixture("turns-response.json")["data"][0].clone();
        turn["id"] = json!(id);
        turn["status"] = json!(status);
        turn["items"][0]["id"] = json!(format!("user-{id}"));
        turn["items"][0]["clientId"] = json!(format!("client-{id}"));
        turn["items"][0]["content"][0]["text"] = json!(payload);
        turn["items"][1]["text"] = json!("Visible host text does not publish an Ariadne result.");
        turn
    }
    pub fn set_turns(&self, mut delivered: Vec<Value>) {
        let mut history = self.turns.lock().unwrap();
        delivered.push(history["data"].as_array().unwrap().last().unwrap().clone());
        history["data"] = json!(delivered);
    }
    pub fn assert_read_only(&self) {
        assert!(
            !self.foreign_queue["data"].as_array().unwrap().is_empty(),
            "exercise a busy foreign queue"
        );
        assert!(self.calls.lock().unwrap().iter().all(|c| {
            [
                "initialize",
                "initialized",
                "thread/read",
                "thread/queue/list",
                "thread/turns/list",
            ]
            .contains(&c["method"].as_str().unwrap())
        }));
        assert!(
            self.calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c["method"] == "thread/queue/list"),
            "the real adapter inspected the nonempty foreign queue"
        );
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}
