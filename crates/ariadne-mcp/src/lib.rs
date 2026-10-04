//! Local stdio facade over the canonical service; no provider or owner tools.
mod framing;
pub mod native;
mod tools;
use rmcp::{transport::async_rw::AsyncRwTransport, ServiceExt};
use tokio::io::{AsyncRead, AsyncWrite};
pub use tools::AgentMcpService;

pub type ServeError = Box<dyn std::error::Error + Send + Sync>;

/// Both installed entrypoints use this exact stdio service. Only JSON-RPC is
/// written to stdout; this library installs no logger or tracing subscriber.
pub async fn serve_stdio(service: AgentMcpService) -> Result<(), ServeError> {
    serve_io(service, tokio::io::stdin(), tokio::io::stdout()).await
}

/// Native composition/test-owned streams share the actual SDK transport.
pub async fn serve_io<R, W>(service: AgentMcpService, read: R, write: W) -> Result<(), ServeError>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    let transport = AsyncRwTransport::new_server(framing::BoundedLines::new(read), write);
    service.serve(transport).await?.waiting().await?;
    Ok(())
}
