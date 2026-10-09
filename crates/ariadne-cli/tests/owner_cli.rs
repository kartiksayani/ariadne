use ariadne_cli::owner;
use ariadne_core::{fake::*, native::NativeCoreService, *};
use ariadne_domain::models::*;
use ariadne_store::registry::Registry;
use serde_json::json;

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012}")).unwrap()
}
fn call(core: &dyn CoreService, args: &[&str], mut bytes: &[u8]) -> (i32, serde_json::Value) {
    let mut output = vec![];
    let mut errors = vec![];
    let exit = owner::run_with(
        core,
        &|route| {
            Ok(RegisteredSession::from_trusted_entrypoint(
                route.project_id.clone(),
                route.session_id.clone(),
            ))
        },
        args,
        &mut bytes,
        &mut output,
        &mut errors,
    );
    assert!(errors.is_empty());
    (exit, serde_json::from_slice(&output).unwrap())
}

#[test]
fn canonical_stdin_preserves_exact_command_and_stale_guards_for_core_replay() {
    let route = SessionRef {
        project_id: id(1),
        session_id: id(2),
    };
    let command = OwnerCommand::SessionClose {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(3),
        params: SessionLifecycleParams {
            expected_revision: PositiveSafeInteger::new(999).unwrap(),
        },
    };
    let receipt = MutationReceipt::Session(Box::new(SavedReceipt {
        operation_id: id(3),
        session_id: id(2),
        revision: PositiveSafeInteger::new(2).unwrap(),
        data: SavedReceiptData::SessionLifecycle {
            state: SessionState::Closed,
            closed_at: None,
            cancelled_input_ids: vec![],
        },
    }));
    let recorded = RecordedRequest::Owner(
        OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
            RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        )),
        Box::new(command.clone()),
    );
    let core = ScriptedCoreService::new([ScriptStep {
        request: recorded.clone(),
        response: ScriptedResponse::Owner(Box::new(Ok(receipt.clone()))),
    }]);
    let bytes = serde_json::to_vec(&OwnerMutationRequest {
        session: Some(route),
        command,
    })
    .unwrap();
    let (exit, result) = call(&core, &["session", "close", "--json-stdin"], &bytes);
    assert_eq!(exit, 0);
    assert_eq!(result["data"], serde_json::to_value(receipt).unwrap());
    assert_eq!(core.history().unwrap(), vec![recorded]);
    assert_eq!(core.remaining().unwrap(), 0);
}

#[test]
fn item_ack_preserves_its_canonical_owner_tag_and_revision_guard() {
    let command = OwnerCommand::Ack {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(30),
        params: ItemAckParams {
            item_id: ItemRef::new("1").unwrap(),
            expected_revision: PositiveSafeInteger::new(999).unwrap(),
        },
    };
    let receipt = MutationReceipt::Session(Box::new(SavedReceipt {
        operation_id: id(30),
        session_id: id(2),
        revision: PositiveSafeInteger::new(2).unwrap(),
        data: SavedReceiptData::ItemAck {
            item_id: ItemRef::new("1").unwrap(),
            item_revision: PositiveSafeInteger::new(1000).unwrap(),
            status: ItemStatus::Done,
            message_id: id(31),
        },
    }));
    let recorded = RecordedRequest::Owner(
        OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
            RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
        )),
        Box::new(command.clone()),
    );
    let core = ScriptedCoreService::new([ScriptStep {
        request: recorded.clone(),
        response: ScriptedResponse::Owner(Box::new(Ok(receipt.clone()))),
    }]);
    let bytes = serde_json::to_vec(&OwnerMutationRequest {
        session: Some(SessionRef {
            project_id: id(1),
            session_id: id(2),
        }),
        command,
    })
    .unwrap();
    let (exit, result) = call(&core, &["item", "ack", "--json-stdin"], &bytes);
    assert_eq!(exit, 0);
    assert_eq!(result["data"], serde_json::to_value(receipt).unwrap());
    assert_eq!(core.history().unwrap(), vec![recorded]);
    assert_eq!(core.remaining().unwrap(), 0);
    let (exit, _) = call(&core, &["item", "reveal", "--json-stdin"], &bytes);
    assert_eq!(exit, 2);
    assert_eq!(core.history().unwrap().len(), 1);
}

