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
    pub(crate) fn diagnostics(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .rev()
            .filter_map(|outcome| match outcome {
                ActivationOutcome::ConnectFailed { scope, failure } => Some(format!(
                    "Binding {}: {}{}",
                    scope.binding_id.as_str(),
                    failure.cause.message,
                    if failure.pending.is_some() {
                        " Unsaved connection facts remain retained."
                    } else {
                        ""
                    }
                )),
                ActivationOutcome::Failed { scope, error } => Some(format!(
                    "Binding {}: {}",
                    scope.binding_id.as_str(),
                    error.message
                )),
                ActivationOutcome::Stopped { scope, exit } => match exit {
                    Err(error) => Some(format!(
                        "Binding {}: {}",
                        scope.binding_id.as_str(),
                        error.message
                    )),
                    Ok(exit) if exit.pending.is_some() || exit.pending_claim.is_some() => {
                        Some(format!(
                            "Binding {} retains unconfirmed observation or claim facts.",
                            scope.binding_id.as_str()
                        ))
                    }
                    Ok(exit) => exit.error.as_ref().map(|error| {
                        format!("Binding {}: {}", scope.binding_id.as_str(), error.message)
                    }),
                },
            })
            .take(16)
            .collect()
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
    let refresh = app.clone();
    let report = app.clone();
    let diagnostic_handoffs = handoffs.clone();
    let runtime = NativeRuntime::start_with_presence_and_refresh(
        configuration,
        Arc::new(move |outcome| {
            outcomes
                .0
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(outcome);
            if let Some(tray) = report.try_state::<crate::native::tray::NativeTray>() {
                tray.diagnostics(outcomes.diagnostics());
            }
        }),
        Arc::new(move |hint| {
            let emitted = events.emit("ariadne://session_changed", hint).is_ok();
            if let Some(tray) = events.try_state::<crate::native::tray::NativeTray>() {
                tray.refresh();
            }
            emitted
        }),
        Arc::new(move |hint| presence.emit("ariadne://presence_changed", hint).is_ok()),
        Arc::new(move || {
            if let Some(tray) = refresh.try_state::<crate::native::tray::NativeTray>() {
                let mut diagnostics = diagnostic_handoffs.diagnostics();
                if let Some(runtime) = refresh.try_state::<Arc<NativeRuntime>>() {
                    diagnostics.extend(runtime.reconciliation_diagnostics());
                }
                tray.diagnostics(diagnostics);
            }
        }),
    )?;
    let preferences = app.clone();
    app.manage(
        runtime
            .bridge()
            .desktop_service()
            .with_preferences_changed(move |revision| {
                // Best effort: the renderer's periodic reconciliation covers a missed hint.
                let _ = preferences.emit(
                    "ariadne://preferences_changed",
                    crate::commands::PreferencesChangedHint { revision },
                );
            }),
    );
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

#[cfg(test)]
#[path = "tests/entrypoint.rs"]
mod tests;
