use super::Report;
use crate::setup::providers;
use ariadne_adapter_claude::{read_cli_version, SUPPORTED_HOST_VERSION};
use ariadne_adapter_codex::{CodexDaemonReader, CodexOptions, SUPPORTED_CODEX_VERSION};
use ariadne_agent_protocol::host_version::{
    accepted_range, classify_host_version, untested_notice, HostVersionStatus,
};
use ariadne_domain::models::*;
use ariadne_runtime::health::{read_health_file, HealthRead, SupervisorState, STALE_AFTER};
use ariadne_store::{
    registry::{Registry, RegistryError},
    session::{Store, StoreError},
    OwnedDirectory,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

fn host_version_state(status: Option<HostVersionStatus>) -> &'static str {
    match status {
        Some(HostVersionStatus::Qualified) => "qualified",
        Some(HostVersionStatus::Untested) => "untested",
        None => "unsupported",
    }
}

#[derive(Default)]
pub struct Options {
    pub project: Option<PathBuf>,
    pub claude_bin: Option<PathBuf>,
    pub codex_bin: Option<PathBuf>,
}

/// Trusted native caller supplies private roots; tests use private profiles only.
pub fn collect(data: &Path, version_root: Option<&Path>, options: &Options) -> Value {
    collect_for_display(data, version_root, options).0
}

