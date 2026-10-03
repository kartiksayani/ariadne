//! Async provider-neutral seam; all blocking socket and child IO runs on one bounded worker.
use crate::{queue::Worker, CodexOptions};
use ariadne_agent_protocol::*;
use std::time::Duration;

pub struct CodexAdapter {
    worker: Worker,
}
impl CodexAdapter {
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