#[test]
fn tag_scope_unknown_fields_and_stdin_bounds_reject_before_any_core_call() {
    let core = ScriptedCoreService::new([]);
    let good = json!({"session":null,"request":{"command":"preferences_get","params":{}}});
    for (args,bytes) in [
        (vec!["project","list","--json-stdin"],serde_json::to_vec(&good).unwrap()),
        (vec!["preferences","get","--json-stdin"],br#"{"session":null,"request":{"command":"preferences_get","params":{}},"actor":"owner"}"#.to_vec()),
        (vec!["preferences","get","--json-stdin","--json-stdin"],serde_json::to_vec(&good).unwrap()),
        (vec!["preferences","get","--json-stdin","--generation","x"],serde_json::to_vec(&good).unwrap()),
        (vec!["preferences","get","--json-stdin"],vec![b' ';512*1024+1]),
        (vec!["session","get","--json-stdin"],serde_json::to_vec(&good).unwrap()),
    ] {
        let (exit,result) = call(&core,&args,&bytes);
        assert_ne!(exit,0);
        assert_eq!(result["ok"],false);
    }
    assert!(core.history().unwrap().is_empty());
}

#[test]
fn owner_lists_and_preferences_read_the_actual_native_service_without_provider_io() {
    let home = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    let core = NativeCoreService::new(
        registry,
        || id(100),
        || UtcMillis::new("2026-10-04T00:00:00.000Z").unwrap(),
        |_| panic!("read cannot qualify a host"),
    );
    for (args, kind) in [
        (vec!["project", "list", "--json"], "project_list"),
        (vec!["session", "list", "--json"], "session_list"),
        (vec!["preferences", "get", "--json"], "preferences_get"),
    ] {
        let (exit, result) = call(&core, &args, &[]);
        assert_eq!(exit, 0);
        assert_eq!(result["data"]["kind"], kind);
    }
    assert!(!home.path().join(".ariadne/ui.json").exists());
}

#[test]
fn explicit_route_must_match_native_membership_before_dispatch() {
    let core = ScriptedCoreService::new([]);
    let wrapper = json!({"session":{"project_id":id(1),"session_id":id(2)},
        "command":{"command":"session_close","api_version":1,"op_id":id(3),
        "params":{"expected_revision":1}}});
    let bytes = serde_json::to_vec(&wrapper).unwrap();
    let mut output = vec![];
    let mut errors = vec![];
    let exit = owner::run_with(
        &core,
        &|_| Ok(RegisteredSession::from_trusted_entrypoint(id(1), id(999))),
        &["session", "close", "--json-stdin"],
        &mut bytes.as_slice(),
        &mut output,
        &mut errors,
    );
    assert_eq!(exit, 3);
    assert!(errors.is_empty());
    let result: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(result["error"]["code"], "binding_mismatch");
    assert!(core.history().unwrap().is_empty());
}

#[test]
fn mismatched_core_receipt_is_not_printed_as_owner_success() {
    let command = OwnerCommand::SessionClose {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(3),
        params: SessionLifecycleParams {
            expected_revision: PositiveSafeInteger::new(1).unwrap(),
        },
    };
    let core = ScriptedCoreService::new([ScriptStep {
        request: RecordedRequest::Owner(
            OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
                RegisteredSession::from_trusted_entrypoint(id(1), id(2)),
            )),
            Box::new(command.clone()),
        ),
        response: ScriptedResponse::Owner(Box::new(Ok(MutationReceipt::Session(Box::new(
            SavedReceipt {
                operation_id: id(999),
                session_id: id(2),
                revision: PositiveSafeInteger::new(2).unwrap(),
                data: SavedReceiptData::SessionLifecycle {
                    state: SessionState::Closed,
                    closed_at: None,
                    cancelled_input_ids: vec![],
                },
            },
        ))))),
    }]);
    let bytes = serde_json::to_vec(&OwnerMutationRequest {
        session: Some(SessionRef {
            project_id: id(1),
            session_id: id(2),
        }),
        command,
    })
    .unwrap();
    let (exit, result) = call(&core, &["session", "close", "--json-stdin"], &bytes);
    assert_eq!(exit, 3);
    assert_eq!(result["error"]["code"], "protocol_conflict");
    assert_eq!(core.remaining().unwrap(), 0);
}