pub(crate) fn collect_for_display(
    data: &Path,
    version_root: Option<&Path>,
    options: &Options,
) -> (Value, Vec<super::human::Session>) {
    let mut report = Report::new();
    let mut display_sessions = Vec::new();
    // Flags win; otherwise the paths setup recorded in providers.json are used.
    let recorded = providers::read(data);
    let recorded_codex = match &recorded {
        providers::Read::Present(file) => file.codex.as_ref().map(|c| c.executable.clone()),
        _ => None,
    };
    let options = &Options {
        project: options.project.clone(),
        claude_bin: options.claude_bin.clone(),
        codex_bin: options.codex_bin.clone().or(recorded_codex),
    };
    if let Some(version_root) = version_root {
        match crate::setup::owned::check(version_root) {
            Ok(facts) => {
                let changed = !facts["changed"].as_array().expect("changed").is_empty();
                let missing = !facts["missing"].as_array().expect("missing").is_empty();
                report.add(if changed { "error" } else if missing { "warning" } else { "ok" }, "installation.resource_parity", "Compared Ariadne's installed files with this version.", "If a file changed or is missing, run `ariadne setup` again, then run /reload-plugins in Claude. Matching files don't prove Claude has loaded the plugin.", facts);
            }
            Err(error) => report.add(
                "warning",
                "installation.resources_unknown",
                "Ariadne couldn't check its installed files.",
                &error.hint,
                json!({"error_code":error.code}),
            ),
        }
    } else {
        report.add(
            "warning",
            "installation.unknown",
            "Ariadne couldn't find its installed app and helpers.",
            "Install Ariadne, then run `ariadne doctor` from the installed command.",
            json!({}),
        );
    }
    let control_available = ariadne_runtime::control::control_path(data).is_ok();
    report.add(
        if control_available { "ok" } else { "warning" },
        "control.socket",
        if control_available {
            "The Ariadne app is listening for its helpers."
        } else {
            "The Ariadne app isn't listening. It may not be open."
        },
        "Open the Ariadne app to see live status. This check alone doesn't mean messages can be sent.",
        json!({"validated_socket":control_available,"dispatch_ready":false}),
    );
    supervisor_health(&mut report, data);
    match Registry::inspect_data_directory(data) {
        Ok(catalogue) => {
            match (catalogue.diagnostic_routes(), Registry::inspect_binding_index(data)) {
                (Ok(Some(expected)), Ok(Some(actual))) => report.add(if expected == actual {"ok"} else {"warning"},"registry.binding_index", if expected == actual {"The saved list of agent connections matches your sessions."} else {"The saved list of agent connections is out of date."},"Your sessions are safe; this list is only a shortcut. Doctor never rebuilds it, and it never makes an agent ready to receive messages.",json!({"state":if expected==actual {"matching"} else {"stale"},"authoritative_route_count":expected.len(),"index_route_count":actual.len(),"atomic_readiness_guarantee":false})),
                (Ok(Some(_)), Ok(None)) => report.add("warning","registry.binding_index","The saved list of agent connections is missing.","Your sessions and projects are safe; this list is only a shortcut. Doctor doesn't rebuild it.",json!({"state":"missing"})),
                (Err(_), _) => report.add("error","registry.route_conflict","Two sessions claim the same agent connection.","Check your projects and their agent connections. Ariadne won't pick one for you.",json!({"state":"conflict"})),
                _ => report.add("warning","registry.binding_index","Couldn't compare the saved list of agent connections, because some data was busy or unreadable.","Check you can read Ariadne's data folder, or wait for Ariadne to finish and run doctor again.",json!({"state":"unknown"})),
            }
            report.add("ok", "registry.valid", "Your list of projects is valid.", "A project whose folder is missing stays listed. Being listed doesn't mean an agent is connected.", json!({"revision":catalogue.revision,"registered_project_count":catalogue.projects.len()}));
            let selected = options.project.as_ref().and_then(|p| p.canonicalize().ok());
            if options.project.is_some() && selected.is_none() {
                report.add(
                    "error",
                    "project.unavailable",
                    "Couldn't open the project folder you named.",
                    "Check the folder exists and you can read it. Doctor doesn't pick another project.",
                    json!({}),
                );
            }
            if let Some(selected) = &selected {
                if !catalogue
                    .projects
                    .iter()
                    .any(|p| &p.registered.root == selected)
                {
                    report.add("error", "project.unregistered", "This project isn't registered with Ariadne.", "Run `ariadne setup --project <folder>` with this exact folder. Doctor doesn't guess the project from where you run it.", json!({"canonical_root":selected}));
                }
            }
            for project in catalogue.projects {
                if options.project.is_some() && selected.as_ref() != Some(&project.registered.root)
                {
                    continue;
                }
                let root = &project.registered.root;
                let store_dir = catalogue
                    .data
                    .join("projects")
                    .join(project.registered.project_id.as_str());
                if let Some(legacy) = ariadne_store::registry::legacy_store_path(root) {
                    report.add("warning", "store.legacy", "Unmigrated store at this path: the project still keeps Ariadne data inside its own folder. Moving it to Ariadne's data folder is pending, was blocked by a running Ariadne, or failed.", "Quit the Ariadne app and agent sessions, then open the project in the app or run any ariadne project command to move it. If that reports a conflict, compare the two folders by hand. Nothing is deleted automatically.", json!({"project_id":project.registered.project_id,"canonical_root":root,"legacy_path":legacy,"store_path":store_dir}));
                }
                let parked_copies = ariadne_store::registry::parked_legacy_paths(
                    &catalogue.data,
                    &project.registered.project_id,
                )
                .into_iter()
                .chain(ariadne_store::registry::parked_legacy_paths_in_root(root));
                for parked in parked_copies {
                    let shown = parked.display();
                    let differences =
                        ariadne_store::registry::parked_copy_differences(&parked, &store_dir);
                    let (message, hint) = match differences {
                        Ok(0) => (
                            format!("Parked copy at {shown} is identical to the store; safe to delete."),
                            "The data was moved and the old copy was set aside instead of deleted. Delete this folder when you no longer need it.".to_owned(),
                        ),
                        Ok(count) => (
                            format!("Parked copy at {shown} differs from the store ({count} files differ); keep it until you have checked."),
                            "Compare the parked copy with the store before deleting it. It may hold sessions the store lacks.".to_owned(),
                        ),
                        Err(error) => (
                            format!("Parked copy at {shown} could not be compared with the store ({error}); keep it until you have checked."),
                            "Compare the parked copy with the store by hand before deleting it.".to_owned(),
                        ),
                    };
                    report.add("warning", "store.legacy", &message, &hint, json!({"project_id":project.registered.project_id,"canonical_root":root,"parked_path":parked,"store_path":store_dir}));
                }
                match project.result {
                    Ok(project_catalogue) => {
                        report.add("ok", "project.identity", "Project details are valid.", "Doctor only reads your sessions and backups. It never changes them.", json!({"canonical_root":root,"project_id":project_catalogue.project.id,"store_path":store_dir}));
                        match project_catalogue.sessions {
                            Ok(sessions) => {
                                for read in sessions {
                                    match read.result {
                                        Ok(session) => {
                                            let first_check = report.checks.len();
                                            report.add("ok", "session.valid", "Session is valid.", "Doctor shows only counts and IDs, never message text.", json!({"session_id":session.id,"revision":session.revision}));
                                            backup(&mut report, &store_dir, &session);
                                            for binding in session.bindings.0.values() {
                                                binding_check(
                                                    &mut report,
                                                    data,
                                                    root,
                                                    &session,
                                                    binding,
                                                    options,
                                                    control_available,
                                                );
                                            }
                                            display_sessions.push(super::human::Session {
                                                name: session
                                                    .name
                                                    .as_deref()
                                                    .filter(|name| !name.trim().is_empty())
                                                    .unwrap_or(&session.title)
                                                    .to_owned(),
                                                checks: first_check..report.checks.len(),
                                                binding_ids: session
                                                    .bindings
                                                    .0
                                                    .keys()
                                                    .map(|id| id.as_str().to_owned())
                                                    .collect(),
                                                recovery_binding_ids: session
                                                    .inputs
                                                    .0
                                                    .values()
                                                    .filter(|input| {
                                                        input.state == InputState::NeedsAttention
                                                    })
                                                    .map(|input| {
                                                        input.binding_id.as_str().to_owned()
                                                    })
                                                    .collect(),
                                                active_binding_id: session
                                                    .active_binding_id
                                                    .as_ref()
                                                    .map(|id| id.as_str().to_owned()),
                                            });
                                        }
                                        Err(error) => store_error(
                                            &mut report,
                                            "session",
                                            &error,
                                            json!({"session_id":read.session_id}),
                                        ),
                                    }
                                }
                            }
                            Err(error) => {
                                store_error(&mut report, "session_catalogue", &error, json!({}))
                            }
                        }
                    }
                    Err(error) => store_error(
                        &mut report,
                        "project",
                        &error,
                        json!({"project_id":project.registered.project_id,"canonical_root":root}),
                    ),
                }
            }
        }
        // A brand-new install has no private data directory yet: only an explicit
        // project register or demo creates it, so "no data" is healthy here.
        Err(_)
            if matches!(
                std::fs::symlink_metadata(data),
                Err(ref e) if e.kind() == std::io::ErrorKind::NotFound
            ) =>
        {
            report.add(
                "ok",
                "registry.empty",
                "No sessions yet. Connect a session to get started.",
                "Nothing to repair: Ariadne creates its data on first project registration.",
                json!({"state":"no_data_yet"}),
            );
        }
        Err(error) => {
            let (status, cause) = match error {
                RegistryError::Store(ref e)
                | RegistryError::InvalidData { source: ref e, .. }
                | RegistryError::Unavailable { source: ref e, .. } => store_class(e),
                _ => ("error", "invalid_registry"),
            };
            report.add(status, "registry.unavailable", "Ariadne's list of projects couldn't be read.", "Leave the files as they are. Check you can read Ariadne's data folder, or wait for Ariadne to finish and run doctor again.", json!({"cause":cause}));
        }
    }
    providers_config(&mut report, &recorded);
    providers(&mut report, options);
    (report.value(), display_sessions)
}

