use super::StoreError;
use std::collections::HashMap;
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, TryLockError, Weak};
use std::time::{Duration, Instant};

type Locks = HashMap<PathBuf, Weak<Mutex<()>>>;
static LOCKS: OnceLock<Mutex<Locks>> = OnceLock::new();

pub(crate) fn keyed(path: &Path) -> Result<Arc<Mutex<()>>, StoreError> {
    let mut locks = LOCKS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| StoreError::LockPoisoned)?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    Ok(locks
        .entry(path.into())
        .or_default()
        .upgrade()
        .unwrap_or_else(|| {
            let lock = Arc::new(Mutex::new(()));
            locks.insert(path.into(), Arc::downgrade(&lock));
            lock
        }))
}

pub(crate) struct Wait {
    deadline: Instant,
    delay: Duration,
}

impl Wait {
    pub fn new() -> Self {
        Self {
            deadline: Instant::now() + Duration::from_secs(2),
            delay: Duration::from_millis(10),
        }
    }

    fn retry(&mut self) -> Result<(), StoreError> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(StoreError::Busy);
        }
        std::thread::sleep(self.delay.min(remaining));
        self.delay = (self.delay * 2).min(Duration::from_millis(50));
        Ok(())
    }

    pub fn mutex<'a>(&mut self, mutex: &'a Mutex<()>) -> Result<MutexGuard<'a, ()>, StoreError> {
        loop {
            match mutex.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(TryLockError::Poisoned(_)) => return Err(StoreError::LockPoisoned),
                Err(TryLockError::WouldBlock) => self.retry()?,
            }
        }
    }

    pub fn flock(&mut self, file: File, path: &Path) -> Result<OsLock, StoreError> {
        loop {
            // SAFETY: file owns a live regular descriptor; flock borrows it.
            let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result == 0 {
                return Ok(OsLock(file));
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::WouldBlock
                && error.kind() != io::ErrorKind::Interrupted
            {
                return Err(StoreError::io("lock", path, error));
            }
            self.retry()?;
        }
    }
}

pub(crate) struct OsLock(File);
impl Drop for OsLock {
    fn drop(&mut self) {
        // SAFETY: the owned live descriptor is unlocked and then closed by File.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

/// Shared stable lock primitive; callers obey registry → metadata → session order.
pub(crate) fn with_lock<T, E: From<StoreError>>(
    directory: &super::fs::Directory,
    name: &str,
    work: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    let path = directory.path.join(name);
    let keyed = keyed(&path)?;
    let mut wait = Wait::new();
    let _mutex = wait.mutex(&keyed)?;
    let _flock = wait.flock(directory.open(name, true)?, &path)?;
    work()
}
