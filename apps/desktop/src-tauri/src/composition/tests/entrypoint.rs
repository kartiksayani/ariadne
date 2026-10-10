use super::*;
use ariadne_core::CoreErrorCode;
use ariadne_domain::models::UuidV4;
use ariadne_runtime::control::BindingScope;

#[test]
fn native_display_snapshots_leave_exact_recovery_facts_owned() {
    let handoffs = ActivationHandoffs::default();
    let scope = BindingScope {
        binding_id: UuidV4::new("00000000-0000-4000-8000-000000000001").unwrap(),
        generation: UuidV4::new("00000000-0000-4000-8000-000000000002").unwrap(),
    };
    handoffs.0.lock().unwrap().push(ActivationOutcome::Failed {
        scope,
        error: CoreError::new(
            CoreErrorCode::HostUnreachable,
            "Selected host is unavailable.",
            "Keep the saved binding.",
        ),
    });
    let first = handoffs.diagnostics();
    assert_eq!(first, handoffs.diagnostics());
    assert_eq!(
        first,
        [LifecycleNote::connection(
            "00000000-0000-4000-8000-000000000001",
            "00000000-0000-4000-8000-000000000002",
            "could not start"
        )]
    );
    // The tray names the session; the binding ID never reaches the menu.
    let labels = std::collections::BTreeMap::from([(
        "00000000-0000-4000-8000-000000000001".to_owned(),
        "claude-code · iTerm window 1".to_owned(),
    )]);
    assert_eq!(
        first[0].render(&labels),
        "claude-code · iTerm window 1: could not start"
    );
    assert_eq!(handoffs.take().len(), 1);
    assert!(handoffs.diagnostics().is_empty());
}

#[test]
fn latest_outcome_supersedes_failure_without_consuming_evidence() {
    let handoffs = ActivationHandoffs::default();
    let scope = BindingScope {
        binding_id: UuidV4::new("00000000-0000-4000-8000-000000000001").unwrap(),
        generation: UuidV4::new("00000000-0000-4000-8000-000000000002").unwrap(),
    };
    let error = || {
        CoreError::new(
            CoreErrorCode::HostUnreachable,
            "Host unavailable.",
            "Try again later.",
        )
    };
    handoffs.0.lock().unwrap().extend([
        ActivationOutcome::Failed {
            scope: scope.clone(),
            error: error(),
        },
        ActivationOutcome::Stopped {
            scope: scope.clone(),
            exit: Err(error()),
        },
    ]);
    assert_eq!(
        handoffs.diagnostics(),
        [LifecycleNote::connection(
            scope.binding_id.as_str(),
            scope.generation.as_str(),
            "disconnected unexpectedly"
        )]
    );
    handoffs.0.lock().unwrap().push(ActivationOutcome::Stopped {
        scope,
        exit: Ok(ariadne_runtime::supervisor::SupervisorExit {
            pending: None,
            pending_claim: None,
            acknowledged_checkpoint: None,
            diagnostics: vec![],
            error: None,
        }),
    });
    assert!(handoffs.diagnostics().is_empty());
    assert_eq!(handoffs.take().len(), 3);
}

#[test]
fn late_previous_connection_exit_does_not_replace_current_connection_failure() {
    let handoffs = ActivationHandoffs::default();
    let binding_id = UuidV4::new("00000000-0000-4000-8000-000000000001").unwrap();
    let previous = BindingScope {
        binding_id: binding_id.clone(),
        generation: UuidV4::new("00000000-0000-4000-8000-000000000002").unwrap(),
    };
    let current = BindingScope {
        binding_id,
        generation: UuidV4::new("00000000-0000-4000-8000-000000000003").unwrap(),
    };
    let error = || {
        CoreError::new(
            CoreErrorCode::HostUnreachable,
            "Host unavailable.",
            "Try again later.",
        )
    };
    handoffs.0.lock().unwrap().extend([
        ActivationOutcome::Failed {
            scope: current.clone(),
            error: error(),
        },
        ActivationOutcome::Stopped {
            scope: previous.clone(),
            exit: Err(error()),
        },
    ]);
    assert_eq!(
        handoffs.diagnostics(),
        [
            LifecycleNote::connection(
                previous.binding_id.as_str(),
                previous.generation.as_str(),
                "disconnected unexpectedly"
            ),
            LifecycleNote::connection(
                current.binding_id.as_str(),
                current.generation.as_str(),
                "could not start"
            ),
        ]
    );
    let retained = handoffs.take();
    assert_eq!(retained.len(), 2);
    assert!(matches!(&retained[0], ActivationOutcome::Failed { scope, .. } if scope == &current));
    assert!(matches!(&retained[1], ActivationOutcome::Stopped { scope, .. } if scope == &previous));
}