/// Reads the health file the desktop rewrites every few seconds. Only Codex
/// connections appear in it; a Claude connection never has an entry.
fn supervisor_health(report: &mut Report, data: &Path) {
    const CODE: &str = "desktop.supervisor_health";
    let log = ariadne_runtime::logging::logs_dir(data).join(ariadne_runtime::logging::FILE_NAME);
    let file = match read_health_file(data) {
        HealthRead::Present(file) => file,
        HealthRead::Missing => {
            report.add(
                "warning",
                CODE,
                "The Ariadne app hasn't recorded how its agent connections are doing.",
                "Open the Ariadne app. While it runs, it updates this record every 15 seconds.",
                json!({"state":"missing"}),
            );
            return;
        }
        HealthRead::Unreadable => {
            report.add(
                "warning",
                CODE,
                "The Ariadne app's record of its agent connections couldn't be read.",
                "Open the Ariadne app again. It rewrites this record every 15 seconds.",
                json!({"state":"unreadable"}),
            );
            return;
        }
    };
    let age = chrono::DateTime::parse_from_rfc3339(file.written_at.as_str())
        .ok()
        .map(|at| {
            (chrono::Utc::now() - at.with_timezone(&chrono::Utc))
                .num_seconds()
                .max(0)
        });
    let Some(age) = age.filter(|age| *age <= STALE_AFTER.as_secs() as i64) else {
        report.add(
            "warning",
            CODE,
            "The Ariadne app isn't running, or it stopped updating its record.",
            "Open the Ariadne app. Until it runs, nothing is sent to Codex.",
            json!({"state":"stale","age_seconds":age,"written_at":file.written_at}),
        );
        return;
    };
    let mut troubled = 0;
    for health in &file.bindings {
        let reason = health
            .reason
            .as_deref()
            .map(|reason| bounded(reason, 512))
            .unwrap_or("No reason was recorded.");
        let (message, hint) = match health.state {
            SupervisorState::Running => continue,
            SupervisorState::BackingOff => (
                format!("A Codex connection is retrying. {reason}"),
                format!(
                    "Ariadne keeps trying on its own. Details are in {}.",
                    log.display()
                ),
            ),
            SupervisorState::Stopped => (
                format!("A Codex connection stopped. {reason}"),
                format!(
                    "Reconnect the conversation in Ariadne to start it again. Details are in {}.",
                    log.display()
                ),
            ),
        };
        troubled += 1;
        report.add("warning", CODE, &message, &hint, json!({"state":health.state,"binding_id":health.binding_id,"generation":health.generation,"retry_in_seconds":health.retry_in_seconds,"updated_at":health.updated_at}));
    }
    if troubled == 0 {
        report.add(
            "ok",
            CODE,
            "The Ariadne app is running, and every Codex connection it watches is working.",
            "Nothing to do.",
            json!({"state":"running","age_seconds":age,"codex_connections":file.bindings.len()}),
        );
    }
}