#[test]
fn bound_agent_item_flags_keep_the_original_agent_route() {
    assert!(!owner::handles(&[
        "item",
        "messages",
        "--binding",
        "B",
        "--generation",
        "G"
    ]));
    assert!(owner::handles(&["item", "messages", "--json-stdin"]));
    assert!(owner::handles(&["binding", "connect", "--json-stdin"]));
    assert!(owner::handles(&["remove", "item", "--json-stdin"]));
}

#[test]
fn remove_nouns_map_to_their_own_command_tags_only() {
    let core = ScriptedCoreService::new([]);
    let item = json!({"session":{"project_id":id(1),"session_id":id(2)},
        "command":{"command":"item_remove","api_version":1,"op_id":id(3),
        "params":{"item_id":"1","expected_revision":1}}});
    let project = json!({"session":null,
        "command":{"command":"project_remove","api_version":1,"op_id":id(3),
        "params":{"project_id":id(1)}}});
    for (args, wire) in [
        (vec!["remove", "topic", "--json-stdin"], &item),
        (vec!["remove", "session", "--json-stdin"], &project),
        (vec!["remove", "item", "--json"], &item),
        (vec!["remove", "everything", "--json-stdin"], &item),
    ] {
        let (exit, result) = call(&core, &args, &serde_json::to_vec(wire).unwrap());
        assert_eq!(exit, 2);
        assert_eq!(result["ok"], false);
    }
    assert!(core.history().unwrap().is_empty());
    let receipt = MutationReceipt::Removed(RemovedReceipt {
        operation_id: id(3),
        scope: RemovedScope::Project,
        project_id: id(1),
        session_ids: vec![id(2)],
        backup: "/data/backups/pre-remove-1-x".into(),
    });
    let core = ScriptedCoreService::new([ScriptStep {
        request: RecordedRequest::Owner(
            OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
            Box::new(serde_json::from_value(project["command"].clone()).unwrap()),
        ),
        response: ScriptedResponse::Owner(Box::new(Ok(receipt.clone()))),
    }]);
    let (exit, result) = call(
        &core,
        &["remove", "project", "--json-stdin"],
        &serde_json::to_vec(&project).unwrap(),
    );
    assert_eq!(exit, 0);
    assert_eq!(result["data"], serde_json::to_value(receipt).unwrap());
    assert_eq!(result["data"]["backup"], "/data/backups/pre-remove-1-x");
}

