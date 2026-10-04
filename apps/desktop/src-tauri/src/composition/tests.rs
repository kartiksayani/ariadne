use super::*;
use ariadne_adapter_claude::ClaudeOptions;
use ariadne_core::*;
use ariadne_domain::models::*;
use ariadne_runtime::{control::*, discovery::*, leases::DesktopOwner};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn invoke(
    runtime: &Arc<NativeRuntime>,
    name: &str,
    request: serde_json::Value,
) -> serde_json::Value {
    let app = tauri::test::mock_builder()
        .manage(runtime.bridge().desktop_service())
        .invoke_handler(crate::desktop_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    tauri::test::get_ipc_response(
        &window,
        tauri::webview::InvokeRequest {
            cmd: name.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({"request":request})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .unwrap()
    .deserialize()
    .unwrap()
}
pub(super) struct Fixture {
    _home: tempfile::TempDir,
    home: PathBuf,
    root: PathBuf,
    plugin: PathBuf,
    helper: PathBuf,
    executable: PathBuf,
}
impl Fixture {
    pub(super) fn new() -> Self {
        let home = tempfile::Builder::new()
            .prefix("ariadne-composition-")
            .tempdir_in("/tmp")
            .unwrap();
        let base = home.path().canonicalize().unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        let root = base.join("project");
        fs::create_dir(&root).unwrap();
        let plugin = base.join("plugin");
        for (name, body) in [
            (
                ".claude-plugin/plugin.json",
                "{\"name\":\"ariadne\",\"version\":\"0.1.0\"}",
            ),
            ("hooks/hooks.json", "{}"),
            ("hooks/register.js", "// fixture"),
            ("hooks/contracts.js", "// fixture"),
            ("hooks/setup.js", "// fixture"),
            ("hooks/claims.js", "// fixture"),
            ("hooks/discovery.js", "// fixture"),
            ("hooks/installed.js", "export default null;"),
            ("skills/ariadne/SKILL.md", "# Local scripted provider"),
        ] {
            let file = plugin.join(name);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, body).unwrap();
        }
        let helper = base.join("ariadne");
        let executable = base.join("claude");
        for (path, version) in [
            (&helper, "ariadne 0.1.0"),
            (&executable, "2.1.287 (Claude Code)"),
        ] {
            fs::write(path, format!("#!/bin/sh\n[ \"$#\" = 1 ] && [ \"$1\" = --version ] || exit 3\nprintf '%s\\n' '{version}'\n")).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self {
            _home: home,
            home: base.join("data"),
            root,
            plugin,
            helper,
            executable,
        }
    }
    pub(super) fn configuration(&self) -> NativeConfiguration {
        NativeConfiguration {
            home: self.home.clone(),
            codex: None,
            discovery_endpoints: vec![],
            claude: Some(ClaudeOptions {
                executable: self.executable.clone(),
                helper: self.helper.clone(),
                installed_plugin: self.plugin.clone(),
                project_root: self.root.clone(),
                app_version: "0.1.0".into(),
            }),
        }
    }
    fn announcement(&self, scope: Option<BindingScope>) -> SessionAnnouncement {
        SessionAnnouncement {
            adapter_id: "claude_code_mod".into(),
            external_session_id: "fixture-original".into(),
            cwd: self.root.to_str().unwrap().into(),
            host_version: "2.1.287".into(),
            plugin: LoadedPlugin {
                name: "ariadne".into(),
                root: self.plugin.to_str().unwrap().into(),
            },
            descriptor: ModDescriptor {
                helper_path: self.helper.to_str().unwrap().into(),
                app_version: "0.1.0".into(),
                api_version: 1,
            },
            binding_scope: scope,
        }
    }
    fn call(&self, n: u64, method: ControlMethod) -> Result<ControlResult, CoreError> {
        call_blocking(
            self.home.clone(),
            ControlRequest::new(id(n), method).unwrap(),
        )
    }
    pub(super) fn connected(
        &self,
        runtime: &Arc<NativeRuntime>,
    ) -> (
        SessionRef,
        BindingScope,
        OwnerMutationRequest,
        MutationReceipt,
    ) {
        let request = self.connect_request(runtime);
        let core = runtime.bridge().core().clone();
        let response = invoke(
            runtime,
            "binding_connect",
            serde_json::to_value(&request).unwrap(),
        );
        assert_eq!(response["ok"], true);
        let receipt: MutationReceipt = serde_json::from_value(response["data"].clone()).unwrap();
        let MutationReceipt::Session(saved) = &receipt else {
            panic!("saved setup")
        };
        let SavedReceiptData::BindingConnect {
            binding_id,
            generation,
            setup_instruction,
            ..
        } = &saved.data
        else {
            panic!("setup")
        };
        assert!(
            setup_instruction.contains(include_str!("../../../../../integrations/rules/claude.md"))
        );
        let scope = BindingScope {
            binding_id: binding_id.clone(),
            generation: generation.clone(),
        };
        let OwnerCommand::BindingConnect { params, .. } = &request.command else {
            panic!("connect request")
        };
        let session = SessionRef {
            project_id: params.project_id.clone(),
            session_id: saved.session_id.clone(),
        };
        assert_eq!(
            self.call(4, ControlMethod::Ping(scope.clone()))
                .unwrap_err()
                .code,
            CoreErrorCode::NotFound
        );
        core.execute_owner(
            OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
                core.resolve_session(&session).unwrap(),
            )),
            OwnerCommand::BindingPause {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(5),
                params: BindingStateParams {
                    binding_id: scope.binding_id.clone(),
                    expected_generation: scope.generation.clone(),
                },
            },
        )
        .unwrap();
        self.call(
            6,
            ControlMethod::SessionAnnouncement(self.announcement(Some(scope.clone()))),
        )
        .unwrap();
        self.wait_route(&scope);
        (session, scope, request, receipt)
    }
    fn connect_request(&self, runtime: &Arc<NativeRuntime>) -> OwnerMutationRequest {
        let core = runtime.bridge().core().clone();
        let MutationReceipt::ProjectRegistered(project) = core
            .execute_owner(
                OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
                OwnerCommand::ProjectRegister {
                    api_version: SchemaVersion::new(1).unwrap(),
                    op_id: id(1),
                    params: ProjectRegisterParams {
                        canonical_root: self.root.to_str().unwrap().into(),
                    },
                },
            )
            .unwrap()
        else {
            panic!("registration")
        };
        self.call(
            2,
            ControlMethod::SessionAnnouncement(self.announcement(None)),
        )
        .unwrap();
        OwnerMutationRequest {
            session: None,
            command: OwnerCommand::BindingConnect {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(3),
                params: BindingConnectParams {
                    project_id: project.project_id.clone(),
                    adapter_id: "claude_code_mod".into(),
                    external_session_id: "fixture-original".into(),
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
        }
    }
    fn wait_route(&self, scope: &BindingScope) {
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            match self.call(7, ControlMethod::Ping(scope.clone())) {
                Ok(ControlResult::Ping(_)) => return,
                Err(error) if error.code == CoreErrorCode::NotFound && Instant::now() < until => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                other => panic!("route publication: {other:?}"),
            }
        }
    }
}
fn read(core: &ariadne_core::native::NativeCoreService, route: &SessionRef) -> Session {
    let context = QueryContext::owner(OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        core.resolve_session(route).unwrap(),
    )));
    let QueryResult::SessionGet(snapshot) =
        core.query(context, QueryRequest::SessionGet {}).unwrap()
    else {
        panic!("snapshot")
    };
    snapshot.session
}

