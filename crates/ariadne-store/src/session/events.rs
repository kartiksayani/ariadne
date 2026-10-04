use super::*;

/// A known opaque identity retains its original durable scope. Core validates
/// authority and chooses the affected barrier; proposed IDs cannot retarget it.
#[derive(Debug, Clone, PartialEq)]
pub enum EventIdentity {
    Fresh,
    Conflict { prior_receipt: Box<SavedReceipt> },
}

#[derive(Debug, Clone, PartialEq)]
pub enum EventMutation {
    Unchanged,
    Commit {
        input_id: Option<UuidV4>,
        attempt_id: Option<UuidV4>,
    },
    ProtocolConflict {
        input_id: Option<UuidV4>,
        attempt_id: Option<UuidV4>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum EventTransaction {
    Unchanged,
    Saved {
        receipt: SavedReceipt,
        replayed: bool,
    },
    ProtocolConflict {
        receipt: SavedReceipt,
        replayed: bool,
    },
}

impl Store {
    /// Full opaque event identity and actor, not a UUID conversion or another
    /// index. Exact normal/conflict replay precedes mutable guards and allocation.
    /// The callback runs only local Core work under this existing session lock.
    #[allow(clippy::too_many_arguments)]
    pub fn transact_event<E>(
        &self,
        session_id: &UuidV4,
        actor: &ReceiptActorScope,
        event_id: &str,
        normalized_command: &Value,
        allocate_operation_id: impl FnOnce() -> UuidV4,
        apply: impl FnOnce(&mut Session, EventIdentity) -> Result<EventMutation, E>,
    ) -> Result<EventTransaction, TransactionError<E>> {
        self.with_lock(session_id, || {
            let (live, previous) = self.live(session_id)?;
            if !matches!(actor, ReceiptActorScope::Adapter { .. })
                || event_id.trim().is_empty()
                || event_id.len() > 4096
            {
                return Err(StoreError::IdentityMismatch.into());
            }
            let digest = self.digest(session_id, actor, normalized_command)?;
            let mut prior = None;
            for entry in live.operation_receipts.0.values().flatten() {
                if &entry.actor_scope != actor {
                    continue;
                }
                let (id, conflict) = match &entry.result.data {
                    SavedReceiptData::Event { event_id, .. } => (event_id, false),
                    SavedReceiptData::EventConflict { event_id, .. } => (event_id, true),
                    _ => continue,
                };
                if id != event_id {
                    continue;
                }
                if entry.command_digest == digest {
                    return Ok(if conflict {
                        EventTransaction::ProtocolConflict {
                            receipt: entry.result.clone(),
                            replayed: true,
                        }
                    } else {
                        EventTransaction::Saved {
                            receipt: entry.result.clone(),
                            replayed: true,
                        }
                    });
                }
                // Prefer the immutable original accepted fact over any rejected
                // proposal, independent of ordinary UUID map order.
                if prior.is_none() || !conflict {
                    prior = Some(entry.result.clone());
                }
            }
            let identity_conflict = prior.is_some();
            let identity = prior.map_or(EventIdentity::Fresh, |prior_receipt| {
                EventIdentity::Conflict {
                    prior_receipt: Box::new(prior_receipt),
                }
            });
            let mut candidate = live.clone();
            let mutation = apply(&mut candidate, identity).map_err(TransactionError::Command)?;
            let (data, conflict) = match mutation {
                EventMutation::Unchanged => {
                    if candidate != live || identity_conflict {
                        return Err(StoreError::IdentityMismatch.into());
                    }
                    return Ok(EventTransaction::Unchanged);
                }
                EventMutation::Commit {
                    input_id,
                    attempt_id,
                } => {
                    if identity_conflict {
                        return Err(StoreError::IdentityMismatch.into());
                    }
                    (
                        SavedReceiptData::Event {
                            event_id: event_id.into(),
                            input_id,
                            attempt_id,
                            durable_effect: true,
                        },
                        false,
                    )
                }
                EventMutation::ProtocolConflict {
                    input_id,
                    attempt_id,
                } => (
                    SavedReceiptData::EventConflict {
                        event_id: event_id.into(),
                        input_id,
                        attempt_id,
                    },
                    true,
                ),
            };
            // Validate effects before asking native composition for a UUID. The
            // shared saver then validates complete receipt/revision bookkeeping.
            if candidate.id != live.id
                || candidate.project_id != live.project_id
                || candidate.revision != live.revision
                || candidate.operation_receipts != live.operation_receipts
            {
                return Err(StoreError::IdentityMismatch.into());
            }
            self.validate(&candidate, session_id)?;
            let operation_id = allocate_operation_id();
            let receipt = self.save_effect(
                &live,
                &previous,
                candidate,
                actor,
                &operation_id,
                digest,
                data,
            )?;
            Ok(if conflict {
                EventTransaction::ProtocolConflict {
                    receipt,
                    replayed: false,
                }
            } else {
                EventTransaction::Saved {
                    receipt,
                    replayed: false,
                }
            })
        })
    }
}
