//! One bounded blocking IO worker; polling and dropping futures never wait on native IO.
use crate::{adapter::State, normalization::error};
use ariadne_agent_protocol::{AdapterError, AdapterErrorCode, AdapterFuture};
use futures_channel::oneshot;
use std::{
    sync::mpsc::{sync_channel, SyncSender},
    time::{Duration, Instant},
};
type Job = Box<dyn FnOnce(&mut State) + Send>;
pub(crate) struct Worker(SyncSender<Job>);
impl Worker {
    pub(crate) fn new(mut state: State) -> Result<Self, AdapterError> {
        let (sender, receiver) = sync_channel::<Job>(1);
        std::thread::Builder::new()
            .name("ariadne-claude-io".into())
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    job(&mut state);
                }
            })
            .map_err(|_| {
                error(
                    AdapterErrorCode::HostUnreachable,
                    "Cannot start bounded Claude native IO worker",
                )
            })?;
        Ok(Self(sender))
    }
    pub(crate) fn call<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut State, Instant) -> Result<T, AdapterError> + Send + 'static,
    ) -> AdapterFuture<'static, T> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let (reply, receive) = oneshot::channel();
        let job: Job = Box::new(move |state| {
            if !reply.is_canceled() {
                let result = if Instant::now() >= deadline {
                    Err(error(
                        AdapterErrorCode::HostUnreachable,
                        "Claude native IO deadline expired before inspection",
                    ))
                } else {
                    operation(state, deadline)
                };
                let _ = reply.send(result);
            }
        });
        if self.0.try_send(job).is_err() {
            return Box::pin(async {
                Err(error(
                    AdapterErrorCode::HostUnreachable,
                    "Claude adapter is busy or stopped; no new inspection was admitted",
                ))
            });
        }
        Box::pin(async move {
            receive.await.map_err(|_| {
                error(
                    AdapterErrorCode::HostUnreachable,
                    "Claude native IO worker stopped; requalify and reconcile persisted attempts",
                )
            })?
        })
    }
}