#[test]
fn desktop_composes_canonical_receipt_control_leases_watch_and_quit_without_host_mutation() {
    let fixture = Fixture::new();
    let outcomes = Arc::new(Mutex::new(Vec::new()));
    let saved = outcomes.clone();
    let (emit, hints) = std::sync::mpsc::channel();
    let runtime = NativeRuntime::start(
        fixture.configuration(),
        Arc::new(move |outcome| saved.lock().unwrap().push(outcome)),
        Arc::new(move |hint| emit.send(hint).is_ok()),
    )
    .unwrap();
    assert!(NativeRuntime::start(
        fixture.configuration(),
        Arc::new(|_| {}),
        Arc::new(|_| true)
    )
    .is_err());
    let (route, scope, request, receipt) = fixture.connected(&runtime);
    let bridge = runtime.bridge();
    runtime.select(Some(route.clone())).unwrap();
    runtime.set_connection_ui_open(true).unwrap();
    runtime.refresh_snapshots().unwrap();
    assert_eq!(
        runtime
            .connect_before(request.clone(), Instant::now() - Duration::from_secs(1))
            .unwrap(),
        receipt
    );
    let before = read(bridge.core(), &route);
    assert!(before.bindings.0[&scope.binding_id].owner_paused);
    let hint = hints.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(hint.session_id, route.session_id);
    assert!(runtime
        .discovery()
        .unwrap()
        .candidates
        .iter()
        .any(|candidate| candidate
            .binding
            .as_ref()
            .is_some_and(|binding| binding.generation == scope.generation)));
    runtime.shutdown().unwrap();
    runtime.shutdown().unwrap();
    let after = read(bridge.core(), &route);
    assert_eq!(before, after);
    assert_eq!(
        runtime
            .connect_before(request, Instant::now() + CONTROL_TIMEOUT)
            .unwrap_err()
            .code,
        CoreErrorCode::HostUnreachable
    );
    DesktopOwner::acquire(&fixture.home).unwrap();
    assert!(outcomes.lock().unwrap().iter().all(|outcome| matches!(outcome,
        ariadne_runtime::activation::ActivationOutcome::Stopped { exit: Ok(exit), .. } if exit.pending.is_none() && exit.error.is_none())));
}

