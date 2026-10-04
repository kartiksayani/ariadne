use ariadne_core::RegisteredSession;
use ariadne_domain::models::UuidV4;
use ariadne_runtime::leases::DesktopOwner;
use std::{
    fs::File,
    io::{Read, Write},
    os::{fd::FromRawFd, unix::fs::PermissionsExt},
    process::Command,
    sync::Arc,
};

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}

// The child waits using only libc IO and _exit. Its inherited lease descriptors
// remain open until the parent has checked final-reference release.
struct Pipes {
    ready: [i32; 2],
    release: [i32; 2],
}
impl Pipes {
    fn new() -> Self {
        let mut pipes = Self {
            ready: [0; 2],
            release: [0; 2],
        };
        // SAFETY: each array has space for both newly owned pipe descriptors.
        assert_eq!(unsafe { libc::pipe(pipes.ready.as_mut_ptr()) }, 0);
        assert_eq!(unsafe { libc::pipe(pipes.release.as_mut_ptr()) }, 0);
        pipes
    }
    fn hold_child(&self) -> ! {
        // SAFETY: these are live pipe fds, each buffer is one byte, and _exit
        // avoids running unrelated inherited process/test cleanup after fork.
        unsafe {
            libc::close(self.ready[0]);
            libc::close(self.release[1]);
            let mut byte = 1_u8;
            if libc::write(self.ready[1], (&byte as *const u8).cast(), 1) != 1 {
                libc::_exit(2);
            }
            libc::close(self.ready[1]);
            libc::read(self.release[0], (&mut byte as *mut u8).cast(), 1);
            libc::_exit(0);
        }
    }
    fn await_child(self, pid: libc::pid_t) -> InheritedChild {
        // SAFETY: the parent closes its unused ends and transfers ownership of
        // each remaining fd to exactly one File.
        let (mut ready, release) = unsafe {
            libc::close(self.ready[1]);
            libc::close(self.release[0]);
            (
                File::from_raw_fd(self.ready[0]),
                File::from_raw_fd(self.release[1]),
            )
        };
        let child = InheritedChild { pid, release };
        ready.read_exact(&mut [0]).unwrap();
        child
    }
}
struct InheritedChild {
    pid: libc::pid_t,
    release: File,
}
impl Drop for InheritedChild {
    fn drop(&mut self) {
        let _ = self.release.write_all(&[1]);
        // SAFETY: this is our forked child; waitpid only writes the status value.
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(self.pid, &mut status, 0) }, self.pid);
        assert_eq!(status, 0);
    }
}

#[test]
fn inherited_descriptors_release_only_with_the_last_acquiring_process_reference() {
    const MODE: &str = "ARIADNE_TEST_INHERITED_LEASES";
    if std::env::var_os(MODE).is_none() {
        // Isolate fork from the runtime tests' worker pools and other tests.
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "inherited_descriptors_release_only_with_the_last_acquiring_process_reference",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(MODE, "1")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let home = tempfile::tempdir().unwrap();
    std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let session = RegisteredSession::from_trusted_entrypoint(id(1), id(2));

    let owner = Arc::new(DesktopOwner::acquire(home.path()).unwrap());
    let owner_lifetime = Arc::downgrade(&owner);
    let lease = owner
        .binding_lease_shared(session.clone(), id(3), id(4))
        .unwrap();
    let retained = lease.clone();
    let pipes = Pipes::new();
    // SAFETY: this isolated helper has started no runtime or provider workers;
    // the child only holds inherited objects and uses pipe IO before _exit.
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0);
    if pid == 0 {
        pipes.hold_child();
    }
    let child = pipes.await_child(pid);
    drop(owner);
    drop(lease);
    assert_eq!(owner_lifetime.strong_count(), 1);
    assert!(DesktopOwner::acquire(home.path()).is_err());
    assert!(owner_lifetime
        .upgrade()
        .unwrap()
        .binding_lease(session.clone(), id(3), id(4))
        .is_err());
    drop(retained);
    assert_eq!(owner_lifetime.strong_count(), 0);
    let owner = DesktopOwner::acquire(home.path())
        .expect("final parent reference releases the instance while the child still holds its fd");
    let lease = owner
        .binding_lease(session.clone(), id(3), id(4))
        .expect("final parent lease clone releases the binding while the child still holds its fd");
    drop(child);
    drop(lease);
    drop(owner);

    let owner = DesktopOwner::acquire(home.path()).unwrap();
    let lease = owner.binding_lease(session.clone(), id(3), id(4)).unwrap();
    let pipes = Pipes::new();
    // SAFETY: same isolated helper; the child drops only these lease objects
    // before its pipe handshake, with no runtime or provider workers running.
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0);
    if pid == 0 {
        drop(lease);
        drop(owner);
        pipes.hold_child();
    }
    let child = pipes.await_child(pid);
    assert!(DesktopOwner::acquire(home.path()).is_err());
    assert!(owner.binding_lease(session, id(3), id(4)).is_err());
    drop(child);
    drop(lease);
    drop(owner);
    DesktopOwner::acquire(home.path()).unwrap();
}
