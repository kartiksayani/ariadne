//! Protocol shape/scope checks. Replay, outcome joins and dispatch leases belong to core/runtime.
use crate::*;
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256 as Hasher};
use std::borrow::Cow;
use std::collections::BTreeSet;

const METADATA_BYTES: usize = 4096;
const TEXT_BYTES: usize = 65536;

fn invalid(message: &str) -> AdapterError {
    AdapterError {
        code: AdapterErrorCode::InvalidArgument,
        message: message.into(),
        retryable: false,
    }
}

fn bounded(value: &str, maximum: usize) -> Result<(), AdapterError> {
    if value.len() > maximum {
        Err(invalid("Protocol text exceeds its UTF-8 byte bound"))
    } else {
        Ok(())
    }
}

fn identifier(value: &str) -> Result<(), AdapterError> {
    if value.is_empty() {
        return Err(invalid("Protocol identifier must be nonempty"));
    }
    bounded(value, METADATA_BYTES)
}

fn optional_identifier(value: &Option<String>) -> Result<(), AdapterError> {
    value.as_deref().map(identifier).transpose().map(|_| ())
}

fn receipt(value: &Option<HostReceipt>) -> Result<(), AdapterError> {
    if let Some(value) = value {
        identifier(&value.provider_reference)?;
    }
    Ok(())
}

/// An observation batch requests between one and one hundred events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(transparent)]
#[ts(type = "number")]
pub struct ObserveLimit(u8);

impl ObserveLimit {
    pub fn new(value: u16) -> Result<Self, AdapterError> {
        if (1..=100).contains(&value) {
            Ok(Self(value as u8))
        } else {
            Err(invalid("Observation limit must be in 1..=100"))
        }
    }
    pub fn value(self) -> u8 {
        self.0
    }
}