/// The health file is private to the owner, but its text is still bounded on display.
fn bounded(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn providers_config(report: &mut Report, recorded: &providers::Read) {
    // Claude needs no recorded path; only Codex's executable is recorded at setup.
    let hint = "Run `ariadne setup --agent codex` (or both) so the app can find Codex.";
    let file = match recorded {
        providers::Read::Present(file) => file,
        // Claude-only installs never need this file, so its absence is not a warning.
        providers::Read::Missing => {
            report.add(
                "ok",
                "providers.config",
                "No Codex path is recorded; Claude needs none. Record one only if you use Codex.",
                hint,
                json!({"state":"missing"}),
            );
            return;
        }
        providers::Read::Invalid => {
            report.add("warning", "providers.config", "The file that records where Codex is installed is damaged or unsafe, so it was ignored.", "Delete the file yourself, then run `ariadne setup --agent codex` (or both).", json!({"state":"invalid"}));
            return;
        }
    };
    let probe = |path: &Path| json!({"path":path,"exists":path.exists(),"executable":providers::is_executable_file(path)});
    let codex = file.codex.as_ref().map(|c| probe(&c.executable));
    let ok = codex.as_ref().is_some_and(|v| v["executable"] == true);
    report.add(
        if ok { "ok" } else { "warning" },
        "providers.config",
        if ok {
            "The recorded Codex path exists and can run."
        } else if codex.is_some() {
            "The recorded Codex path is missing or can't run."
        } else {
            "The providers file doesn't record any agent."
        },
        if ok {
            "The app reads this path when it starts. Reopen the app after changing it."
        } else {
            hint
        },
        json!({"state":"present","configured":{"codex":codex.is_some()},"codex":codex}),
    );
}

fn store_class(error: &StoreError) -> (&'static str, &'static str) {
    match error {
        StoreError::FutureSchema => ("error", "future_schema"),
        StoreError::UnsafePath { .. } => ("error", "unsafe_path_or_permissions"),
        StoreError::Busy => ("warning", "coordination_busy"),
        StoreError::Migration { .. } => ("warning", "migration_pending"),
        StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
            ..
        } => ("warning", "missing_coordination_or_data"),
        StoreError::Io { .. } => ("warning", "io_unavailable"),
        _ => ("error", "invalid_snapshot"),
    }
}
fn store_error(report: &mut Report, kind: &str, error: &StoreError, facts: Value) {
    let (status, cause) = store_class(error);
    report.add(status, &format!("{kind}.{cause}"), "Saved data couldn't be read safely.", "Leave these files as they are. Check folder access or try again later. Doctor never restores a backup, and data from a newer Ariadne stays read-only.", facts);
}

