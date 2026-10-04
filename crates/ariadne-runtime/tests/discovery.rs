use ariadne_adapter_claude::{ClaudeAdapter, ClaudeOptions, ModEvidenceSlot};
use ariadne_adapter_codex::CodexOptions;
use ariadne_agent_protocol::{
    Adapter, AdapterConfig, Availability, Compatibility, EndpointRef, ProbeRequest,
};
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
        atomic::{AtomicBool, AtomicUsize, Ordering},
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
struct ClaudeFiles {
    _root: tempfile::TempDir,
    options: ClaudeOptions,
    loaded: std::path::PathBuf,
}
impl ClaudeFiles {
    fn new() -> Self {
        let root = home();
        let installed = root.path().join("installed");
        let loaded = root.path().join("loaded");
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let executable = root.path().join("claude");
        let helper = root.path().join("ariadne");
        for (path, text) in [
            (&executable, "2.1.287 (Claude Code)"),
            (&helper, "ariadne 0.1.0"),
        ] {
            fs::write(path, format!("#!/bin/sh\n[ \"$#\" = 1 ] && [ \"$1\" = --version ] || exit 3\nprintf '%s\\n' '{text}'\n")).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        for root in [&installed, &loaded] {
            for (name, bytes) in [
                (
                    ".claude-plugin/plugin.json",
                    "{\"name\":\"ariadne\",\"version\":\"0.1.0\"}",
                ),
                ("hooks/hooks.json", "{}"),
                ("hooks/register.js", "// register"),
                ("hooks/contracts.js", "// contracts"),
                ("hooks/setup.js", "// setup"),
                ("hooks/claims.js", "// claims"),
                ("hooks/discovery.js", "// discovery"),
                ("hooks/installed.js", "export default null;"),
                ("skills/ariadne/SKILL.md", "# Structured context"),
            ] {
                let path = root.join(name);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, bytes).unwrap();
            }
        }
        Self {
            _root: root,
            options: ClaudeOptions {
                executable,
                installed_plugin: installed,
                helper,
                project_root: project,
                app_version: "0.1.0".into(),
            },
            loaded,
        }
    }
    fn announcement(&self) -> SessionAnnouncement {
        let mut a = announcement(&self.options.project_root);
        a.plugin.root = self.loaded.to_str().unwrap().into();
        a.descriptor.helper_path = self.options.helper.to_str().unwrap().into();
        a
    }
    fn availability(&self, rt: &Runtime, slot: ModEvidenceSlot) -> Availability {
        let adapter = ClaudeAdapter::new(self.options.clone(), slot, id(99)).unwrap();
        rt.block_on(
            adapter.probe(ProbeRequest {
                endpoint: EndpointRef::LocalBridge {
                    name: "claude-mod".into(),
                },
                configuration: serde_json::from_value::<AdapterConfig>(
                    serde_json::json!({"namespace":"claude_code_mod","values":{}}),
                )
                .unwrap(),
            }),
        )
        .unwrap()
        .availability
    }
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
fn qualification_replaces_slots_but_heartbeats_do_not_refresh_prior_evidence() {
    let files = ClaudeFiles::new();
    let home = home();
    let rt = runtime();
    let d = Discovery::new(Arc::new(time), None);
    let core = Arc::new(ScriptedCoreService::new([]));
    let server = Running::start(&rt, home.path(), core.clone(), Some(d.clone()));
    let a = files.announcement();
    rt.block_on(call(home.path().into(), request(a.clone())))
        .unwrap();
    let old = ModEvidenceSlot::default();
    let new = ModEvidenceSlot::default();
    let selected = d.snapshot().unwrap().candidates.remove(0);
    let qualified_facts = d
        .qualify_claude_host_before(
            selected.clone(),
            files.options.clone(),
            old.clone(),
            std::time::Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
    assert_eq!(
        qualified_facts.identity().external_session_id,
        selected.external_session_id
    );
    assert_eq!(qualified_facts.identity().project_root, selected.cwd);
    assert_eq!(qualified_facts.observed_at(), &selected.observed_at);
    assert!(qualified_facts.is_fresh());
    assert!(qualified_facts.capabilities().domain_cli.supported);
    assert!(!qualified_facts.capabilities().domain_mcp.supported);
    assert_eq!(
        files.availability(&rt, old.clone()),
        Availability::Available
    );
    rt.block_on(d.qualify_claude(selected.clone(), files.options.clone(), new.clone()))
        .unwrap();
    assert_eq!(files.availability(&rt, old), Availability::Unavailable);
    assert_eq!(
        files.availability(&rt, new.clone()),
        Availability::Available
    );
    let qualified = d.snapshot().unwrap().candidates.remove(0);
    assert_eq!(qualified.compatibility, Compatibility::Compatible);
    assert_eq!(qualified.observed_at, selected.observed_at);
    // Same-identity heartbeat replaces only the candidate, not qualified slot age.
    rt.block_on(call(home.path().into(), request(a.clone())))
        .unwrap();
    assert_eq!(
        d.snapshot().unwrap().candidates[0].compatibility,
        Compatibility::Unknown
    );
    assert!(rt
        .block_on(d.qualify_claude(selected, files.options.clone(), new.clone()))
        .is_err());
    assert_eq!(
        files.availability(&rt, new.clone()),
        Availability::Available
    );
    // A concrete resource mismatch invalidates the current selected slot.
    let selected = d.snapshot().unwrap().candidates.remove(0);
    fs::write(
        files.loaded.join("hooks/discovery.js"),
        "// incompatible installed bytes",
    )
    .unwrap();
    assert_eq!(
        rt.block_on(d.qualify_claude(selected, files.options.clone(), new.clone()))
            .unwrap_err()
            .code,
        CoreErrorCode::IncompatibleAdapter
    );
    assert_eq!(
        files.availability(&rt, new.clone()),
        Availability::Unavailable
    );
    fs::write(files.loaded.join("hooks/discovery.js"), "// discovery").unwrap();
    let selected = d.snapshot().unwrap().candidates.remove(0);
    rt.block_on(d.qualify_claude(selected, files.options.clone(), new.clone()))
        .unwrap();
    d.refresh_after_wake().unwrap();
    assert_eq!(
        files.availability(&rt, new.clone()),
        Availability::Unavailable
    );
    assert_eq!(
        d.snapshot().unwrap().candidates[0].freshness,
        Freshness::Unknown
    );
    // A genuine heartbeat, followed by actual requalification, restores evidence.
    rt.block_on(call(home.path().into(), request(a.clone())))
        .unwrap();
    rt.block_on(d.qualify_claude(
        d.snapshot().unwrap().candidates.remove(0),
        files.options.clone(),
        new.clone(),
    ))
    .unwrap();
    let mut changed = a;
    changed.host_version = "2.1.289".into();
    rt.block_on(call(home.path().into(), request(changed)))
        .unwrap();
    assert_eq!(files.availability(&rt, new), Availability::Unavailable);
    assert!(core.history().unwrap().is_empty());
    server.stop(&rt);
}

#[test]
fn blocking_pre_id_qualification_preserves_short_original_deadline_without_a_runtime() {
    let files = ClaudeFiles::new();
    let home = home();
    let rt = runtime();
    let d = Discovery::new(Arc::new(time), None);
    let core = Arc::new(ScriptedCoreService::new([]));
    let server = Running::start(&rt, home.path(), core.clone(), Some(d.clone()));
    rt.block_on(call(home.path().into(), request(files.announcement())))
        .unwrap();
    let selected = d.snapshot().unwrap().candidates.remove(0);
    fs::write(&files.options.executable, "#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
    let slot = ModEvidenceSlot::default();
    let started = std::time::Instant::now();
    let error = d
        .qualify_claude_host_before(
            selected,
            files.options.clone(),
            slot.clone(),
            started + Duration::from_millis(100),
        )
        .unwrap_err();
    assert_eq!(error.code, CoreErrorCode::HostUnreachable);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "absolute caller budget must not become a fresh 5s probe"
    );
    assert_eq!(
        d.snapshot().unwrap().candidates[0].compatibility,
        Compatibility::Unknown
    );
    assert!(core.history().unwrap().is_empty());
    server.stop(&rt);
}

#[test]
fn candidate_replacement_during_qualification_cannot_publish_into_old_slot() {
    qualification_race(false);
}

#[test]
fn registered_generation_rotation_during_qualification_cannot_grant_old_scope() {
    qualification_race(true);
}

fn qualification_race(rotate: bool) {
    let files = ClaudeFiles::new();
    let home = home();
    let rt = runtime();
    let facts = AnnouncementBinding {
        binding_id: id(2),
        session: SessionRef {
            project_id: id(4),
            session_id: id(5),
        },
        canonical_root: fs::canonicalize(&files.options.project_root).unwrap(),
        adapter_id: "claude_code_mod".into(),
        external_session_id: "original-session".into(),
        generation: id(3),
    };
    let current = Arc::new(Mutex::new(facts));
    let native = current.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let (entered, received) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let released = Mutex::new(released);
    let d = Discovery::new(
        Arc::new(time),
        Some(Arc::new(move |_| {
            // Two admission resolutions, two first qualification resolutions, then
            // pause the second qualification after resource IO without holding any lock.
            if count.fetch_add(1, Ordering::SeqCst) == 5 {
                entered.send(()).unwrap();
                released
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(2))
                    .unwrap();
            }
            Ok(native.lock().unwrap().clone())
        })),
    );
    let core = Arc::new(ScriptedCoreService::new([]));
    let server = Running::start(&rt, home.path(), core.clone(), Some(d.clone()));
    let mut a = files.announcement();
    a.binding_scope = Some(BindingScope {
        binding_id: id(2),
        generation: id(3),
    });
    rt.block_on(call(home.path().into(), request(a.clone())))
        .unwrap();
    let slot = ModEvidenceSlot::default();
    let selected = d.snapshot().unwrap().candidates.remove(0);
    rt.block_on(d.qualify_claude(selected.clone(), files.options.clone(), slot.clone()))
        .unwrap();
    let pending = {
        let d = d.clone();
        let options = files.options.clone();
        let slot = slot.clone();
        rt.spawn(async move { d.qualify_claude(selected, options, slot).await })
    };
    received.recv_timeout(Duration::from_secs(2)).unwrap();
    if rotate {
        current.lock().unwrap().generation = id(6);
    } else {
        // This announced loaded root exists, but has never been resource-qualified.
        a.plugin.root = files.options.installed_plugin.to_str().unwrap().into();
        rt.block_on(call(home.path().into(), request(a))).unwrap();
        assert_eq!(
            files.availability(&rt, slot.clone()),
            Availability::Unavailable
        );
    }
    release.send(()).unwrap();
    let error = rt.block_on(pending).unwrap().unwrap_err();
    assert_eq!(
        error.code,
        if rotate {
            CoreErrorCode::StaleGeneration
        } else {
            CoreErrorCode::InvalidArgument
        }
    );
    assert_eq!(files.availability(&rt, slot), Availability::Unavailable);
    assert_eq!(
        d.snapshot().unwrap().candidates[0].compatibility,
        Compatibility::Unknown
    );
    assert!(core.history().unwrap().is_empty());
    server.stop(&rt);
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
