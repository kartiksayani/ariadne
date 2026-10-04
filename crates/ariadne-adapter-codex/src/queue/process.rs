//! The owned queue sender is the only process this adapter may launch besides --version.
use ariadne_agent_protocol::SubmitOutcome;
use std::{
    io::{ErrorKind, Read},
    os::unix::io::AsRawFd,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub(super) fn send(
    executable: &Path,
    socket: &Path,
    thread: &str,
    payload: &str,
    deadline: Instant,
) -> SubmitOutcome {
    if Instant::now() >= deadline {
        return rejected("Codex sender deadline expired before spawn; nothing was sent.");
    }
    let Some(socket) = socket.to_str() else {
        return rejected("Resolved Codex endpoint must be UTF-8; nothing was sent.");
    };
    let spawned = Command::new(executable)
        .args([
            "queue",
            "--remote",
            &format!("unix://{socket}"),
            "--thread",
            thread,
            "--message",
            payload,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let Ok(mut child) = spawned else {
        return rejected("Cannot spawn the configured Codex queue sender; nothing was sent.");
    };
    let result = (|| {
        let mut stdout = child.stdout.take()?;
        let mut stderr = child.stderr.take()?;
        for fd in [stdout.as_raw_fd(), stderr.as_raw_fd()] {
            // SAFETY: each fd belongs to a live owned pipe; flags contain no pointers.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
            {
                return None;
            }
        }
        loop {
            // Neither receipt text nor stderr is a stable protocol. Drain both without retaining
            // private provider output. One bounded read per pipe also prevents output starvation.
            for pipe in [&mut stdout as &mut dyn Read, &mut stderr as &mut dyn Read] {
                let mut bytes = [0; 8192];
                match pipe.read(&mut bytes) {
                    Ok(_) => {}
                    Err(e)
                        if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                    Err(_) => return None,
                }
            }
            if let Some(status) = child.try_wait().ok()? {
                return Some(status.success());
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    })();
    if result.is_none() {
        // Only the short-lived sender is owned here. Never signal or stop the daemon/host.
        let _ = child.kill();
    }
    let _ = child.wait();
    match result {
        Some(true) => SubmitOutcome::Accepted { receipt: None },
        Some(false) => uncertain("Codex queue sender exited unsuccessfully after spawn; reconcile before any explicit recovery."),
        None => uncertain("Codex queue sender timed out or lost its receipt after spawn; reconcile before any explicit recovery."),
    }
}
pub(super) fn rejected(reason: &str) -> SubmitOutcome {
    SubmitOutcome::RejectedBeforeDelivery {
        reason: reason.to_owned(),
    }
}
pub(super) fn uncertain(reason: &str) -> SubmitOutcome {
    SubmitOutcome::Uncertain {
        reason: reason.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};
    #[test]
    fn sender_spawn_failure_and_expired_admission_are_proven_unsent() {
        assert!(matches!(
            send(
                Path::new("/absent/ariadne-test-codex"),
                Path::new("/unused"),
                "thread",
                "payload",
                Instant::now() + Duration::from_secs(1)
            ),
            SubmitOutcome::RejectedBeforeDelivery { .. }
        ));
        assert!(matches!(
            send(
                Path::new("/unused"),
                Path::new("/unused"),
                "thread",
                "payload",
                Instant::now()
            ),
            SubmitOutcome::RejectedBeforeDelivery { .. }
        ));
    }
    #[test]
    fn sender_timeout_after_spawn_remains_uncertain_and_bounds_owned_child_lifetime() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("sender");
        fs::write(&executable, "#!/bin/sh\nwhile :; do :; done\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let start = Instant::now();
        assert!(matches!(
            send(
                &executable,
                Path::new("/unused"),
                "thread",
                "payload",
                start + Duration::from_millis(40)
            ),
            SubmitOutcome::Uncertain { .. }
        ));
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
