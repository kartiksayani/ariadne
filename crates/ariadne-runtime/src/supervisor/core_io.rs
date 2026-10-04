use crate::{control::validated_error, leases::BindingLease};
use ariadne_core::{CoreError, CoreErrorCode};
use std::time::Duration;

pub(super) async fn call<T: Send + 'static>(
    lease: BindingLease,
    operation: impl FnOnce() -> Result<T, CoreError> + Send + 'static,
) -> Result<T, CoreError> {
    finish(start(lease, operation)).await
}
pub(super) async fn unleased<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, CoreError> + Send + 'static,
) -> Result<T, CoreError> {
    finish(tokio::task::spawn_blocking(move || {
        operation().map_err(validated_error)
    }))
    .await
}
pub(super) fn start<T: Send + 'static>(
    lease: BindingLease,
    operation: impl FnOnce() -> Result<T, CoreError> + Send + 'static,
) -> tokio::task::JoinHandle<Result<T, CoreError>> {
    tokio::task::spawn_blocking(move || {
        let _physical_lease = lease;
        operation().map_err(validated_error)
    })
}
pub(super) async fn finish<T: Send + 'static>(
    task: tokio::task::JoinHandle<Result<T, CoreError>>,
) -> Result<T, CoreError> {
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?
}
fn unavailable() -> CoreError {
    CoreError::new(
        CoreErrorCode::HostUnreachable,
        "Core call did not return a validated receipt within the runtime bound.",
        "Effects may already exist. Retain the same request/event IDs and reconcile before any new delivery; any held physical lease remains retained until the started call finishes.",
    )
}
