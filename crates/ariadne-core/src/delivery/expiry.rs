use super::{error::core, DeliveryError, DeliveryService};
use crate::*;
use ariadne_domain::models::*;
use ariadne_store::session::TransactionError;
use chrono::DateTime;

enum ExpiryFailure {
    Unchanged,
    Core(CoreError),
}
impl From<CoreError> for ExpiryFailure {
    fn from(e: CoreError) -> Self {
        Self::Core(e)
    }
}
impl DeliveryService<'_> {
    /// Explicit native scheduler tick, never a fabricated provider event. The
    /// caller waits outside all store locks and owns the five-second UI policy.
    pub fn expire_missing_result(
        &self,
        context: &AdapterContext,
        input_id: &UuidV4,
        attempt_id: &UuidV4,
        operation_id: &UuidV4,
        now: UtcMillis,
    ) -> Result<Option<SavedReceipt>, DeliveryError> {
        let store = self.store(context.session())?;
        let normalized = crate::receipts::normalized(
            "expire_missing_result",
            &serde_json::json!({"binding_id":context.binding_id(),"generation":context.current_generation(),"input_id":input_id,"attempt_id":attempt_id}),
        )?;
        let saved=store.transact(context.session().session_id(),&ReceiptActorScope::Adapter {binding_id:context.binding_id().clone()},operation_id,&normalized,|session| {
            let input=session.inputs.0.get(input_id).ok_or_else(||core(CoreErrorCode::InvalidRef,"Expiry input is missing"))?;
            let attempt=input.attempts.iter().find(|a| &a.id==attempt_id).ok_or_else(||core(CoreErrorCode::InvalidRef,"Expiry attempt is missing"))?;
            super::report::authorize(session,context,&attempt.binding_generation,Some(input_id),Some(attempt_id))?;
            if attempt.sealed_at.is_some() || matches!(input.state,InputState::Handled|InputState::Cancelled|InputState::Skipped) || attempt.turn_state!=TurnState::Completed || attempt.result_state!=ResultState::Pending || attempt.domain_result.is_some() || matches!(attempt.acceptance,AcceptanceState::Rejected|AcceptanceState::Uncertain) || attempt.error.as_ref().is_some_and(|e|e.code!="result_missing") {return Err(ExpiryFailure::Unchanged);}
            let Some(completed)=&attempt.turn_observed_at else {return Err(ExpiryFailure::Unchanged);};
            let elapsed=DateTime::parse_from_rfc3339(now.as_str()).expect("canonical time").signed_duration_since(DateTime::parse_from_rfc3339(completed.as_str()).expect("canonical time"));
            if elapsed.num_milliseconds()<5000 {return Err(ExpiryFailure::Unchanged);}
            let input=session.inputs.0.get_mut(input_id).expect("input");let attempt=input.attempts.iter_mut().find(|a| &a.id==attempt_id).expect("attempt");
            attempt.result_state=ResultState::Missing;
            if attempt.error.is_none() {attempt.error=Some(AttemptError {code:"result_missing".into(),reason:"The completed host turn has no committed structured result after the five-second grace.".into(),retryable:false,observed_at:now.clone()});}
            input.state=InputState::NeedsAttention;
            let binding=session.bindings.0.get_mut(context.binding_id()).expect("binding");
            if binding.pause_reason.is_none() {binding.pause_reason=Some(PauseReason::ResultMissing);}
            if binding.connection_state==ConnectionState::Connected {binding.dispatch_state=DispatchState::RecoveryRequired;}
            session.updated_at=now.clone();
            Ok(SavedReceiptData::DeliveryExpiry {input_id:input_id.clone(),attempt_id:attempt_id.clone()})
        });
        match saved {
            Ok(r) => Ok(Some(r)),
            Err(TransactionError::Command(ExpiryFailure::Unchanged)) => Ok(None),
            Err(TransactionError::Command(ExpiryFailure::Core(e))) => Err(e.into()),
            Err(TransactionError::Store(e)) => Err(e.into()),
        }
    }
}
