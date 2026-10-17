use super::StoreError;
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError, Weak};
use std::time::{Duration, Instant};

type Locks = HashMap<PathBuf, Weak<Fair>>;
static LOCKS: OnceLock<Mutex<Locks>> = OnceLock::new();

pub(crate) fn keyed(path: &Path) -> Result<Arc<Fair>, StoreError> {
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
            let lock = Arc::new(Fair::default());
            locks.insert(path.into(), Arc::downgrade(&lock));
            lock
        }))
}

/// How long one lock acquisition waits before it reports `StoreError::Busy`.
pub const LOCK_WAIT: Duration = Duration::from_secs(2);

/// How often a cross-process (flock) waiter tries again. Flat, so a long
/// waiter polls as often as a newcomer.
const FLOCK_POLL: Duration = Duration::from_millis(10);

/// The in-process lock for one path. Waiters take it strictly in arrival
/// order, so a newcomer never overtakes the longest waiter. A waiter whose
/// deadline passes leaves the queue and the next one moves up.
#[derive(Default)]
pub(crate) struct Fair {
    queue: Mutex<Queue>,
    turn: Condvar,
}

#[derive(Default)]
struct Queue {
    next_ticket: u64,
    waiting: VecDeque<u64>,
    held: bool,
    /// A holder panicked, as a std `Mutex` would report it.
    poisoned: bool,
}

impl Fair {
    /// The queue holds only this file's bookkeeping, which no step leaves
    /// half-done, so a poisoned queue mutex is still consistent.
    fn queue(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(test)]
    fn waiting(&self) -> usize {
        self.queue().waiting.len()
    }
}

/// Holds a `Fair` lock; dropping it hands the lock to the longest waiter.
pub(crate) struct FairGuard<'a>(&'a Fair);

impl Drop for FairGuard<'_> {
    fn drop(&mut self) {
        let mut queue = self.0.queue();
        queue.held = false;
        queue.poisoned |= std::thread::panicking();
        drop(queue);
        self.0.turn.notify_all();
    }
}

pub(crate) struct Wait {
    deadline: Instant,
}

impl Wait {
    pub fn new() -> Self {
        Self {
            deadline: Instant::now() + LOCK_WAIT,
        }
    }

    fn retry(&mut self) -> Result<(), StoreError> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(StoreError::Busy);
        }
        std::thread::sleep(FLOCK_POLL.min(remaining));
        Ok(())
    }

    pub fn mutex<'a>(&mut self, lock: &'a Fair) -> Result<FairGuard<'a>, StoreError> {
        let mut queue = lock.queue();
        let ticket = queue.next_ticket;
        queue.next_ticket += 1;
        queue.waiting.push_back(ticket);
        loop {
            if queue.poisoned {
                return Err(leave(lock, queue, ticket, StoreError::LockPoisoned));
            }
            if !queue.held && queue.waiting.front() == Some(&ticket) {
                queue.waiting.pop_front();
                queue.held = true;
                return Ok(FairGuard(lock));
            }
            let remaining = self.deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(leave(lock, queue, ticket, StoreError::Busy));
            }
            queue = lock
                .turn
                .wait_timeout(queue, remaining)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
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

/// Drop a waiter that gives up, and wake the rest: the next one may now be first.
fn leave(
    lock: &Fair,
    mut queue: MutexGuard<'_, Queue>,
    ticket: u64,
    error: StoreError,
) -> StoreError {
    queue.waiting.retain(|waiting| *waiting != ticket);
    drop(queue);
    lock.turn.notify_all();
    error
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
    with_lock_mode(directory, name, true, work)
}

pub(crate) fn with_lock_mode<T, E: From<StoreError>>(
    directory: &super::fs::Directory,
    name: &str,
    create: bool,
    work: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    let path = directory.path.join(name);
    let keyed = keyed(&path)?;
    let mut wait = Wait::new();
    let _mutex = wait.mutex(&keyed)?;
    let _flock = wait.flock(directory.open(name, create)?, &path)?;
    work()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;

    /// A wait long enough that a loaded machine cannot time it out.
    fn patient() -> Wait {
        Wait {
            deadline: Instant::now() + Duration::from_secs(60),
        }
    }

    fn until(done: impl Fn() -> bool) {
        let started = Instant::now();
        while !done() {
            assert!(
                started.elapsed() < Duration::from_secs(60),
                "waiter never queued"
            );
            thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn the_longest_waiter_gets_the_lock_before_newcomers() {
        let lock = Arc::new(Fair::default());
        let order = Arc::new(Mutex::new(Vec::new()));
        let held = patient().mutex(&lock).unwrap();
        let waiters: Vec<_> = (0..6)
            .map(|n| {
                let (shared, order) = (lock.clone(), order.clone());
                let waiter = thread::spawn(move || {
                    let _guard = patient().mutex(&shared).unwrap();
                    order.lock().unwrap().push(n);
                });
                until(|| lock.waiting() == n + 1);
                if n == 0 {
                    // The first waiter has waited far longer than any newcomer.
                    thread::sleep(Duration::from_millis(100));
                }
                waiter
            })
            .collect();
        drop(held);
        for waiter in waiters {
            waiter.join().unwrap();
        }
        assert_eq!(*order.lock().unwrap(), vec![0, 1, 2, 3, 4, 5]);
    }

    #[test]
    fn a_waiter_that_runs_out_of_time_is_busy_and_does_not_block_the_next() {
        let lock = Arc::new(Fair::default());
        let held = patient().mutex(&lock).unwrap();
        let mut hurried = Wait {
            deadline: Instant::now() + Duration::from_millis(50),
        };
        assert!(matches!(hurried.mutex(&lock), Err(StoreError::Busy)));
        assert_eq!(lock.waiting(), 0);
        let next = {
            let lock = lock.clone();
            thread::spawn(move || patient().mutex(&lock).map(|_| ()))
        };
        until(|| lock.waiting() == 1);
        drop(held);
        assert!(next.join().unwrap().is_ok());
    }

    #[test]
    fn a_holder_that_panics_poisons_the_lock() {
        let lock = Arc::new(Fair::default());
        let holder = {
            let lock = lock.clone();
            thread::spawn(move || {
                let _guard = patient().mutex(&lock).unwrap();
                panic!("holder failed");
            })
        };
        assert!(holder.join().is_err());
        assert!(matches!(
            patient().mutex(&lock),
            Err(StoreError::LockPoisoned)
        ));
    }

    #[test]
    fn only_one_thread_holds_the_lock_at_a_time() {
        let lock = Arc::new(Fair::default());
        let inside = Arc::new(AtomicUsize::new(0));
        let entries = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (lock, inside, entries) = (lock.clone(), inside.clone(), entries.clone());
                thread::spawn(move || {
                    for _ in 0..200 {
                        let _guard = patient().mutex(&lock).unwrap();
                        assert_eq!(inside.fetch_add(1, Ordering::SeqCst), 0);
                        entries.fetch_add(1, Ordering::SeqCst);
                        inside.fetch_sub(1, Ordering::SeqCst);
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(entries.load(Ordering::SeqCst), 8 * 200);
        assert_eq!(lock.waiting(), 0);
    }
}
