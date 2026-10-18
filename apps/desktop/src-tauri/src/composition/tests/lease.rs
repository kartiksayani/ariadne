//! A replacement activation after wake and the old activation's last lease clone.
//! The clone stands for a started call the old activation left running; it keeps
//! the binding's OS lease until it returns.
use super::*;

const HANG_GUARD: Duration = Duration::from_secs(30);

fn started(fixture: &Fixture) -> (Arc<NativeRuntime>, BindingScope) {
    let runtime = NativeRuntime::start(
        fixture.configuration(),
        Arc::new(|_| {}),
        Arc::new(|_| true),
    )
    .unwrap();
    let (_, scope, _, _) = fixture.connected(&runtime);
    (runtime, scope)
}

fn announce(fixture: &Fixture, n: u64, scope: &BindingScope) -> Result<ControlResult, CoreError> {
    fixture.call(
        n,
        ControlMethod::SessionAnnouncement(fixture.announcement(Some(scope.clone()))),
    )
}

fn assert_announced(announced: Result<ControlResult, CoreError>) {
    assert!(
        matches!(announced, Ok(ControlResult::Announcement(_))),
        "{announced:?}"
    );
}

fn finish(fixture: &Fixture, runtime: &NativeRuntime) {
    runtime.shutdown().unwrap();
    DesktopOwner::acquire(&fixture.home).unwrap();
}

#[test]
fn bound_announcement_after_wake_waits_for_the_old_activations_last_lease_clone() {
    let fixture = Fixture::new();
    let (runtime, scope) = started(&fixture);
    let old = runtime
        .held_lease_for_test(&scope)
        .expect("the old activation holds its lease");
    assert!(runtime.reconcile_after_wake().is_err());
    let announced = std::thread::scope(|threads| {
        let announcer = threads.spawn(|| announce(&fixture, 9, &scope));
        // The gate: release the clone only once the replacement is waiting for it.
        let until = Instant::now() + HANG_GUARD;
        while !runtime.awaiting_release_for_test(&scope) {
            if announcer.is_finished() {
                panic!("announced without waiting: {:?}", announcer.join().unwrap());
            }
            assert!(Instant::now() < until, "the replacement never waited");
            std::thread::sleep(Duration::from_millis(5));
        }
        drop(old);
        announcer.join().unwrap()
    });
    assert_announced(announced);
    fixture.wait_route(&scope);
    finish(&fixture, &runtime);
}

#[test]
fn old_clone_never_released_refuses_the_announcement_as_retryable_busy_then_a_retry_binds() {
    let fixture = Fixture::new();
    let (runtime, scope) = started(&fixture);
    let old = runtime
        .held_lease_for_test(&scope)
        .expect("the old activation holds its lease");
    assert!(runtime.reconcile_after_wake().is_err());
    let started = Instant::now();
    let refused = announce(&fixture, 9, &scope).unwrap_err();
    assert_eq!(refused.code, CoreErrorCode::StoreBusy, "{refused:?}");
    assert!(refused.retryable);
    assert!(started.elapsed() < HANG_GUARD);
    // Nothing started: no route, and the binding is kept for the retry.
    assert_eq!(
        fixture
            .call(10, ControlMethod::Ping(scope.clone()))
            .unwrap_err()
            .code,
        CoreErrorCode::NotFound
    );
    drop(old);
    assert_announced(announce(&fixture, 11, &scope));
    fixture.wait_route(&scope);
    finish(&fixture, &runtime);
}

#[test]
fn another_desktop_holding_the_binding_lease_is_still_permission_denied() {
    let fixture = Fixture::new();
    let (runtime, scope) = started(&fixture);
    assert!(runtime.reconcile_after_wake().is_err());
    // Another open file description on the lease file: what any other desktop
    // or supervisor holds. Retry until the old activation's lease is released.
    let path = fixture
        .home
        .join("run/leases")
        .join(format!("{}.lock", scope.binding_id.as_str()));
    let other = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .unwrap();
    let until = Instant::now() + HANG_GUARD;
    while other.try_lock().is_err() {
        assert!(Instant::now() < until, "the old lease was never released");
        std::thread::sleep(Duration::from_millis(5));
    }
    let refused = announce(&fixture, 9, &scope).unwrap_err();
    assert_eq!(refused.code, CoreErrorCode::PermissionDenied, "{refused:?}");
    assert!(!refused.retryable);
    drop(other);
    assert_announced(announce(&fixture, 10, &scope));
    fixture.wait_route(&scope);
    finish(&fixture, &runtime);
}
