use ariadne_core::*;
use ariadne_domain::models::*;
use serde_json::json;

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012}")).unwrap()
}
fn connect() -> OwnerMutationRequest {
    let inventory: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/contracts/core/inventory.json"
    ))
    .unwrap();
    OwnerMutationRequest {
        session: None,
        command: serde_json::from_value(
            inventory["owner_commands"]
                .as_array()
                .unwrap()
                .iter()
                .find(|value| value["command"] == "binding_connect")
                .unwrap()
                .clone(),
        )
        .unwrap(),
    }
}
fn saved(request: &OwnerMutationRequest) -> MutationReceipt {
    let session: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json")).unwrap();
    MutationReceipt::Session(Box::new(SavedReceipt {
        operation_id: request.command.operation_id().clone(),
        session_id: id(800),
        revision: PositiveSafeInteger::new(1).unwrap(),
        data: SavedReceiptData::BindingConnect {
            binding_id: id(801),
            generation: id(802),
            capabilities: session
                .bindings
                .0
                .values()
                .next()
                .unwrap()
                .capabilities
                .clone(),
            setup_instruction: "Exact verified guidance".into(),
        },
    }))
}

#[test]
fn owner_receipt_checks_original_operation_route_and_variant_without_new_replay_guards() {
    let mut request = connect();
    let mut receipt = saved(&request);
    validate_owner_receipt(&request, &receipt).unwrap();
    let OwnerCommand::BindingConnect { params, .. } = &mut request.command else {
        unreachable!()
    };
    params.existing_session_id = Some(id(800));
    validate_owner_receipt(&request, &receipt).unwrap();
    let OwnerCommand::BindingConnect { params, .. } = &mut request.command else {
        unreachable!()
    };
    params.existing_session_id = Some(id(803));
    assert_eq!(
        validate_owner_receipt(&request, &receipt).unwrap_err().code,
        CoreErrorCode::ProtocolConflict
    );
    let OwnerCommand::BindingConnect { params, .. } = &mut request.command else {
        unreachable!()
    };
    params.existing_session_id = None;
    let MutationReceipt::Session(saved) = &mut receipt else {
        unreachable!()
    };
    saved.operation_id = id(804);
    assert!(validate_owner_receipt(&request, &receipt).is_err());
    let MutationReceipt::Session(saved) = &mut receipt else {
        unreachable!()
    };
    saved.operation_id = request.command.operation_id().clone();
    saved.data = SavedReceiptData::SessionLifecycle {
        state: SessionState::Closed,
        closed_at: None,
    };
    assert!(validate_owner_receipt(&request, &receipt).is_err());
    let route = SessionRef {
        project_id: id(1),
        session_id: id(800),
    };
    request = OwnerMutationRequest {
        session: Some(route),
        command: OwnerCommand::SessionClose {
            api_version: SchemaVersion::new(1).unwrap(),
            op_id: request.command.operation_id().clone(),
            params: SessionLifecycleParams {
                expected_revision: PositiveSafeInteger::new(999).unwrap(),
            },
        },
    };
    // Saved replay may legitimately carry an older revision than current guards.
    validate_owner_receipt(&request, &receipt).unwrap();
    let MutationReceipt::Session(saved) = &mut receipt else {
        unreachable!()
    };
    saved.session_id = id(805);
    assert!(validate_owner_receipt(&request, &receipt).is_err());
}

#[test]
fn malformed_owner_receipts_stay_outside_the_canonical_transport_union() {
    for wire in [
        json!({"operation_id":id(1),"session_id":id(2),"revision":0,"data":{"kind":"session_lifecycle","state":"closed","closed_at":null}}),
        json!({"operation_id":id(1),"project_id":id(2),"registry_revision":1,"preferences_revision":1}),
    ] {
        assert!(serde_json::from_value::<MutationReceipt>(wire).is_err());
    }
}

#[test]
fn native_typed_error_conversions_preserve_core_bounds_and_uncertainty() {
    use ariadne_core::bindings::BindingError;
    use ariadne_store::{registry::RegistryError, session::StoreError};
    let original = CoreError::new(
        CoreErrorCode::QuestionChanged,
        "Question changed",
        "Reload.",
    );
    assert_eq!(
        CoreError::from(BindingError::Core(original.clone())),
        original
    );
    let error = CoreError::from(RegistryError::Store(StoreError::CommitUncertain {
        operation_id: Some(id(900)),
    }));
    assert_eq!(error.code, CoreErrorCode::CommitUncertain);
    assert!(!error.retryable);
    error.validate().unwrap();
    let io = StoreError::Io {
        action: "open",
        path: std::path::PathBuf::from(format!("/{}", "é".repeat(6000))),
        kind: std::io::ErrorKind::PermissionDenied,
    };
    let error = CoreError::from(BindingError::Store(io));
    assert_eq!(error.code, CoreErrorCode::PermissionDenied);
    assert!(error.message.len() <= 4096);
    error.validate().unwrap();
    let error = CoreError::from(RegistryError::Conflict { paths: vec![] });
    assert_eq!(error.code, CoreErrorCode::BindingConflict);
    assert_eq!(
        CoreError::from(StoreError::FutureSchema).code,
        CoreErrorCode::FutureSchema
    );
}
