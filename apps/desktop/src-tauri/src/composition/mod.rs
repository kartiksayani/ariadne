//! The installed desktop joins the existing native Core and owning runtime.
//! Configuration and lifecycle installers are Rust-only, never renderer DTOs.
mod bridge;
mod configuration;
mod entrypoint;
mod expiry;
mod presence;
mod runtime;
pub(crate) use entrypoint::establish;

pub use bridge::CoreBridge;
pub use entrypoint::ActivationHandoffs;
pub use runtime::{NativeConfiguration, NativeRuntime};

use ariadne_runtime::providers::ProviderInstructions;

fn instructions() -> ProviderInstructions {
    ProviderInstructions {
        claude: include_str!("../../../../../integrations/rules/claude.md").into(),
        codex: include_str!("../../../../../integrations/rules/codex.md").into(),
    }
}

#[cfg(test)]
mod tests;
