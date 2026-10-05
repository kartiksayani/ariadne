use ariadne_core::{native::NativeCoreService, *};
use ariadne_domain::models::*;
use ariadne_store::session::{Store, StoreError};
use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

#[derive(Default)]
struct Pending {
    dirty: BTreeSet<UuidV4>,
    waiting: BTreeSet<UuidV4>,
}
/// Watcher revisions discover work, including persisted work on startup. The
/// owned timer revisits only changed sessions and unfinished grace periods.
pub(super) struct ResultExpiry {
    core: Arc<NativeCoreService>,
    pending: Mutex<Pending>,
    fenced: AtomicBool,
}
impl ResultExpiry {
    pub fn new(core: Arc<NativeCoreService>) -> Arc<Self> {
        Arc::new(Self {
            core,
            pending: Mutex::new(Pending::default()),
            fenced: AtomicBool::new(false),
        })
    }
    pub fn changed(&self, session_id: UuidV4) {
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .dirty
            .insert(session_id);
    }
    pub fn fence(&self) {
        self.fenced.store(true, Ordering::Release);
    }
    pub fn reopen(&self) {
        self.fenced.store(false, Ordering::Release);
    }
    pub fn sweep(&self) {
        if self.fenced.load(Ordering::Acquire) {
            return;
        }
        let sessions = {
            let mut pending = self
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let mut sessions = std::mem::take(&mut pending.dirty);
            sessions.extend(pending.waiting.iter().cloned());
            sessions
        };
        if sessions.is_empty() {
            return;
        }
        let projects = match self.core.registry().registered_projects() {
            Ok(projects) => projects,
            Err(_) => {
                self.retry(sessions);
                return;
            }
        };
        for id in sessions {
            if self.fenced.load(Ordering::Acquire) {
                self.changed(id);
                continue;
            }
            // Hints intentionally omit project IDs. Resolve this one session
            // across registered roots and reject ambiguous/unreadable routing.
            // This does not enumerate every saved session on each timer tick.
            let mut found = None;
            let mut unavailable = false;
            for project in &projects {
                match Store::read_registered(&project.root, &project.project_id, &id) {
                    Ok(session) if found.is_none() => found = Some(session),
                    Ok(_) => unavailable = true,
                    Err(StoreError::Io {
                        kind: std::io::ErrorKind::NotFound,
                        ..
                    }) => {}
                    Err(_) => unavailable = true,
                }
            }
            let waiting = if unavailable {
                true // Unavailable reads never establish absence of a result.
            } else if let Some(session) = found {
                self.expire(&session)
            } else {
                false
            };
            let mut pending = self
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if waiting {
                pending.waiting.insert(id);
            } else {
                pending.waiting.remove(&id);
            }
            // A revision hint arriving during IO stays in dirty for next tick.
        }
    }
    fn retry(&self, sessions: BTreeSet<UuidV4>) {
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .dirty
            .extend(sessions);
    }
    fn expire(&self, session: &Session) -> bool {
        let Some(binding) = session
            .active_binding_id
            .as_ref()
            .and_then(|id| session.bindings.0.get(id))
        else {
            return false;
        };
        let context = AdapterContext::from_trusted_entrypoint(
            RegisteredSession::from_trusted_entrypoint(
                session.project_id.clone(),
                session.id.clone(),
            ),
            binding.id.clone(),
            binding.generation.clone(),
            None,
        );
        let mut waiting = false;
        for input in session
            .inputs
            .0
            .values()
            .filter(|input| input.binding_id == binding.id)
        {
            for attempt in &input.attempts {
                if attempt.sealed_at.is_some()
                    || matches!(
                        input.state,
                        InputState::Handled | InputState::Cancelled | InputState::Skipped
                    )
                    || attempt.turn_state != TurnState::Completed
                    || attempt.result_state != ResultState::Pending
                    || attempt.domain_result.is_some()
                    || matches!(
                        attempt.acceptance,
                        AcceptanceState::Rejected | AcceptanceState::Uncertain
                    )
                    || attempt
                        .error
                        .as_ref()
                        .is_some_and(|error| error.code != "result_missing")
                    || attempt.turn_observed_at.is_none()
                {
                    continue;
                }
                if self.fenced.load(Ordering::Acquire) {
                    return true;
                }
                let completed = chrono::DateTime::parse_from_rfc3339(
                    attempt
                        .turn_observed_at
                        .as_ref()
                        .expect("checked completion")
                        .as_str(),
                )
                .expect("canonical saved time");
                let now = chrono::DateTime::parse_from_rfc3339(super::runtime::now().as_str())
                    .expect("canonical native time");
                if now.signed_duration_since(completed).num_milliseconds() < 5000 {
                    waiting = true;
                    continue;
                }
                // Core checks the saved grace time and every route/state guard
                // atomically with competing result, recovery and generation writes.
                match self.core.expire_missing_result_native(
                    &context,
                    &input.id,
                    &attempt.id,
                    &super::runtime::next_id(),
                ) {
                    Ok(Some(_)) => {}
                    Ok(None) | Err(_) => waiting = true,
                }
            }
        }
        waiting
    }
}

#[cfg(test)]
#[path = "tests/expiry.rs"]
mod tests;
