//! Bounded local WebSocket RPC. No provider process/session is started here.
mod identity;
mod rpc;

pub use identity::SUPPORTED_CODEX_VERSION;
pub(crate) use identity::{ExecutableIdentity, SocketIdentity};
pub(crate) use rpc::RpcClient;

use ariadne_agent_protocol::{deadline_scale, AdapterError, AdapterErrorCode};
use std::time::Duration;

/// A wall-clock budget in seconds for one host call. Release builds use it as written;
/// debug test runs may stretch it (`deadline_scale`) so a busy machine cannot fail them.
pub(crate) fn budget(seconds: u64) -> Duration {
    deadline_scale::scaled(Duration::from_secs(seconds))
}

pub(crate) fn error(code: AdapterErrorCode, message: &str) -> AdapterError {
    AdapterError {
        code,
        message: message.to_owned(),
        retryable: code == AdapterErrorCode::HostUnreachable,
    }
}