fn backup(report: &mut Report, store_dir: &Path, session: &Session) {
    let result = (|| -> Result<bool, StoreError> {
        let data = OwnedDirectory::existing(store_dir)?;
        let backups = match data.child("backups", false) {
            Ok(b) => b,
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
                ..
            }) => return Ok(false),
            Err(e) => return Err(e),
        };
        let name = format!("{}.previous.json", session.id.as_str());
        if !backups.verify_target(&name)? {
            return Ok(false);
        }
        let bytes = backups.read_bounded(&name, 16 * 1024 * 1024)?;
        Store::decode_diagnostic_snapshot(&bytes, &session.id, &session.project_id)?;
        Ok(true)
    })();
    match result {
        Ok(present) => report.add(
            "ok",
            "backup.health",
            "Checked the session's previous backup. A new session has none yet.",
            "Backups are kept and never restored automatically.",
            json!({"session_id":session.id,"previous_snapshot_present":present}),
        ),
        Err(error) => store_error(report, "backup", &error, json!({"session_id":session.id})),
    }
}

fn binding_check(
    report: &mut Report,
    data: &Path,
    root: &Path,
    session: &Session,
    binding: &Binding,
    options: &Options,
    control_available: bool,
) {
    let mut queued = 0;
    let mut claimed = 0;
    let mut uncertain = 0;
    let mut missing = 0;
    let mut unresolved = 0;
    for input in session
        .inputs
        .0
        .values()
        .filter(|i| i.binding_id == binding.id)
    {
        queued += usize::from(input.state == InputState::Queued);
        claimed += usize::from(input.state == InputState::InFlight);
        for attempt in input.attempts.iter().filter(|a| a.sealed_at.is_none()) {
            uncertain += usize::from(attempt.acceptance == AcceptanceState::Uncertain);
            missing += usize::from(attempt.result_state == ResultState::Missing);
            unresolved += 1;
        }
    }
    report.add(if unresolved>0 || binding.dispatch_state==DispatchState::RecoveryRequired {"warning"} else {"ok"}, "binding.recovery", "Checked messages waiting to send and earlier sends that aren't settled yet. Nothing was resent.", &format!("Open Ariadne and choose \"Review recovery\" for binding {} to check them and decide what to do.",binding.id.as_str()), json!({"binding_id":binding.id,"generation":binding.generation,"adapter_id":binding.adapter_id,"external_session_id":"[redacted]","endpoint_fingerprint":"[redacted]","queued":queued,"claimed":claimed,"uncertain":uncertain,"missing_result":missing,"unresolved":unresolved,"owner_paused":binding.owner_paused,"dispatch_state":binding.dispatch_state,"existing_session_capability":binding.capabilities.existing_session.supported,"domain_cli_capability":binding.capabilities.domain_cli.supported,"dispatch_ready":false}));
    let mut fresh_native = false;
    if control_available {
        let request = UuidV4::new(uuid::Uuid::new_v4().to_string()).expect("native UUID");
        match crate::bridge::connection_status(data.into(), binding.id.clone(), binding.generation.clone(), request) {
            Ok(status) if status.id==binding.id && status.generation==binding.generation => {
                let fresh=status.presence.as_ref().is_some_and(|p| p.generation==binding.generation && p.freshness==Freshness::Fresh);
                fresh_native = fresh && status.connection_state == ConnectionState::Connected;
                report.add(if fresh {"ok"} else {"warning"},"binding.presence",if fresh {"The Ariadne app recently heard from this agent."} else {"The Ariadne app hasn't heard from this agent recently."},"If it isn't recent, reconnect from the agent's terminal and check whether the agent is waiting for an approval. Nothing is resent.",json!({"binding_id":binding.id,"connection_state":status.connection_state,"freshness":status.presence.as_ref().map(|p|&p.freshness),"last_seen_at":status.presence.as_ref().and_then(|p|p.last_seen_at.as_ref()),"dispatch_ready":false}));
            }
            _=> report.add("warning","binding.presence_unknown","The Ariadne app didn't report this connection's live status.","Open the Ariadne app and reconnect the agent from its terminal. Nothing is resent.",json!({"binding_id":binding.id,"dispatch_ready":false})),
        }
    } else {
        report.add(
            "warning",
            "binding.presence_unknown",
            "The Ariadne app isn't running, so this connection's live status is unknown.",
            "Open the Ariadne app to see it. The saved status may be out of date.",
            json!({"binding_id":binding.id,"dispatch_ready":false}),
        );
    }
    if binding.adapter_id == "claude_code_mod" {
        report.add(if fresh_native {"ok"} else {"warning"},"claude.loaded_gate",if fresh_native {"Claude has Ariadne's plugin loaded and is connected."} else {"Ariadne can't tell whether Claude has its plugin loaded."},if fresh_native {"Approve actions in Claude's own terminal as usual."} else {"In Claude, run /reload-plugins and then /ariadne-connect. Approve actions in Claude as usual."},json!({"binding_id":binding.id,"adapter_gate":if fresh_native {"native_qualified_fresh"} else {"unknown"},"dispatch_ready":false}));
    }
    if binding.adapter_id == "codex" {
        if let Some(executable) = &options.codex_bin {
            let thread = binding.external_session_id.as_str();
            let result = CodexOptions::from_environment(executable.clone()).and_then(|opts| {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut reader =
                    CodexDaemonReader::open_before(opts, binding.endpoint.clone(), deadline)?;
                if !reader.selected_thread_loaded(thread, deadline)? {
                    return Ok(None);
                }
                reader
                    .qualify_selected_thread(thread, root, deadline)
                    .map(Some)
            });
            match result {
                Ok(Some(qualified))=>report.add("ok","codex.selected_thread","Codex has this conversation open in the right project.","Approve actions in Codex as usual.",json!({"binding_id":binding.id,"host_version":qualified.facts().host_version,"compatibility":qualified.facts().compatibility,"availability":qualified.facts().availability,"dispatch_ready":false})),
                Ok(None)=>{
                    let remote = match &binding.endpoint {
                        EndpointRef::UnixSocket { path } => format!("`--remote unix://{path}`"),
                        _ => "the `--remote` option".to_owned(),
                    };
                    report.add("warning","codex.thread_not_loaded","Codex isn't sharing this conversation with Ariadne, so messages can't reach it.",&format!("Quit Codex in its terminal. Start it again with {remote} and reopen this conversation."),json!({"binding_id":binding.id,"dispatch_ready":false}));
                }
                Err(error)=>report.add("warning","codex.thread_unknown","Couldn't check this Codex conversation.","Leave the connection as it is. In Codex, run /status to check the conversation. Ariadne never starts another conversation in its place.",json!({"binding_id":binding.id,"error_code":error.code,"dispatch_ready":false})),
            }
        }
    }
}

