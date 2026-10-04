//! Read-only native candidates. An announcement never grants a route or lease.
mod candidates;
mod codex;
mod wire;
pub use candidates::{
    AnnouncementBinding, BindingResolver, Candidate, Discovery, DiscoverySnapshot,
};
pub use codex::{CodexEndpoint, DiscoveryPoller};
pub use wire::{AnnouncementAck, LoadedPlugin, ModDescriptor, SessionAnnouncement};

use ariadne_core::{CoreError, CoreErrorCode};
fn invalid(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::InvalidArgument, message, "Use the original SDK identity and installed descriptor; discovery never selects a binding.")
}
fn capacity() -> CoreError {
    CoreError::new(CoreErrorCode::CapacityExceeded, "Native discovery exceeded its 256-candidate or bounded scan limit.", "Close unused host conversations or narrow the configured discovery scope; explicit manual binding remains available.")
}
fn bounded(value: &str) -> bool {
    !value.trim().is_empty() && !value.contains('\0') && value.len() <= 4096
}
