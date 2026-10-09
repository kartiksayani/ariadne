use super::*;
use ariadne_core::fake::{RecordedRequest, ScriptStep, ScriptedCoreService, ScriptedResponse};
use ariadne_domain::models::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::Listener;

fn inventory() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../../fixtures/contracts/core/inventory.json"
    ))
    .unwrap()
}
fn fixture_session() -> Session {
    serde_json::from_str(include_str!(
        "../../../../../../fixtures/domain/demo/session.json"
    ))
    .unwrap()
}
fn route() -> SessionRef {
    let session = fixture_session();
    SessionRef {
        project_id: session.project_id,
        session_id: session.id,
    }
}
fn context(route: &SessionRef) -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(
            route.project_id.clone(),
            route.session_id.clone(),
        ),
    ))
}
fn resolve(route: &SessionRef) -> Result<RegisteredSession, CoreError> {
    Ok(RegisteredSession::from_trusted_entrypoint(
        route.project_id.clone(),
        route.session_id.clone(),
    ))
}
fn failure<T>(value: &ApplicationEnvelope<T>) -> &CoreError {
    match value {
        ApplicationEnvelope::Failure(value) => &value.error,
        _ => panic!("Expected failure"),
    }
}
struct TestWindow {
    _app: tauri::App<MockRuntime>,
    window: tauri::WebviewWindow<MockRuntime>,
}
fn window(service: DesktopService) -> TestWindow {
    let app = mock_builder()
        .manage(service)
        .invoke_handler(crate::desktop_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    TestWindow { _app: app, window }
}
fn invoke(window: &TestWindow, name: &str, body: Value) -> Result<Value, Value> {
    get_ipc_response(
        &window.window,
        tauri::webview::InvokeRequest {
            cmd: name.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|value| value.deserialize().unwrap())
}

#[test]
fn actual_ipc_offloads_registration_and_core_calls_from_command_threads() {
    let query = QueryRequest::SessionGet {};
    let inventory = inventory();
    let command: OwnerCommand = serde_json::from_value(
        inventory["owner_commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["command"] == "input_submit")
            .unwrap()
            .clone(),
    )
    .unwrap();
    let error = CoreError::new(
        CoreErrorCode::IoError,
        "Test read failed.",
        "Check test access.",
    );
    let core = Arc::new(ScriptedCoreService::new([
        ScriptStep {
            request: RecordedRequest::Query(
                QueryContext::owner(context(&route())),
                Box::new(query.clone()),
            ),
            response: ScriptedResponse::Query(Box::new(Err(error.clone()))),
        },
        ScriptStep {
            request: RecordedRequest::Owner(context(&route()), Box::new(command.clone())),
            response: ScriptedResponse::Owner(Box::new(Err(error))),
        },
    ]));
    let (send, receive) = std::sync::mpsc::channel();
    let window = window(DesktopService::from_trusted_startup(
        core.clone(),
        move |route| {
            send.send(std::thread::current().id()).unwrap();
            resolve(route)
        },
    ));
    let ipc_thread = std::thread::current().id();
    for (name, request) in [
        (
            "session_get",
            json!(OwnerQueryRequest {
                session: Some(route()),
                request: query
            }),
        ),
        (
            "input_submit",
            json!(OwnerMutationRequest {
                session: Some(route()),
                command
            }),
        ),
    ] {
        let response = invoke(&window, name, json!({"request":request})).unwrap();
        assert_eq!(response["error"]["code"], "io_error");
        assert_ne!(
            receive
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap(),
            ipc_thread
        );
    }
    // The actual blocking closure also asserts its callback is off the async
    // command executor thread. The scripted core proves each routed call arrived.
    assert_eq!(core.remaining().unwrap(), 0);
    assert_eq!(core.history().unwrap().len(), 2);
}

#[test]
fn terminated_workers_preserve_read_failure_and_unknown_mutation_completion() {
    let core = Arc::new(ScriptedCoreService::new([]));
    let window = window(DesktopService::from_trusted_startup(core.clone(), |_| {
        panic!("Test-owned resolver panic must not appear in a wire error")
    }));
    let response = invoke(
        &window,
        "session_get",
        json!({"request":OwnerQueryRequest {
            session: Some(route()), request: QueryRequest::SessionGet {},
        }}),
    )
    .unwrap();
    assert_eq!(response["error"]["code"], "io_error");
    assert_eq!(response["error"]["retryable"], false);
    let inventory = inventory();
    let command: OwnerCommand = serde_json::from_value(
        inventory["owner_commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["command"] == "input_submit")
            .unwrap()
            .clone(),
    )
    .unwrap();
    let operation_id = command.operation_id().as_str().to_owned();
    let response = invoke(
        &window,
        "input_submit",
        json!({"request":OwnerMutationRequest {
            session: Some(route()), command,
        }}),
    )
    .unwrap();
    assert_eq!(response["error"]["code"], "commit_uncertain");
    assert_eq!(response["error"]["retryable"], false);
    assert!(response["error"]["hint"]
        .as_str()
        .unwrap()
        .contains(&operation_id));
    assert!(!response.to_string().contains("resolver panic"));
    assert!(core.history().unwrap().is_empty());
}

#[test]
fn actual_registered_command_names_and_request_envelopes_match_canonical_inventory() {
    let inventory = inventory();
    let route = route();
    for value in inventory["query_requests"].as_array().unwrap() {
        let query: QueryRequest = serde_json::from_value(value.clone()).unwrap();
        let needs_session = !matches!(
            query,
            QueryRequest::ProjectList(_)
                | QueryRequest::SessionList(_)
                | QueryRequest::PreferencesGet {}
                | QueryRequest::TopicContinuePreview(_)
        );
        let scope = if needs_session {
            context(&route)
        } else {
            OwnerContext::from_trusted_entrypoint(
                if matches!(query, QueryRequest::PreferencesGet {}) {
                    OwnerScope::Preferences
                } else {
                    OwnerScope::Registry
                },
            )
        };
        let core = Arc::new(ScriptedCoreService::new([ScriptStep {
            request: RecordedRequest::Query(QueryContext::owner(scope), Box::new(query.clone())),
            response: ScriptedResponse::Query(Box::new(Err(CoreError::new(
                CoreErrorCode::IoError,
                "Test-owned directory unavailable.",
                "Check test-owned access.",
            )))),
        }]));
        let window = window(DesktopService::from_trusted_startup(core.clone(), resolve));
        let wrapper = OwnerQueryRequest {
            session: needs_session.then(|| route.clone()),
            request: query,
        };
        let response = invoke(
            &window,
            value["command"].as_str().unwrap(),
            json!({"request":wrapper}),
        )
        .unwrap();
        assert_eq!(response["api_version"], 1);
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "io_error");
        assert_eq!(core.remaining().unwrap(), 0);
        assert_eq!(core.history().unwrap().len(), 1);
    }
    for value in inventory["owner_commands"].as_array().unwrap() {
        let command: OwnerCommand = serde_json::from_value(value.clone()).unwrap();
        let needs_session = !matches!(
            command,
            OwnerCommand::ProjectRegister { .. }
                | OwnerCommand::BindingConnect { .. }
                | OwnerCommand::PreferencesPatch { .. }
                | OwnerCommand::SessionRemove { .. }
                | OwnerCommand::ProjectRemove { .. }
        );
        let target = if let OwnerCommand::TopicContinue { params, .. } = &command {
            params.target.clone()
        } else {
            route.clone()
        };
        let owner = if needs_session {
            context(&target)
        } else {
            OwnerContext::from_trusted_entrypoint(
                if matches!(command, OwnerCommand::PreferencesPatch { .. }) {
                    OwnerScope::Preferences
                } else {
                    OwnerScope::Registry
                },
            )
        };
        let core = Arc::new(ScriptedCoreService::new([ScriptStep {
            request: RecordedRequest::Owner(owner, Box::new(command.clone())),
            response: ScriptedResponse::Owner(Box::new(Err(CoreError::new(
                CoreErrorCode::StoreBusy,
                "Test transaction is busy.",
                "Retry the same operation after it unlocks.",
            )))),
        }]));
        let window = window(DesktopService::from_trusted_startup(core.clone(), resolve));
        let wrapper = OwnerMutationRequest {
            session: needs_session.then_some(target),
            command,
        };
        let response = invoke(
            &window,
            value["command"].as_str().unwrap(),
            json!({"request":wrapper}),
        )
        .unwrap();
        assert_eq!(response["error"]["code"], "store_busy");
        assert_eq!(core.remaining().unwrap(), 0);
        assert_eq!(core.history().unwrap().len(), 1);
    }
}

#[test]
fn wrong_command_route_and_actor_fields_are_rejected_before_core_invocation() {
    let core = Arc::new(ScriptedCoreService::new([]));
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let service = DesktopService::from_trusted_startup(core.clone(), move |requested| {
        count.fetch_add(1, Ordering::SeqCst);
        let mut different = requested.clone();
        different.project_id = UuidV4::new("00000000-0000-4000-8000-000000000099").unwrap();
        resolve(&different)
    });
    let window = window(service);
    let wrapper = OwnerQueryRequest {
        session: Some(route()),
        request: QueryRequest::SessionGet {},
    };
    let wrong_command = invoke(&window, "item_messages", json!({"request":wrapper})).unwrap();
    assert_eq!(wrong_command["error"]["code"], "invalid_argument");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let wrong_registration = invoke(&window, "session_get", json!({"request":wrapper})).unwrap();
    assert_eq!(wrong_registration["error"]["code"], "binding_mismatch");
    let mut injected = serde_json::to_value(&wrapper).unwrap();
    injected["actor"] = json!("owner");
    assert!(invoke(&window, "session_get", json!({"request":injected})).is_err());
    let missing = OwnerQueryRequest {
        session: None,
        request: QueryRequest::SessionGet {},
    };
    assert_eq!(
        invoke(&window, "session_get", json!({"request":missing})).unwrap()["error"]["code"],
        "invalid_argument"
    );
    assert!(core.history().unwrap().is_empty());
    let expected = route();
    let different_session = DesktopService::from_trusted_startup(core.clone(), move |_| {
        resolve(&SessionRef {
            project_id: expected.project_id.clone(),
            session_id: UuidV4::new("00000000-0000-4000-8000-000000000099").unwrap(),
        })
    });
    assert_eq!(
        failure(&different_session.query(wrapper, true)).code,
        CoreErrorCode::BindingMismatch
    );
    assert!(core.history().unwrap().is_empty());
}

#[test]
fn ordinary_startup_is_unsupported_and_canonical_success_is_returned_unchanged() {
    let wrapper = OwnerQueryRequest {
        session: Some(route()),
        request: QueryRequest::SessionGet {},
    };
    let uncomposed = DesktopService::default().query(wrapper.clone(), true);
    assert_eq!(failure(&uncomposed).code, CoreErrorCode::Unsupported);
    assert!(!failure(&uncomposed).retryable);
    let snapshot = SessionSnapshot {
        session: fixture_session(),
        freshness: Freshness::Fresh,
    };
    let core = Arc::new(ScriptedCoreService::new([ScriptStep {
        request: RecordedRequest::Query(
            QueryContext::owner(context(&route())),
            Box::new(wrapper.request.clone()),
        ),
        response: ScriptedResponse::Query(Box::new(Ok(QueryResult::SessionGet(snapshot.clone())))),
    }]));
    let window = window(DesktopService::from_trusted_startup(core, resolve));
    let response = invoke(&window, "session_get", json!({"request":wrapper})).unwrap();
    assert_eq!(response["ok"], true);
    assert_eq!(
        response["data"]["data"],
        serde_json::to_value(snapshot).unwrap()
    );
    let invalid: ApplicationEnvelope<()> =
        envelope(Err(CoreError::new(CoreErrorCode::IoError, "", "")));
    assert_eq!(failure(&invalid).code, CoreErrorCode::ProtocolConflict);
}

#[test]
fn mutation_receipts_keep_the_saved_shape_and_validate_operation_route_and_kind() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../../../fixtures/contracts/core/cases.json"
    ))
    .unwrap();
    let step = &corpus["cases"][0]["steps"][0];
    let command: OwnerCommand = serde_json::from_value(step["request"].clone()).unwrap();
    let receipt: MutationReceipt =
        serde_json::from_value(step["response"]["data"].clone()).unwrap();
    let wrapper = OwnerMutationRequest {
        session: Some(route()),
        command: command.clone(),
    };
    validate_receipt(&wrapper, &receipt).unwrap();
    let core = Arc::new(ScriptedCoreService::new([ScriptStep {
        request: RecordedRequest::Owner(context(&route()), Box::new(command)),
        response: ScriptedResponse::Owner(Box::new(Ok(receipt.clone()))),
    }]));
    let window = window(DesktopService::from_trusted_startup(core, resolve));
    let (send, receive) = std::sync::mpsc::channel();
    window
        ._app
        .listen("ariadne://session_changed", move |event| {
            send.send(serde_json::from_str::<SessionChangedHint>(event.payload()).unwrap())
                .unwrap();
        });
    let response = invoke(&window, "input_submit", json!({"request":wrapper})).unwrap();
    assert_eq!(response["data"], serde_json::to_value(&receipt).unwrap());
    let hint = receive
        .recv_timeout(std::time::Duration::from_secs(1))
        .unwrap();
    let MutationReceipt::Session(saved) = &receipt else {
        panic!("Expected saved receipt")
    };
    assert_eq!(hint.session_id, saved.session_id);
    assert_eq!(hint.revision, saved.revision);
    let MutationReceipt::Session(mut wrong) = receipt else {
        panic!("Expected saved receipt")
    };
    wrong.operation_id = UuidV4::new("00000000-0000-4000-8000-000000000099").unwrap();
    assert_eq!(
        validate_receipt(&wrapper, &MutationReceipt::Session(wrong.clone()))
            .unwrap_err()
            .code,
        CoreErrorCode::ProtocolConflict
    );
    wrong.operation_id = wrapper.command.operation_id().clone();
    wrong.session_id = UuidV4::new("00000000-0000-4000-8000-000000000099").unwrap();
    assert!(validate_receipt(&wrapper, &MutationReceipt::Session(wrong.clone())).is_err());
    wrong.session_id = route().session_id;
    wrong.data = SavedReceiptData::SessionLifecycle {
        state: SessionState::Closed,
        closed_at: None,
        archived_at: None,
        cancelled_input_ids: vec![],
    };
    assert!(validate_receipt(&wrapper, &MutationReceipt::Session(wrong)).is_err());
}

