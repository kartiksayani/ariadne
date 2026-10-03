//! One retained observation batch. A returned token is only a persistence candidate.
use super::*;

struct Batch {
    number: u64,
    events: Vec<NormalizedEvent>,
    acknowledged: usize,
    offered: Vec<usize>,
    start: Option<Checkpoint>,
}
pub(super) struct Observer {
    nonce: String,
    number: u64,
    batch: Option<Batch>,
    start: Option<Checkpoint>,
}
impl Observer {
    pub(super) fn new(nonce: String) -> Self {
        Self {
            nonce,
            number: 0,
            batch: None,
            start: None,
        }
    }
    pub(super) fn reset(&mut self) {
        self.batch = None;
        self.start = None;
    }
    pub(super) fn has_unacknowledged(&self) -> bool {
        self.batch
            .as_ref()
            .is_some_and(|b| b.acknowledged < b.events.len())
    }
    fn token(
        &self,
        request: &ObserveRequest,
        number: u64,
        offset: usize,
    ) -> Result<Checkpoint, AdapterError> {
        let encoded = serde_json::to_string(&(
            "codex-observe-v1",
            &self.nonce,
            &request.binding_id,
            &request.generation,
            number,
            offset,
        ))
        .map_err(|_| poisoned())?;
        Checkpoint::new(encoded).map_err(|_| poisoned())
    }
    /// Check the caller's acknowledgement before scanning or retiring any context.
    fn acknowledge(&mut self, request: &ObserveRequest) -> Result<Vec<UuidV4>, AdapterError> {
        let Some(batch) = self.batch.as_ref() else {
            if request.checkpoint != self.start {
                return Err(foreign());
            }
            return Ok(Vec::new());
        };
        let current = if batch.acknowledged == 0 {
            batch.start.clone()
        } else {
            Some(self.token(request, batch.number, batch.acknowledged)?)
        };
        if request.checkpoint == current {
            return Ok(Vec::new());
        }
        let mut acknowledged = None;
        for offset in &batch.offered {
            if *offset > batch.acknowledged
                && request.checkpoint == Some(self.token(request, batch.number, *offset)?)
            {
                acknowledged = Some(*offset);
                break;
            }
        }
        let acknowledged = acknowledged.ok_or_else(foreign)?;
        let batch = self.batch.as_mut().ok_or_else(poisoned)?;
        let retired = batch.events[batch.acknowledged..acknowledged]
            .iter()
            .filter_map(|event| {
                matches!(
                    event.event,
                    EventPayload::TurnFinished { .. } | EventPayload::Rejected { .. }
                )
                .then(|| event.attempt_id.clone())
                .flatten()
            })
            .collect();
        batch.acknowledged = acknowledged;
        batch.offered.retain(|offset| *offset > acknowledged);
        if batch.acknowledged == batch.events.len() {
            self.start = request.checkpoint.clone();
            self.batch = None;
        }
        Ok(retired)
    }
    fn install(&mut self, events: Vec<NormalizedEvent>) -> Result<(), AdapterError> {
        if self.batch.is_some() {
            return Err(poisoned());
        }
        self.number = self.number.checked_add(1).ok_or_else(poisoned)?;
        self.batch = Some(Batch {
            number: self.number,
            events,
            acknowledged: 0,
            offered: Vec::new(),
            start: self.start.clone(),
        });
        Ok(())
    }
    fn page(&mut self, request: &ObserveRequest) -> Result<ObserveResult, AdapterError> {
        let batch = self.batch.as_ref().ok_or_else(poisoned)?;
        let end = (batch.acknowledged + usize::from(request.limit.value())).min(batch.events.len());
        let result = ObserveResult {
            events: batch.events[batch.acknowledged..end].to_vec(),
            next_checkpoint: Some(self.token(request, batch.number, end)?),
        };
        let offered = &mut self.batch.as_mut().ok_or_else(poisoned)?.offered;
        // At most one entry per event offset in this single bounded batch. A retry with a
        // narrower limit must not revoke another candidate that was actually offered.
        if !offered.contains(&end) {
            offered.push(end);
        }
        result.validate_for(request)?;
        Ok(result)
    }
}
fn foreign() -> AdapterError {
    error(AdapterErrorCode::InvalidArgument, "Codex observation checkpoint is stale, foreign, or was never offered. After restart, reconcile persisted attempts and begin observing with no checkpoint.")
}

