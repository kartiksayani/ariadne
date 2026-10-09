//! Owner rename: name and description, limits, clearing, closed and removed sessions.
use ariadne_core::{
    history_actions::{HistoryActionError, HistoryActionService},
    *,
};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use std::fs;
use tempfile::TempDir;

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn p(n: u64) -> PositiveSafeInteger {
    PositiveSafeInteger::new(n).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn version() -> SchemaVersion {
    SchemaVersion::new(1).unwrap()
}
fn seed() -> Session {
    serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap()
}
/// The seed with every item finished and its binding paused, so it can close.
fn closable_seed() -> Session {
    let mut session = seed();
    for item in session.items.0.values_mut() {
        item.status = ItemStatus::Done;
        item.outcome = Some("Retained complete outcome".into());
        item.why = Some("Explicitly completed".into());
        item.waiting_since = None;
        item.replaced_by = None;
    }
    let binding = session.bindings.0.get_mut(&id(3)).unwrap();
    binding.dispatch_state = DispatchState::Paused;
    binding.owner_paused = true;
    session
}
fn owner() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
    ))
}
fn label(name: Option<&str>, description: Option<&str>, op: u64) -> OwnerCommand {
    OwnerCommand::SessionLabelSet {
        api_version: version(),
        op_id: id(op),
        params: SessionLabelParams {
            name: name.map(str::to_owned),
            description: description.map(str::to_owned),
        },
    }
}
fn close(revision: u64, op: u64) -> OwnerCommand {
    OwnerCommand::SessionClose {
        api_version: version(),
        op_id: id(op),
        params: SessionLifecycleParams {
            expected_revision: p(revision),
        },
    }
}
fn session_remove(revision: u64, op: u64) -> OwnerCommand {
    OwnerCommand::SessionRemove {
        api_version: version(),
        op_id: id(op),
        params: SessionRemoveParams {
            project_id: id(1),
            session_id: id(2),
            expected_revision: p(revision),
        },
    }
}
fn saved(result: MutationReceipt) -> SavedReceipt {
    let MutationReceipt::Session(saved) = result else {
        panic!("session receipt")
    };
    *saved
}
fn refused(result: Result<MutationReceipt, HistoryActionError>) -> CoreError {
    match result.unwrap_err() {
        HistoryActionError::Core(error) => error,
        other => panic!("core error, got {other:?}"),
    }
}
struct Setup {
    home: TempDir,
    _root: TempDir,
    registry: Registry,
}
impl Setup {
    fn new(session: &Session) -> Self {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        Store::open_registered(&dir(&home), id(1))
            .unwrap()
            .create(session)
            .unwrap();
        Self {
            home,
            _root: root,
            registry,
        }
    }
    fn service(&self) -> HistoryActionService<'_> {
        HistoryActionService::new(&self.registry)
    }
    /// A fresh handle on the same files, as after the app restarts.
    fn read(&self) -> Session {
        Store::open_registered(&dir(&self.home), id(1))
            .unwrap()
            .read(&id(2))
            .unwrap()
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(dir(&self.home).join(format!("sessions/{}.json", id(2).as_str()))).unwrap()
    }
}
fn dir(home: &TempDir) -> std::path::PathBuf {
    home.path().join(".ariadne/projects").join(id(1).as_str())
}

#[test]
fn rename_trims_stores_and_persists_across_reopen() {
    let setup = Setup::new(&seed());
    let before = setup.read();
    assert!(before.name.is_none() && before.description.is_none());
    let receipt = saved(
        setup
            .service()
            .execute(
                &owner(),
                &label(
                    Some("  Billing fixes  "),
                    Some(" Sorting out the refund rules "),
                    100,
                ),
                at(),
            )
            .unwrap(),
    );
    assert_eq!(
        receipt.data,
        SavedReceiptData::SessionLabel {
            name: Some("Billing fixes".into()),
            description: Some("Sorting out the refund rules".into()),
        }
    );
    let live = setup.read();
    assert_eq!(live.name.as_deref(), Some("Billing fixes"));
    assert_eq!(
        live.description.as_deref(),
        Some("Sorting out the refund rules")
    );
    // The rename is a saved change, but not session activity.
    assert_eq!(live.revision.value(), before.revision.value() + 1);
    assert_eq!(receipt.revision, live.revision);
    assert_eq!(live.updated_at, before.updated_at);
    assert_eq!(live.title, before.title);
}

#[test]
fn blank_or_null_fields_clear_back_to_the_default() {
    let setup = Setup::new(&seed());
    setup
        .service()
        .execute(
            &owner(),
            &label(Some("Billing"), Some("Refunds"), 100),
            at(),
        )
        .unwrap();
    let receipt = saved(
        setup
            .service()
            .execute(&owner(), &label(Some("   "), None, 101), at())
            .unwrap(),
    );
    assert_eq!(
        receipt.data,
        SavedReceiptData::SessionLabel {
            name: None,
            description: None
        }
    );
    let live = setup.read();
    assert!(live.name.is_none() && live.description.is_none());
    // Cleared fields are omitted from the file, as in a store written before them.
    let file: serde_json::Value = serde_json::from_slice(&setup.bytes()).unwrap();
    assert!(file.get("name").is_none() && file.get("description").is_none());
    // The name can be cleared while the description stays.
    setup
        .service()
        .execute(
            &owner(),
            &label(Some("Billing"), Some("Refunds"), 102),
            at(),
        )
        .unwrap();
    setup
        .service()
        .execute(&owner(), &label(Some(""), Some("Refunds"), 103), at())
        .unwrap();
    let live = setup.read();
    assert!(live.name.is_none());
    assert_eq!(live.description.as_deref(), Some("Refunds"));
}

