use ariadne_core::{CoreError, CoreErrorCode};
use std::sync::{Arc, Mutex};

type Callback = dyn Fn() -> Result<(), CoreError> + Send + Sync;
struct OwnedCallbacks {
    shutdown: Box<Callback>,
    reconcile: Box<Callback>,
    stopped: bool,
}

/// Only the native startup owner supplies callbacks for its own runtime.
/// There is no callback installer or lifecycle authority in renderer IPC.
#[derive(Clone, Default)]
pub struct NativeLifecycle {
    owned: Option<Arc<Mutex<OwnedCallbacks>>>,
    diagnostic_only: bool,
}
fn unavailable() -> CoreError {
    CoreError::new(CoreErrorCode::Unsupported,"Native owning-runtime lifecycle is not composed.","Compose actual owned shutdown and reconciliation before reporting those operations complete.")
}
impl NativeLifecycle {
    /// Trusted startup explicitly established that no runtime/watchers were started.
    /// This permits process exit without claiming an owning-runtime shutdown.
    pub fn diagnostic_only() -> Self {
        Self {
            owned: None,
            diagnostic_only: true,
        }
    }
    /// Call off the UI thread before permitting explicit process exit.
    pub(crate) fn prepare_exit(&self) -> Result<(), CoreError> {
        if self.diagnostic_only {
            Ok(())
        } else {
            self.shutdown()
        }
    }
    pub fn from_trusted_owner(
        shutdown: impl Fn() -> Result<(), CoreError> + Send + Sync + 'static,
        reconcile: impl Fn() -> Result<(), CoreError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            diagnostic_only: false,
            owned: Some(Arc::new(Mutex::new(OwnedCallbacks {
                shutdown: Box::new(shutdown),
                reconcile: Box::new(reconcile),
                stopped: false,
            }))),
        }
    }
    /// Call off the UI thread. The owner joins only its own workers/helpers.
    pub fn shutdown(&self) -> Result<(), CoreError> {
        let mut callbacks = self
            .owned
            .as_ref()
            .ok_or_else(unavailable)?
            .lock()
            .map_err(|_| unavailable())?;
        if !callbacks.stopped {
            (callbacks.shutdown)()?;
            callbacks.stopped = true;
        }
        Ok(())
    }
    /// Call off the UI thread; this callback does not infer idle or resend work.
    pub fn reconcile(&self) -> Result<(), CoreError> {
        let callbacks = self
            .owned
            .as_ref()
            .ok_or_else(unavailable)?
            .lock()
            .map_err(|_| unavailable())?;
        if callbacks.stopped {
            return Err(unavailable());
        }
        (callbacks.reconcile)()
    }
}

#[cfg(test)]
#[path = "tests/lifecycle.rs"]
mod tests;
