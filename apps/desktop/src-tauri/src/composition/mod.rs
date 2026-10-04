//! The installed desktop joins the existing native Core and owning runtime.
//! Configuration and lifecycle installers are Rust-only, never renderer DTOs.
mod bridge;
mod configuration;
mod runtime;

pub use bridge::CoreBridge;
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
