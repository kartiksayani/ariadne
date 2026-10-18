//! Stable nonblocking leases. They authorize desktop claims, never host signals.
pub(crate) mod fs;
use self::fs::{error, held_elsewhere, try_lock, Directory};
use ariadne_core::{CoreError, CoreErrorCode, RegisteredSession, ValidatedDispatchContext};
use ariadne_domain::models::UuidV4;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    os::fd::AsRawFd,
    path::Path,
    sync::{Arc, Condvar, Mutex, MutexGuard},
    time::{Duration, Instant},
};

/// The longest a replacement activation waits for this desktop's own earlier
/// lease on the same binding to be released. It matches the store's lock wait.
pub const LEASE_RELEASE_WAIT: Duration = Duration::from_secs(2);

pub struct DesktopOwner {
    pub(crate) home: Directory,
    pub(crate) run: Directory,
    leases: Directory,
    held: Arc<Held>,
    _instance: File,
    acquiring_process: u32,
}
/// This owner's live binding leases. Under `state`'s lock a binding is listed
/// exactly while this owner holds its lease file's lock: a lease is listed only
/// after its flock succeeds, and unlisted only when it is unlocked. So a locked
/// file whose binding is not listed is held by another desktop or supervisor.
#[derive(Default)]
struct Held {
    state: Mutex<HeldState>,
    released: Condvar,
}
#[derive(Default)]
struct HeldState {
    bindings: BTreeSet<String>,
    waiting: BTreeMap<String, usize>,
}
impl Held {
    fn lock(&self) -> MutexGuard<'_, HeldState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}
/// This desktop's own earlier lease is still alive: a started call of a replaced
/// activation has not returned. Nothing was started; trying again is safe.
fn still_releasing() -> CoreError {
    CoreError::new(
        CoreErrorCode::StoreBusy,
        "This desktop's previous connection to this binding is still finishing; nothing was started.",
        "Ariadne is busy for a moment; try again.",
    )
}
impl DesktopOwner {
    /// Blocking native setup; entrypoints call this off the UI/executor thread.
    pub fn acquire(home: &Path) -> Result<Self, CoreError> {
        let home = Directory::home(home, true)?;
        let run = home.child("run", true)?;
        let instance = run.lock("runtime.lock")?;
        let leases = run.child("leases", true)?;
        Ok(Self {
            home,
            run,
            leases,
            held: Arc::default(),
            _instance: instance,
            acquiring_process: std::process::id(),
        })
    }
    /// Caller has resolved the session and binding through trusted registration.
    /// Never waits. Another holder is `permission_denied`; this owner's own live
    /// lease on the binding is the retryable `store_busy`.
    pub fn binding_lease(
        &self,
        session: RegisteredSession,
        binding_id: UuidV4,
        generation: UuidV4,
    ) -> Result<BindingLease, CoreError> {
        self.binding_lease_until(session, binding_id, generation, Instant::now())
    }
    /// Dynamic composition keeps the one real instance owner alive through every
    /// lease clone, including started blocking calls surviving caller timeout.
    pub fn binding_lease_shared(
        self: &Arc<Self>,
        session: RegisteredSession,
        binding_id: UuidV4,
        generation: UuidV4,
    ) -> Result<BindingLease, CoreError> {
        self.binding_lease_shared_until(session, binding_id, generation, Instant::now())
    }
    /// A replacement activation's lease. While this owner's earlier lease on the
    /// binding is still alive (a replaced activation's started call keeps a
    /// clone until it returns), wait for its release, for at most
    /// `LEASE_RELEASE_WAIT` and never past `deadline`, then return `store_busy`.
    /// Blocking: call it off the UI and async executor threads.
    pub fn binding_lease_shared_before(
        self: &Arc<Self>,
        session: RegisteredSession,
        binding_id: UuidV4,
        generation: UuidV4,
        deadline: Instant,
    ) -> Result<BindingLease, CoreError> {
        let until = deadline.min(Instant::now() + LEASE_RELEASE_WAIT);
        self.binding_lease_shared_until(session, binding_id, generation, until)
    }
    /// Whether a lease request is waiting for this owner's own earlier lease on
    /// the binding to be released.
    pub fn is_awaiting_release(&self, binding_id: &UuidV4) -> bool {
        self.held.lock().waiting.contains_key(binding_id.as_str())
    }
    pub fn control_path(&self) -> std::path::PathBuf {
        self.run.path.join("control.sock")
    }
    fn binding_lease_shared_until(
        self: &Arc<Self>,
        session: RegisteredSession,
        binding_id: UuidV4,
        generation: UuidV4,
        until: Instant,
    ) -> Result<BindingLease, CoreError> {
        let mut lease = self.binding_lease_until(session, binding_id, generation, until)?;
        Arc::get_mut(&mut lease.inner)
            .expect("new lease is exclusively owned")
            ._owner = Some(self.clone());
        Ok(lease)
    }
    fn binding_lease_until(
        &self,
        session: RegisteredSession,
        binding_id: UuidV4,
        generation: UuidV4,
        until: Instant,
    ) -> Result<BindingLease, CoreError> {
        self.home.validate_path()?;
        self.run.validate_path()?;
        self.leases.validate_path()?;
        let key = binding_id.as_str().to_owned();
        let file = self.leases.lease_file(&format!("{key}.lock"))?;
        let mut state = self.held.lock();
        // Every try runs under the held-set lock, so a release cannot slip
        // between a failed try and the check of who holds the lock.
        while !try_lock(&file)? {
            if !state.bindings.contains(&key) {
                return Err(held_elsewhere());
            }
            let now = Instant::now();
            if now >= until {
                return Err(still_releasing());
            }
            *state.waiting.entry(key.clone()).or_default() += 1;
            state = self
                .held
                .released
                .wait_timeout(state, until - now)
                .unwrap_or_else(|poison| poison.into_inner())
                .0;
            if let Some(waiting) = state.waiting.get_mut(&key) {
                *waiting -= 1;
                if *waiting == 0 {
                    state.waiting.remove(&key);
                }
            }
        }
        state.bindings.insert(key);
        drop(state);
        Ok(BindingLease {
            inner: Arc::new(LeaseInner {
                _file: file,
                held: self.held.clone(),
                _owner: None,
                acquiring_process: std::process::id(),
                session,
                binding_id,
                generation,
            }),
        })
    }
}
impl Drop for DesktopOwner {
    fn drop(&mut self) {
        unlock_acquired(&self._instance, self.acquiring_process);
    }
}
struct LeaseInner {
    _file: File,
    held: Arc<Held>,
    _owner: Option<Arc<DesktopOwner>>,
    acquiring_process: u32,
    session: RegisteredSession,
    binding_id: UuidV4,
    generation: UuidV4,
}
impl Drop for LeaseInner {
    fn drop(&mut self) {
        if std::process::id() != self.acquiring_process {
            // See unlock_acquired: an inherited copy never releases the parent's lease.
            return;
        }
        // Unlock and unlist together, then wake any replacement waiting for it.
        let mut state = self.held.lock();
        unlock_acquired(&self._file, self.acquiring_process);
        state.bindings.remove(self.binding_id.as_str());
        drop(state);
        self.held.released.notify_all();
    }
}
fn unlock_acquired(file: &File, acquiring_process: u32) {
    // A forked child can retain this open file description until exec despite
    // CLOEXEC. Final Arc destruction in the acquiring process must release the
    // lock independently of those inherited descriptors. A child dropping its
    // inherited Rust object must never unlock the still-live parent's lease.
    if std::process::id() == acquiring_process {
        // SAFETY: the final owner still owns this live fd; LOCK_UN never waits.
        let _ = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    }
}
/// Cloning retains the actual OS lease, including throughout a blocking core call.
#[derive(Clone)]
pub struct BindingLease {
    inner: Arc<LeaseInner>,
}
impl BindingLease {
    pub fn session(&self) -> &RegisteredSession {
        &self.inner.session
    }
    pub fn binding_id(&self) -> &UuidV4 {
        &self.inner.binding_id
    }
    pub fn generation(&self) -> &UuidV4 {
        &self.inner.generation
    }
    pub(crate) fn context(
        &self,
        binding: &UuidV4,
        generation: &UuidV4,
    ) -> Result<ValidatedDispatchContext, CoreError> {
        if binding != self.binding_id() {
            return Err(error(
                CoreErrorCode::BindingMismatch,
                "Control binding differs from the held lease.",
            ));
        }
        if generation != self.generation() {
            return Err(error(
                CoreErrorCode::StaleGeneration,
                "Control generation differs from the held lease.",
            ));
        }
        Ok(ValidatedDispatchContext::from_trusted_current_lease(
            self.session().clone(),
            binding.clone(),
            generation.clone(),
        ))
    }
}