fn preference_request(entries: Vec<PreferencesPatchEntry>) -> OwnerMutationRequest {
    let mut command: OwnerCommand = serde_json::from_value(
        inventory()["owner_commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["command"] == "preferences_patch")
            .unwrap()
            .clone(),
    )
    .unwrap();
    let OwnerCommand::PreferencesPatch { params, .. } = &mut command else {
        unreachable!()
    };
    params.entries = entries;
    OwnerMutationRequest {
        session: None,
        command,
    }
}

fn notification_counts(command: &OwnerCommand, response: &MutationEnvelope) -> (usize, usize) {
    let window = std::cell::Cell::new(0);
    let tray = std::cell::Cell::new(0);
    notify_native_preferences(
        command,
        response,
        || window.set(window.get() + 1),
        || tray.set(tray.get() + 1),
    );
    (window.get(), tray.get())
}

#[test]
fn preference_notifications_follow_consumers_and_preserve_exact_replay_receipts() {
    // Start with the canonical entries, including global, view, Later and drafts.
    let command: OwnerCommand = serde_json::from_value(
        inventory()["owner_commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["command"] == "preferences_patch")
            .unwrap()
            .clone(),
    )
    .unwrap();
    let OwnerCommand::PreferencesPatch {
        params: canonical, ..
    } = command
    else {
        unreachable!()
    };
    let entries = canonical.entries;
    for (selected, expected) in [
        (vec![entries[1].clone()], (0, 0)), // Search/selection/expansion view.
        (vec![entries[2].clone()], (0, 0)), // Later does not hide native Waiting.
        (vec![entries[3].clone(), entries[4].clone()], (0, 0)),
        (vec![entries[1].clone(), entries[2].clone()], (0, 0)),
        (vec![entries[0].clone()], (1, 1)),
        (entries.clone(), (1, 1)), // Mixed patch still affects both consumers once.
    ] {
        let request = preference_request(selected);
        let receipt = MutationReceipt::PreferencesPatched(PreferencesPatchedReceipt {
            operation_id: request.command.operation_id().clone(),
            preferences_revision: PositiveSafeInteger::new(2).unwrap(),
        });
        let step = ScriptStep {
            request: RecordedRequest::Owner(
                OwnerContext::from_trusted_entrypoint(OwnerScope::Preferences),
                Box::new(request.command.clone()),
            ),
            response: ScriptedResponse::Owner(Box::new(Ok(receipt.clone()))),
        };
        let core = Arc::new(ScriptedCoreService::new([step.clone(), step]));
        let service = DesktopService::from_trusted_startup(core.clone(), resolve);
        for _ in 0..2 {
            let response = service.owner(request.clone(), true);
            let before = serde_json::to_value(&response).unwrap();
            assert_eq!(notification_counts(&request.command, &response), expected);
            assert_eq!(serde_json::to_value(&response).unwrap(), before);
            assert_eq!(before["data"], serde_json::to_value(&receipt).unwrap());
        }
        assert_eq!(core.remaining().unwrap(), 0);
    }
}

#[test]
fn rejected_or_invalid_preference_receipts_never_notify_native_consumers() {
    let entry: PreferencesPatchEntry = serde_json::from_value(
        inventory()["owner_commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["command"] == "preferences_patch")
            .unwrap()["params"]["entries"][0]
            .clone(),
    )
    .unwrap();
    let request = preference_request(vec![entry]);
    for result in [
        Err(CoreError::new(
            CoreErrorCode::RevisionConflict,
            "Preferences changed.",
            "Reload preferences.",
        )),
        Err(CoreError::new(
            CoreErrorCode::CommitUncertain,
            "Receipt was not confirmed.",
            "Reconcile the original operation.",
        )),
        Ok(MutationReceipt::PreferencesPatched(
            PreferencesPatchedReceipt {
                operation_id: UuidV4::new("00000000-0000-4000-8000-000000000099").unwrap(),
                preferences_revision: PositiveSafeInteger::new(2).unwrap(),
            },
        )),
    ] {
        let core = Arc::new(ScriptedCoreService::new([ScriptStep {
            request: RecordedRequest::Owner(
                OwnerContext::from_trusted_entrypoint(OwnerScope::Preferences),
                Box::new(request.command.clone()),
            ),
            response: ScriptedResponse::Owner(Box::new(result)),
        }]));
        let service = DesktopService::from_trusted_startup(core, resolve);
        let response = service.owner(request.clone(), true);
        assert!(matches!(&response.0, ApplicationEnvelope::Failure(_)));
        assert_eq!(notification_counts(&request.command, &response), (0, 0));
    }
}

#[test]
fn native_preference_writes_announce_only_saved_revisions() {
    let entry: PreferencesPatchEntry = serde_json::from_value(
        inventory()["owner_commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["command"] == "preferences_patch")
            .unwrap()["params"]["entries"][0]
            .clone(),
    )
    .unwrap();
    let request = preference_request(vec![entry]);
    for (result, announced) in [
        (
            Ok(MutationReceipt::PreferencesPatched(
                PreferencesPatchedReceipt {
                    operation_id: request.command.operation_id().clone(),
                    preferences_revision: PositiveSafeInteger::new(7).unwrap(),
                },
            )),
            vec![7],
        ),
        (
            Err(CoreError::new(
                CoreErrorCode::RevisionConflict,
                "Preferences changed.",
                "Reload preferences.",
            )),
            vec![],
        ),
        (
            Err(CoreError::new(
                CoreErrorCode::CommitUncertain,
                "Receipt was not confirmed.",
                "Reconcile the original operation.",
            )),
            vec![],
        ),
    ] {
        let core = Arc::new(ScriptedCoreService::new([ScriptStep {
            request: RecordedRequest::Owner(
                OwnerContext::from_trusted_entrypoint(OwnerScope::Preferences),
                Box::new(request.command.clone()),
            ),
            response: ScriptedResponse::Owner(Box::new(result)),
        }]));
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let record = seen.clone();
        let service = DesktopService::from_trusted_startup(core, resolve)
            .with_preferences_changed(move |revision| record.lock().unwrap().push(revision));
        let _ = service.native_preferences_write(&request);
        assert_eq!(*seen.lock().unwrap(), announced);
    }
}

#[test]
fn qualified_connect_keeps_admission_deadline_and_validation_before_native_handoff() {
    let core = Arc::new(ScriptedCoreService::new([]));
    let command: OwnerCommand = serde_json::from_value(
        inventory()["owner_commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["command"] == "binding_connect")
            .unwrap()
            .clone(),
    )
    .unwrap();
    let expected = Instant::now() - std::time::Duration::from_secs(1);
    let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let record = observed.clone();
    let service = DesktopService::from_trusted_startup_with_connect(
        core.clone(),
        resolve,
        move |_, deadline| {
            record
                .lock()
                .unwrap()
                .push((deadline, std::thread::current().id()));
            Err(CoreError::new(
                CoreErrorCode::HostUnreachable,
                "Test admission expired.",
                "Retain the original operation.",
            ))
        },
    );
    let wrapper = OwnerMutationRequest {
        session: None,
        command,
    };
    assert_eq!(
        failure(&service.owner_before(&wrapper, true, expected)).code,
        CoreErrorCode::HostUnreachable
    );
    assert_eq!(observed.lock().unwrap()[0].0, expected);
    assert_eq!(
        failure(&service.owner_before(&wrapper, false, expected)).code,
        CoreErrorCode::InvalidArgument
    );
    let mut wrong_scope = wrapper.clone();
    wrong_scope.session = Some(route());
    assert_eq!(
        failure(&service.owner_before(&wrong_scope, true, expected)).code,
        CoreErrorCode::InvalidArgument
    );
    assert_eq!(observed.lock().unwrap().len(), 1);
    let ipc_thread = std::thread::current().id();
    let window = window(service);
    let before = Instant::now();
    let response = invoke(&window, "binding_connect", json!({"request": wrapper})).unwrap();
    assert_eq!(response["error"]["code"], "host_unreachable");
    let calls = observed.lock().unwrap();
    assert!(calls[1].0 >= before + ariadne_runtime::control::CONTROL_TIMEOUT);
    assert_ne!(calls[1].1, ipc_thread);
    assert!(core.history().unwrap().is_empty());
}

#[test]
fn discovery_ipc_uses_trusted_off_thread_callbacks_and_strict_visibility_request() {
    let core = Arc::new(ScriptedCoreService::new([]));
    let (send, receive) = std::sync::mpsc::channel();
    let read = send.clone();
    let service = DesktopService::from_trusted_startup(core, resolve).with_native_discovery(
        move || {
            read.send((None, std::thread::current().id())).unwrap();
            Ok(DesktopDiscoverySnapshot {
                candidates: vec![],
                error: None,
            })
        },
        move |open| {
            send.send((Some(open), std::thread::current().id()))
                .unwrap();
            Ok(())
        },
    );
    let window = window(service);
    let ipc_thread = std::thread::current().id();
    assert_eq!(
        invoke(&window, "discovery_snapshot", json!({})).unwrap(),
        json!({"candidates":[],"error":null})
    );
    for open in [true, false] {
        assert_eq!(
            invoke(
                &window,
                "discovery_ui_open",
                json!({"request":{"open":open}})
            )
            .unwrap(),
            Value::Null
        );
    }
    for expected in [None, Some(true), Some(false)] {
        let (open, worker) = receive
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert_eq!(open, expected);
        assert_ne!(worker, ipc_thread);
    }
    for request in [
        json!({"open":"true"}),
        json!({"open":true,"root":"/tmp"}),
        json!({}),
    ] {
        assert!(invoke(&window, "discovery_ui_open", json!({"request":request})).is_err());
    }
    assert!(receive.try_recv().is_err());
}

#[test]
fn codex_default_endpoint_ipc_returns_the_configured_socket_or_null() {
    let core = Arc::new(ScriptedCoreService::new([]));
    let window = window(
        DesktopService::from_trusted_startup(core.clone(), resolve).with_codex_default_endpoint(
            || Some("/home/u/.codex/app-server-control/app-server-control.sock".into()),
        ),
    );
    assert_eq!(
        invoke(&window, "codex_default_endpoint", json!({})).unwrap(),
        json!("/home/u/.codex/app-server-control/app-server-control.sock")
    );
    let window = self::window(
        DesktopService::from_trusted_startup(core, resolve).with_codex_default_endpoint(|| None),
    );
    assert_eq!(
        invoke(&window, "codex_default_endpoint", json!({})).unwrap(),
        Value::Null
    );
}

#[test]
fn supervisor_health_ipc_returns_the_published_entries_in_wire_shape() {
    use ariadne_runtime::health::SupervisorHealth;
    let core = Arc::new(ScriptedCoreService::new([]));
    let binding = UuidV4::new("00000000-0000-4000-8000-000000000001").unwrap();
    let generation = UuidV4::new("00000000-0000-4000-8000-000000000002").unwrap();
    let at = ariadne_domain::models::UtcMillis::new("2026-10-07T12:00:00.000Z").unwrap();
    let entry = SupervisorHealth::backing_off(
        binding,
        generation,
        "Ariadne can't reach Codex right now.".into(),
        std::time::Duration::from_secs(4),
        at,
    );
    let window = window(
        DesktopService::from_trusted_startup(core.clone(), resolve)
            .with_supervisor_health(move || vec![entry.clone()]),
    );
    assert_eq!(
        invoke(&window, "supervisor_health", json!({})).unwrap(),
        json!([{
            "binding_id": "00000000-0000-4000-8000-000000000001",
            "generation": "00000000-0000-4000-8000-000000000002",
            "state": "backing_off",
            "reason": "Ariadne can't reach Codex right now.",
            "retry_in_seconds": 4,
            "updated_at": "2026-10-07T12:00:00.000Z"
        }])
    );
    // Without a runtime (or with only Claude bindings) the list is empty.
    let window = self::window(DesktopService::from_trusted_startup(core, resolve));
    assert_eq!(
        invoke(&window, "supervisor_health", json!({})).unwrap(),
        json!([])
    );
}

#[test]
fn discovery_ipc_exposes_typed_failure_without_calling_core_or_persisting() {
    let empty = window(DesktopService::default());
    assert_eq!(
        invoke(&empty, "discovery_snapshot", json!({})).unwrap_err()["code"],
        "unsupported"
    );
    assert_eq!(
        invoke(
            &empty,
            "discovery_ui_open",
            json!({"request":{"open":true}})
        )
        .unwrap_err()["code"],
        "unsupported"
    );
    let service =
        DesktopService::from_trusted_startup(Arc::new(ScriptedCoreService::new([])), resolve)
            .with_native_discovery(
                || {
                    Err(CoreError::new(
                        CoreErrorCode::HostUnreachable,
                        "Provider unavailable.",
                        "Use manual connection.",
                    ))
                },
                |_| {
                    Err(CoreError::new(
                        CoreErrorCode::HostUnreachable,
                        "Runtime unavailable.",
                        "Close the connection panel.",
                    ))
                },
            );
    let window = window(service);
    assert_eq!(
        invoke(&window, "discovery_snapshot", json!({})).unwrap_err()["code"],
        "host_unreachable"
    );
    assert_eq!(
        invoke(
            &window,
            "discovery_ui_open",
            json!({"request":{"open":false}})
        )
        .unwrap_err()["code"],
        "host_unreachable"
    );
}

#[test]
fn topic_removal_hints_every_other_family_session_at_its_listed_revision() {
    let uuid = |n: u64| UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap();
    let page: Page<SessionSummary> = serde_json::from_str(include_str!(
        "../../../../../../fixtures/domain/projections/sessions.json"
    ))
    .unwrap();
    let summary = |session: u64, revision: u64| {
        let mut summary = page.items[0].clone();
        summary.session_id = uuid(session);
        summary.revision = PositiveSafeInteger::new(revision).unwrap();
        summary
    };
    let list = |items: Vec<SessionSummary>, next: Option<QueryCursor>| {
        let counts = page.items[0].counts.clone();
        QueryResult::SessionList(SessionListResult {
            sessions: Page {
                items,
                next_cursor: next,
                snapshot_revision: page.snapshot_revision,
            },
            active_total: NonnegativeSafeInteger::new(3).unwrap(),
            closed_total: NonnegativeSafeInteger::new(0).unwrap(),
            archived_total: NonnegativeSafeInteger::new(0).unwrap(),
            counts,
        })
    };
    let member = |session: u64, topic: u64| RemovalTarget {
        session_id: uuid(session),
        id: uuid(topic),
    };
    let receipt = SavedReceipt {
        operation_id: uuid(100),
        session_id: uuid(1),
        revision: PositiveSafeInteger::new(5).unwrap(),
        data: SavedReceiptData::Removal {
            item_ids: vec![],
            topic_ids: vec![uuid(10)],
            input_ids: vec![],
            family: vec![member(1, 10), member(2, 11), member(2, 12), member(3, 13)],
            notice: None,
            backup: "/backup".into(),
        },
    };
    // Members span two list pages; the route session is never re-hinted.
    let cursor = QueryCursor {
        schema: SchemaVersion::new(1).unwrap(),
        view: QueryView::Sessions,
        filter_digest: Sha256::new("0".repeat(64)).unwrap(),
        after: None,
        revision: page.snapshot_revision,
    };
    let mut pages = vec![
        list(vec![summary(1, 5), summary(2, 7)], Some(cursor)),
        list(vec![summary(4, 2), summary(3, 9)], None),
    ]
    .into_iter();
    let mut calls = 0;
    let hints = family_hints(&receipt, |request| {
        calls += 1;
        assert!(request.session.is_none());
        Ok(pages.next().unwrap())
    });
    assert_eq!(calls, 2);
    let pairs: Vec<_> = hints
        .iter()
        .map(|hint| (hint.session_id.clone(), hint.revision.value()))
        .collect();
    assert_eq!(pairs, vec![(uuid(2), 7), (uuid(3), 9)]);

    // Item removal has no family: no list read and no extra hints.
    let mut single = receipt.clone();
    single.data = SavedReceiptData::Removal {
        item_ids: vec![],
        topic_ids: vec![],
        input_ids: vec![],
        family: vec![],
        notice: None,
        backup: "/backup".into(),
    };
    assert!(family_hints(&single, |_| panic!("no list read")).is_empty());
    // A failed list read is best effort.
    assert!(family_hints(&receipt, |_| Err(CoreError::new(
        CoreErrorCode::IoError,
        "down",
        "retry"
    )))
    .is_empty());

    // A partial removal error hints the sessions it already removed from.
    let mut partial = CoreError::new(CoreErrorCode::IoError, "partial removal: down", "retry");
    partial.details = Some(Box::new(ErrorDetails {
        reason: None,
        binding_id: None,
        input_id: None,
        attempt_id: None,
        blocking_item_ids: vec![],
        blocking_input_ids: vec![],
        dispatch_must_pause: false,
        partial_removal: Some(PartialRemoval {
            removed: vec![uuid(1), uuid(2)],
            remaining: vec![uuid(3)],
        }),
    }));
    let hints = partial_removal_hints(&partial, |_| {
        Ok(list(
            vec![summary(1, 5), summary(2, 7), summary(3, 9)],
            None,
        ))
    });
    let pairs: Vec<_> = hints
        .iter()
        .map(|hint| (hint.session_id.clone(), hint.revision.value()))
        .collect();
    assert_eq!(pairs, vec![(uuid(1), 5), (uuid(2), 7)]);
    let other = CoreError::new(CoreErrorCode::IoError, "down", "retry");
    assert!(partial_removal_hints(&other, |_| panic!("no list read")).is_empty());
}
