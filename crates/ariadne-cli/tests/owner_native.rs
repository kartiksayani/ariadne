use ariadne_core::{delivery::DeliveryService, *};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
};

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}
fn p(n: u64) -> PositiveSafeInteger {
    PositiveSafeInteger::new(n).unwrap()
}
fn at() -> UtcMillis {
    UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
}
fn seed() -> Session {
    serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json")).unwrap()
}
struct Setup {
    home: tempfile::TempDir,
    _root: tempfile::TempDir,
    registry: Registry,
}
impl Setup {
    fn new(session: &Session) -> Self {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(home.path()).unwrap();
        registry.register(root.path(), &id(99), || id(1)).unwrap();
        Store::open_registered(&registry.project_dir(&id(1)), id(1))
            .unwrap()
            .create(session)
            .unwrap();
        Self {
            home,
            _root: root,
            registry,
        }
    }
    fn store(&self) -> Store {
        Store::open_registered(&self.registry.project_dir(&id(1)), id(1)).unwrap()
    }
    fn bytes(&self, session: u64) -> Vec<u8> {
        fs::read(
            self.registry
                .project_dir(&id(1))
                .join(format!("sessions/{}.json", id(session).as_str())),
        )
        .unwrap()
    }
    fn call(&self, noun: &str, verb: &str, request: &impl Serialize) -> (i32, Value) {
        let mut child = Command::new(env!("CARGO_BIN_EXE_ariadne"))
            .args([noun, verb, "--json-stdin"])
            .env("ARIADNE_HOME", self.home.path().join(".ariadne"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(request).unwrap())
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(result.stderr.is_empty(), "{result:?}");
        (
            result.status.code().unwrap(),
            serde_json::from_slice(&result.stdout).unwrap(),
        )
    }
    fn mutation(
        &self,
        noun: &str,
        verb: &str,
        session: u64,
        command: OwnerCommand,
    ) -> (i32, Value) {
        self.call(
            noun,
            verb,
            &OwnerMutationRequest {
                session: Some(SessionRef {
                    project_id: id(1),
                    session_id: id(session),
                }),
                command,
            },
        )
    }
}

#[test]
fn installed_remove_commands_print_the_backup_and_replay_exact_retries() {
    let s = Setup::new(&seed());
    let mut second = seed();
    second.id = id(20);
    s.store().create(&second).unwrap();
    let version = || SchemaVersion::new(1).unwrap();
    let item = OwnerCommand::ItemRemove {
        api_version: version(),
        op_id: id(100),
        params: ItemRemoveParams {
            item_id: ItemRef::new("1").unwrap(),
            expected_revision: p(1),
        },
    };
    let (exit, saved) = s.mutation("remove", "item", 2, item.clone());
    assert_eq!(exit, 0, "{saved}");
    assert_eq!(saved["data"]["data"]["kind"], "removal");
    let backup = saved["data"]["data"]["backup"].as_str().unwrap();
    let mut earlier = vec![std::path::Path::new(backup).file_name().unwrap().to_owned()];
    assert!(
        std::path::Path::new(backup).starts_with(s.registry.project_dir(&id(1)).join("backups"))
    );
    assert!(backup.contains("/backups/pre-remove-"));
    assert!(fs::metadata(backup).unwrap().is_file());
    // The agent is told through a queued removal notice.
    let notice = saved["data"]["data"]["notice"]["id"].as_str().unwrap();
    let live = s.store().read(&id(2)).unwrap();
    assert_eq!(
        live.inputs.0[&UuidV4::new(notice).unwrap()].kind,
        InputKind::Removed
    );
    assert!(!live.items.0.contains_key(&ItemRef::new("1").unwrap()));
    let before = s.bytes(2);
    assert_eq!(s.mutation("remove", "item", 2, item), (0, saved));
    assert_eq!(s.bytes(2), before);

    // Session removal uses session:null and names its backup file.
    let session = OwnerCommand::SessionRemove {
        api_version: version(),
        op_id: id(101),
        params: SessionRemoveParams {
            project_id: id(1),
            session_id: id(20),
            expected_revision: p(1),
        },
    };
    let request = OwnerMutationRequest {
        session: None,
        command: session,
    };
    let (exit, removed) = s.call("remove", "session", &request);
    assert_eq!(exit, 0, "{removed}");
    assert_eq!(removed["data"]["scope"], "session");
    let session_backup = std::path::PathBuf::from(removed["data"]["backup"].as_str().unwrap());
    assert!(fs::metadata(&session_backup).unwrap().is_file());
    earlier.push(session_backup.file_name().unwrap().to_owned());
    assert_eq!(s.call("remove", "session", &request), (0, removed));
    // A session route is refused for session removal before any change.
    let routed = OwnerMutationRequest {
        session: Some(SessionRef {
            project_id: id(1),
            session_id: id(2),
        }),
        command: request.command.clone(),
    };
    assert_eq!(s.call("remove", "session", &routed).0, 2);

    // Project removal leaves the folder, drops the store and unregisters.
    fs::write(s._root.path().join("notes.txt"), "owner file").unwrap();
    let store = s.registry.project_dir(&id(1));
    let project = OwnerMutationRequest {
        session: None,
        command: OwnerCommand::ProjectRemove {
            api_version: version(),
            op_id: id(102),
            params: ProjectRemoveParams { project_id: id(1) },
        },
    };
    let (exit, removed) = s.call("remove", "project", &project);
    assert_eq!(exit, 0, "{removed}");
    assert_eq!(removed["data"]["scope"], "project");
    assert_eq!(removed["data"]["session_ids"], json!([id(2)]));
    let backup = std::path::PathBuf::from(removed["data"]["backup"].as_str().unwrap());
    assert!(backup.starts_with(fs::canonicalize(s.home.path().join(".ariadne/backups")).unwrap()));
    assert!(backup.join("removal.json").is_file());
    // Earlier item and session backups survive the store deletion.
    for name in &earlier {
        assert!(backup.join("backups").join(name).is_file());
    }
    assert!(!store.exists());
    assert!(s._root.path().join("notes.txt").is_file());
    assert!(s.registry.registered_projects().unwrap().is_empty());
}

#[test]
fn installed_lifecycle_commands_keep_history_and_exact_receipts_and_reopen_resumes() {
    let mut original = seed();
    for item in original.items.0.values_mut() {
        item.status = ItemStatus::Done;
        item.outcome = Some("Complete retained outcome".into());
        item.why = Some("Explicitly completed".into());
        item.replaced_by = None;
        item.waiting_since = None;
    }
    let binding = original.bindings.0.get_mut(&id(3)).unwrap();
    binding.dispatch_state = DispatchState::Paused;
    binding.owner_paused = true;
    let s = Setup::new(&original);
    let archive = OwnerCommand::TopicArchive {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(100),
        params: TopicLifecycleParams {
            topic_id: id(5),
            expected_revision: p(1),
        },
    };
    let (exit, saved) = s.mutation("topic", "archive", 2, archive.clone());
    assert_eq!(exit, 0);
    assert_eq!(saved["ok"], true);
    let close = OwnerCommand::SessionClose {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(101),
        params: SessionLifecycleParams {
            expected_revision: p(2),
        },
    };
    assert_eq!(s.mutation("session", "close", 2, close).0, 0);
    assert_eq!(s.store().read(&id(2)).unwrap().state, SessionState::Closed);
    let restore = OwnerCommand::TopicRestore {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(102),
        params: TopicLifecycleParams {
            topic_id: id(5),
            expected_revision: p(2),
        },
    };
    assert_eq!(s.mutation("topic", "restore", 2, restore).0, 0);
    let reopen = OwnerCommand::SessionReopen {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(103),
        params: SessionLifecycleParams {
            expected_revision: p(4),
        },
    };
    assert_eq!(s.mutation("session", "reopen", 2, reopen).0, 0);
    let before = s.bytes(2);
    assert_eq!(s.mutation("topic", "archive", 2, archive), (0, saved));
    assert_eq!(s.bytes(2), before);
    let live = s.store().read(&id(2)).unwrap();
    assert_eq!(live.state, SessionState::Active);
    assert_eq!(live.items, original.items);
    assert_eq!(live.messages, original.messages);
    // Reopen lifts the owner pause, including the one set before close.
    let mut resumed = original.bindings.clone();
    let binding = resumed.0.get_mut(&id(3)).unwrap();
    binding.owner_paused = false;
    binding.dispatch_state = DispatchState::Enabled;
    assert_eq!(live.bindings, resumed);
    let stale = OwnerCommand::SessionClose {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(104),
        params: SessionLifecycleParams {
            expected_revision: p(1),
        },
    };
    assert_eq!(
        s.mutation("session", "close", 2, stale).1["error"]["code"],
        "revision_conflict"
    );
    assert_eq!(s.bytes(2), before);
}

#[test]
fn installed_preview_and_continue_copy_full_history_once_and_replay_without_source() {
    let original = seed();
    let s = Setup::new(&original);
    let mut target = seed();
    target.id = id(20);
    s.store().create(&target).unwrap();
    let source = SessionRef {
        project_id: id(1),
        session_id: id(2),
    };
    let target = SessionRef {
        project_id: id(1),
        session_id: id(20),
    };
    let request = OwnerQueryRequest {
        session: None,
        request: QueryRequest::TopicContinuePreview(ContinuePreviewRequest {
            source: source.clone(),
            source_topic_id: id(5),
            target: target.clone(),
        }),
    };
    let source_bytes = s.bytes(2);
    let target_bytes = s.bytes(20);
    let (exit, result) = s.call("topic", "continue-preview", &request);
    assert_eq!(exit, 0, "{result}");
    let QueryResult::TopicContinuePreview(preview) =
        serde_json::from_value(result["data"].clone()).unwrap()
    else {
        panic!("preview")
    };
    assert_eq!(s.bytes(2), source_bytes);
    assert_eq!(s.bytes(20), target_bytes);
    let command = OwnerCommand::TopicContinue {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(200),
        params: TopicContinueParams {
            source,
            source_topic_id: id(5),
            source_revision: preview.source_revision,
            source_sha256: preview.source_sha256,
            target,
            target_binding_id: id(3),
            summary: preview.summary,
        },
    };
    let (exit, receipt) = s.mutation("topic", "continue", 20, command.clone());
    assert_eq!(exit, 0, "{receipt}");
    assert_eq!(s.bytes(2), source_bytes);
    let persisted = s.store().read(&id(20)).unwrap();
    assert_eq!(persisted.inputs.0.len(), 1);
    let input = persisted.inputs.0.values().next().unwrap();
    assert_eq!(input.kind, InputKind::Continue);
    assert_eq!(input.state, InputState::Queued);
    assert!(input.attempts.is_empty());
    let mapping = &persisted.continuations.0[&id(200)];
    for (source, copied) in &mapping.message_id_map.0 {
        let original = original.messages.iter().find(|m| &m.id == source).unwrap();
        let copied = persisted.messages.iter().find(|m| &m.id == copied).unwrap();
        assert_eq!(copied.body, original.body);
        assert_eq!(copied.author, original.author);
        assert!(copied.origin.is_some());
    }
    let after = s.bytes(20);
    fs::remove_file(
        s.registry
            .project_dir(&id(1))
            .join(format!("sessions/{}.json", id(2).as_str())),
    )
    .unwrap();
    assert_eq!(s.mutation("topic", "continue", 20, command), (0, receipt));
    assert_eq!(s.bytes(20), after);
    let query = OwnerQueryRequest {
        session: Some(SessionRef {
            project_id: id(1),
            session_id: id(20),
        }),
        request: QueryRequest::ItemMessages(ItemMessagesRequest {
            item_id: ItemRef::new("1").unwrap(),
            cursor: None,
            limit: PageLimit::new(20).unwrap(),
        }),
    };
    assert_eq!(s.call("item", "messages", &query).0, 0);
}

#[test]
fn installed_recovery_requires_new_attestation_preserves_attempt_and_resumes_dispatch() {
    let s = Setup::new(&seed());
    let command = OwnerCommand::InputSubmit {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(300),
        params: InputSubmitParams {
            binding_id: id(3),
            target: InputTarget {
                topic_id: id(5),
                item_id: Some(ItemRef::new("1").unwrap()),
            },
            kind: InputKind::Reply,
            text: "Original immutable owner action".into(),
            selected_option_id: None,
            expected_question_revision: None,
            supersedes_answer_id: None,
        },
    };
    assert_eq!(s.mutation("input", "submit", 2, command).0, 0);
    let route = RegisteredSession::from_trusted_entrypoint(id(1), id(2));
    let lease = ValidatedDispatchContext::from_trusted_current_lease(route, id(3), id(4));
    let mut next = 400;
    let prepared = DeliveryService::new(&s.registry)
        .claim(
            &lease,
            &ClaimRequest {
                binding_id: id(3),
                generation: id(4),
                request_id: id(301),
            },
            || {
                next += 1;
                id(next)
            },
            at(),
        )
        .unwrap()
        .unwrap();
    let original = s.store().read(&id(2)).unwrap();
    let mut request = OwnerCommand::InputResolve {
        api_version: SchemaVersion::new(1).unwrap(),
        op_id: id(302),
        params: InputResolveParams {
            input_id: prepared.input_id.clone(),
            attempt_id: prepared.attempt_id.clone(),
            decision: ResolutionKind::Resend,
            reason: "Owner reviewed the exact attempt and permits possible repeated work.".into(),
            expected_revision: original.revision,
            evidence: None,
        },
    };
    let bytes = s.bytes(2);
    assert_eq!(
        s.mutation("input", "resolve", 2, request.clone()).1["error"]["code"],
        "delivery_uncertain"
    );
    assert_eq!(s.bytes(2), bytes);
    let OwnerCommand::InputResolve { params, .. } = &mut request else {
        unreachable!()
    };
    params.evidence = Some(OwnerResolutionEvidence {
        source: OwnerEvidenceSource::OwnerAttestation,
        turn_state: TurnState::Unknown,
        host_turn_id: None,
        owner_attested_idle: true,
        at: at(),
    });
    let (exit, receipt) = s.mutation("input", "resolve", 2, request.clone());
    assert_eq!(exit, 0, "{receipt}");
    let saved = s.store().read(&id(2)).unwrap();
    let input = &saved.inputs.0[&prepared.input_id];
    let prior = &original.inputs.0[&prepared.input_id];
    assert_eq!(input.payload, prior.payload);
    assert_eq!(input.seq, prior.seq);
    assert_eq!(input.state, InputState::Queued);
    assert!(input.active_attempt_id.is_none());
    assert!(input.attempts[0].sealed_at.is_some());
    assert_eq!(input.attempts[0].turn_state, prior.attempts[0].turn_state);
    assert_eq!(input.resolution_history.len(), 1);
    // The saved decision is the owner's go-ahead: dispatch resumes on its own.
    assert!(!saved.bindings.0[&id(3)].owner_paused);
    assert_eq!(saved.bindings.0[&id(3)].pause_reason, None);
    assert_eq!(
        saved.bindings.0[&id(3)].dispatch_state,
        DispatchState::Enabled
    );
    let bytes = s.bytes(2);
    assert_eq!(s.mutation("input", "resolve", 2, request), (0, receipt));
    assert_eq!(s.bytes(2), bytes);
    assert_eq!(s.call("project", "list", &json!({"session":null,"request":{"command":"project_list","params":{"cursor":null,"limit":20}}})).0, 0);
}

#[test]
fn installed_project_setup_initializes_custom_data_but_read_does_not() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let data = home.path().join("custom-data");
    let call = |noun: &str, verb: &str, request: Value| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_ariadne"))
            .args([noun, verb, "--json-stdin"])
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
            .write_all(&serde_json::to_vec(&request).unwrap())
            .unwrap();
        child.wait_with_output().unwrap()
    };
    let read = json!({"session":null,"request":{"command":"project_list","params":{"cursor":null,"limit":20}}});
    let output = call("project", "list", read.clone());
    assert!(!output.status.success());
    assert!(!data.exists());
    let register = json!({"session":null,"command":{"api_version":1,"op_id":id(700),
        "command":"project_register","params":{"canonical_root":root.path().canonicalize().unwrap()}}});
    let output = call("project", "register", register.clone());
    assert!(output.status.success(), "{output:?}");
    let saved: Value = serde_json::from_slice(&output.stdout).unwrap();
    let replay = call("project", "register", register);
    assert!(replay.status.success(), "{replay:?}");
    assert_eq!(
        serde_json::from_slice::<Value>(&replay.stdout).unwrap(),
        saved
    );
    let output = call("project", "list", read);
    assert!(output.status.success(), "{output:?}");
    assert!(!data.join(".ariadne").exists());
}
