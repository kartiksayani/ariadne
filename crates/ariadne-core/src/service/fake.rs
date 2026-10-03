//! Default-off test/dev double. Scripts return facts; only steps/history are mutable.
use crate::*;
use ariadne_agent_protocol::NormalizedEvent;
use std::collections::VecDeque;
use std::sync::{Mutex, MutexGuard};

#[derive(Debug, Clone, PartialEq)]
pub enum RecordedRequest {
    Query(QueryContext, Box<QueryRequest>),
    Owner(OwnerContext, Box<OwnerCommand>),
    Apply(AgentContext, Box<ApplyRequest>),
    Claim(ValidatedDispatchContext, ClaimRequest),
    Report(AdapterContext, Box<NormalizedEvent>),
}
#[derive(Debug, Clone, PartialEq)]
pub enum ScriptedResponse {
    Query(Box<Result<QueryResult, CoreError>>),
    Owner(Box<Result<MutationReceipt, CoreError>>),
    Apply(Box<Result<ApplyReceipt, CoreError>>),
    Claim(Result<Option<PreparedAttempt>, CoreError>),
    Report(Result<EventReceipt, CoreError>),
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
pub struct ScriptedCoreService {
    state: Mutex<ScriptState>,
}
fn conflict() -> CoreError {
    CoreError::new(
        CoreErrorCode::ProtocolConflict,
        "Core script does not match the requested call",
        "Correct the test script; no operation has been executed.",
    )
}
impl ScriptedCoreService {
    pub fn new(steps: impl IntoIterator<Item = ScriptStep>) -> Self {
        Self {
            state: Mutex::new(ScriptState {
                steps: steps.into_iter().collect(),
                history: Vec::new(),
            }),
        }
    }
    fn state(&self) -> Result<MutexGuard<'_, ScriptState>, CoreError> {
        self.state.lock().map_err(|_| conflict())
    }
    pub fn history(&self) -> Result<Vec<RecordedRequest>, CoreError> {
        Ok(self.state()?.history.clone())
    }
    pub fn remaining(&self) -> Result<usize, CoreError> {
        Ok(self.state()?.steps.len())
    }
    fn take(&self, request: RecordedRequest) -> Result<ScriptedResponse, CoreError> {
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
    result: Result<T, CoreError>,
    validate: impl FnOnce(&T) -> Result<(), CoreError>,
) -> Result<T, CoreError> {
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
impl CoreService for ScriptedCoreService {
    fn query(
        &self,
        context: QueryContext,
        request: QueryRequest,
    ) -> Result<QueryResult, CoreError> {
        request.validate_wire(&context)?;
        match self.take(RecordedRequest::Query(
            context.clone(),
            Box::new(request.clone()),
        ))? {
            ScriptedResponse::Query(result) => {
                checked(*result, |value| value.validate_for(&context, &request))
            }
            _ => Err(conflict()),
        }
    }
    fn execute_owner(
        &self,
        context: OwnerContext,
        command: OwnerCommand,
    ) -> Result<MutationReceipt, CoreError> {
        command.validate_wire()?;
        match self.take(RecordedRequest::Owner(
            context.clone(),
            Box::new(command.clone()),
        ))? {
            ScriptedResponse::Owner(result) => checked(*result, |value| {
                let id = match value {
                    MutationReceipt::Session(value) => &value.operation_id,
                    MutationReceipt::ProjectRegistered(value) => &value.operation_id,
                    MutationReceipt::PreferencesPatched(value) => &value.operation_id,
                };
                let session_matches = match (&value, context.scope()) {
                    (MutationReceipt::Session(receipt), OwnerScope::Session(session)) => {
                        &receipt.session_id == session.session_id()
                    }
                    _ => true,
                };
                if id == command.operation_id() && session_matches {
                    Ok(())
                } else {
                    Err(conflict())
                }
            }),
            _ => Err(conflict()),
        }
    }
    fn apply(
        &self,
        context: AgentContext,
        request: ApplyRequest,
    ) -> Result<ApplyReceipt, CoreError> {
        request.validate_wire()?;
        match self.take(RecordedRequest::Apply(
            context.clone(),
            Box::new(request.clone()),
        ))? {
            ScriptedResponse::Apply(result) => checked(*result, |value| {
                validate_apply_receipt(value, &context, &request)
            }),
            _ => Err(conflict()),
        }
    }
    fn claim(
        &self,
        context: ValidatedDispatchContext,
        request: ClaimRequest,
    ) -> Result<Option<PreparedAttempt>, CoreError> {
        match self.take(RecordedRequest::Claim(context, request.clone()))? {
            ScriptedResponse::Claim(result) => checked(result, |value| match value {
                Some(value) => value.validate_for(&request),
                None => Ok(()),
            }),
            _ => Err(conflict()),
        }
    }
    fn report(
        &self,
        context: AdapterContext,
        event: NormalizedEvent,
    ) -> Result<EventReceipt, CoreError> {
        event.validate().map_err(CoreError::from)?;
        match self.take(RecordedRequest::Report(
            context.clone(),
            Box::new(event.clone()),
        ))? {
            ScriptedResponse::Report(result) => {
                checked(result, |value| value.validate_for(&context, &event))
            }
            _ => Err(conflict()),
        }
    }
}
