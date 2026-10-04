//! Async provider-neutral seam; all blocking socket and child IO runs on one bounded worker.
use crate::{queue::Worker, CodexOptions, QualifiedCodexThread};
use ariadne_agent_protocol::*;
use std::time::{Duration, Instant};

pub struct CodexAdapter {
    worker: Worker,
}
impl CodexAdapter {
    /// Carry native activation's original deadline into the same bounded worker.
    pub fn connect_before(
        &self,
        request: ConnectRequest,
        deadline: Instant,
    ) -> AdapterFuture<'_, ConnectResult> {
        self.worker.call_before(deadline, move |state, deadline| {
            state.connect(request, deadline)
        })
    }
    /// Consume the already initialized reader for one selected thread/root/endpoint.
    /// Final binding/generation IDs arrive through Adapter.connect. Reconnect never
    /// retargets this selection or silently replaces its qualified fingerprint.
    pub fn from_qualified_thread(
        qualified: QualifiedCodexThread,
        instance_id: UuidV4,
    ) -> Result<Self, AdapterError> {
        Ok(Self {
            worker: Worker::from_qualified_thread(qualified, instance_id)?,
        })
    }
    /// The instance identifies qualified presence. Observation tokens also carry a fresh private
    /// worker nonce, so recreating an adapter requires persisted-attempt reconciliation.
    pub fn new(options: CodexOptions, instance_id: UuidV4) -> Result<Self, AdapterError> {
        Ok(Self {
            worker: Worker::new(options, instance_id)?,
        })
    }
}
impl Adapter for CodexAdapter {
    fn probe(&self, request: ProbeRequest) -> AdapterFuture<'_, ProbeResult> {
        self.worker
            .call(Duration::from_secs(10), move |state, deadline| {
                state.probe(request, deadline)
            })
    }
    fn connect(&self, request: ConnectRequest) -> AdapterFuture<'_, ConnectResult> {
        self.worker
            .call(Duration::from_secs(10), move |state, deadline| {
                state.connect(request, deadline)
            })
    }
    fn submit(&self, request: SubmitRequest) -> AdapterFuture<'_, SubmitOutcome> {
        self.worker.submit(request)
    }
    fn observe(&self, request: ObserveRequest) -> AdapterFuture<'_, ObserveResult> {
        self.worker
            .call(Duration::from_secs(5), move |state, deadline| {
                state.observe(request, deadline)
            })
    }
    fn reconcile(&self, request: ReconcileRequest) -> AdapterFuture<'_, ReconcileResult> {
        self.worker
            .call(Duration::from_secs(10), move |state, deadline| {
                state.reconcile(request, deadline)
            })
    }
    fn disconnect(&self, request: DisconnectRequest) -> AdapterFuture<'_, DisconnectResult> {
        self.worker.call(Duration::from_secs(5), move |state, _| {
            state.disconnect(request)
        })
    }
}
