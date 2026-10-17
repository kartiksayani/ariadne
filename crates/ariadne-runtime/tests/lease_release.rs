//! A replacement's lease waits, bounded, for this desktop's own earlier lease on
//! the binding; any other holder is still refused at once.
use ariadne_core::{CoreErrorCode, RegisteredSession};
use ariadne_domain::models::UuidV4;
use ariadne_runtime::leases::{DesktopOwner, LEASE_RELEASE_WAIT};
use std::{
    io::{Read, Write},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

const HANG_GUARD: Duration = Duration::from_secs(30);
const HOLD: &str = "ARIADNE_TEST_HOLD_LEASE_FILE";
const READY: &[u8] = b"<lease held>";

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn session() -> RegisteredSession {
    RegisteredSession::from_trusted_entrypoint(id(1), id(2))
}
fn owner() -> (tempfile::TempDir, Arc<DesktopOwner>) {
    let home = tempfile::tempdir().unwrap();
    std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let owner = Arc::new(DesktopOwner::acquire(home.path()).unwrap());
    (home, owner)
}
fn lease_path(home: &tempfile::TempDir) -> PathBuf {
    home.path()
        .join(format!("run/leases/{}.lock", id(3).as_str()))
}

#[test]
fn replacement_waits_for_its_own_earlier_clone_and_takes_the_lease_when_it_is_released() {
    let (_home, owner) = owner();
    let old = owner.binding_lease_shared(session(), id(3), id(4)).unwrap();
    let retained = old.clone();
    drop(old);
    let started = Instant::now();
    let replacement = std::thread::scope(|threads| {
        let waiter = threads.spawn(|| {
            owner.binding_lease_shared_before(session(), id(3), id(5), started + HANG_GUARD)
        });
        // The gate: release the clone only once the replacement waits for it.
        let until = Instant::now() + HANG_GUARD;
        while !owner.is_awaiting_release(&id(3)) {
            if waiter.is_finished() {
                panic!(
                    "returned without waiting: {:?}",
                    waiter.join().unwrap().err()
                );
            }
            assert!(Instant::now() < until, "the replacement never waited");
            std::thread::sleep(Duration::from_millis(5));
        }
        drop(retained);
        waiter.join().unwrap()
    });
    let replacement = replacement.expect("the released lease is taken");
    assert_eq!(replacement.generation(), &id(5));
    assert!(!owner.is_awaiting_release(&id(3)));
    // Still exclusive: the replacement now holds it.
    assert_eq!(
        owner
            .binding_lease(session(), id(3), id(6))
            .err()
            .unwrap()
            .code,
        CoreErrorCode::StoreBusy
    );
}

#[test]
fn own_clone_never_released_ends_in_retryable_busy_at_the_bound_not_permission_denied() {
    let (_home, owner) = owner();
    let _held = owner.binding_lease_shared(session(), id(3), id(4)).unwrap();
    // Plain requests never wait; they report this desktop's own holder as busy.
    let started = Instant::now();
    let plain = owner.binding_lease(session(), id(3), id(5)).err().unwrap();
    assert_eq!(plain.code, CoreErrorCode::StoreBusy);
    assert!(plain.retryable);
    assert!(started.elapsed() < LEASE_RELEASE_WAIT);
    // A replacement waits out its own bound, then reports busy.
    let started = Instant::now();
    let bounded = owner
        .binding_lease_shared_before(session(), id(3), id(5), started + HANG_GUARD)
        .err()
        .unwrap();
    let waited = started.elapsed();
    assert_eq!(bounded.code, CoreErrorCode::StoreBusy);
    assert!(bounded.retryable);
    assert!(waited >= LEASE_RELEASE_WAIT, "{waited:?}");
    assert!(waited < HANG_GUARD, "{waited:?}");
    // An earlier deadline ends the wait sooner.
    let started = Instant::now();
    let short = Duration::from_millis(100);
    let deadline = owner
        .binding_lease_shared_before(session(), id(3), id(5), started + short)
        .err()
        .unwrap();
    let waited = started.elapsed();
    assert_eq!(deadline.code, CoreErrorCode::StoreBusy);
    assert!(waited >= short && waited < LEASE_RELEASE_WAIT, "{waited:?}");
    assert!(!owner.is_awaiting_release(&id(3)));
}

#[test]
fn another_desktop_holding_the_lease_is_still_refused_at_once() {
    if let Some(path) = std::env::var_os(HOLD) {
        // The other desktop: hold the lease file's lock until stdin closes.
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        file.lock().unwrap();
        std::io::stdout().write_all(READY).unwrap();
        std::io::stdout().flush().unwrap();
        let _ = std::io::stdin().read_to_end(&mut Vec::new());
        return;
    }
    let (home, owner) = owner();
    // Create the lease file, then free it for the other process.
    drop(owner.binding_lease(session(), id(3), id(4)).unwrap());
    let mut other = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "another_desktop_holding_the_lease_is_still_refused_at_once",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(HOLD, lease_path(&home))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    // The test harness prints its own lines too; wait for the holder's marker.
    let mut seen = Vec::new();
    let stdout = other.stdout.as_mut().unwrap();
    while !seen.ends_with(READY) {
        let mut byte = [0_u8; 1];
        stdout.read_exact(&mut byte).unwrap();
        seen.push(byte[0]);
    }
    let started = Instant::now();
    let refused = owner
        .binding_lease_shared_before(session(), id(3), id(5), started + HANG_GUARD)
        .err()
        .unwrap();
    assert_eq!(refused.code, CoreErrorCode::PermissionDenied);
    assert!(!refused.retryable);
    assert!(started.elapsed() < LEASE_RELEASE_WAIT);
    assert!(!owner.is_awaiting_release(&id(3)));
    drop(other.stdin.take());
    assert!(other.wait().unwrap().success());
    owner
        .binding_lease_shared_before(session(), id(3), id(5), Instant::now() + HANG_GUARD)
        .expect("the other desktop released it");
}