impl<'de> Deserialize<'de> for ObserveLimit {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(u16::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for ObserveLimit {
    fn schema_name() -> Cow<'static, str> {
        "ObserveLimit".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({"type":"integer","minimum":1,"maximum":100})
    }
}

impl AdapterError {
    pub fn validate(&self) -> Result<(), AdapterError> {
        bounded(&self.message, METADATA_BYTES)?;
        if self.code == AdapterErrorCode::DeliveryUncertain && self.retryable {
            return Err(invalid("Uncertain delivery never permits resend"));
        }
        Ok(())
    }
}

impl std::fmt::Display for AdapterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for AdapterError {}

impl ConnectRequest {
    pub fn validate(&self) -> Result<(), AdapterError> {
        identifier(&self.external_session_id)
    }
}

impl ConnectResult {
    pub fn validate_for(&self, request: &ConnectRequest) -> Result<(), AdapterError> {
        request.validate()?;
        identifier(&self.external_session_id)?;
        if self.external_session_id != request.external_session_id {
            return Err(AdapterError {
                code: AdapterErrorCode::BindingMismatch,
                message: "Connected host identity differs from selected session".into(),
                retryable: false,
            });
        }
        if self.observation.generation != request.generation {
            return Err(invalid("Connected presence uses a different generation"));
        }
        // EndpointFingerprint retains its canonical opaque-metadata meaning.
        bounded(&self.endpoint_fingerprint.0, METADATA_BYTES)
    }
}

impl SubmitOutcome {
    pub fn validate(&self) -> Result<(), AdapterError> {
        match self {
            Self::Accepted { receipt: value } => receipt(value),
            Self::RejectedBeforeDelivery { reason } | Self::Uncertain { reason } => {
                bounded(reason, METADATA_BYTES)
            }
        }
    }
}

impl NormalizedEvent {
    pub fn validate(&self) -> Result<(), AdapterError> {
        identifier(&self.event_id)?;
        optional_identifier(&self.host_turn_id)?;
        let matched = !matches!(
            self.event,
            EventPayload::Connected { .. }
                | EventPayload::Presence { .. }
                | EventPayload::Disconnected { .. }
        );
        if matched {
            if self.input_id.is_none() || self.attempt_id.is_none() {
                return Err(invalid("Matched event requires input and attempt IDs"));
            }
        } else if self.input_id.is_some()
            || self.attempt_id.is_some()
            || self.host_turn_id.is_some()
        {
            return Err(invalid(
                "Connection/presence event cannot carry attempt correlation",
            ));
        }
        if matches!(
            self.event,
            EventPayload::TurnStarted { .. }
                | EventPayload::VisibleOutput { .. }
                | EventPayload::TurnFinished { .. }
        ) && self.host_turn_id.is_none()
        {
            return Err(invalid("Turn event requires a correlated host turn ID"));
        }
        match &self.event {
            EventPayload::Connected {
                external_session_id,
                endpoint_fingerprint,
                ..
            } => {
                identifier(external_session_id)?;
                bounded(&endpoint_fingerprint.0, METADATA_BYTES)?;
            }
            EventPayload::Accepted { receipt: value } => receipt(value)?,
            EventPayload::VisibleOutput {
                host_message_id,
                text,
                ..
            } => {
                optional_identifier(host_message_id)?;
                bounded(text, TEXT_BYTES)?;
            }
            EventPayload::TurnFinished {
                reason,
                diagnostic_text,
                ..
            } => {
                if let Some(reason) = reason {
                    bounded(reason, METADATA_BYTES)?;
                }
                if let Some(text) = diagnostic_text {
                    bounded(text, TEXT_BYTES)?;
                }
            }
            EventPayload::Rejected { reason } | EventPayload::Uncertain { reason } => {
                bounded(reason, METADATA_BYTES)?
            }
            EventPayload::Presence { observation } => {
                if observation.generation != self.generation {
                    return Err(invalid("Presence generation differs from its event"));
                }
            }
            EventPayload::Disconnected { reason } => {
                if let Some(reason) = reason {
                    bounded(reason, METADATA_BYTES)?;
                }
            }
            EventPayload::TurnStarted {} => {}
        }
        Ok(())
    }
}

impl ObserveResult {
    pub fn validate_for(&self, request: &ObserveRequest) -> Result<(), AdapterError> {
        if self.events.len() > usize::from(request.limit.value()) {
            return Err(invalid("Observation exceeded its requested limit"));
        }
        for event in &self.events {
            event.validate()?;
            if event.binding_id != request.binding_id || event.generation != request.generation {
                return Err(invalid(
                    "Observation crossed its binding or current generation",
                ));
            }
        }
        Ok(())
    }
}

impl ReconcileRequest {
    pub fn validate(&self) -> Result<(), AdapterError> {
        let mut attempts = BTreeSet::new();
        for attempt in &self.attempts {
            optional_identifier(&attempt.host_turn_id)?;
            if !attempts.insert(&attempt.attempt_id) {
                return Err(invalid("Reconciliation request repeats an attempt ID"));
            }
        }
        Ok(())
    }
}

impl ReconcileResult {
    pub fn validate_for(&self, request: &ReconcileRequest) -> Result<(), AdapterError> {
        request.validate()?;
        let mut evidence_ids = BTreeSet::new();
        for evidence in &self.attempt_evidence {
            let attempt = request
                .attempts
                .iter()
                .find(|attempt| attempt.attempt_id == evidence.attempt_id)
                .ok_or_else(|| {
                    invalid("Reconciliation evidence references an unrequested attempt")
                })?;
            if attempt.input_id != evidence.input_id || !evidence_ids.insert(&evidence.attempt_id) {
                return Err(invalid(
                    "Reconciliation evidence has mismatched or repeated attempt scope",
                ));
            }
            for event in &evidence.events {
                event.validate()?;
                if event.binding_id != request.binding_id
                    || event.generation != attempt.binding_generation
                    || event.input_id.as_ref() != Some(&attempt.input_id)
                    || event.attempt_id.as_ref() != Some(&attempt.attempt_id)
                {
                    return Err(invalid(
                        "Historical event does not match its originating attempt scope",
                    ));
                }
            }
        }
        let mut unresolved = BTreeSet::new();
        for id in &self.unresolved_attempt_ids {
            if !request
                .attempts
                .iter()
                .any(|attempt| &attempt.attempt_id == id)
                || !unresolved.insert(id)
            {
                return Err(invalid(
                    "Unresolved reconciliation IDs are repeated or unrequested",
                ));
            }
        }
        // Evidence and unresolved may overlap: partial evidence cannot prove non-delivery.
        if request.attempts.iter().any(|attempt| {
            !evidence_ids.contains(&attempt.attempt_id) && !unresolved.contains(&attempt.attempt_id)
        }) {
            return Err(invalid(
                "Reconciliation response omitted a requested attempt",
            ));
        }
        Ok(())
    }
}

/// Terminal fallback identity hashes a serialized tuple, never ambiguous concatenation.
/// Output chunks require their own stable source/sequence identity, never a text hash.
pub fn terminal_event_id(
    binding_id: &UuidV4,
    generation: &UuidV4,
    attempt_id: &UuidV4,
    host_turn_id: Option<&str>,
    kind: TerminalEventKind,
    source_event_id: Option<&str>,
) -> Result<String, AdapterError> {
    if let Some(turn) = host_turn_id {
        identifier(turn)?;
    }
    if kind == TerminalEventKind::TurnFinished && host_turn_id.is_none() {
        return Err(invalid("Finished turn identity requires a host turn ID"));
    }
    if let Some(identity) = source_event_id {
        identifier(identity)?;
        return Ok(identity.into());
    }
    let tuple = (binding_id, generation, attempt_id, host_turn_id, kind);
    let encoded = serde_json::to_vec(&tuple)
        .map_err(|_| invalid("Terminal identity could not be encoded"))?;
    Ok(format!("{:x}", Hasher::digest(encoded)))
}
