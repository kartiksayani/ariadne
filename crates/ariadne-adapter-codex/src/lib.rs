//! Read-only Codex existing-daemon boundary. Queue submission is a separate task.

// Keep typify's output unchanged. Its keyword spelling, conversion helpers,
// enum names/layout and explicit defaults trigger these specific lints.
// Generated wires await their adapter consumer and stay private to this crate.
#[allow(
    dead_code,
    non_camel_case_types,
    clippy::clone_on_copy,
    clippy::derivable_impls,
    clippy::enum_variant_names,
    clippy::large_enum_variant
)]
mod generated;

#[cfg(test)]
#[path = "tests/wire.rs"]
mod wire_tests;

mod history;
mod transport;
pub use history::{
    CodexDaemonReader, CodexHistoryClient, CodexOptions, DiscoveryPage, HistoryScan, ScanProgress,
    ThreadCandidate, UserMessageIdentity,
};
