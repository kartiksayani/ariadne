use ariadne_agent_protocol::{Availability, Compatibility};
use ariadne_core::{bindings::VerifiedHost, native::NativeCoreService, *};
use ariadne_domain::models::*;
use ariadne_store::registry::{Registry, RegistryError};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn owner() -> OwnerContext {
    OwnerContext::from_trusted_entrypoint(OwnerScope::Registry)
}
fn setup() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    Arc<NativeCoreService>,
    OwnerCommand,
) {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let ids = Arc::new(AtomicU64::new(100));
    let core = Arc::new(NativeCoreService::new(
        Registry::open(home.path()).unwrap(),
        move || id(ids.fetch_add(1, Ordering::SeqCst)),
        at,
        |_| panic!("request-local verifier required"),
    ));
    let MutationReceipt::ProjectRegistered(project) = core
        .execute_owner(
            owner(),
            OwnerCommand::ProjectRegister {
                api_version: SchemaVersion::new(1).unwrap(),
                op_id: id(1),
                params: ProjectRegisterParams {
                    canonical_root: root.path().canonicalize().unwrap().to_str().unwrap().into(),
                },
            },
        )
        .unwrap()
    else {
        panic!()
    };
    let command = OwnerCommand::BindingConnect {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(2),
        params: BindingConnectParams {
            project_id: project.project_id,
            adapter_id: "test.native".into(),
            external_session_id: "chosen-thread".into(),
            endpoint: EndpointRef::LocalBridge {
                name: "fixture".into(),
            },
            configuration: AdapterConfig {
                namespace: "test.native".into(),
                values: UniqueMap(Default::default()),
            },
            existing_session_id: None,
        },
    };
    (home, root, core, command)
}
fn host(params: &BindingConnectParams) -> VerifiedHost {
    let session: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json")).unwrap();
    VerifiedHost {
        adapter_id: params.adapter_id.clone(),
        adapter_version: "fixture".into(),
        protocol_major: PositiveSafeInteger::new(1).unwrap(),
        config_version: PositiveSafeInteger::new(1).unwrap(),
        external_session_id: params.external_session_id.clone(),
        endpoint: params.endpoint.clone(),
        endpoint_fingerprint: EndpointFingerprint("fixture/native".into()),
        configuration: params.configuration.clone(),
        capabilities: session
            .bindings
            .0
            .values()
            .next()
            .unwrap()
            .capabilities
            .clone(),
        compatibility: Compatibility::Compatible,
        availability: Availability::Available,
        connection_state: ConnectionState::Unknown,
        setup_instruction: "fixture instructions".into(),
    }
}
#[test]
fn exact_replay_precedes_expired_deadline_and_never_rechecks_provider() {
    let (_home, _root, core, command) = setup();
    let saved = core
        .connect_before(
            owner(),
            command.clone(),
            Instant::now() + Duration::from_secs(2),
            |params, _| Ok(host(params)),
        )
        .unwrap();
    assert_eq!(
        core.connect_before(
            owner(),
            command.clone(),
            Instant::now() - Duration::from_secs(1),
            |_, _| panic!("exact replay must not verify")
        )
        .unwrap(),
        saved
    );
    let mut changed = command;
    let OwnerCommand::BindingConnect { params, .. } = &mut changed else {
        panic!()
    };
    params.existing_session_id = match &saved {
        MutationReceipt::Session(saved) => Some(saved.session_id.clone()),
        _ => panic!(),
    };
    params.external_session_id = "different-thread".into();
    assert_eq!(
        core.connect_before(
            owner(),
            changed,
            Instant::now() - Duration::from_secs(1),
            |_, _| panic!("conflicting receipt must not verify")
        )
        .unwrap_err()
        .code,
        CoreErrorCode::OperationReused
    );
}
#[test]
fn expired_fresh_work_cannot_persist_after_waiting_for_registry_lock() {
    let (_home, _root, core, command) = setup();
    let deadline = Instant::now() + Duration::from_millis(200);
    let (go, await_go) = mpsc::channel();
    let (held, await_held) = mpsc::channel();
    let locked = core.clone();
    let worker = std::thread::spawn(move || {
        await_go.recv().unwrap();
        locked
            .registry()
            .with_binding_setup::<_, RegistryError>(|_| {
                held.send(()).unwrap();
                std::thread::sleep(
                    deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(30),
                );
                Ok(())
            })
            .unwrap();
    });
    let error = core
        .connect_before(owner(), command, deadline, |params, _| {
            go.send(()).unwrap();
            await_held.recv().unwrap();
            Ok(host(params))
        })
        .unwrap_err();
    worker.join().unwrap();
    assert_eq!(error.code, CoreErrorCode::HostUnreachable);
    assert!(core.registry().catalogue().unwrap().projects[0]
        .result
        .as_ref()
        .unwrap()
        .sessions
        .as_ref()
        .unwrap()
        .is_empty());
}

#[test]
fn post_io_committed_replay_wins_over_original_deadline_expiry() {
    let (_home, _root, core, command) = setup();
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut committed = None;
    let result = core
        .connect_before(owner(), command.clone(), deadline, |params, _| {
            committed = Some(
                core.connect_before(owner(), command.clone(), deadline, |params, _| {
                    Ok(host(params))
                })
                .unwrap(),
            );
            std::thread::sleep(
                deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(10),
            );
            Ok(host(params))
        })
        .unwrap();
    assert_eq!(Some(result), committed);
}
