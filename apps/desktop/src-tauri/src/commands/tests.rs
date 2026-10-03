use super::*;
use ariadne_core::fake::{RecordedRequest, ScriptStep, ScriptedCoreService, ScriptedResponse};
use ariadne_domain::models::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::Listener;

fn inventory() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../fixtures/contracts/core/inventory.json"
    ))
    .unwrap()
}
fn fixture_session() -> Session {
    serde_json::from_str(include_str!(
        "../../../../../fixtures/domain/demo/session.json"
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
        "../../../../../fixtures/contracts/core/cases.json"
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
    };
    assert!(validate_receipt(&wrapper, &MutationReceipt::Session(wrong)).is_err());
}
