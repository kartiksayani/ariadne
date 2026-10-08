//! Delivery-supervisor health for the renderer (`ariadne://supervisor_health`
//! plus the `supervisor_health` command) and the doctor's heartbeat file.
//! Logging of activation outcomes lives here too: IDs and error codes only.
use ariadne_domain::models::UtcMillis;
use ariadne_runtime::{
    activation::ActivationOutcome,
    health::{HealthBoard, HealthObserver, SupervisorHealth, SupervisorState},
    logging,
};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::SystemTime,
};

type Emitter = dyn Fn(SupervisorHealth) + Send + Sync;

pub(crate) struct HealthHub {
    board: HealthBoard,
    emit: Mutex<Option<Arc<Emitter>>>,
}
impl HealthHub {
    pub(crate) fn new(home: Option<&Path>) -> Arc<Self> {
        Arc::new(Self {
            board: HealthBoard::new(home),
            emit: Mutex::new(None),
        })
    }
    /// The renderer emitter is installed after startup; earlier entries are
    /// still served by the `supervisor_health` command.
    pub(crate) fn set_emitter(&self, emit: Arc<Emitter>) {
        *self.emit.lock().unwrap_or_else(|p| p.into_inner()) = Some(emit);
    }
    pub(crate) fn observer(self: &Arc<Self>) -> Arc<HealthObserver> {
        let hub = self.clone();
        Arc::new(move |health| hub.publish(health))
    }
    fn publish(&self, health: SupervisorHealth) {
        if self.board.publish(health.clone()) {
            self.emit(health);
        }
    }
    fn emit(&self, health: SupervisorHealth) {
        let emit = self.emit.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(emit) = emit {
            emit(health);
        }
    }
    pub(crate) fn snapshot(&self) -> Vec<SupervisorHealth> {
        self.board.snapshot()
    }
    pub(crate) fn heartbeat(&self) {
        self.board.heartbeat();
    }
    /// Logs every activation outcome and drops the entry of a supervisor that
    /// ended without a fault, so a disconnected binding shows nothing.
    pub(crate) fn observe_outcome(&self, outcome: &ActivationOutcome) {
        match outcome {
            ActivationOutcome::ConnectFailed { scope, failure } => logging::warn(
                "activation",
                &format!(
                    "binding={} generation={} connect failed: {:?}",
                    scope.binding_id.as_str(),
                    scope.generation.as_str(),
                    failure.cause.code
                ),
            ),
            ActivationOutcome::Failed { scope, error } => logging::error(
                "activation",
                &format!(
                    "binding={} generation={} failed: {:?}",
                    scope.binding_id.as_str(),
                    scope.generation.as_str(),
                    error.code
                ),
            ),
            ActivationOutcome::Stopped { scope, exit } => {
                let fault = match exit {
                    Err(error) => Some(error.code),
                    Ok(exit) => exit.error.as_ref().map(|error| error.code),
                };
                let retained = matches!(exit, Ok(exit) if exit.pending.is_some() || exit.pending_claim.is_some());
                logging::info(
                    "activation",
                    &format!(
                        "binding={} generation={} supervisor ended: fault={fault:?} retained_facts={retained}",
                        scope.binding_id.as_str(),
                        scope.generation.as_str(),
                    ),
                );
                // A supervisor that ended itself published `stopped` with its
                // reason; keep that. Any other end (disconnect, wake, quit,
                // including a stop while backing off) leaves nothing to show.
                // The renderer is told with a plain `running` entry, so it drops
                // any "retrying in Ns" it still shows for this generation.
                let ended_itself = self.board.snapshot().iter().any(|entry| {
                    entry.binding_id == scope.binding_id
                        && entry.generation == scope.generation
                        && entry.state == SupervisorState::Stopped
                });
                if !ended_itself && self.board.forget(&scope.binding_id, &scope.generation) {
                    if let Ok(at) = UtcMillis::new(logging::utc(SystemTime::now())) {
                        self.emit(SupervisorHealth::running(
                            scope.binding_id.clone(),
                            scope.generation.clone(),
                            at,
                        ));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ariadne_domain::models::UuidV4;
    use ariadne_runtime::{control::BindingScope, supervisor::SupervisorExit};

    fn id(n: u8) -> UuidV4 {
        UuidV4::new(format!("00000000-0000-4000-8000-0000000000{n:02}")).unwrap()
    }
    fn at() -> UtcMillis {
        UtcMillis::new("2026-10-07T12:00:00.000Z").unwrap()
    }
    fn clean_exit() -> SupervisorExit {
        SupervisorExit {
            pending: None,
            pending_claim: None,
            acknowledged_checkpoint: None,
            diagnostics: vec![],
            error: None,
        }
    }

    #[test]
    fn emits_only_changes_and_forgets_a_supervisor_stopped_on_request() {
        let home = tempfile::tempdir().unwrap();
        let hub = HealthHub::new(Some(home.path()));
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = emitted.clone();
        let observer = hub.observer();
        // Before the emitter exists the entry is still kept for the command.
        observer(SupervisorHealth::running(id(1), id(2), at()));
        hub.set_emitter(Arc::new(move |health| sink.lock().unwrap().push(health)));
        observer(SupervisorHealth::running(id(1), id(2), at()));
        observer(SupervisorHealth::backing_off(
            id(1),
            id(2),
            "Ariadne can't reach Codex right now.".into(),
            std::time::Duration::from_secs(2),
            at(),
        ));
        assert_eq!(
            emitted.lock().unwrap().len(),
            1,
            "unchanged entries are not re-emitted"
        );
        assert_eq!(hub.snapshot().len(), 1);
        // Stopped on request while backing off: the exit carries that cause,
        // but nothing is left to show for a supervisor that no longer runs.
        let mut exit = clean_exit();
        exit.error = Some(ariadne_core::CoreError::new(
            ariadne_core::CoreErrorCode::HostUnreachable,
            "Unreachable.",
            "Retry.",
        ));
        hub.observe_outcome(&ActivationOutcome::Stopped {
            scope: BindingScope {
                binding_id: id(1),
                generation: id(2),
            },
            exit: Ok(exit),
        });
        assert!(hub.snapshot().is_empty());
        assert!(home.path().join("logs/supervisor-health.json").is_file());
    }

    #[test]
    fn forgetting_an_entry_emits_running_so_the_renderer_drops_its_retry_countdown() {
        let hub = HealthHub::new(None);
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = emitted.clone();
        hub.set_emitter(Arc::new(move |health| sink.lock().unwrap().push(health)));
        hub.observer()(SupervisorHealth::backing_off(
            id(1),
            id(2),
            "Ariadne can't reach Codex right now.".into(),
            std::time::Duration::from_secs(8),
            at(),
        ));
        let stopped = |generation| ActivationOutcome::Stopped {
            scope: BindingScope {
                binding_id: id(1),
                generation,
            },
            exit: Ok(clean_exit()),
        };
        // A late clean stop of an older generation forgets and emits nothing.
        hub.observe_outcome(&stopped(id(3)));
        assert_eq!(emitted.lock().unwrap().len(), 1);
        hub.observe_outcome(&stopped(id(2)));
        assert!(hub.snapshot().is_empty());
        let emitted = emitted.lock().unwrap();
        assert_eq!(emitted.len(), 2);
        let forgotten = serde_json::to_value(&emitted[1]).unwrap();
        assert_eq!(forgotten["binding_id"], id(1).as_str());
        assert_eq!(forgotten["generation"], id(2).as_str());
        assert_eq!(forgotten["state"], "running");
        assert!(forgotten["reason"].is_null());
        assert!(forgotten["retry_in_seconds"].is_null());
    }

    #[test]
    fn a_faulted_stop_keeps_the_stopped_entry_for_the_owner() {
        let hub = HealthHub::new(None);
        hub.observer()(SupervisorHealth::stopped(
            id(1),
            id(2),
            "This connection was replaced. Reconnect to send again.".into(),
            at(),
        ));
        let mut exit = clean_exit();
        exit.error = Some(ariadne_core::CoreError::new(
            ariadne_core::CoreErrorCode::StaleGeneration,
            "Replaced.",
            "Reconnect.",
        ));
        hub.observe_outcome(&ActivationOutcome::Stopped {
            scope: BindingScope {
                binding_id: id(1),
                generation: id(2),
            },
            exit: Ok(exit),
        });
        assert_eq!(hub.snapshot().len(), 1);
    }
}
