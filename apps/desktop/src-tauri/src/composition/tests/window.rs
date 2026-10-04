use ariadne_core::*;

fn geometry(x: f64) -> WindowGeometry {
    WindowGeometry {
        x,
        y: 10.0,
        width: 1000.0,
        height: 700.0,
        monitor_id: Some("display".into()),
    }
}

#[test]
fn queued_geometry_before_quit_finishes_its_first_read_and_save_after_the_fence() {
    use crate::{
        composition::{NativeConfiguration, NativeRuntime},
        native::window::NativeWindow,
    };
    use std::{
        sync::{mpsc, Arc, Mutex},
        time::Duration,
    };
    let directory = tempfile::tempdir().unwrap();
    let runtime = NativeRuntime::start(
        NativeConfiguration {
            home: directory.path().join("data"),
            claude: None,
            codex: None,
            discovery_endpoints: vec![],
        },
        Arc::new(|_| {}),
        Arc::new(|_| true),
    )
    .unwrap();
    let service = runtime.bridge().desktop_service();
    let read = service.clone();
    let write = service.clone();
    let (started, began) = mpsc::channel();
    let (released, release) = mpsc::channel();
    let release = Mutex::new(release);
    let delayed = service.with_native_preferences(
        move || {
            started.send(()).unwrap();
            release.lock().unwrap().recv().unwrap();
            read.native_preferences()
        },
        move |request| write.native_preferences_write(request),
    );
    let window = NativeWindow::default();
    assert!(window.queue_geometry(geometry(20.0), delayed.clone()));
    began.recv_timeout(Duration::from_secs(1)).unwrap();
    window.begin_stop();
    runtime.begin_shutdown().unwrap();
    assert!(!window.queue_geometry(geometry(99.0), delayed.clone()));
    released.send(()).unwrap();
    window.join_writer(&delayed).unwrap();
    let core = runtime.bridge().core().clone();
    let QueryResult::PreferencesGet(saved) = core
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
    assert_eq!(saved.global.window, Some(geometry(20.0)));
    assert_eq!(saved.revision.value(), 2);
    assert!(runtime
        .bridge()
        .query(
            QueryContext::owner(OwnerContext::from_trusted_entrypoint(
                OwnerScope::Preferences
            )),
            QueryRequest::PreferencesGet {},
        )
        .is_err());
    runtime.shutdown().unwrap();
    assert!(delayed.native_preferences().is_err());
}
