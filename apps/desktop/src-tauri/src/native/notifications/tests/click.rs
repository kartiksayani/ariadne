use super::*;
use crate::{commands::DesktopService, native::routes::NativeRoutes};
use ariadne_core::{native::NativeCoreService, *};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use std::{sync::mpsc, time::Duration};
use tauri::{Listener, Manager};

fn id(value: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{value:012x}")).unwrap()
}

fn at() -> UtcMillis {
    UtcMillis::new("2026-10-05T12:00:00.000Z").unwrap()
}

#[test]
fn click_admission_rejects_inactive_nondefault_and_invalid_payloads_and_always_completes() {
    let active = Arc::new(AtomicBool::new(true));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let opened = calls.clone();
    let state = DelegateState {
        active: active.clone(),
        foreground: Box::new(|| false),
        open: Box::new(move |_| opened.lock().unwrap().push("open")),
    };
    let route = OpenRoute {
        project_id: id(1),
        session_id: id(2),
        item_id: Some(ItemRef::new("2").unwrap()),
    };
    let payload = serde_json::to_string(&route).unwrap();
    let complete = || calls.lock().unwrap().push("complete");
    active.store(false, Ordering::Release);
    state.clicked(
        || panic!("Inactive delegate read the action"),
        || panic!("Inactive delegate read the payload"),
        complete,
    );
    active.store(true, Ordering::Release);
    state.clicked(
        || false,
        || panic!("Nondefault action read the payload"),
        complete,
    );
    let mut unknown = serde_json::to_value(&route).unwrap();
    unknown["unexpected"] = serde_json::json!(true);
    for invalid in [
        None,
        Some("not json".into()),
        Some("x".repeat(1025)),
        Some(payload.replace('2', "invalid")),
        Some(format!("{payload}{}", " ".repeat(1025 - payload.len()))),
        Some(unknown.to_string()),
    ] {
        state.clicked(|| true, || invalid, complete);
    }
    assert_eq!(*calls.lock().unwrap(), vec!["complete"; 8]);
    state.clicked(
        || true,
        || Some(format!("{payload}{}", " ".repeat(1024 - payload.len()))),
        complete,
    );
    state.clicked(|| true, || Some(payload), complete);
    assert_eq!(
        &calls.lock().unwrap()[8..],
        &["open", "complete", "open", "complete"]
    );
}

#[test]
fn notification_click_routes_registered_item_and_loads_current_detail_after_answer() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let session: Session = serde_json::from_str(include_str!(
        "../../../../../../../fixtures/domain/demo/session.json"
    ))
    .unwrap();
    let item_id = ItemRef::new("2").unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registry
        .register(root.path(), &id(900), || session.project_id.clone())
        .unwrap();
    let store = Store::open_registered(root.path(), session.project_id.clone()).unwrap();
    store.create(&session).unwrap();
    let core = Arc::new(NativeCoreService::new(
        registry,
        || UuidV4::new(uuid::Uuid::new_v4().to_string()).unwrap(),
        at,
        |_| panic!("Notification routing must not contact a host"),
    ));
    let resolver = core.clone();
    let service = DesktopService::from_trusted_startup(core.clone(), move |route| {
        resolver.resolve_session(route)
    });
    let app = tauri::test::mock_builder()
        .manage(service.clone())
        .manage(NativeRoutes::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    crate::native::routes::route_ready(window).unwrap();
    let (send, receive) = mpsc::channel();
    app.listen_any("ariadne://route", move |event| {
        send.send(serde_json::from_str::<OpenRoute>(event.payload()).unwrap())
            .unwrap();
    });
    let handle = app.handle().clone();
    let state = DelegateState {
        active: Arc::new(AtomicBool::new(true)),
        foreground: Box::new(|| false),
        open: Box::new(move |route| {
            // The installed delegate's callback enters this same shared service.
            let routes = handle.state::<NativeRoutes>().inner().clone();
            tauri::async_runtime::block_on(routes.open(handle.clone(), route)).unwrap();
        }),
    };
    let route = OpenRoute {
        project_id: session.project_id.clone(),
        session_id: session.id.clone(),
        item_id: Some(item_id.clone()),
    };
    // Keep the delivered notification's original payload after the answer.
    let payload = serde_json::to_string(&route).unwrap();
    let current = || {
        state.clicked(|| true, || Some(payload.clone()), || ());
        let routed = receive.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(routed, route);
        let target = SessionRef {
            project_id: routed.project_id,
            session_id: routed.session_id,
        };
        let QueryResult::RevealItem(revealed) = service
            .native_query(OwnerQueryRequest {
                session: Some(target.clone()),
                request: QueryRequest::RevealItem {
                    item_id: routed.item_id.unwrap(),
                },
            })
            .unwrap()
        else {
            panic!("Expected common item reveal")
        };
        assert_eq!(revealed.item_id, item_id);
        let QueryResult::SessionGet(snapshot) = service
            .native_query(OwnerQueryRequest {
                session: Some(target),
                request: QueryRequest::SessionGet {},
            })
            .unwrap()
        else {
            panic!("Expected current detail snapshot")
        };
        snapshot.session
    };
    let before = current();
    assert_eq!(before, session);
    let waiting = crate::native::tray::capture(|request| service.native_query(request)).unwrap();
    assert!(waiting.rows.iter().any(|row| row.route() == route));
    let receipt = core
        .execute_owner(
            OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
                core.resolve_session(&SessionRef {
                    project_id: session.project_id.clone(),
                    session_id: session.id.clone(),
                })
                .unwrap(),
            )),
            OwnerCommand::InputSubmit {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(901),
                params: InputSubmitParams {
                    binding_id: session.items.0[&item_id]
                        .recipient_binding_id
                        .clone()
                        .unwrap(),
                    target: InputTarget {
                        topic_id: session.items.0[&item_id].topic_id.clone(),
                        item_id: Some(item_id.clone()),
                    },
                    kind: InputKind::Answer,
                    text: "Use the next delivery window.".into(),
                    selected_option_id: None,
                    expected_question_revision: Some(session.items.0[&item_id].question_revision),
                    supersedes_answer_id: None,
                },
            },
        )
        .unwrap();
    let MutationReceipt::Session(receipt) = receipt else {
        panic!("Expected durable answer receipt")
    };
    let after = current();
    assert_eq!(after, store.read(&session.id).unwrap());
    assert_eq!(after.revision, receipt.revision);
    assert!(after.revision > before.revision);
    assert_eq!(
        after.answers.last().unwrap().text,
        "Use the next delivery window."
    );
    let answered = crate::native::tray::capture(|request| service.native_query(request)).unwrap();
    assert!(!answered.rows.iter().any(|row| row.route() == route));
}
