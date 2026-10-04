use super::{NativeConfiguration, NativeRuntime};
use ariadne_core::CoreError;
use ariadne_runtime::activation::ActivationOutcome;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

/// Exact unsaved facts stay owned by the actual native process. Reading this
/// handoff never acknowledges, retries or removes a persisted attempt.
#[derive(Default)]
pub struct ActivationHandoffs(Mutex<Vec<ActivationOutcome>>);
impl ActivationHandoffs {
    pub fn take(&self) -> Vec<ActivationOutcome> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|error| error.into_inner()))
    }
}

pub(crate) fn establish<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    configuration: NativeConfiguration,
) -> Result<crate::native::window::lifecycle::NativeLifecycle, CoreError> {
    let handoffs = Arc::new(ActivationHandoffs::default());
    let outcomes = handoffs.clone();
    let events = app.clone();
    let presence = app.clone();
    let runtime = NativeRuntime::start_with_presence(
        configuration,
        Arc::new(move |outcome| {
            outcomes
                .0
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(outcome);
        }),
        Arc::new(move |hint| events.emit("ariadne://session_changed", hint).is_ok()),
        Arc::new(move |hint| presence.emit("ariadne://presence_changed", hint).is_ok()),
    )?;
    app.manage(runtime.bridge().desktop_service());
    app.manage(handoffs);
    app.manage(runtime.clone());
    let startup = runtime.clone();
    // Actual providers may be absent. Reconcile persisted selections off UI,
    // keeping the same owner/runtime and retaining any qualification failure.
    runtime.spawn_reconciliation(startup);
    let shutdown = runtime.clone();
    Ok(
        crate::native::window::lifecycle::NativeLifecycle::from_trusted_owner(
            move || shutdown.shutdown(),
            move || runtime.reconcile_after_wake(),
        ),
    )
}