#[test]
fn limits_count_characters_after_trimming_and_refuse_in_plain_words() {
    let setup = Setup::new(&seed());
    // Exactly at the limits, multi-byte characters included.
    let name = "é".repeat(60);
    let description = "d".repeat(200);
    setup
        .service()
        .execute(
            &owner(),
            &label(Some(&format!(" {name} ")), Some(&description), 100),
            at(),
        )
        .unwrap();
    assert_eq!(setup.read().name.as_deref(), Some(name.as_str()));
    let stored = setup.bytes();
    for (command, expected) in [
        (
            label(Some(&"n".repeat(61)), None, 101),
            "The session name can be up to 60 characters.",
        ),
        (
            label(None, Some(&"d".repeat(201)), 102),
            "The session description can be up to 200 characters.",
        ),
        (
            label(Some("two\nlines"), None, 103),
            "The session name must be on one line.",
        ),
        (
            label(None, Some("two\r\nlines"), 104),
            "The session description must be on one line.",
        ),
        (
            label(Some("bell\u{7}"), None, 105),
            "The session name has a character Ariadne cannot save.",
        ),
    ] {
        let error = refused(setup.service().execute(&owner(), &command, at()));
        assert_eq!(error.code, CoreErrorCode::InvalidArgument);
        assert_eq!(error.message, expected);
        assert_eq!(error.field_errors.len(), 1);
    }
    // A refusal changes nothing on disk.
    assert_eq!(setup.bytes(), stored);
}

#[test]
fn closed_sessions_can_be_renamed_and_removed_ones_are_refused() {
    let setup = Setup::new(&closable_seed());
    setup
        .service()
        .execute(&owner(), &close(1, 100), at())
        .unwrap();
    assert_eq!(setup.read().state, SessionState::Closed);
    setup
        .service()
        .execute(&owner(), &label(Some("Old billing work"), None, 101), at())
        .unwrap();
    let closed = setup.read();
    assert_eq!(closed.state, SessionState::Closed);
    assert_eq!(closed.name.as_deref(), Some("Old billing work"));
    let registry = OwnerContext::from_trusted_entrypoint(OwnerScope::Registry);
    setup
        .service()
        .remove(
            &registry,
            &session_remove(closed.revision.value(), 102),
            || id(500),
            at(),
        )
        .unwrap();
    let error = refused(setup.service().execute(
        &owner(),
        &label(Some("Too late"), None, 103),
        at(),
    ));
    assert_eq!(error.code, CoreErrorCode::NotFound);
    assert_eq!(
        error.message,
        "This session was removed, so it can't be renamed."
    );
}

#[test]
fn an_exact_retry_replays_even_when_typed_with_other_spacing() {
    let setup = Setup::new(&seed());
    let first = saved(
        setup
            .service()
            .execute(
                &owner(),
                &label(Some("Billing"), Some("Refunds"), 100),
                at(),
            )
            .unwrap(),
    );
    let revision = setup.read().revision;
    let replay = saved(
        setup
            .service()
            .execute(
                &owner(),
                &label(Some(" Billing "), Some("Refunds  "), 100),
                at(),
            )
            .unwrap(),
    );
    assert_eq!(replay, first);
    assert_eq!(setup.read().revision, revision);
    // The same operation with a different name is a reused operation id.
    assert!(setup
        .service()
        .execute(&owner(), &label(Some("Other"), Some("Refunds"), 100), at())
        .is_err());
}

#[test]
fn the_registry_scope_and_other_receipt_kinds_do_not_pass() {
    let setup = Setup::new(&seed());
    let registry = OwnerContext::from_trusted_entrypoint(OwnerScope::Registry);
    assert_eq!(
        refused(
            setup
                .service()
                .execute(&registry, &label(Some("Billing"), None, 100), at())
        )
        .code,
        CoreErrorCode::PermissionDenied
    );
    let route = SessionRef {
        project_id: id(1),
        session_id: id(2),
    };
    let request = OwnerMutationRequest {
        session: Some(route.clone()),
        command: label(Some("Billing"), None, 101),
    };
    request.validate_wire().unwrap();
    let mut no_route = request.clone();
    no_route.session = None;
    assert!(no_route.validate_wire().is_err());
    let receipt = saved(
        setup
            .service()
            .execute(&owner(), &request.command, at())
            .unwrap(),
    );
    service::validate_owner_receipt(
        &request,
        &MutationReceipt::Session(Box::new(receipt.clone())),
    )
    .unwrap();
    let mut wrong = receipt;
    wrong.data = SavedReceiptData::SessionLifecycle {
        state: SessionState::Closed,
        closed_at: None,
        archived_at: None,
        cancelled_input_ids: vec![],
    };
    assert!(
        service::validate_owner_receipt(&request, &MutationReceipt::Session(Box::new(wrong)))
            .is_err()
    );
    let too_long = OwnerMutationRequest {
        session: Some(route),
        command: label(Some(&"n".repeat(61)), None, 102),
    };
    assert!(too_long.validate_wire().is_err());
}
