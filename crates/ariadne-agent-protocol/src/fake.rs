//! Opt-in test/dev adapter. Scripts supply facts; there is no dispatch/result state machine.
use crate::*;
use std::collections::VecDeque;
use std::sync::{Mutex, MutexGuard};

#[derive(Debug, Clone, PartialEq)]
pub enum RecordedRequest {
    Probe(ProbeRequest),
    Connect(ConnectRequest),
    Submit(SubmitRequest),
    Observe(ObserveRequest),
    Reconcile(ReconcileRequest),
    Disconnect(DisconnectRequest),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ScriptedResponse {
    Probe(Result<ProbeResult, AdapterError>),
    Connect(Box<Result<ConnectResult, AdapterError>>),
    Submit(Result<SubmitOutcome, AdapterError>),
    Observe(Result<ObserveResult, AdapterError>),
    Reconcile(Result<ReconcileResult, AdapterError>),
    Disconnect(Result<DisconnectResult, AdapterError>),
}

impl ScriptedResponse {
    /// Keep the large response boxed without exposing allocation details to scripts.
    pub fn connect(result: Result<ConnectResult, AdapterError>) -> Self {
        Self::Connect(Box::new(result))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScriptStep {
    pub request: RecordedRequest,
    pub response: ScriptedResponse,
}

struct ScriptState {
    steps: VecDeque<ScriptStep>,
    history: Vec<RecordedRequest>,
}

pub struct ScriptedAdapter {
    state: Mutex<ScriptState>,
}

fn conflict() -> AdapterError {
    AdapterError {
        code: AdapterErrorCode::ProtocolConflict,
        message: "Adapter script does not match the requested operation".into(),
        retryable: false,
    }
}

impl ScriptedAdapter {
    pub fn new(steps: impl IntoIterator<Item = ScriptStep>) -> Self {
        Self {
            state: Mutex::new(ScriptState {
                steps: steps.into_iter().collect(),
                history: Vec::new(),
            }),
        }
    }
    fn state(&self) -> Result<MutexGuard<'_, ScriptState>, AdapterError> {
        self.state.lock().map_err(|_| conflict())
    }
    pub fn history(&self) -> Result<Vec<RecordedRequest>, AdapterError> {
        Ok(self.state()?.history.clone())
    }
    pub fn remaining(&self) -> Result<usize, AdapterError> {
        Ok(self.state()?.steps.len())
    }

    fn take(&self, request: RecordedRequest) -> Result<ScriptedResponse, AdapterError> {
        let mut state = self.state()?;
        state.history.push(request.clone());
        if state
            .steps
            .front()
            .is_none_or(|step| step.request != request)
        {
            return Err(conflict());
        }
        Ok(state.steps.pop_front().ok_or_else(conflict)?.response)
    }
}

fn checked<T>(
    result: Result<T, AdapterError>,
    validate: impl FnOnce(&T) -> Result<(), AdapterError>,
) -> Result<T, AdapterError> {
    match result {
        Ok(value) => {
            validate(&value)?;
            Ok(value)
        }
        Err(error) => {
            error.validate()?;
            Err(error)
        }
    }
}

impl Adapter for ScriptedAdapter {
    fn probe(&self, request: ProbeRequest) -> AdapterFuture<'_, ProbeResult> {
        Box::pin(async move {
            match self.take(RecordedRequest::Probe(request))? {
                ScriptedResponse::Probe(result) => checked(result, |_| Ok(())),
                _ => Err(conflict()),
            }
        })
    }
    fn connect(&self, request: ConnectRequest) -> AdapterFuture<'_, ConnectResult> {
        Box::pin(async move {
            request.validate()?;
            match self.take(RecordedRequest::Connect(request.clone()))? {
                ScriptedResponse::Connect(result) => {
                    checked(*result, |value| value.validate_for(&request))
                }
                _ => Err(conflict()),
            }
        })
    }
    fn submit(&self, request: SubmitRequest) -> AdapterFuture<'_, SubmitOutcome> {
        Box::pin(async move {
            match self.take(RecordedRequest::Submit(request))? {
                ScriptedResponse::Submit(Err(error))
                    if error.code == AdapterErrorCode::DeliveryUncertain =>
                {
                    Err(AdapterError {
                        code: AdapterErrorCode::InvalidArgument,
                        message: "Script submit uncertainty as SubmitOutcome::Uncertain".into(),
                        retryable: false,
                    })
                }
                ScriptedResponse::Submit(result) => checked(result, SubmitOutcome::validate),
                _ => Err(conflict()),
            }
        })
    }
    fn observe(&self, request: ObserveRequest) -> AdapterFuture<'_, ObserveResult> {
        Box::pin(async move {
            match self.take(RecordedRequest::Observe(request.clone()))? {
                ScriptedResponse::Observe(result) => {
                    checked(result, |value| value.validate_for(&request))
                }
                _ => Err(conflict()),
            }
        })
    }
    fn reconcile(&self, request: ReconcileRequest) -> AdapterFuture<'_, ReconcileResult> {
        Box::pin(async move {
            request.validate()?;
            match self.take(RecordedRequest::Reconcile(request.clone()))? {
                ScriptedResponse::Reconcile(result) => {
                    checked(result, |value| value.validate_for(&request))
                }
                _ => Err(conflict()),
            }
        })
    }
    fn disconnect(&self, request: DisconnectRequest) -> AdapterFuture<'_, DisconnectResult> {
        Box::pin(async move {
            match self.take(RecordedRequest::Disconnect(request))? {
                ScriptedResponse::Disconnect(result) => checked(result, |_| Ok(())),
                _ => Err(conflict()),
            }
        })
    }
}

#[cfg(test)]
#[path = "../tests/support/fake_contract.rs"]
mod tests;