fn providers(report: &mut Report, options: &Options) {
    if let Some(executable) = &options.claude_bin {
        match read_cli_version(executable, Instant::now() + Duration::from_secs(5)) {
            Ok(version) => {
                let status = classify_host_version(SUPPORTED_HOST_VERSION, &version);
                let message=match status {
                    Some(HostVersionStatus::Untested)=>untested_notice("Claude Code",&version,SUPPORTED_HOST_VERSION),
                    _=>"Read Claude's version. The version alone doesn't show the plugin is loaded.".to_owned(),
                };
                let next=match status {
                    Some(_)=>"Claude Code 2.1.287 is the tested version and the oldest one Ariadne supports. Newer versions should work but are untested.".to_owned(),
                    None=>format!("Ariadne requires Claude Code {}; update Claude Code.",accepted_range(SUPPORTED_HOST_VERSION)),
                };
                report.add(if status==Some(HostVersionStatus::Qualified) {"ok"} else {"warning"},"claude.version",&message,&next,json!({"detected_version":version,"supported_baseline":SUPPORTED_HOST_VERSION,"host_version_status":host_version_state(status),"adapter_gate":"unknown","dispatch_ready":false}));
            }
            Err(error) => report.add(
                "warning",
                "claude.version_unknown",
                "Couldn't read Claude's version.",
                "Check the path you gave with --claude-bin. Doctor only runs `claude --version`.",
                json!({"error_code":error.code}),
            ),
        }
    } else {
        report.add(
            "warning",
            "claude.version_unknown",
            "No Claude path was given, so its version wasn't checked.",
            "Pass --claude-bin with Claude's full path to check its version.",
            json!({"supported_baseline":SUPPORTED_HOST_VERSION}),
        );
    }
    if let Some(executable) = &options.codex_bin {
        match CodexOptions::from_environment(executable.clone()) {
            Ok(options)=>{
                let deadline=Instant::now()+Duration::from_secs(5);
                match options.read_host_version(deadline) {
                    Ok(version)=>{
                        let status=classify_host_version(SUPPORTED_CODEX_VERSION,&version);
                        let supported=status.is_some();
                        let message=match status {
                            Some(HostVersionStatus::Untested)=>untested_notice("Codex",&version,SUPPORTED_CODEX_VERSION),
                            _=>"Read Codex's version. The version alone doesn't show a conversation is reachable.".to_owned(),
                        };
                        let next=match status {
                            Some(_)=>"Codex 0.160.0 is the tested version and the oldest one Ariadne supports. Newer versions should work but are untested.".to_owned(),
                            None=>format!("Ariadne requires Codex {}; update Codex.",accepted_range(SUPPORTED_CODEX_VERSION)),
                        };
                        report.add(if status==Some(HostVersionStatus::Qualified) {"ok"} else {"warning"},"codex.version",&message,&next,json!({"detected_version":version,"supported_baseline":SUPPORTED_CODEX_VERSION,"host_version_status":host_version_state(status),"dispatch_ready":false}));
                        if supported {
                            let handshake=options.default_endpoint().and_then(|endpoint|CodexDaemonReader::open_before(options,endpoint,deadline));
                            match handshake {
                                Ok(_)=>report.add("ok","codex.daemon","Reached the running Codex app-server, and its version is supported.","Pick the conversation to connect in Ariadne. Doctor didn't start or resume anything.",json!({"adapter_gate":"daemon_compatible","selected_thread_gate":"unknown","dispatch_ready":false})),
                                Err(error)=>report.add("warning","codex.daemon_unknown","Couldn't reach a running Codex app-server, or its version isn't supported.","Start the Codex app-server, and check CODEX_HOME if you set it. Doctor doesn't start it for you.",json!({"error_code":error.code,"dispatch_ready":false})),
                            }
                        }
                    }
                    Err(error)=>report.add("warning","codex.version_unknown","Couldn't read Codex's version.","Check the Codex path and that this Codex install works.",json!({"error_code":error.code})),
                }
            }
            Err(error)=>report.add("warning","codex.configuration_unknown","Couldn't find the Codex program or its settings folder.","Use Codex's full path, and check CODEX_HOME if you set it. Doctor never reads your login details.",json!({"error_code":error.code})),
        }
    } else {
        report.add(
            "warning",
            "codex.version_unknown",
            "No Codex path is known, so Codex wasn't checked.",
            "Run `ariadne setup --agent codex`, or pass --codex-bin with Codex's full path.",
            json!({"supported_baseline":SUPPORTED_CODEX_VERSION}),
        );
    }
}
