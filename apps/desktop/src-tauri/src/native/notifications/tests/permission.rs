use super::*;
use crate::commands::DesktopService;
use crate::native::tray::capture;
use ariadne_core::{native::NativeCoreService, *};
use ariadne_domain::{
    history::open_ask_round,
    models::*,
    transitions::{transition_item, ItemChange, TransitionContext},
};
use ariadne_store::{registry::Registry, session::Store};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets};

fn id(value: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{value:012x}")).unwrap()
}

fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}

fn waiting_session() -> Session {
    let mut session: Session = serde_json::from_str(include_str!(
        "../../../../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap();
    let item_id = ItemRef::new("1").unwrap();
    let mut activity = session.messages[0].clone();
    activity.id = id(101);
    activity.number = session.counters.next_message;
    activity.created_at = at();
    activity.items_touched = vec![item_id.clone()];
    session.counters.next_message = PositiveSafeInteger::new(3).unwrap();
    session.messages.push(activity);
    let asked = transition_item(
        &session,
        &item_id,
        &ItemChange::Ask {
            ask: "Choose the release approach.".into(),
            options: vec![],
            recipient_binding_id: id(3),
            round_id: id(201),
        },
        &TransitionContext {
            binding_id: id(3),
            generation: id(4),
            cause_message_id: id(101),
            at: at(),
            handled_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
            expected_revision: PositiveSafeInteger::new(1).unwrap(),
            expected_question_revision: None,
        },
    )
    .unwrap();
    open_ask_round(&session, asked, &id(101), at()).unwrap()
}

#[test]
fn denied_permission_completes_with_diagnostic_and_in_app_answer_still_saves() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let session = waiting_session();
    let registry = Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(99), || id(1)).unwrap();
    let store = Store::open_registered(root.path(), session.project_id.clone()).unwrap();
    store.create(&session).unwrap();
    let core = Arc::new(NativeCoreService::new(
        registry,
        || UuidV4::new(uuid::Uuid::new_v4().to_string()).unwrap(),
        at,
        |_| panic!("Answering must not request or qualify a host"),
    ));
    let resolver = core.clone();
    let service =
        DesktopService::from_trusted_startup(core, move |route| resolver.resolve_session(route));
    let captured = capture(|request| service.native_query(request)).unwrap();
    assert_eq!(captured.counts.waiting_unanswered.value(), 1);
    assert_eq!(captured.rows.len(), 1);

    // Invoke the actual Rust completion block with only the OS decision faked.
    // No UserNotifications object, permission prompt or native window is used.
    let active = Arc::new(AtomicBool::new(true));
    let permission = Arc::new(AtomicU8::new(2));
    let (send, mut receive) = tokio::sync::oneshot::channel();
    let completion = authorization_completion(active.clone(), permission.clone(), send);
    completion.call((Bool::NO, std::ptr::null_mut()));
    assert!(!receive.try_recv().unwrap().unwrap());
    assert!(active.load(Ordering::Acquire));
    let diagnostic = permission_diagnostic(&permission).unwrap();
    assert_eq!(
        diagnostic,
        "Notifications are denied; answer questions in the Waiting queue."
    );
    let projection =
        crate::native::tray::TrayProjection::from_capture(&captured, &[diagnostic.into()]);
    assert_eq!(projection.title, "1");
    assert_eq!(projection.oldest.len(), 1);
    assert_eq!(projection.diagnostics, vec![diagnostic]);

    let app = mock_builder()
        .manage(service.clone())
        .invoke_handler(crate::desktop_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let text = "Ship the documented release.\nPreserve my full answer.  ";
    let request = OwnerMutationRequest {
        session: Some(SessionRef {
            project_id: session.project_id.clone(),
            session_id: session.id.clone(),
        }),
        command: OwnerCommand::InputSubmit {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: id(500),
            params: InputSubmitParams {
                binding_id: id(3),
                target: InputTarget {
                    topic_id: session.items.0[&ItemRef::new("1").unwrap()]
                        .topic_id
                        .clone(),
                    item_id: Some(ItemRef::new("1").unwrap()),
                },
                kind: InputKind::Answer,
                text: text.into(),
                selected_option_id: None,
                expected_question_revision: Some(PositiveSafeInteger::new(2).unwrap()),
                supersedes_answer_id: None,
            },
        },
    };
    let response: MutationEnvelope = get_ipc_response(
        &window,
        tauri::webview::InvokeRequest {
            cmd: "input_submit".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({"request": request})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .unwrap()
    .deserialize()
    .unwrap();
    let ApplicationEnvelope::Success(SuccessEnvelope {
        data: MutationReceipt::Session(receipt),
        ..
    }) = response.0
    else {
        panic!("Permission denial blocked in-app answer: {response:?}")
    };
    let SavedReceiptData::InputSubmit { input_id, .. } = &receipt.data else {
        panic!("Expected a durable input receipt")
    };
    let saved = store.read(&session.id).unwrap();
    assert_eq!(saved.revision, receipt.revision);
    assert_eq!(saved.inputs.0[input_id].state, InputState::Queued);
    assert_eq!(saved.inputs.0[input_id].payload.text, text);
    assert_eq!(saved.answers.last().unwrap().text, text);
    assert_eq!(saved.messages.last().unwrap().body, text);
    let refreshed = capture(|request| service.native_query(request)).unwrap();
    assert_eq!(refreshed.counts.waiting_unanswered.value(), 0);
    assert!(refreshed.rows.is_empty());
    assert_eq!(permission_diagnostic(&permission), Some(diagnostic));
}
