//! Claude Mod compatibility and native normalization boundary.
mod adapter;
mod capabilities;
mod evidence;
mod normalization;
mod probe;
mod worker;
pub use adapter::ClaudeAdapter;
pub use evidence::{LoadedModIdentity, ModEvidence, ModEvidenceSlot, QualifiedClaudeHost};
pub use normalization::{normalize_mod_event, CapturedScope};
pub use probe::{ClaudeOptions, SUPPORTED_HOST_VERSION};