#[test]
fn wake_replaces_activation_only_after_old_monitors_exit_and_requires_fresh_bound_evidence() {
    let fixture = Fixture::new();
    let runtime = NativeRuntime::start(
        fixture.configuration(),
        Arc::new(|_| {}),
        Arc::new(|_| true),
    )
    .unwrap();
    let (route, scope, _, _) = fixture.connected(&runtime);
    let bridge = runtime.bridge();
    let before = read(bridge.core(), &route);
    assert!(runtime.reconcile_after_wake().is_err());
    assert_eq!(
        fixture
            .call(8, ControlMethod::Ping(scope.clone()))
            .unwrap_err()
            .code,
        CoreErrorCode::NotFound
    );
    fixture
        .call(
            9,
            ControlMethod::SessionAnnouncement(fixture.announcement(Some(scope.clone()))),
        )
        .unwrap();
    fixture.wait_route(&scope);
    let after = read(bridge.core(), &route);
    assert_eq!(
        after.bindings.0[&scope.binding_id].generation,
        scope.generation
    );
    assert!(after.bindings.0[&scope.binding_id].owner_paused);
    assert_eq!(before.inputs, after.inputs);
    runtime.shutdown().unwrap();
    assert!(runtime.reconcile_after_wake().is_err());
    DesktopOwner::acquire(&fixture.home).unwrap();
}

#[test]
fn shutdown_awaits_actual_started_blocking_work_and_releases_owner_after_completion() {
    let fixture = Fixture::new();
    let runtime = NativeRuntime::start(
        fixture.configuration(),
        Arc::new(|_| {}),
        Arc::new(|_| true),
    )
    .unwrap();
    let (admitted, started) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    {
        runtime.executor_for_test().spawn_blocking(move || {
            admitted.send(()).unwrap();
            released.recv().unwrap();
        });
    }
    started.recv_timeout(Duration::from_secs(1)).unwrap();
    let quitting = runtime.clone();
    let (completed, completion) = std::sync::mpsc::channel();
    let quit = std::thread::spawn(move || completed.send(quitting.shutdown()).unwrap());
    assert!(completion.recv_timeout(Duration::from_millis(100)).is_err());
    assert!(DesktopOwner::acquire(&fixture.home).is_err());
    release.send(()).unwrap();
    completion
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    quit.join().unwrap();
    DesktopOwner::acquire(&fixture.home).unwrap();
}

#[test]
fn admitted_post_deadline_core_commit_returns_the_actual_saved_receipt() {
    let fixture = Fixture::new();
    let runtime = NativeRuntime::start(
        fixture.configuration(),
        Arc::new(|_| {}),
        Arc::new(|_| true),
    )
    .unwrap();
    let core = runtime.bridge().core().clone();
    let command = OwnerCommand::ProjectRegister {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(20),
        params: ProjectRegisterParams {
            canonical_root: fixture.root.to_str().unwrap().into(),
        },
    };
    let original = Instant::now() + Duration::from_millis(30);
    let (began, started) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let admitted = runtime.clone();
    let original_command = command.clone();
    let caller = std::thread::spawn(move || {
        admitted.run_owned(super::runtime::uncertain(), move || {
            began.send(()).unwrap();
            released.recv().unwrap();
            assert!(Instant::now() >= original);
            core.execute_owner(
                OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
                original_command,
            )
        })
    });
    started.recv_timeout(Duration::from_secs(1)).unwrap();
    std::thread::sleep(original.saturating_duration_since(Instant::now()));
    release.send(()).unwrap();
    let receipt = caller.join().unwrap().unwrap();
    assert_eq!(
        runtime
            .bridge()
            .core()
            .execute_owner(
                OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
                command,
            )
            .unwrap(),
        receipt
    );
    runtime.shutdown().unwrap();
}

