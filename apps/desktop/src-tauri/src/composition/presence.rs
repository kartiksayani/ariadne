use ariadne_core::{
    native::{AgentResolver, NativeCoreService},
    recovery::RecoveryObservation,
    *,
};
use ariadne_domain::models::*;
use ariadne_runtime::{
    discovery::PRESENCE_LIFETIME,
    supervisor::{PresenceObserver, PresenceUpdate},
};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

struct Entry {
    hint: PresenceChangedHint,
    endpoint: EndpointFingerprint,
}
/// One volatile fact per authoritative selected binding/current instance.
/// Core remains the authority for identity, pause, dispatch and durable state.
pub(super) struct PresenceCache {
    core: Arc<NativeCoreService>,
    entries: Mutex<BTreeMap<UuidV4, Entry>>,
    emit: Arc<dyn Fn(PresenceChangedHint) -> bool + Send + Sync>,
    stopped: AtomicBool,
    fenced: AtomicBool,
}
impl PresenceCache {
    pub fn new(
        core: Arc<NativeCoreService>,
        emit: Arc<dyn Fn(PresenceChangedHint) -> bool + Send + Sync>,
    ) -> Arc<Self> {
        Arc::new(Self {
            core,
            entries: Mutex::new(BTreeMap::new()),
            emit,
            stopped: AtomicBool::new(false),
            fenced: AtomicBool::new(false),
        })
    }
    pub fn observer(self: &Arc<Self>) -> Arc<PresenceObserver> {
        let cache = Arc::downgrade(self);
        Arc::new(move |update| {
            if let Some(cache) = cache.upgrade() {
                cache.accept(update);
            }
        })
    }
    fn selected(&self, hint: &PresenceChangedHint, endpoint: &EndpointFingerprint) -> bool {
        let read = || -> Result<bool, CoreError> {
            hint.validate_wire()?;
            let resolved = AgentResolver::resolve(
                self.core.registry(),
                hint.binding_id.clone(),
                hint.generation.clone(),
                None,
                None,
            )?;
            let context = QueryContext::owner(OwnerContext::from_trusted_entrypoint(
                OwnerScope::Session(resolved.session().clone()),
            ));
            let request = QueryRequest::SessionGet {};
            let result = self.core.query(context.clone(), request.clone())?;
            result.validate_for(&context, &request)?;
            let QueryResult::SessionGet(snapshot) = result else {
                return Ok(false);
            };
            Ok(
                snapshot.session.active_binding_id.as_ref() == Some(&hint.binding_id)
                    && snapshot
                        .session
                        .bindings
                        .0
                        .get(&hint.binding_id)
                        .is_some_and(|binding| {
                            binding.generation == hint.generation
                                && &binding.endpoint_fingerprint == endpoint
                                && binding.dispatch_state != DispatchState::Disconnected
                        }),
            )
        };
        read().unwrap_or(false)
    }
    fn accept(&self, update: PresenceUpdate) {
        if self.stopped.load(Ordering::Acquire) || self.fenced.load(Ordering::Acquire) {
            return;
        }
        let (mut hint, endpoint, connected, stopped) = match update {
            PresenceUpdate::Connected { hint, endpoint } => (hint, endpoint, true, false),
            PresenceUpdate::Observed { hint, endpoint } => (hint, endpoint, false, false),
            PresenceUpdate::Stopped { hint, endpoint } => (hint, endpoint, false, true),
        };
        // All registration/store reads precede the cache mutex and happen on
        // the supervisor's retained, awaited blocking offload.
        let selected = self.selected(&hint, &endpoint);
        let published = {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if self.stopped.load(Ordering::Acquire) || self.fenced.load(Ordering::Acquire) {
                return;
            }
            let previous = entries.get(&hint.binding_id);
            let same = previous.is_some_and(|entry| {
                entry.hint.generation == hint.generation
                    && entry.hint.observation.instance_id == hint.observation.instance_id
                    && entry.endpoint == endpoint
            });
            if !selected || stopped {
                if !same {
                    return;
                }
                let mut old = entries
                    .remove(&hint.binding_id)
                    .expect("matching current instance")
                    .hint;
                unknown(&mut old.observation, Freshness::Unknown);
                Some(old)
            } else {
                if connected && same {
                    return;
                }
                if !connected && !same {
                    return;
                }
                if same
                    && previous.is_some_and(|entry| {
                        hint.observation.last_seen_at <= entry.hint.observation.last_seen_at
                    })
                {
                    return;
                }
                expire(&mut hint.observation, &super::runtime::now());
                entries.insert(
                    hint.binding_id.clone(),
                    Entry {
                        hint: hint.clone(),
                        endpoint,
                    },
                );
                Some(hint)
            }
        };
        if let Some(hint) = published {
            (self.emit)(hint);
        }
    }
    /// Optional native evidence only; failure must not preempt Core receipt
    /// replay or its authoritative current-session/selection checks.
    pub fn recovery_observation(
        &self,
        context: &OwnerContext,
        command: &OwnerCommand,
    ) -> Option<RecoveryObservation> {
        let OwnerCommand::InputResolve { params, .. } = command else {
            return None;
        };
        let OwnerScope::Session(_) = context.scope() else {
            return None;
        };
        let query_context = QueryContext::owner(context.clone());
        let request = QueryRequest::SessionGet {};
        let result = self
            .core
            .query(query_context.clone(), request.clone())
            .ok()?;
        result.validate_for(&query_context, &request).ok()?;
        let QueryResult::SessionGet(snapshot) = result else {
            return None;
        };
        let input = snapshot.session.inputs.0.get(&params.input_id)?;
        if snapshot.session.active_binding_id.as_ref() != Some(&input.binding_id) {
            return None;
        }
        let binding = snapshot.session.bindings.0.get(&input.binding_id)?;
        // All registered-session/Core IO is finished before this brief lock.
        // Connected installs the current instance; only matching observations
        // can replace it. Copy that exact current fact, never infer an idle one.
        let mut observation = {
            let entries = self.entries.lock().ok()?;
            if self.stopped.load(Ordering::Acquire) || self.fenced.load(Ordering::Acquire) {
                return None;
            }
            let entry = entries.get(&binding.id)?;
            if entry.hint.generation != binding.generation
                || entry.endpoint != binding.endpoint_fingerprint
                || binding.dispatch_state == DispatchState::Disconnected
            {
                return None;
            }
            entry.hint.observation.clone()
        };
        expire(&mut observation, &super::runtime::now());
        Some(RecoveryObservation {
            binding_id: binding.id.clone(),
            instance_id: observation.instance_id.clone(),
            observation,
        })
    }
    pub fn overlay(&self, result: &mut QueryResult) {
        let QueryResult::SessionList(list) = result else {
            return;
        };
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let now = super::runtime::now();
        for summary in &mut list.sessions.items {
            if let Some(binding) = &mut summary.active_binding {
                binding.presence = entries
                    .get(&binding.id)
                    .filter(|entry| entry.hint.generation == binding.generation)
                    .map(|entry| {
                        let mut observation = entry.hint.observation.clone();
                        expire(&mut observation, &now);
                        observation
                    });
            }
        }
    }
    pub fn sweep(&self) {
        let candidates: Vec<_> = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .map(|entry| (entry.hint.clone(), entry.endpoint.clone()))
            .collect();
        for (hint, endpoint) in candidates {
            let selected = self.selected(&hint, &endpoint);
            let changed = {
                let mut entries = self
                    .entries
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let Some(current) = entries.get_mut(&hint.binding_id) else {
                    continue;
                };
                if current.hint != hint || current.endpoint != endpoint {
                    continue;
                }
                if !selected {
                    let mut hint = entries
                        .remove(&hint.binding_id)
                        .expect("matching candidate")
                        .hint;
                    unknown(&mut hint.observation, Freshness::Unknown);
                    Some(hint)
                } else {
                    expire(&mut current.hint.observation, &super::runtime::now());
                    (current.hint != hint).then(|| current.hint.clone())
                }
            };
            if let Some(hint) = changed {
                (self.emit)(hint);
            }
        }
    }
    pub fn invalidate(&self) {
        let entries = std::mem::take(
            &mut *self
                .entries
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        for (_, mut entry) in entries {
            unknown(&mut entry.hint.observation, Freshness::Unknown);
            (self.emit)(entry.hint);
        }
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.invalidate();
    }
    pub fn fence(&self) {
        self.fenced.store(true, Ordering::Release);
        self.invalidate();
    }
    pub fn reopen(&self) {
        self.fenced.store(false, Ordering::Release);
    }
}
fn unknown(observation: &mut PresenceObservation, freshness: Freshness) {
    observation.freshness = freshness;
    observation.execution_state = ExecutionState::Unknown;
    observation.connection_state = ConnectionState::Unknown;
}
fn expire(observation: &mut PresenceObservation, now: &UtcMillis) {
    if observation.freshness != Freshness::Fresh {
        return;
    }
    let age = observation.last_seen_at.as_ref().and_then(|seen| {
        let now = chrono::DateTime::parse_from_rfc3339(now.as_str()).ok()?;
        let seen = chrono::DateTime::parse_from_rfc3339(seen.as_str()).ok()?;
        (now - seen).to_std().ok()
    });
    if age.is_none_or(|age| age >= PRESENCE_LIFETIME) {
        unknown(observation, Freshness::Stale);
    }
}

#[cfg(test)]
#[path = "presence_tests.rs"]
mod tests;