impl State {
    pub(crate) fn observe(
        &mut self,
        request: ObserveRequest,
        deadline: Instant,
    ) -> Result<ObserveResult, AdapterError> {
        scope(
            &*self.shared.lock().map_err(|_| poisoned())?,
            &request.binding_id,
            &request.generation,
        )?;
        let retired = self.observation.acknowledge(&request)?;
        {
            let mut shared = self.shared.lock().map_err(|_| poisoned())?;
            for attempt in retired {
                shared.records.remove(&attempt);
                if self
                    .observing
                    .as_ref()
                    .is_some_and(|(id, _)| id == &attempt)
                {
                    self.observing = None;
                }
            }
        }
        // Retained verified facts replay with their original timestamps even if the endpoint
        // disappeared. Requiring new liveness here would prevent acknowledgement and reconnect.
        if self.observation.batch.is_some() {
            return self.observation.page(&request);
        }
        let client = self.client.as_mut().ok_or_else(|| {
            error(
                AdapterErrorCode::HostUnreachable,
                "Connect Codex before observing.",
            )
        })?;
        client.verify_scope(&request.binding_id, &request.generation)?;
        client.verify_identity()?;
        if self.observation.batch.is_none() {
            let observed_at = now()?;
            let mut events = Vec::new();
            let presence = client.presence_before(observed_at.clone(), deadline)?;
            let selected = {
                let shared = self.shared.lock().map_err(|_| poisoned())?;
                let mut records: Vec<_> = shared
                    .records
                    .values()
                    .filter(|r| {
                        r.request.binding_id == request.binding_id
                            && r.request.generation == request.generation
                            && r.outcome.is_some()
                    })
                    .collect();
                records.sort_by(|a, b| {
                    a.request
                        .attempt_id
                        .as_str()
                        .cmp(b.request.attempt_id.as_str())
                });
                let selected = if let Some((id, _)) = &self.observing {
                    records.iter().find(|r| &r.request.attempt_id == id)
                } else {
                    records
                        .iter()
                        .find(|r| {
                            self.last_observed
                                .as_ref()
                                .is_none_or(|id| r.request.attempt_id.as_str() > id.as_str())
                        })
                        .or_else(|| records.first())
                };
                selected.map(|record| (*record).clone())
            };
            if let Some(record) = selected {
                let submit = &record.request;
                if let Some(SubmitOutcome::RejectedBeforeDelivery { reason }) = &record.outcome {
                    events.push(NormalizedEvent {
                        event_id: terminal_event_id(
                            &submit.binding_id,
                            &submit.generation,
                            &submit.attempt_id,
                            None,
                            TerminalEventKind::Rejected,
                            None,
                        )?,
                        binding_id: submit.binding_id.clone(),
                        generation: submit.generation.clone(),
                        input_id: Some(submit.input_id.clone()),
                        attempt_id: Some(submit.attempt_id.clone()),
                        host_turn_id: None,
                        observed_at: observed_at.clone(),
                        event: EventPayload::Rejected {
                            reason: reason.clone(),
                        },
                    });
                } else {
                    if self.observing.is_none() {
                        self.observing = Some((
                            submit.attempt_id.clone(),
                            client.begin_scan(record.anchor.clone())?,
                        ));
                    }
                    let evidence = ReconcileRequest {
                        binding_id: submit.binding_id.clone(),
                        generation: submit.generation.clone(),
                        attempts: vec![AttemptEvidenceRequest {
                            input_id: submit.input_id.clone(),
                            attempt_id: submit.attempt_id.clone(),
                            binding_generation: submit.generation.clone(),
                            payload_sha256: submit.payload_sha256.clone(),
                            wire_marker: submit.wire_marker.clone(),
                            host_turn_id: None,
                        }],
                        checkpoint: None,
                    };
                    let (_, scan) = self.observing.as_mut().ok_or_else(poisoned)?;
                    let mut result = client.read_history_before(
                        evidence.clone(),
                        scan,
                        observed_at.clone(),
                        deadline,
                    )?;
                    recover_acceptance(&mut result, scan)?;
                    result.validate_for(&evidence)?;
                    events.extend(result.attempt_evidence.into_iter().flat_map(|e| e.events));
                    if !scan.progress().has_more {
                        self.observing = None;
                        self.last_observed = Some(submit.attempt_id.clone());
                    }
                }
            }
            // Presence comes from an explicit current-thread read, never absence of matched turns.
            let event_id = digest(
                &serde_json::to_vec(&(
                    "codex-presence",
                    &self.instance_id,
                    &request.binding_id,
                    &request.generation,
                    &observed_at,
                    &presence,
                ))
                .map_err(|_| poisoned())?,
            );
            events.push(NormalizedEvent {
                event_id,
                binding_id: request.binding_id.clone(),
                generation: request.generation.clone(),
                input_id: None,
                attempt_id: None,
                host_turn_id: None,
                observed_at,
                event: EventPayload::Presence {
                    observation: presence,
                },
            });
            if events.iter().all(|event| {
                matches!(
                    event.event,
                    EventPayload::Presence { .. } | EventPayload::VisibleOutput { .. }
                )
            }) {
                let result = ObserveResult {
                    events,
                    next_checkpoint: self.observation.start.clone(),
                };
                result.validate_for(&request)?;
                return Ok(result);
            }
            self.observation.install(events)?;
        }
        self.observation.page(&request)
    }
}
