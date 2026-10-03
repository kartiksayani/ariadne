//! Stable nonblocking leases. They authorize desktop claims, never host signals.
pub(crate) mod fs;
use self::fs::{error, Directory};
use ariadne_core::{CoreError, CoreErrorCode, RegisteredSession, ValidatedDispatchContext};
use ariadne_domain::models::UuidV4;
use std::{fs::File, path::Path, sync::Arc};

pub struct DesktopOwner {
    pub(crate) home: Directory,
    pub(crate) run: Directory,
    leases: Directory,
    _instance: File,
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
                session,
                binding_id,
                generation,
            }),
        })
    }
    pub fn control_path(&self) -> std::path::PathBuf {
        self.run.path.join("control.sock")
    }
}
struct LeaseInner {
    _file: File,
    session: RegisteredSession,
    binding_id: UuidV4,
    generation: UuidV4,
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
