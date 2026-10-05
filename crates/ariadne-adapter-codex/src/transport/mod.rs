//! Bounded local WebSocket RPC. No provider process/session is started here.
mod identity;
mod rpc;

pub use identity::SUPPORTED_CODEX_VERSION;
pub(crate) use identity::{ExecutableIdentity, SocketIdentity};
pub(crate) use rpc::RpcClient;

use ariadne_agent_protocol::{AdapterError, AdapterErrorCode};

pub(crate) fn error(code: AdapterErrorCode, message: &str) -> AdapterError {
    AdapterError {
        code,
        message: message.to_owned(),
        retryable: code == AdapterErrorCode::HostUnreachable,
    }
}
