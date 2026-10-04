//! Stable nonblocking leases. They authorize desktop claims, never host signals.
pub(crate) mod fs;
use self::fs::{error, Directory};
use ariadne_core::{CoreError, CoreErrorCode, RegisteredSession, ValidatedDispatchContext};
use ariadne_domain::models::UuidV4;
use std::{fs::File, os::fd::AsRawFd, path::Path, sync::Arc};

pub struct DesktopOwner {
    pub(crate) home: Directory,
    pub(crate) run: Directory,
    leases: Directory,
    _instance: File,
    acquiring_process: u32,
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
            _instance: instance,
            acquiring_process: std::process::id(),
        })
    }
    /// Caller has resolved the session and binding through trusted registration.
    pub fn binding_lease(
        &self,
        session: RegisteredSession,
        binding_id: UuidV4,
        generation: UuidV4,
    ) -> Result<BindingLease, CoreError> {
        self.home.validate_path()?;
        self.run.validate_path()?;
        self.leases.validate_path()?;
        let file = self.leases.lock(&format!("{}.lock", binding_id.as_str()))?;
        Ok(BindingLease {
            inner: Arc::new(LeaseInner {
                _file: file,
                _owner: None,
                acquiring_process: std::process::id(),
                session,
                binding_id,
                generation,
            }),
        })
    }
    /// Dynamic composition keeps the one real instance owner alive through every
    /// lease clone, including started blocking calls surviving caller timeout.
    pub fn binding_lease_shared(
        self: &Arc<Self>,
        session: RegisteredSession,
        binding_id: UuidV4,
        generation: UuidV4,
    ) -> Result<BindingLease, CoreError> {
        let mut lease = self.binding_lease(session, binding_id, generation)?;
        Arc::get_mut(&mut lease.inner)
            .expect("new lease is exclusively owned")
            ._owner = Some(self.clone());
        Ok(lease)
    }
    pub fn control_path(&self) -> std::path::PathBuf {
        self.run.path.join("control.sock")
    }
}
impl Drop for DesktopOwner {
    fn drop(&mut self) {
        unlock_acquired(&self._instance, self.acquiring_process);
    }
}
struct LeaseInner {
    _file: File,
    _owner: Option<Arc<DesktopOwner>>,
    acquiring_process: u32,
    session: RegisteredSession,
    binding_id: UuidV4,
    generation: UuidV4,
}
impl Drop for LeaseInner {
    fn drop(&mut self) {
        unlock_acquired(&self._file, self.acquiring_process);
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
