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

/// Ask for one context pull when the agent's context is fresh; Ariadne never
/// pushes context with an input.
const FRESH_CONTEXT: &str = "When your context is fresh (just connected, after /clear or /compact, or an item ID you do not recognise), run the read command below once to rebuild it.";

/// The rules live in the installed Ariadne skill, loaded once; the setup
/// instruction is a short block that Core completes with the routing IDs and
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
        claude: format!("This Claude Code session is connected to Ariadne. Follow the Ariadne skill for the rules and request shapes.\n{FRESH_CONTEXT}"),
        codex: format!("This Codex thread is connected to Ariadne. Follow the Ariadne skill (installed by Ariadne setup) for the rules and request shapes.{fallback}\n{FRESH_CONTEXT}"),
    }
}

/// The installed package's Codex rule sheet, when present.
fn installed_codex_rules(home: Option<PathBuf>) -> Option<PathBuf> {
    home.map(|home| home.join(".local/share/ariadne/current/integrations/rules/codex.md"))
        .filter(|path| path.is_absolute() && path.is_file())
}

#[cfg(test)]
mod tests;
