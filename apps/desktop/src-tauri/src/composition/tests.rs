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
        let request = OwnerMutationRequest {
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
        };
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
        let session = SessionRef {
            project_id: project.project_id,
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
