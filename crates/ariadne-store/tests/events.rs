#[allow(dead_code)]
mod support;
use ariadne_domain::models::*;
use ariadne_store::session::{
    EventIdentity, EventMutation, EventTransaction, StoreError, TransactionError,
};
use serde_json::json;
use support::*;

fn adapter() -> ReceiptActorScope {
    ReceiptActorScope::Adapter { binding_id: id(3) }
}

#[test]
fn opaque_event_replay_and_conflicting_proposal_preserve_original_scope_atomically() {
    let p = ProjectDir::new();
    let store = p.store();
    let event = "opaque:/provider:α/123";
    let command = json!({"kind":"accepted","event_id":event,"fact":"one"});
    let first = store
        .transact_event(
            &id(2),
            &adapter(),
            event,
            &command,
            || id(200),
            |s, identity| {
                assert_eq!(identity, EventIdentity::Fresh);
                s.updated_at = UtcMillis::new("2026-10-04T13:00:00.000Z").unwrap();
                Ok::<_, ()>(EventMutation::Commit {
                    input_id: None,
                    attempt_id: None,
                })
            },
        )
        .unwrap();
    let EventTransaction::Saved {
        receipt: original,
        replayed: false,
    } = first
    else {
        panic!()
    };
    let bytes = std::fs::read(p.live()).unwrap();
    assert_eq!(
        store
            .transact_event(
                &id(2),
                &adapter(),
                event,
                &command,
                || panic!("replay allocation"),
                |_, _| -> Result<_, ()> { panic!("replay effects") }
            )
            .unwrap(),
        EventTransaction::Saved {
            receipt: original.clone(),
            replayed: true
        }
    );
    assert_eq!(std::fs::read(p.live()).unwrap(), bytes);
    let changed = json!({"kind":"accepted","event_id":event,"fact":"changed"});
    let conflict = store
        .transact_event(
            &id(2),
            &adapter(),
            event,
            &changed,
            || id(199),
            |s, identity| {
                assert_eq!(
                    identity,
                    EventIdentity::Conflict {
                        prior_receipt: Box::new(original.clone())
                    }
                );
                let binding = s.bindings.0.get_mut(&id(3)).unwrap();
                binding.pause_reason = Some(PauseReason::Uncertain);
                binding.dispatch_state = DispatchState::RecoveryRequired;
                Ok::<_, ()>(EventMutation::ProtocolConflict {
                    input_id: None,
                    attempt_id: None,
                })
            },
        )
        .unwrap();
    let EventTransaction::ProtocolConflict {
        receipt: rejected,
        replayed: false,
    } = conflict
    else {
        panic!()
    };
    let saved = store.read(&id(2)).unwrap();
    assert_eq!(saved.revision.value(), original.revision.value() + 1);
    assert_eq!(saved.operation_receipts.0[&id(200)][0].result, original);
    assert_eq!(
        saved.bindings.0[&id(3)].dispatch_state,
        DispatchState::RecoveryRequired
    );
    let bytes = std::fs::read(p.live()).unwrap();
    assert_eq!(
        store
            .transact_event(
                &id(2),
                &adapter(),
                event,
                &changed,
                || panic!(),
                |_, _| -> Result<_, ()> { panic!() }
            )
            .unwrap(),
        EventTransaction::ProtocolConflict {
            receipt: rejected,
            replayed: true
        }
    );
    assert_eq!(
        store
            .transact_event(
                &id(2),
                &adapter(),
                event,
                &command,
                || panic!(),
                |_, _| -> Result<_, ()> { panic!() }
            )
            .unwrap(),
        EventTransaction::Saved {
            receipt: original,
            replayed: true
        }
    );
    assert_eq!(std::fs::read(p.live()).unwrap(), bytes);
}

#[test]
fn unchanged_event_has_no_allocation_receipt_revision_backup_or_byte_effect() {
    let p = ProjectDir::new();
    let store = p.store();
    let bytes = std::fs::read(p.live()).unwrap();
    assert_eq!(
        store
            .transact_event(
                &id(2),
                &adapter(),
                "presence-like",
                &json!({}),
                || panic!(),
                |_, _| Ok::<_, ()>(EventMutation::Unchanged)
            )
            .unwrap(),
        EventTransaction::Unchanged
    );
    assert_eq!(std::fs::read(p.live()).unwrap(), bytes);
    assert!(!p.backup().exists());
    assert!(matches!(
        store.transact_event(
            &id(2),
            &adapter(),
            "bad-noop",
            &json!({}),
            || panic!(),
            |s, _| {
                s.title = "changed".into();
                Ok::<_, ()>(EventMutation::Unchanged)
            }
        ),
        Err(TransactionError::Store(StoreError::IdentityMismatch))
    ));
    assert_eq!(std::fs::read(p.live()).unwrap(), bytes);
}

#[test]
fn known_identity_cannot_commit_normal_effect_or_overwrite_another_actor() {
    let p = ProjectDir::new();
    let store = p.store();
    let cmd = json!({"fact":1});
    store
        .transact_event(
            &id(2),
            &adapter(),
            "same",
            &cmd,
            || id(210),
            |_, _| {
                Ok::<_, ()>(EventMutation::Commit {
                    input_id: None,
                    attempt_id: None,
                })
            },
        )
        .unwrap();
    let bytes = std::fs::read(p.live()).unwrap();
    assert!(matches!(
        store.transact_event(
            &id(2),
            &adapter(),
            "same",
            &json!({"fact":2}),
            || panic!(),
            |_, _| Ok::<_, ()>(EventMutation::Commit {
                input_id: None,
                attempt_id: None
            })
        ),
        Err(TransactionError::Store(StoreError::IdentityMismatch))
    ));
    assert_eq!(std::fs::read(p.live()).unwrap(), bytes);
    let other = ReceiptActorScope::Adapter {
        binding_id: id(999),
    };
    store
        .transact_event(
            &id(2),
            &other,
            "same",
            &cmd,
            || id(211),
            |_, identity| {
                assert_eq!(identity, EventIdentity::Fresh);
                Ok::<_, ()>(EventMutation::Commit {
                    input_id: None,
                    attempt_id: None,
                })
            },
        )
        .unwrap();
    assert_eq!(store.read(&id(2)).unwrap().operation_receipts.0.len(), 2);
}

#[test]
fn rejected_callback_and_invalid_candidate_never_allocate_or_persist() {
    let p = ProjectDir::new();
    let store = p.store();
    let bytes = std::fs::read(p.live()).unwrap();
    assert!(matches!(
        store.transact_event(
            &id(2),
            &adapter(),
            "denied",
            &json!({}),
            || panic!(),
            |_, _| Err::<EventMutation, _>("stale_scope")
        ),
        Err(TransactionError::Command("stale_scope"))
    ));
    assert!(matches!(
        store.transact_event(
            &id(2),
            &adapter(),
            "invalid",
            &json!({}),
            || panic!(),
            |s, _| {
                s.items.0.get_mut(&item("1")).unwrap().parent = Some(item("1"));
                Ok::<_, ()>(EventMutation::Commit {
                    input_id: None,
                    attempt_id: None,
                })
            }
        ),
        Err(TransactionError::Store(StoreError::Validation(_)))
    ));
    assert_eq!(std::fs::read(p.live()).unwrap(), bytes);
    assert!(!p.backup().exists());
}