#[test]
fn saved_connect_instruction_routes_real_read_and_apply_processes() {
    use ariadne_agent_protocol::{Availability, Compatibility};
    use ariadne_core::bindings::{BindingService, VerifiedHost};
    use std::io::Write;
    use std::process::{Command, Stdio};

    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(home.path()).unwrap();
    registry.register(root.path(), &id(90), || id(1)).unwrap();
    let seed: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap();
    let binding = seed.bindings.0[&id(3)].clone();
    let command = OwnerCommand::BindingConnect {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(91),
        params: BindingConnectParams {
            project_id: id(1),
            adapter_id: binding.adapter_id.clone(),
            external_session_id: "explicit-test-thread".into(),
            endpoint: binding.endpoint.clone(),
            configuration: binding.adapter_config.clone(),
            existing_session_id: None,
        },
    };
    let mut next = 100;
    let receipt = BindingService::new(&registry)
        .connect(
            &OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
            &command,
            |params| {
                Ok(VerifiedHost {
                    adapter_id: params.adapter_id.clone(),
                    adapter_version: binding.adapter_version.clone(),
                    protocol_major: binding.protocol_major,
                    config_version: binding.config_version,
                    external_session_id: params.external_session_id.clone(),
                    endpoint: params.endpoint.clone(),
                    endpoint_fingerprint: binding.endpoint_fingerprint.clone(),
                    configuration: params.configuration.clone(),
                    capabilities: binding.capabilities.clone(),
                    compatibility: Compatibility::Compatible,
                    availability: Availability::Available,
                    connection_state: ConnectionState::Connected,
                    cli_invocation: "ariadne".into(),
                    host_location: None,
                    setup_instruction: "Exact verified prefix; no live provider is contacted."
                        .into(),
                })
            },
            || {
                next += 1;
                id(next)
            },
            UtcMillis::new("2026-10-04T00:00:00.000Z").unwrap(),
        )
        .unwrap();
    let MutationReceipt::Session(saved) = receipt else {
        panic!("connect receipt")
    };
    // Exact connect replay is installed CLI behavior and needs no desktop socket.
    let wrapper = OwnerMutationRequest {
        session: None,
        command: command.clone(),
    };
    let mut replay = Command::new(env!("CARGO_BIN_EXE_ariadne"))
        .args(["binding", "connect", "--json-stdin"])
        .env("ARIADNE_HOME", home.path().join(".ariadne"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    replay
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&wrapper).unwrap())
        .unwrap();
    let replay = replay.wait_with_output().unwrap();
    assert!(replay.status.success(), "{replay:?}");
    assert!(replay.stderr.is_empty());
    let actual: serde_json::Value = serde_json::from_slice(&replay.stdout).unwrap();
    assert_eq!(
        actual["data"],
        serde_json::to_value(MutationReceipt::Session(saved.clone())).unwrap()
    );
    let mut conflicting = wrapper.clone();
    if let OwnerCommand::BindingConnect { params, .. } = &mut conflicting.command {
        params.existing_session_id = Some(saved.session_id.clone());
    }
    let mut conflict = Command::new(env!("CARGO_BIN_EXE_ariadne"))
        .args(["binding", "connect", "--json-stdin"])
        .env("ARIADNE_HOME", home.path().join(".ariadne"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    conflict
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&conflicting).unwrap())
        .unwrap();
    let conflict = conflict.wait_with_output().unwrap();
    assert_eq!(conflict.status.code(), Some(3));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&conflict.stdout).unwrap()["error"]["code"],
        "operation_reused"
    );
    // A new operation uses the actual merged private relay; the test replaces
    // only provider verification while persisting through the real BindingService.
    use std::io::Read;
    use std::os::unix::{fs::PermissionsExt, net::UnixListener};
    let data = home.path().join(".ariadne");
    let desktop = ariadne_runtime::leases::DesktopOwner::acquire(&data).unwrap();
    let listener = UnixListener::bind(desktop.control_path()).unwrap();
    std::fs::set_permissions(
        desktop.control_path(),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let mut fresh = wrapper.clone();
    if let OwnerCommand::BindingConnect { op_id, params, .. } = &mut fresh.command {
        *op_id = id(94);
        params.external_session_id = "new-qualified-test-thread".into();
    }
    let expected = fresh.clone();
    let data_server = data.clone();
    let server = std::thread::spawn(move || {
        let _desktop = desktop;
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        let mut length = [0; 4];
        stream.read_exact(&mut length).unwrap();
        let mut bytes = vec![0; u32::from_be_bytes(length) as usize];
        stream.read_exact(&mut bytes).unwrap();
        let wire: ariadne_runtime::control::ControlRequest =
            serde_json::from_slice(&bytes).unwrap();
        wire.validate().unwrap();
        assert_eq!(wire.id, id(94));
        assert_eq!(
            wire.method,
            ariadne_runtime::control::ControlMethod::BindingConnect(Box::new(expected.clone()))
        );
        let registry = Registry::open_data_directory(&data_server).unwrap();
        let mut next = 200;
        let result = BindingService::new(&registry)
            .connect(
                &OwnerContext::from_trusted_entrypoint(OwnerScope::Registry),
                &expected.command,
                |params| {
                    Ok(VerifiedHost {
                        adapter_id: params.adapter_id.clone(),
                        adapter_version: binding.adapter_version.clone(),
                        protocol_major: binding.protocol_major,
                        config_version: binding.config_version,
                        external_session_id: params.external_session_id.clone(),
                        endpoint: params.endpoint.clone(),
                        endpoint_fingerprint: binding.endpoint_fingerprint.clone(),
                        configuration: params.configuration.clone(),
                        capabilities: binding.capabilities.clone(),
                        compatibility: Compatibility::Compatible,
                        availability: Availability::Available,
                        connection_state: ConnectionState::Connected,
                        cli_invocation: "ariadne".into(),
                        host_location: None,
                        setup_instruction: "Qualified test provider seam".into(),
                    })
                },
                || {
                    next += 1;
                    id(next)
                },
                UtcMillis::new("2026-10-04T00:00:00.000Z").unwrap(),
            )
            .unwrap();
        let bytes = serde_json::to_vec(&json!({"v":1,"kind":"response","id":wire.id,
            "result":ariadne_runtime::control::ControlResult::BindingConnect(result.clone())}))
        .unwrap();
        stream
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .unwrap();
        stream.write_all(&bytes).unwrap();
        result
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_ariadne"))
        .args(["binding", "connect", "--json-stdin"])
        .env("ARIADNE_HOME", &data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&fresh).unwrap())
        .unwrap();
    let actual = child.wait_with_output().unwrap();
    assert!(actual.status.success(), "{actual:?}");
    let result = server.join().unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&actual.stdout).unwrap()["data"],
        serde_json::to_value(result).unwrap()
    );
    let before: Vec<_> =
        std::fs::read_dir(data.join("projects").join(id(1).as_str()).join("sessions"))
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                (path.clone(), std::fs::read(path).unwrap())
            })
            .collect();
    let mut unavailable = fresh.clone();
    if let OwnerCommand::BindingConnect { op_id, .. } = &mut unavailable.command {
        *op_id = id(95);
    }
    let mut child = Command::new(env!("CARGO_BIN_EXE_ariadne"))
        .args(["binding", "connect", "--json-stdin"])
        .env("ARIADNE_HOME", &data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&unavailable).unwrap())
        .unwrap();
    let unavailable = child.wait_with_output().unwrap();
    assert!(!unavailable.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&unavailable.stdout).unwrap()["error"]["code"],
        "host_unreachable"
    );
    for (path, bytes) in before {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    let SavedReceiptData::BindingConnect {
        setup_instruction, ..
    } = &saved.data
    else {
        panic!("instruction")
    };
    let read = setup_instruction
        .lines()
        .find_map(|line| line.strip_prefix("Use ariadne read "))
        .unwrap()
        .trim_end_matches('.');
    let result = Command::new(env!("CARGO_BIN_EXE_ariadne"))
        .arg("read")
        .args(read.split_whitespace())
        .env("ARIADNE_HOME", home.path().join(".ariadne"))
        .output()
        .unwrap();
    assert!(result.status.success(), "{result:?}");
    assert!(result.stderr.is_empty());
    let value: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["ok"], true);
    let apply = setup_instruction
        .lines()
        .find_map(|line| line.strip_prefix("Publish full item replies with ariadne apply "))
        .unwrap()
        .split(". Use explicit")
        .next()
        .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_ariadne"))
        .arg("apply")
        .args(apply.split_whitespace())
        // The default receipt is compact; this test parses the saved receipt.
        .arg("--full")
        .env("ARIADNE_HOME", home.path().join(".ariadne"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let request = json!({"op_id":id(92),"source_input_id":null,"attempt_id":null,
        "expected_item_revisions":{},"expected_topic_revisions":{},"summary":"",
        "operations":[],"input_result":null});
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&request).unwrap())
        .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(result.status.success(), "{result:?}");
    assert!(result.stderr.is_empty());
    let applied: ApplyReceipt = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(applied.operation_id, id(92));
    assert_eq!(applied.session_id, saved.session_id);
}
