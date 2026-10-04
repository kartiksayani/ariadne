use ariadne_core::{CoreError, CoreErrorCode};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct State {
    ready: bool,
    stopped: bool,
}

/// Native readiness assertion, deliberately absent from control JSON.
/// Every newly constructed gate blocks claims until reconciliation completes.
#[derive(Clone, Default)]
pub struct ClaimGate(Arc<Mutex<State>>);
impl ClaimGate {
    pub fn new() -> Self {
        Self::default()
    }
    /// Trusted native composition calls this only after initial reconciliation
    /// and every corresponding core receipt have succeeded. It is not a lease.
    pub fn reconciled_from_trusted_native(&self) -> Result<(), CoreError> {
        let mut state = self.0.lock().map_err(|_| unavailable())?;
        if state.stopped {
            return Err(unavailable());
        }
        state.ready = true;
        Ok(())
    }
    /// Immediately fence new claims. Already admitted calls retain their lease.
    pub fn stop(&self) {
        let mut state = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
        state.ready = false;
        state.stopped = true;
    }
    pub(crate) fn admit<T>(&self, start: impl FnOnce() -> T) -> Result<T, CoreError> {
        let state = self.0.lock().map_err(|_| unavailable())?;
        if !state.ready || state.stopped {
            return Err(unavailable());
        }
        // The critical section covers only admission, never core IO or an await.
        Ok(start())
    }
}
fn unavailable() -> CoreError {
    CoreError::new(
        CoreErrorCode::HostUnreachable,
        "Binding claims are unavailable during startup reconciliation or shutdown.",
        "Retain the original claim request ID; earlier effects may exist. Reopen the desktop and repeat that exact request after reconciliation.",
    )
}