fn wait_file(path: &std::path::Path) {
    let end = Instant::now() + Duration::from_secs(2);
    while !path.exists() {
        assert!(
            Instant::now() < end,
            "scripted provider did not enter qualification"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn admitted_connect_drains_before_wake_and_quit_wins_without_losing_the_receipt() {
    let fixture = Fixture::new();
    let runtime = NativeRuntime::start(
        fixture.configuration(),
        Arc::new(|_| {}),
        Arc::new(|_| true),
    )
    .unwrap();
    let request = fixture.connect_request(&runtime);
    let began = fixture.root.join("qualification-started");
    let release = fixture.root.join("qualification-release");
    // Only the scripted provider is delayed; actual Core/Store and native
    // bootstrap receive the one original admission Instant.
    fs::write(
        &fixture.executable,
        format!(
            "#!/bin/sh\n[ \"$#\" = 1 ] && [ \"$1\" = --version ] || exit 3\n: > '{}'\nwhile [ ! -f '{}' ]; do sleep 0.01; done\nprintf '2.1.287 (Claude Code)\\n'\n",
            began.display(), release.display()
        ),
    )
    .unwrap();
    let admitted = runtime.clone();
    let original = request.clone();
    let connect = std::thread::spawn(move || {
        admitted.connect_before(original, Instant::now() + CONTROL_TIMEOUT)
    });
    wait_file(&began);
    let shutdown = runtime.clone();
    let waking = runtime.clone();
    let (shutdown_began, shutdown_started) = std::sync::mpsc::channel();
    let lifecycle = crate::native::window::lifecycle::NativeLifecycle::from_trusted_owner(
        move || {
            shutdown_began.send(()).unwrap();
            shutdown.shutdown()
        },
        move || waking.reconcile_after_wake(),
    );
    let waking = lifecycle.clone();
    let (wake_sent, wake_result) = std::sync::mpsc::channel();
    let wake = std::thread::spawn(move || wake_sent.send(waking.reconcile()).unwrap());
    assert!(wake_result.recv_timeout(Duration::from_millis(50)).is_err());
    // The accepted native Quit event fences before window/tray drains. The
    // actual lifecycle callback still must be reachable while wake waits.
    runtime.begin_shutdown().unwrap();
    let quitting = lifecycle.clone();
    let (quit_sent, quit_result) = std::sync::mpsc::channel();
    let quit = std::thread::spawn(move || quit_sent.send(quitting.prepare_exit()).unwrap());
    shutdown_started
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert!(quit_result.recv_timeout(Duration::from_millis(50)).is_err());
    assert!(DesktopOwner::acquire(&fixture.home).is_err());
    fs::write(&release, "release").unwrap();
    let receipt = connect.join().unwrap().unwrap();
    assert!(wake_result
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .is_err());
    quit_result
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    wake.join().unwrap();
    quit.join().unwrap();
    assert!(runtime.reconcile_after_wake().is_err());
    let MutationReceipt::Session(saved) = &receipt else {
        panic!("connect receipt")
    };
    let SavedReceiptData::BindingConnect {
        binding_id,
        generation,
        ..
    } = &saved.data
    else {
        panic!("connect IDs")
    };
    let OwnerCommand::BindingConnect { params, .. } = &request.command else {
        panic!("connect request")
    };
    let core = runtime.bridge().core().clone();
    let route = SessionRef {
        project_id: params.project_id.clone(),
        session_id: saved.session_id.clone(),
    };
    let persisted = read(&core, &route);
    assert_eq!(persisted.active_binding_id.as_ref(), Some(binding_id));
    assert_eq!(&persisted.bindings.0[binding_id].generation, generation);
    assert_eq!(
        core.connect_before(
            OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
            request.command,
            Instant::now() - Duration::from_secs(1),
            |_, _| panic!("exact replay must not qualify or reactivate a provider"),
        )
        .unwrap(),
        receipt
    );
    DesktopOwner::acquire(&fixture.home).unwrap();
}

#[test]
fn quit_confirms_frozen_native_writer_operations_on_the_real_core() {
    use crate::native::{notifications::writer::PreferenceWriter, window::WindowPreferenceWrite};
    let fixture = Fixture::new();
    let runtime = NativeRuntime::start(
        fixture.configuration(),
        Arc::new(|_| {}),
        Arc::new(|_| true),
    )
    .unwrap();
    let (session, scope, _, _) = fixture.connected(&runtime);
    let service = runtime.bridge().desktop_service();
    let mut window = WindowPreferenceWrite::default();
    let mut tray = PreferenceWriter::default();
    let mut frozen_window = None;
    let mut frozen_tray = None;
    let mut window_receipt = None;
    let mut tray_receipt = None;
    let commit_with_lost_delivery = |request: &OwnerMutationRequest, receipt: &mut Option<_>| {
        let core = runtime.bridge().core().clone();
        let original = request.clone();
        let saved = Arc::new(Mutex::new(None));
        let committed = saved.clone();
        let result = runtime.native_preferences_owned(request, move || {
            let MutationReceipt::PreferencesPatched(actual) = core.execute_owner(
                OwnerContext::from_trusted_entrypoint(OwnerScope::Preferences),
                original.command,
            )?
            else {
                panic!("actual preference receipt")
            };
            *committed.lock().unwrap() = Some(actual);
            Err(CoreError::new(
                CoreErrorCode::IoError,
                "Scripted delivery lost the already saved preference receipt.",
                "Confirm the same frozen native operation.",
            ))
        });
        *receipt = saved.lock().unwrap().clone();
        result
    };
    assert!(window
        .save(
            WindowGeometry {
                x: 10.0,
                y: 20.0,
                width: 1000.0,
                height: 700.0,
                monitor_id: None
            },
            || id(70),
            || service.native_preferences(),
            |request| {
                frozen_window = Some(request.clone());
                commit_with_lost_delivery(request, &mut window_receipt)
            },
        )
        .is_err());
    assert!(window.ready_to_exit().is_err());
    tray.pin(service.native_preferences().unwrap(), || id(71))
        .unwrap();
    assert!(tray
        .confirm(|request| {
            frozen_tray = Some(request.clone());
            commit_with_lost_delivery(request, &mut tray_receipt)
        })
        .is_err());
    assert!(tray.pending());
    let persisted = service.native_preferences().unwrap();
    assert!(persisted.global.pinned);
    assert!(persisted.global.window.is_some());
    assert_eq!(persisted.revision.value(), 3);
    let frozen = frozen_window.unwrap();
    let drain_request = frozen.clone();
    let drain_runtime = runtime.clone();
    let drain_core = runtime.bridge().core().clone();
    let (entered, draining) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let drain = std::thread::spawn(move || {
        let command = drain_request.command.clone();
        drain_runtime.native_preferences_owned(&drain_request, move || {
            entered.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(3)).unwrap();
            let MutationReceipt::PreferencesPatched(receipt) = drain_core.execute_owner(
                OwnerContext::from_trusted_entrypoint(OwnerScope::Preferences),
                command,
            )?
            else {
                panic!("preference drain receipt")
            };
            Ok(receipt)
        })
    });
    draining.recv_timeout(Duration::from_secs(3)).unwrap();
    runtime.begin_shutdown().unwrap();
    // Accepted Quit must fence the activation's own route/gate immediately,
    // even while an actual admitted native preference closure is still held.
    assert_eq!(
        fixture
            .call(
                72,
                ControlMethod::Claim(ClaimRequest {
                    binding_id: scope.binding_id.clone(),
                    generation: scope.generation.clone(),
                    request_id: id(72),
                })
            )
            .unwrap_err()
            .code,
        CoreErrorCode::NotFound
    );
    assert!(DesktopOwner::acquire(&fixture.home).is_err());
    let QueryResult::SessionGet(current) = runtime
        .bridge()
        .core()
        .query(
            QueryContext::owner(OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
                runtime.bridge().core().resolve_session(&session).unwrap(),
            ))),
            QueryRequest::SessionGet {},
        )
        .unwrap()
    else {
        panic!("session")
    };
    assert_eq!(
        current.session.bindings.0[&scope.binding_id].generation,
        scope.generation
    );
    release.send(()).unwrap();
    assert_eq!(Some(drain.join().unwrap().unwrap()), window_receipt);
    let mut changed = frozen.clone();
    let OwnerCommand::PreferencesPatch { params, .. } = &mut changed.command else {
        panic!("patch")
    };
    params.expected_preferences_revision = persisted.revision;
    assert!(service.native_preferences_write(&changed).is_err());
    assert!(runtime
        .bridge()
        .execute_owner(
            OwnerContext::from_trusted_entrypoint(OwnerScope::Preferences),
            frozen.command.clone(),
        )
        .is_err());
    assert!(runtime
        .run_owned::<()>(super::runtime::uncertain(), || panic!(
            "no fresh claim/connect admission"
        ))
        .is_err());
    window
        .confirm(|request| {
            assert_eq!(request, &frozen);
            let actual = service.native_preferences_write(request)?;
            assert_eq!(Some(actual.clone()), window_receipt);
            Ok(actual)
        })
        .unwrap();
    window.ready_to_exit().unwrap();
    tray.confirm(|request| {
        assert_eq!(Some(request), frozen_tray.as_ref());
        let actual = service.native_preferences_write(request)?;
        assert_eq!(Some(actual.clone()), tray_receipt);
        Ok(actual)
    })
    .unwrap();
    assert!(!tray.pending());
    // Query actual canonical preferences without reopening runtime admission.
    let QueryResult::PreferencesGet(after) = runtime
        .bridge()
        .core()
        .query(
            QueryContext::owner(OwnerContext::from_trusted_entrypoint(
                OwnerScope::Preferences,
            )),
            QueryRequest::PreferencesGet {},
        )
        .unwrap()
    else {
        panic!("preferences")
    };
    assert_eq!(after, persisted);
    assert!(DesktopOwner::acquire(&fixture.home).is_err());
    runtime.shutdown().unwrap();
    drop(DesktopOwner::acquire(&fixture.home).unwrap());
}

