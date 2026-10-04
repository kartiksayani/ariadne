//! Shared provider capability conditions; qualification does not grant dispatch authority.
use ariadne_agent_protocol::*;

pub(crate) fn capabilities(qualified_app_version: &str) -> Capabilities {
    let supported = |condition: &str| Capability {
        supported: true,
        conditions: vec![condition.into()],
    };
    let unsupported = |condition: &str| Capability {
        supported: false,
        conditions: vec![condition.into()],
    };
    Capabilities {
        existing_session: supported("Fresh exact native-validated Mod announcement for the original conversation"),
        deferred_delivery: supported("Pull claims only; desktop reconciliation, lease and durable Core composition must admit work"),
        turn_correlation: supported("Actual SDK callbacks verify first-line marker and exact complete payload digest"),
        turn_completion: supported("Captured main-turn callbacks through existing bridge report, not native history"),
        domain_cli: Capability {
            supported: qualified_app_version == "0.1.0",
            conditions: vec!["Installed 0.1.0 helper command support after native version/resource qualification; each operation still requires current Core authority and dispatch admission".into()],
        },
        domain_mcp: unsupported("Production MCP transport remains a separate acceptance join"),
        history_reconcile: unsupported("No supported Claude host history read; persisted unresolved attempts require later canonical reports/recovery"),
        streaming_output: unsupported("This seam does not read a provider output stream"),
        final_text_read: unsupported("Visible terminal text is diagnostic Mod evidence, not a native final-history read"),
        discover_sessions: unsupported("P3.7 owns actual UID-checked announcement intake and discovery"),
        delivery_mode: DeliveryMode::Pull,
    }
}
