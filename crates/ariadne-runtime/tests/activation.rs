//! Actual native Core + provider version/resource stubs + private control IPC.
use ariadne_adapter_claude::ClaudeOptions;
use ariadne_core::{
    native::{AgentResolver, NativeCoreService},
    *,
};
use ariadne_domain::models::*;
use ariadne_runtime::{
    activation::{registered_announcement_resolver, ActivationOutcome, NativeActivation},
    control::*,
    discovery::*,
    leases::DesktopOwner,
    providers::*,
    supervisor::NativeFacts,
};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn wire_request(id: UuidV4, method: ControlMethod) -> ControlRequest {
    ControlRequest::new(id, method).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn home() -> tempfile::TempDir {
    let home = tempfile::Builder::new()
        .prefix("ariadne-activation-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
    home
}
struct Fixture {
    _files: tempfile::TempDir,
    options: ClaudeOptions,
    loaded: PathBuf,
}
struct ReleaseQualification(std::os::unix::net::UnixStream);
impl Drop for ReleaseQualification {
    fn drop(&mut self) {
        use std::io::Write;
        let _ = self.0.write_all(&[1]);
    }
}
#[test]
fn qualification_version_child_process() {
    use std::io::Read;
    let Some(path) = std::env::var_os("ARIADNE_QUALIFICATION_BARRIER") else {
        return;
    };
    let mut stream = std::os::unix::net::UnixStream::connect(path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream.read_exact(&mut [0]).unwrap();
}
impl Fixture {
    fn new() -> Self {
        let files = home();
        let installed = files.path().join("installed");
        let loaded = files.path().join("loaded");
        let project = files.path().join("project");
        fs::create_dir(&project).unwrap();
        let executable = files.path().join("claude");
        let helper = files.path().join("ariadne");
        let barrier = files.path().join("qualification.sock");
        let shell_path = |path: &std::path::Path| {
            format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
        };
        for (path, version) in [
            (&executable, "2.1.287 (Claude Code)"),
            (&helper, "ariadne 0.1.0"),
        ] {
            let pause = if path == &helper {
                format!(
                    "if [ -S {socket} ]; then ARIADNE_QUALIFICATION_BARRIER={socket} {test} --exact qualification_version_child_process >/dev/null || exit 4; fi\n",
                    socket = shell_path(&barrier),
                    test = shell_path(&std::env::current_exe().unwrap()),
                )
            } else {
                String::new()
            };
            fs::write(path, format!("#!/bin/sh\n[ \"$#\" = 1 ] && [ \"$1\" = --version ] || exit 3\n{pause}printf '%s\\n' '{version}'\n")).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        for root in [&installed, &loaded] {
            for (name, text) in [
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
                ("skills/ariadne/SKILL.md", "# Fixture rules"),
            ] {
                let path = root.join(name);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, text).unwrap();
            }
        }
        Self {
            _files: files,
            loaded,
            options: ClaudeOptions {
                executable,
                helper,
                installed_plugin: installed,
                project_root: project.canonicalize().unwrap(),
                app_version: "0.1.0".into(),
            },
        }
    }
    fn pause_qualification(&self, rt: &tokio::runtime::Runtime) -> ReleaseQualification {
        let path = self._files.path().join("qualification.sock");
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let stream = rt.block_on(async {
            let listener = tokio::net::UnixListener::from_std(listener).unwrap();
            tokio::time::timeout(Duration::from_secs(3), listener.accept())
                .await
                .unwrap()
                .unwrap()
                .0
        });
        fs::remove_file(path).unwrap();
        let stream = stream.into_std().unwrap();
        stream.set_nonblocking(false).unwrap();
        ReleaseQualification(stream)
    }
    fn announcement(&self, scope: Option<BindingScope>) -> SessionAnnouncement {
        SessionAnnouncement {
            adapter_id: "claude_code_mod".into(),
            external_session_id: "original-session".into(),
            cwd: self.options.project_root.to_str().unwrap().into(),
            host_version: "2.1.287".into(),
            plugin: LoadedPlugin {
                name: "ariadne".into(),
                root: self.loaded.to_str().unwrap().into(),
            },
            descriptor: ModDescriptor {
                helper_path: self.options.helper.to_str().unwrap().into(),
                app_version: "0.1.0".into(),
                api_version: 1,
            },
            binding_scope: scope,
        }
    }
}
fn read(core: &NativeCoreService, project: UuidV4, session: UuidV4) -> Session {
    let context = QueryContext::owner(OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(project, session),
    )));
    let QueryResult::SessionGet(snapshot) =
        core.query(context, QueryRequest::SessionGet {}).unwrap()
    else {
        panic!()
    };
    snapshot.session
}

#[test]
fn claude_receipt_precedes_bound_activation_and_real_dispatch_authority() {
    claude_activation(false);
}

#[test]
fn claude_session_end_rejects_active_shortcuts_and_activation_after_restart() {
    claude_activation(true);
}

fn claude_activation(terminal: bool) {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(3)
        .enable_all()
        .build()
        .unwrap();
    let files = Fixture::new();
    let home = home();
    let ids = Arc::new(AtomicU64::new(100));
    let allocated = ids.clone();
    let core = Arc::new(NativeCoreService::new(
        AgentResolver::open_data_directory(home.path()).unwrap(),
        move || id(allocated.fetch_add(1, Ordering::SeqCst)),
        at,
        |_| panic!("native callback owns provider qualification"),
    ));
    let MutationReceipt::ProjectRegistered(project) = core
        .execute_owner(
            OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
            OwnerCommand::ProjectRegister {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(1),
                params: ProjectRegisterParams {
                    canonical_root: files.options.project_root.to_str().unwrap().into(),
                },
            },
        )
        .unwrap()
    else {
        panic!()
    };
    let root_core = core.clone();
    let roots: Arc<ProjectRootResolver> = Arc::new(move |project| {
        root_core
            .registry()
            .resolve_project(project)
            .map(|p| p.root)
            .map_err(|_| {
                CoreError::new(
                    CoreErrorCode::NotFound,
                    "Fixture project missing.",
                    "Retain the original project.",
                )
            })
    });
    let discovery = Discovery::new(
        Arc::new(at),
        Some(registered_announcement_resolver(
            core.clone(),
            roots.clone(),
        )),
    );
    let facts_ids = ids.clone();
    let factory = ProviderFactory::new(
        roots,
        discovery.clone(),
        Some(files.options.clone()),
        None,
        NativeFacts {
            next_id: Arc::new(move || id(ids.fetch_add(1, Ordering::SeqCst))),
            now: Arc::new(at),
        },
        ProviderInstructions {
            claude: "Fixture canonical agent guidance.".into(),
            codex: "Fixture canonical agent guidance.".into(),
        },
    );
    let owner = Arc::new(DesktopOwner::acquire(home.path()).unwrap());
    let routes = ControlRoutes::new();
    let outcomes = Arc::new(Mutex::new(Vec::new()));
    let reported = outcomes.clone();
    let (stopped, observed) = std::sync::mpsc::channel();
    let activation = NativeActivation::new(
        core.clone(),
        factory,
        owner.clone(),
        routes.clone(),
        rt.handle().clone(),
        Arc::new(move |outcome| {
            if matches!(&outcome, ActivationOutcome::Stopped { .. }) {
                let _ = stopped.send(());
            }
            reported.lock().unwrap().push(outcome);
        }),
    );
    let server = ControlServer::bind_shared(owner.clone(), core.clone(), vec![])
        .unwrap()
        .with_routes(routes)
        .with_discovery(discovery.clone())
        .with_native_connect(activation.connect_callback())
        .with_native_announcement(activation.announcement_callback());
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let task = rt.spawn(server.serve(stopped));
    let announcement = wire_request(
        id(2),
        ControlMethod::SessionAnnouncement(files.announcement(None)),
    );
    assert!(matches!(
        rt.block_on(call(home.path().into(), announcement)).unwrap(),
        ControlResult::Announcement(_)
    ));
    let request = OwnerMutationRequest {
        session: None,
        command: OwnerCommand::BindingConnect {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(3),
            params: BindingConnectParams {
                project_id: project.project_id.clone(),
                adapter_id: "claude_code_mod".into(),
                external_session_id: "original-session".into(),
                endpoint: EndpointRef::LocalBridge {
                    name: "claude-mod".into(),
                },
                configuration: AdapterConfig {
                    namespace: "claude_code_mod".into(),
                    values: UniqueMap(Default::default()),
                },
                existing_session_id: None,
            },
        },
    };
    let control = wire_request(
        id(3),
        ControlMethod::BindingConnect(Box::new(request.clone())),
    );
    let ControlResult::BindingConnect(receipt) = rt
        .block_on(call(home.path().into(), control.clone()))
        .unwrap()
    else {
        panic!()
    };
    let MutationReceipt::Session(saved) = &receipt else {
        panic!()
    };
    let SavedReceiptData::BindingConnect {
        binding_id,
        generation,
        ..
    } = &saved.data
    else {
        panic!()
    };
    let scope = BindingScope {
        binding_id: binding_id.clone(),
        generation: generation.clone(),
    };
    let session_id = saved.session_id.clone();
    let initial = read(&core, project.project_id.clone(), session_id.clone());
    assert_eq!(
        initial.bindings.0[binding_id].connection_state,
        ConnectionState::Unknown
    );
    assert_eq!(
        initial.bindings.0[binding_id].dispatch_state,
        DispatchState::Disconnected
    );
    let claim = wire_request(
        id(4),
        ControlMethod::Claim(ClaimRequest {
            binding_id: binding_id.clone(),
            generation: generation.clone(),
            request_id: id(4),
        }),
    );
    assert_eq!(
        rt.block_on(call(home.path().into(), claim.clone()))
            .unwrap_err()
            .code,
        CoreErrorCode::NotFound
    );
    assert_eq!(
        activation
            .bootstrap_before(request.clone(), Instant::now() - Duration::from_secs(1))
            .unwrap(),
        receipt
    );
    core.execute_owner(
        OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
            RegisteredSession::from_trusted_entrypoint(
                project.project_id.clone(),
                session_id.clone(),
            ),
        )),
        OwnerCommand::BindingPause {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(5),
            params: BindingStateParams {
                binding_id: binding_id.clone(),
                expected_generation: generation.clone(),
            },
        },
    )
    .unwrap();
    let mut wrong = scope.clone();
    wrong.generation = id(999);
    assert_eq!(
        rt.block_on(call(
            home.path().into(),
            wire_request(
                id(6),
                ControlMethod::SessionAnnouncement(files.announcement(Some(wrong)))
            )
        ))
        .unwrap_err()
        .code,
        CoreErrorCode::StaleGeneration
    );
    rt.block_on(call(
        home.path().into(),
        wire_request(
            id(7),
            ControlMethod::SessionAnnouncement(files.announcement(Some(scope.clone()))),
        ),
    ))
    .unwrap();
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        match rt.block_on(call(
            home.path().into(),
            wire_request(id(8), ControlMethod::Ping(scope.clone())),
        )) {
            Ok(ControlResult::Ping(_)) => break,
            Err(error) if error.code == CoreErrorCode::NotFound && Instant::now() < until => {
                std::thread::sleep(Duration::from_millis(10))
            }
            other => panic!("route publication: {other:?}"),
        }
    }
    let connected = read(&core, project.project_id.clone(), session_id.clone());
    assert_eq!(
        connected.bindings.0[binding_id].connection_state,
        ConnectionState::Connected
    );
    assert_eq!(
        connected.bindings.0[binding_id].dispatch_state,
        DispatchState::Paused
    );
    assert!(connected.bindings.0[binding_id].owner_paused);
    let ids_before = facts_ids.load(Ordering::SeqCst);
    rt.block_on(call(
        home.path().into(),
        wire_request(
            id(9),
            ControlMethod::SessionAnnouncement(files.announcement(Some(scope.clone()))),
        ),
    ))
    .unwrap();
    assert_eq!(
        facts_ids.load(Ordering::SeqCst),
        ids_before,
        "heartbeat must preserve the existing adapter instance/supervisor/lease"
    );
    // Wake invalidation cannot renew the retained announcement's evidence. The
    // next independently qualified heartbeat must reuse the same active slot.
    let qualification = files.pause_qualification(&rt);
    discovery.refresh_after_wake().unwrap();
    assert_eq!(
        activation
            .announce_before(scope.clone(), Instant::now() + Duration::from_secs(2))
            .unwrap_err()
            .code,
        CoreErrorCode::InvalidArgument
    );
    let mut wrong_active = scope.clone();
    wrong_active.generation = id(998);
    assert_eq!(
        activation
            .announce_before(wrong_active, Instant::now() + Duration::from_secs(2))
            .unwrap_err()
            .code,
        CoreErrorCode::StaleGeneration
    );
    drop(qualification);
    assert_eq!(
        observed.recv_timeout(Duration::from_secs(3)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout),
        "clearing evidence during observation must preserve the supervisor"
    );
    rt.block_on(call(
        home.path().into(),
        wire_request(
            id(10),
            ControlMethod::SessionAnnouncement(files.announcement(Some(scope.clone()))),
        ),
    ))
    .unwrap();
    assert_eq!(facts_ids.load(Ordering::SeqCst), ids_before);
    // The refreshed evidence must be observed by that retained worker. Reaching
    // another qualification proves progress past the interrupted observation;
    // the heartbeat alone cannot prove the worker resumed its polling loop.
    let qualification = files.pause_qualification(&rt);
    assert!(outcomes.lock().unwrap().is_empty());
    // Clear the evidence again before releasing the last process barrier. This
    // also keeps later polls from starting fresh version subprocesses at Quit.
    discovery.refresh_after_wake().unwrap();
    drop(qualification);
    assert_eq!(
        observed.recv_timeout(Duration::from_secs(3)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout),
        "the retained worker must also survive its next observation"
    );
    assert!(rt.block_on(call(home.path().into(), claim)).is_err());
    assert_eq!(
        rt.block_on(call(home.path().into(), control)).unwrap(),
        ControlResult::BindingConnect(receipt.clone())
    );
    assert_eq!(
        read(&core, project.project_id.clone(), session_id.clone())
            .bindings
            .0[binding_id]
            .generation,
        *generation
    );
    if terminal {
        let ended = ariadne_agent_protocol::NormalizedEvent {
            event_id: ariadne_agent_protocol::claude_session_end_event_id(binding_id, generation),
            binding_id: binding_id.clone(),
            generation: generation.clone(),
            input_id: None,
            attempt_id: None,
            host_turn_id: None,
            observed_at: at(),
            event: ariadne_agent_protocol::EventPayload::Disconnected { reason: None },
        };
        let context = AdapterContext::from_trusted_entrypoint(
            RegisteredSession::from_trusted_entrypoint(
                project.project_id.clone(),
                session_id.clone(),
            ),
            binding_id.clone(),
            generation.clone(),
            None,
        );
        core.report(context, ended).unwrap();
        for result in [
            activation
                .activate_registered_before(scope.clone(), Instant::now() + Duration::from_secs(2)),
            activation.announce_before(scope.clone(), Instant::now() + Duration::from_secs(2)),
            activation.resolve_announcement(&scope).map(|_| ()),
        ] {
            assert_eq!(result.unwrap_err().code, CoreErrorCode::HostUnreachable);
        }
    }
    rt.block_on(activation.shutdown()).unwrap();
    stop.send(()).unwrap();
    rt.block_on(task).unwrap().unwrap();
    let after = read(&core, project.project_id.clone(), session_id.clone());
    assert_eq!(after.bindings.0[binding_id].generation, *generation);
    assert_eq!(
        after.bindings.0[binding_id].connection_state,
        if terminal {
            ConnectionState::Disconnected
        } else {
            ConnectionState::Connected
        }
    );
    assert!(outcomes.lock().unwrap().iter().all(|outcome| matches!(outcome, ActivationOutcome::Stopped { exit: Ok(exit), .. } if exit.error.is_none() && exit.pending.is_none())));
    drop(activation);
    drop(owner);
    DesktopOwner::acquire(home.path()).unwrap();
    let event = ariadne_agent_protocol::NormalizedEvent {
        event_id: "fixture:after-desktop-exit".into(),
        binding_id: binding_id.clone(),
        generation: generation.clone(),
        input_id: None,
        attempt_id: None,
        host_turn_id: None,
        observed_at: at(),
        event: ariadne_agent_protocol::EventPayload::Disconnected {
            reason: Some("Explicit fixture host report after desktop exit.".into()),
        },
    };
    let context = AdapterContext::from_trusted_entrypoint(
        RegisteredSession::from_trusted_entrypoint(project.project_id, session_id),
        binding_id.clone(),
        generation.clone(),
        None,
    );
    core.report(context.clone(), event.clone())
        .unwrap()
        .validate_for(&context, &event)
        .unwrap();
    if terminal {
        // Reopen real persisted Core/Store and construct a fresh activation. The
        // end receipt is authoritative before any host qualification or route.
        let allocated = facts_ids.clone();
        let reopened = Arc::new(NativeCoreService::new(
            AgentResolver::open_data_directory(home.path()).unwrap(),
            move || id(allocated.fetch_add(1, Ordering::SeqCst)),
            at,
            |_| panic!("restart cannot qualify terminal generation"),
        ));
        let native = reopened.clone();
        let roots: Arc<ProjectRootResolver> =
            Arc::new(move |project| Ok(native.registry().resolve_project(project)?.root));
        let discovery = Discovery::new(
            Arc::new(at),
            Some(registered_announcement_resolver(
                reopened.clone(),
                roots.clone(),
            )),
        );
        let allocated = facts_ids.clone();
        let factory = ProviderFactory::new(
            roots,
            discovery,
            Some(files.options.clone()),
            None,
            NativeFacts {
                next_id: Arc::new(move || id(allocated.fetch_add(1, Ordering::SeqCst))),
                now: Arc::new(at),
            },
            ProviderInstructions {
                claude: "Retain terminal scope.".into(),
                codex: "Unused".into(),
            },
        );
        let routes = ControlRoutes::new();
        let restarted = NativeActivation::new(
            reopened,
            factory,
            Arc::new(DesktopOwner::acquire(home.path()).unwrap()),
            routes,
            rt.handle().clone(),
            Arc::new(|_| {}),
        );
        assert_eq!(
            restarted
                .activate_registered_before(scope.clone(), Instant::now() + Duration::from_secs(2))
                .unwrap_err()
                .code,
            CoreErrorCode::HostUnreachable
        );
        assert_eq!(
            restarted
                .announce_before(scope, Instant::now() + Duration::from_secs(2))
                .unwrap_err()
                .code,
            CoreErrorCode::HostUnreachable
        );
        rt.block_on(restarted.shutdown()).unwrap();
    }
}

