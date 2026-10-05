//! Existing Codex daemon reads and bounded native queue submission.

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

mod adapter;
mod discovery;
mod history;
mod queue;
mod transport;
pub use adapter::CodexAdapter;
pub use discovery::CodexDiscovery;
pub use history::{
    CodexDaemonReader, CodexHistoryClient, CodexHostFacts, CodexOptions, DiscoveryPage,
    HistoryScan, QualifiedCodexThread, ScanProgress, ThreadCandidate, UserMessageIdentity,
};
pub use transport::SUPPORTED_CODEX_VERSION;
