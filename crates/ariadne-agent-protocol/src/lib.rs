//! Provider-neutral owned adapter seam. Domain state and host processes stay external.
#![cfg_attr(
    not(feature = "test-support"),
    doc = "The default library exposes no scripted fake:\n```compile_fail\nuse ariadne_agent_protocol::fake::ScriptedAdapter;\n```"
)]
mod dto;
mod validation;

#[cfg(any(test, feature = "test-support"))]
pub mod fake;

pub use ariadne_domain::models::{
    AdapterConfig, Capabilities, Capability, Checkpoint, DeliveryMode, EndpointFingerprint,
    EndpointRef, HostReceipt, PresenceObservation, Sha256, UtcMillis, UuidV4,
};
pub use dto::*;
pub use validation::{
    claude_session_end_event_id, is_claude_session_end_event, terminal_event_id, ObserveLimit,
};

pub type AdapterFuture<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, AdapterError>> + Send + 'a>>;

/// Caller supplies deadlines/lease validation; implementations never own domain effects.
/// A possibly delivered submit returns `SubmitOutcome::Uncertain`, even on timeout.
pub trait Adapter: Send + Sync {
    fn probe(&self, request: ProbeRequest) -> AdapterFuture<'_, ProbeResult>;
    fn connect(&self, request: ConnectRequest) -> AdapterFuture<'_, ConnectResult>;
    fn submit(&self, request: SubmitRequest) -> AdapterFuture<'_, SubmitOutcome>;
    fn observe(&self, request: ObserveRequest) -> AdapterFuture<'_, ObserveResult>;
    fn reconcile(&self, request: ReconcileRequest) -> AdapterFuture<'_, ReconcileResult>;
    fn disconnect(&self, request: DisconnectRequest) -> AdapterFuture<'_, DisconnectResult>;
}
