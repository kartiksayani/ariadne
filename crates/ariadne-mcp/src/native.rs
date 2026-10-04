//! Installed native composition. No default provider, owner tools or live host call.
use crate::{serve_stdio, AgentMcpService};
use ariadne_core::{
    native::{AgentResolver, NativeCoreService},
    CoreError, CoreErrorCode,
};
use ariadne_domain::models::{UtcMillis, UuidV4};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

pub const HELP: &str = "ariadne-mcp local agent tools\nUsage: ariadne-mcp serve\n       ariadne mcp serve\n       ariadne-mcp [--help|--version]\nTools: session_read, item_messages, item_rounds, apply.\nEach tool requires an explicit registered binding_id and generation.\nARIADNE_HOME is the application data directory; default HOME/.ariadne.\nStdout contains only MCP JSON-RPC while serving.\n";

pub fn service_at(path: &Path) -> Result<AgentMcpService, CoreError> {
    let registry = AgentResolver::open_data_directory(path)?;
    let core = Arc::new(NativeCoreService::new(
        registry,
        || UuidV4::new(uuid::Uuid::new_v4().to_string()).expect("UUIDv4 generator"),
        || {
            UtcMillis::new(
                chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
            .expect("native UTC clock")
        },
        |_| {
            Err(CoreError::new(
                CoreErrorCode::Unsupported,
                "No provider verifier is composed for MCP.",
                "Use native owner setup with an installed adapter.",
            ))
        },
    ));
    let resolver = core.clone();
    AgentMcpService::from_trusted_startup(core, move |binding, generation, source, attempt| {
        AgentResolver::resolve(resolver.registry(), binding, generation, source, attempt)
    })
}
fn home() -> Result<PathBuf, CoreError> {
    std::env::var_os("ARIADNE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".ariadne")))
        .ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::InvalidArgument,
                "Set ARIADNE_HOME or HOME for the local application data directory.",
                "Use an explicit trusted local application data directory.",
            )
        })
}
pub fn run(args: &[&str]) -> i32 {
    match args {
        [] | ["--help" | "-h"] => {
            print!("{HELP}");
            0
        }
        ["--version" | "-V"] => {
            println!("ariadne-mcp {}", env!("CARGO_PKG_VERSION"));
            0
        }
        ["serve"] => {
            let service = match home().and_then(|path| service_at(&path)) {
                Ok(service) => service,
                Err(error) => {
                    eprintln!("{:?}: {}", error.code, error.message);
                    return error.code.cli_exit();
                }
            };
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(_) => {
                    eprintln!("Local MCP runtime could not start.");
                    return 4;
                }
            };
            match runtime.block_on(serve_stdio(service)) {
                Ok(()) => 0,
                Err(_) => {
                    eprintln!("MCP stdio protocol ended with an invalid or unavailable transport.");
                    4
                }
            }
        }
        _ => {
            eprintln!("Unsupported MCP request; use --help.");
            2
        }
    }
}