struct CodexDaemon {
    _home: tempfile::TempDir,
    options: ariadne_adapter_codex::CodexOptions,
    endpoint: EndpointRef,
    calls: Arc<Mutex<Vec<String>>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl CodexDaemon {
    fn new(root: PathBuf, wrong_final_root: bool) -> Self {
        use std::os::unix::net::UnixListener;
        let home = home();
        let executable = home.path().join("codex");
        fs::write(&executable, "#!/bin/sh\n[ \"$#\" = 1 ] && [ \"$1\" = --version ] || exit 3\nprintf 'codex-cli 0.160.0\\n'\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = home.path().join("daemon.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let observed = calls.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stopped = stop.clone();
        let worker = std::thread::spawn(move || {
            let stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if stopped.load(Ordering::Acquire) {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(e) => panic!("fixture accept: {e}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            let mut reads = 0;
            while let Ok(message) = ws.read() {
                let tungstenite::Message::Text(text) = message else {
                    continue;
                };
                let request: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
                let method = request["method"].as_str().unwrap();
                observed.lock().unwrap().push(method.to_owned());
                if method == "initialized" {
                    continue;
                }
                let fixture = match method {
                    "initialize" => "initialize-response.json",
                    "thread/read" => "read-response.json",
                    "thread/queue/list" => "queue-response.json",
                    "thread/turns/list" => "turns-response.json",
                    other => panic!("unexpected provider mutation: {other}"),
                };
                let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../contracts/providers/codex/0.160.0/fixtures")
                    .join(fixture);
                let mut result: serde_json::Value =
                    serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
                if method == "thread/read" {
                    reads += 1;
                    result["thread"]["id"] = request["params"]["threadId"].clone();
                    result["thread"]["cwd"] = serde_json::json!(if wrong_final_root && reads > 1 {
                        PathBuf::from("/tmp")
                    } else {
                        root.clone()
                    });
                }
                if ws
                    .send(tungstenite::Message::Text(
                        serde_json::json!({"id":request["id"],"result":result})
                            .to_string()
                            .into(),
                    ))
                    .is_err()
                {
                    break;
                }
            }
        });
        Self {
            options: ariadne_adapter_codex::CodexOptions::new(executable, home.path().into())
                .unwrap(),
            _home: home,
            endpoint: EndpointRef::UnixSocket {
                path: socket.to_str().unwrap().into(),
            },
            calls,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for CodexDaemon {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}
fn codex_activation(wrong_final_root: bool) {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(3)
        .enable_all()
        .build()
        .unwrap();
    let project = home();
    let home = home();
    let root = project.path().canonicalize().unwrap();
    let daemon = CodexDaemon::new(root.clone(), wrong_final_root);
    let next = Arc::new(AtomicU64::new(200));
    let allocated = next.clone();
    let core = Arc::new(NativeCoreService::new(
        AgentResolver::open_data_directory(home.path()).unwrap(),
        move || id(allocated.fetch_add(1, Ordering::SeqCst)),
        at,
        |_| panic!("request-local native qualification"),
    ));
    let MutationReceipt::ProjectRegistered(project) = core
        .execute_owner(
            OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
            OwnerCommand::ProjectRegister {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(20),
                params: ProjectRegisterParams {
                    canonical_root: root.to_str().unwrap().into(),
                },
            },
        )
        .unwrap()
    else {
        panic!()
    };
    let native = core.clone();
    let roots: Arc<ProjectRootResolver> =
        Arc::new(move |id| Ok(native.registry().resolve_project(id).unwrap().root));
    let factory = ProviderFactory::new(
        roots,
        Discovery::new(Arc::new(at), None),
        None,
        Some(daemon.options.clone()),
        NativeFacts {
            next_id: Arc::new(move || id(next.fetch_add(1, Ordering::SeqCst))),
            now: Arc::new(at),
        },
        ProviderInstructions {
            claude: "Fixture agent guidance.".into(),
            codex: "Fixture agent guidance.".into(),
        },
    );
    let owner = Arc::new(DesktopOwner::acquire(home.path()).unwrap());
    let routes = ControlRoutes::new();
    let outcomes = Arc::new(Mutex::new(Vec::new()));
    let reported = outcomes.clone();
    let activation = NativeActivation::new(
        core.clone(),
        factory,
        owner.clone(),
        routes.clone(),
        rt.handle().clone(),
        Arc::new(move |outcome| reported.lock().unwrap().push(outcome)),
    );
    let server = ControlServer::bind_shared(owner.clone(), core.clone(), vec![])
        .unwrap()
        .with_routes(routes)
        .with_native_connect(activation.connect_callback());
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let task = rt.spawn(server.serve(stopped));
    let request = OwnerMutationRequest {
        session: None,
        command: OwnerCommand::BindingConnect {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(21),
            params: BindingConnectParams {
                project_id: project.project_id.clone(),
                adapter_id: "codex".into(),
                external_session_id: "selected-thread".into(),
                endpoint: daemon.endpoint.clone(),
                configuration: AdapterConfig {
                    namespace: "codex".into(),
                    values: UniqueMap(Default::default()),
                },
                existing_session_id: None,
            },
        },
    };
    let wire = wire_request(id(21), ControlMethod::BindingConnect(Box::new(request)));
    let ControlResult::BindingConnect(receipt) =
        rt.block_on(call(home.path().into(), wire.clone())).unwrap()
    else {
        panic!()
    };
    let MutationReceipt::Session(saved) = &receipt else {
        panic!()
    };
    let SavedReceiptData::BindingConnect {
        binding_id,
        generation,
        ..
    } = &saved.data
    else {
        panic!()
    };
    let scope = BindingScope {
        binding_id: binding_id.clone(),
        generation: generation.clone(),
    };
    let until = Instant::now() + Duration::from_secs(3);
    if wrong_final_root {
        assert_eq!(
            rt.block_on(call(
                home.path().into(),
                wire_request(id(22), ControlMethod::Ping(scope.clone()))
            ))
            .unwrap_err()
            .code,
            CoreErrorCode::NotFound
        );
        assert_eq!(
            read(&core, project.project_id.clone(), saved.session_id.clone())
                .bindings
                .0[binding_id]
                .connection_state,
            ConnectionState::Disconnected
        );
        assert!(outcomes.lock().unwrap().iter().any(|outcome| matches!(outcome, ActivationOutcome::ConnectFailed { failure, .. } if failure.cause.code==CoreErrorCode::BindingMismatch && failure.pending.is_none())));
    } else {
        loop {
            match rt.block_on(call(
                home.path().into(),
                wire_request(id(22), ControlMethod::Ping(scope.clone())),
            )) {
                Ok(ControlResult::Ping(_)) => break,
                Err(error) if error.code == CoreErrorCode::NotFound && Instant::now() < until => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                other => panic!("Codex route: {other:?}"),
            }
        }
        assert_eq!(
            read(&core, project.project_id.clone(), saved.session_id.clone())
                .bindings
                .0[binding_id]
                .dispatch_state,
            DispatchState::Enabled
        );
        let claim = wire_request(
            id(23),
            ControlMethod::Claim(ClaimRequest {
                binding_id: binding_id.clone(),
                generation: generation.clone(),
                request_id: id(23),
            }),
        );
        assert_eq!(
            rt.block_on(call(home.path().into(), claim)).unwrap(),
            ControlResult::Claim(None)
        );
    }
    assert_eq!(
        rt.block_on(call(home.path().into(), wire)).unwrap(),
        ControlResult::BindingConnect(receipt.clone())
    );
    let calls = daemon.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|method| *method == "initialize")
            .count(),
        1
    );
    assert!(
        calls
            .iter()
            .filter(|method| *method == "thread/read")
            .count()
            >= 2
    );
    drop(calls);
    rt.block_on(activation.shutdown()).unwrap();
    stop.send(()).unwrap();
    rt.block_on(task).unwrap().unwrap();
}
#[test]
fn codex_owns_one_preflight_reader_then_rechecks_final_ids_before_route_activation() {
    codex_activation(false);
}
#[test]
fn codex_changed_final_root_reports_disconnect_without_route_or_new_preflight() {
    codex_activation(true);
}
