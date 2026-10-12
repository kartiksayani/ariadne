use super::*;
use ariadne_core::{ProjectListResult, QueryRequest, QueryResult, SessionListResult};
use ariadne_domain::models::{
    ConnectionState, NonnegativeSafeInteger, Page, ProjectSummary, SessionState, SessionSummary,
};

#[test]
fn launch_notes_follow_the_current_open_session_state() {
    for (state, archived, connection, previous_connection, expected) in [
        (
            SessionState::Closed,
            false,
            ConnectionState::Disconnected,
            false,
            vec![],
        ),
        (
            SessionState::Closed,
            true,
            ConnectionState::Disconnected,
            false,
            vec![],
        ),
        (
            SessionState::Active,
            false,
            ConnectionState::Connected,
            false,
            vec![],
        ),
        (
            SessionState::Active,
            false,
            ConnectionState::Disconnected,
            false,
            vec!["Notes sync: could not start"],
        ),
        (
            SessionState::Active,
            false,
            ConnectionState::Reconnecting,
            true,
            vec!["Notes sync: reconnecting"],
        ),
    ] {
        let mut projects: Page<ProjectSummary> = serde_json::from_str(include_str!(
            "../../../../../../../fixtures/domain/projections/projects.json"
        ))
        .unwrap();
        let mut sessions: Page<SessionSummary> = serde_json::from_str(include_str!(
            "../../../../../../../fixtures/domain/projections/sessions.json"
        ))
        .unwrap();
        projects.items.truncate(1);
        sessions.items.truncate(1);
        let mut counts = projects.items[0].counts.clone();
        counts.waiting_unanswered = NonnegativeSafeInteger::new(0).unwrap();
        projects.items[0].counts = counts.clone();
        let session = &mut sessions.items[0];
        session.name = Some("Notes sync".into());
        session.state = state.clone();
        session.archived_at = archived.then(|| UtcMillis::new("2026-10-09T00:00:00.000Z").unwrap());
        session.counts = counts.clone();
        let binding = session.active_binding.as_mut().unwrap();
        binding.connection_state = connection;
        binding.owner_paused = state == SessionState::Closed;
        let mut lifecycle = Diagnostics::default();
        lifecycle.replace(
            vec![LifecycleNote::connection(
                binding.id.as_str(),
                if previous_connection {
                    "00000000-0000-4000-8000-000000000099"
                } else {
                    binding.generation.as_str()
                },
                "could not start",
            )],
            false,
        );
        let (captured, bindings) = capture_for_tray(|request| match request.request {
            QueryRequest::ProjectList(_) => Ok(QueryResult::ProjectList(ProjectListResult {
                projects: projects.clone(),
                counts: counts.clone(),
            })),
            QueryRequest::SessionList(_) => Ok(QueryResult::SessionList(SessionListResult {
                sessions: sessions.clone(),
                active_total: NonnegativeSafeInteger::new(u64::from(state == SessionState::Active))
                    .unwrap(),
                closed_total: NonnegativeSafeInteger::new(u64::from(
                    state == SessionState::Closed && !archived,
                ))
                .unwrap(),
                archived_total: NonnegativeSafeInteger::new(u64::from(archived)).unwrap(),
                counts: counts.clone(),
            })),
            _ => panic!("No waiting questions need a snapshot"),
        })
        .unwrap();
        let projection =
            TrayProjection::from_capture(&captured, &lifecycle.render(&captured.labels, &bindings));
        assert_eq!(projection.diagnostics, expected);
        assert!(projection.title.is_empty());
        assert!(projection.oldest.is_empty());
    }
}

#[test]
fn quit_fences_new_native_intents_and_retains_the_already_owned_queue() {
    let (sender, receiver) = mpsc::sync_channel(16);
    let tray = NativeTray {
        sender,
        dirty: Arc::new(AtomicBool::new(false)),
        stopped: Arc::new(AtomicBool::new(false)),
        callbacks_active: Arc::new(AtomicBool::new(true)),
        teardown: Arc::new(|| Ok(())),
        worker: Arc::new(Mutex::new(None)),
        diagnostics: Arc::new(Mutex::new(Diagnostics::default())),
    };
    tray.pin(); // Explicit intent accepted before the lifecycle fence.
    tray.begin_stop();
    assert!(!tray.callbacks_active.load(Ordering::Acquire));
    tray.pin();
    tray.refresh();
    assert!(matches!(receiver.try_recv(), Ok(Message::Pin)));
    assert!(matches!(
        receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    tray.stop().unwrap();
    assert!(tray.stopped.load(Ordering::Acquire));
}
