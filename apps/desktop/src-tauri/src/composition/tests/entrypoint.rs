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
        [LifecycleNote::binding(
            "00000000-0000-4000-8000-000000000001",
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
