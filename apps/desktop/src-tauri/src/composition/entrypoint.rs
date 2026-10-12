use super::{NativeConfiguration, NativeRuntime};
use crate::native::tray::LifecycleNote;
use ariadne_core::CoreError;
use ariadne_runtime::activation::ActivationOutcome;
use std::collections::BTreeSet;
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
    /// Plain tray notes per binding; the tray names each session by its label.
    pub(crate) fn diagnostics(&self) -> Vec<LifecycleNote> {
        let mut seen = BTreeSet::new();
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .rev()
            .filter(|outcome| {
                let scope = match outcome {
                    ActivationOutcome::ConnectFailed { scope, .. }
                    | ActivationOutcome::Failed { scope, .. }
                    | ActivationOutcome::Stopped { scope, .. } => scope,
                };
                seen.insert((scope.binding_id.clone(), scope.generation.clone()))
            })
            .filter_map(|outcome| {
                let (scope, text) = match outcome {
                    ActivationOutcome::ConnectFailed { scope, .. } => (scope, "could not connect"),
                    ActivationOutcome::Failed { scope, .. } => (scope, "could not start"),
                    ActivationOutcome::Stopped { scope, exit } => match exit {
                        Err(_) => (scope, "disconnected unexpectedly"),
                        Ok(exit) if exit.pending.is_some() || exit.pending_claim.is_some() => {
                            (scope, "disconnected before its last update was saved")
                        }
                        Ok(exit) if exit.error.is_some() => (scope, "disconnected unexpectedly"),
                        Ok(_) => return None,
                    },
                };
                Some(LifecycleNote::connection(
                    scope.binding_id.as_str(),
                    scope.generation.as_str(),
                    text,
                ))
            })
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
                    diagnostics.extend(
                        runtime
                            .reconciliation_diagnostics()
                            .into_iter()
                            .map(LifecycleNote::general),
                    );
                }
                tray.diagnostics(diagnostics);
            }
        }),
    )?;
    let health = app.clone();
    runtime.set_supervisor_health_emitter(Arc::new(move |entry| {
        // Best effort: the renderer reads `supervisor_health` on mount.
        let _ = health.emit("ariadne://supervisor_health", entry);
    }));
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
