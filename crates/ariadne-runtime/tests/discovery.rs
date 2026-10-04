use ariadne_adapter_codex::CodexOptions;
use ariadne_agent_protocol::{Availability, Compatibility};
use ariadne_core::{fake::ScriptedCoreService, CoreErrorCode, SessionRef};
use ariadne_domain::models::{Freshness, UtcMillis, UuidV4};
use ariadne_runtime::{
    control::{call, BindingScope, ControlMethod, ControlRequest, ControlResult, ControlServer},
    discovery::{
        AnnouncementBinding, CodexEndpoint, Discovery, DiscoveryPoller, LoadedPlugin,
        ModDescriptor, SessionAnnouncement,
    },
    leases::DesktopOwner,
};
use std::{
    fs,
    io::Write,
    os::unix::{
        fs::{symlink, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tokio::{runtime::Runtime, sync::oneshot};

fn id(n: u32) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012}")).unwrap()
}
fn time() -> UtcMillis {
    UtcMillis::new("2026-10-04T00:00:00.000Z").unwrap()
}
fn home() -> tempfile::TempDir {
    let home = tempfile::Builder::new()
        .prefix("ariadne-discovery-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
    home
}
fn runtime() -> Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}
fn announcement(root: &Path) -> SessionAnnouncement {
    SessionAnnouncement {
        adapter_id: "claude_code_mod".into(),
        external_session_id: "original-session".into(),
        cwd: root.to_str().unwrap().into(),
        host_version: "2.1.287".into(),
        plugin: LoadedPlugin {
            name: "ariadne".into(),
            root: root.to_str().unwrap().into(),
        },
        descriptor: ModDescriptor {
            helper_path: "/Applications/Ariadne/helper".into(),
            app_version: "0.1.0".into(),
            api_version: 1,
        },
        binding_scope: None,
    }
}
fn request(a: SessionAnnouncement) -> ControlRequest {
    ControlRequest::new(id(1), ControlMethod::SessionAnnouncement(a)).unwrap()
}
struct Running {
    stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<Result<(), ariadne_core::CoreError>>,
}
impl Running {
    fn start(
        rt: &Runtime,
        home: &Path,
        core: Arc<ScriptedCoreService>,
        discovery: Option<Discovery>,
    ) -> Self {
        // No binding leases or ready claim gates: announcements are read-only.
        let owner = DesktopOwner::acquire(home).unwrap();
        let mut server = ControlServer::bind(owner, core, vec![]).unwrap();
        if let Some(discovery) = discovery {
            server = server.with_discovery(discovery);
        }
        let (stop, stopped) = oneshot::channel();
        Self {
            stop,
            task: rt.spawn(server.serve(stopped)),
        }
    }
    fn stop(self, rt: &Runtime) {
        self.stop.send(()).unwrap();
        rt.block_on(async { tokio::time::timeout(Duration::from_secs(2), self.task).await })
            .unwrap()
            .unwrap()
            .unwrap();
    }
}

#[test]
fn unbound_real_ipc_admits_unknown_identity_without_core_or_dispatch_route() {
    let home = home();
    let root = tempfile::tempdir().unwrap();
    let alias = root.path().join("alias");
    symlink(root.path(), &alias).unwrap();
    let d = Discovery::new(Arc::new(time), None);
    let core = Arc::new(ScriptedCoreService::new([]));
    let rt = runtime();
    let server = Running::start(&rt, home.path(), core.clone(), Some(d.clone()));
    let a = announcement(&alias);
    let expected = a.acknowledgement();
    assert_eq!(
        rt.block_on(call(home.path().into(), request(a.clone())))
            .unwrap(),
        ControlResult::Announcement(expected)
    );
    // Refresh is an in-place native observation, never another candidate/lease.
    rt.block_on(call(home.path().into(), request(a))).unwrap();
    let snapshot = d.snapshot().unwrap();
    assert_eq!(snapshot.candidates.len(), 1);
    let candidate = &snapshot.candidates[0];
    assert_eq!(candidate.cwd, fs::canonicalize(root.path()).unwrap());
    assert_eq!(candidate.observed_at, time());
    assert_eq!(candidate.freshness, Freshness::Fresh);
    assert_eq!(candidate.compatibility, Compatibility::Unknown);
    assert_eq!(candidate.availability, Availability::Unknown);
    assert!(candidate.binding.is_none());
    let ping = ControlRequest::new(
        id(1),
        ControlMethod::Ping(BindingScope {
            binding_id: id(2),
            generation: id(3),
        }),
    )
    .unwrap();
    assert_eq!(
        rt.block_on(call(home.path().into(), ping))
            .unwrap_err()
            .code,
        CoreErrorCode::NotFound
    );
    assert!(core.history().unwrap().is_empty());
    server.stop(&rt);
}

#[test]
fn bound_real_ipc_uses_native_route_and_rejects_rotation_without_retargeting() {
    let home = home();
    let root = tempfile::tempdir().unwrap();
    let facts = AnnouncementBinding {
        binding_id: id(2),
        session: SessionRef {
            project_id: id(4),
            session_id: id(5),
        },
        canonical_root: fs::canonicalize(root.path()).unwrap(),
        adapter_id: "claude_code_mod".into(),
        external_session_id: "original-session".into(),
        generation: id(3),
    };
    let current = Arc::new(Mutex::new(facts.clone()));
    let resolver = current.clone();
    let d = Discovery::new(
        Arc::new(time),
        Some(Arc::new(move |_| Ok(resolver.lock().unwrap().clone()))),
    );
    let core = Arc::new(ScriptedCoreService::new([]));
    let rt = runtime();
    let server = Running::start(&rt, home.path(), core.clone(), Some(d.clone()));
    let mut a = announcement(root.path());
    a.binding_scope = Some(BindingScope {
        binding_id: id(2),
        generation: id(3),
    });
    rt.block_on(call(home.path().into(), request(a.clone())))
        .unwrap();
    assert_eq!(d.snapshot().unwrap().candidates[0].binding, Some(facts));
    for (change, expected) in [
        (0, CoreErrorCode::BindingMismatch),
        (1, CoreErrorCode::StaleGeneration),
        (2, CoreErrorCode::InvalidArgument),
    ] {
        let mut bad = a.clone();
        match change {
            0 => bad.binding_scope.as_mut().unwrap().binding_id = id(6),
            1 => current.lock().unwrap().generation = id(6),
            _ => {
                current.lock().unwrap().generation = id(3);
                bad.external_session_id = "different-conversation".into();
            }
        }
        assert_eq!(
            rt.block_on(call(home.path().into(), request(bad)))
                .unwrap_err()
                .code,
            expected
        );
    }
    let retained = d.snapshot().unwrap();
    assert_eq!(retained.candidates.len(), 1);
    assert_eq!(
        retained.candidates[0].external_session_id,
        "original-session"
    );
    assert_eq!(
        retained.candidates[0].binding.as_ref().unwrap().generation,
        id(3)
    );
    assert!(core.history().unwrap().is_empty());
    server.stop(&rt);
}

#[test]
fn discovery_is_explicitly_enabled_and_acknowledgement_cannot_change_identity() {
    let home = home();
    let root = tempfile::tempdir().unwrap();
    let core = Arc::new(ScriptedCoreService::new([]));
    let rt = runtime();
    let server = Running::start(&rt, home.path(), core.clone(), None);
    let request = request(announcement(root.path()));
    assert_eq!(
        rt.block_on(call(home.path().into(), request.clone()))
            .unwrap_err()
            .code,
        CoreErrorCode::Unsupported
    );
    let wrong: ariadne_runtime::control::ControlResponse = serde_json::from_value(
        serde_json::json!({"v":1,"kind":"response","id":id(1),"result":{
            "adapter_id":"claude_code_mod","external_session_id":"another-conversation"
        }}),
    )
    .unwrap();
    assert_eq!(
        wrong.into_result(&request).unwrap_err().code,
        CoreErrorCode::ProtocolConflict
    );
    assert!(core.history().unwrap().is_empty());
    server.stop(&rt);
}

#[test]
fn codex_polling_starts_closed_and_wake_reuses_owned_runtime_without_signalling_host() {
    let root = home();
    let executable = root.path().join("codex");
    fs::write(&executable, "#!/bin/sh\nprintf 'codex-cli 0.160.0\\n'\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let path = root.path().join("daemon.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let (recorded, received) = mpsc::channel();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop_server = stopped.clone();
    let server = std::thread::spawn(move || loop {
        let (mut stream, _) = listener.accept().unwrap();
        if stop_server.load(Ordering::SeqCst) {
            break;
        }
        // A real transport rejection; no successful host presence is fabricated.
        stream
            .write_all(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n")
            .unwrap();
        recorded.send(()).unwrap();
    });
    let rt = runtime();
    let d = Discovery::new(Arc::new(time), None);
    let poller = rt.block_on(async {
        let poller = DiscoveryPoller::start(
            d.clone(),
            vec![CodexEndpoint {
                options: CodexOptions::new(executable, root.path().into()).unwrap(),
                endpoint: ariadne_agent_protocol::EndpointRef::UnixSocket {
                    path: path.to_str().unwrap().into(),
                },
            }],
        )
        .unwrap();
        tokio::task::yield_now().await;
        poller
    });
    assert!(matches!(
        received.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    poller.set_connection_ui_open(true);
    received.recv_timeout(Duration::from_secs(2)).unwrap();
    poller.set_connection_ui_open(false);
    poller.refresh_after_wake().unwrap();
    poller.set_connection_ui_open(true);
    received.recv_timeout(Duration::from_secs(2)).unwrap();
    rt.block_on(async { tokio::time::timeout(Duration::from_secs(2), poller.stop()).await })
        .unwrap()
        .unwrap();
    assert!(d.snapshot().unwrap().candidates.is_empty());
    assert!(matches!(
        received.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    // Only the test owns/terminates this server. Runtime stop leaves its endpoint intact.
    assert!(path.exists());
    stopped.store(true, Ordering::SeqCst);
    UnixStream::connect(&path).unwrap();
    server.join().unwrap();
}
