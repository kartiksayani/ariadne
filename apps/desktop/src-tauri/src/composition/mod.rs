//! The installed desktop joins the existing native Core and owning runtime.
//! Configuration and lifecycle installers are Rust-only, never renderer DTOs.
mod bridge;
mod configuration;
mod entrypoint;
mod expiry;
mod health;
mod presence;
mod runtime;
pub(crate) use entrypoint::establish;

pub use bridge::CoreBridge;
pub use entrypoint::ActivationHandoffs;
pub use runtime::{NativeConfiguration, NativeRuntime};

use ariadne_runtime::providers::ProviderInstructions;
use std::path::{Path, PathBuf};

/// The rules live in the installed Ariadne skill, loaded once; the setup
/// instruction is one plain line that Core completes with the routing IDs and
/// the exact helper commands. `codex_rules` is the installed rule sheet, named
/// for a Codex whose skill link was skipped at setup.
fn instructions(cli_invocation: &str, codex_rules: Option<&Path>) -> ProviderInstructions {
    let fallback = codex_rules.map_or_else(String::new, |path| {
        format!(
            " If that skill is not available in this thread, read {} first.",
            path.display()
        )
    });
    ProviderInstructions {
        cli_invocation: cli_invocation.into(),
        claude: "This Claude Code session is connected to Ariadne. File your work as you go; the ariadne skill has the rest.".into(),
        codex: format!("This Codex thread is connected to Ariadne. File your work as you go; the ariadne skill has the rest.{fallback}"),
    }
}

/// The installed package's Codex rule sheet, when present.
fn installed_codex_rules(home: Option<PathBuf>) -> Option<PathBuf> {
    home.map(|home| home.join(".local/share/ariadne/current/integrations/rules/codex.md"))
        .filter(|path| path.is_absolute() && path.is_file())
}

#[cfg(test)]
mod tests;