#[test]
fn admitted_real_core_claim_retains_its_physical_lease_until_quit_drains_it() {
    let fixture = Fixture::new();
    let runtime = NativeRuntime::start(
        fixture.configuration(),
        Arc::new(|_| {}),
        Arc::new(|_| true),
    )
    .unwrap();
    let request = fixture.connect_request(&runtime);
    let MutationReceipt::Session(saved) = runtime
        .connect_before(request.clone(), Instant::now() + CONTROL_TIMEOUT)
        .unwrap()
    else {
        panic!("session")
    };
    let SavedReceiptData::BindingConnect {
        binding_id,
        generation,
        ..
    } = saved.data
    else {
        panic!("binding")
    };
    let OwnerCommand::BindingConnect { params, .. } = request.command else {
        panic!("request")
    };
    let route = SessionRef {
        project_id: params.project_id,
        session_id: saved.session_id,
    };
    let scope = BindingScope {
        binding_id: binding_id.clone(),
        generation: generation.clone(),
    };
    let lease = runtime.lease_for_test(&route, scope);
    let context = ValidatedDispatchContext::from_trusted_current_lease(
        lease.session().clone(),
        binding_id.clone(),
        generation.clone(),
    );
    let core = runtime.bridge().core().clone();
    let before = read(&core, &route);
    let (began, started) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let admitted = runtime.clone();
    let claim = std::thread::spawn(move || {
        admitted.run_owned(super::runtime::uncertain(), move || {
            began.send(()).unwrap();
            released.recv().unwrap();
            let result = core.claim(
                context,
                ClaimRequest {
                    binding_id,
                    generation,
                    request_id: id(30),
                },
            );
            drop(lease);
            result
        })
    });
    started.recv_timeout(Duration::from_secs(1)).unwrap();
    let quitting = runtime.clone();
    let (sent, completion) = std::sync::mpsc::channel();
    let quit = std::thread::spawn(move || sent.send(quitting.shutdown()).unwrap());
    assert!(completion.recv_timeout(Duration::from_millis(50)).is_err());
    assert!(DesktopOwner::acquire(&fixture.home).is_err());
    release.send(()).unwrap();
    assert_eq!(
        claim.join().unwrap().unwrap_err().code,
        CoreErrorCode::HostUnreachable
    );
    completion
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    quit.join().unwrap();
    let after = read(runtime.bridge().core(), &route);
    assert_eq!(before.active_binding_id, after.active_binding_id);
    assert_eq!(before.bindings, after.bindings);
    assert_eq!(before.inputs, after.inputs);
    DesktopOwner::acquire(&fixture.home).unwrap();
}
