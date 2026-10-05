use super::Report;
use ariadne_adapter_claude::{ClaudeOptions, SUPPORTED_HOST_VERSION};
use ariadne_adapter_codex::{CodexDaemonReader, CodexOptions};
use ariadne_domain::models::*;
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

#[derive(Default)]
pub struct Options {
    pub project: Option<PathBuf>,
    pub claude_bin: Option<PathBuf>,
    pub codex_bin: Option<PathBuf>,
}

/// Trusted native caller supplies private roots; tests use private profiles only.
pub fn collect(data: &Path, version_root: Option<&Path>, options: &Options) -> Value {
    let mut report = Report::new();
    if let Some(version_root) = version_root {
        match crate::setup::owned::check(version_root) {
            Ok(facts) => {
                let changed = !facts["changed"].as_array().expect("changed").is_empty();
                let missing = !facts["missing"].as_array().expect("missing").is_empty();
                report.add(if changed { "error" } else if missing { "warning" } else { "ok" }, "installation.resource_parity", "Checked fixed integration bytes against this helper version.", "Install the matching selected resources; reload Claude after an upgrade. Matching files alone do not prove the Mod is loaded.", facts);
            }
            Err(error) => report.add(
                "warning",
                "installation.resources_unknown",
                "Integration resources or ownership could not be verified.",
                &error.hint,
                json!({"error_code":error.code}),
            ),
        }
    } else {
        report.add(
            "warning",
            "installation.unknown",
            "Matching personal installation was not verified.",
            "Install the matching app/helpers and run doctor from the installed CLI.",
            json!({}),
        );
    }
    let control_available = ariadne_runtime::control::control_path(data).is_ok();
    report.add(if control_available { "ok" } else { "warning" }, "control.socket", "Checked the fixed desktop socket type, owner, private permissions and path limit.", "Open the matching desktop for fresh binding status; socket presence alone does not prove claim readiness.", json!({"validated_socket":control_available,"dispatch_ready":false}));
    match Registry::inspect_data_directory(data) {
        Ok(catalogue) => {
            match (catalogue.diagnostic_routes(), Registry::inspect_binding_index(data)) {
                (Ok(Some(expected)), Ok(Some(actual))) => report.add(if expected == actual {"ok"} else {"warning"},"registry.binding_index", "Compared the retained routing index with complete validated authoritative observations.","A stale index requires an explicit owner rebuild; doctor never reconciles it or grants dispatch readiness.",json!({"state":if expected==actual {"matching"} else {"stale"},"authoritative_route_count":expected.len(),"index_route_count":actual.len(),"atomic_readiness_guarantee":false})),
                (Ok(Some(_)), Ok(None)) => report.add("warning","registry.binding_index","The rebuildable binding index is missing.","Use the explicit owner rebuild command if required; authoritative sessions and registrations are preserved.",json!({"state":"missing"})),
                (Err(_), _) => report.add("error","registry.route_conflict","Validated authoritative routes conflict.","Inspect registered roots and binding identities; no route is selected or rebuilt.",json!({"state":"conflict"})),
                _ => report.add("warning","registry.binding_index","Index parity is unknown because coordination or authoritative observations are incomplete.","Restore access or retry after the writer finishes; do not rebuild from a partial catalogue.",json!({"state":"unknown"})),
            }
            report.add("ok", "registry.valid", "Registered roots and schema were validated without rebuilding the binding index.", "Unavailable roots remain registered. Registration metadata alone does not qualify a binding.", json!({"revision":catalogue.revision,"registered_project_count":catalogue.projects.len()}));
            let selected = options.project.as_ref().and_then(|p| p.canonicalize().ok());
            if options.project.is_some() && selected.is_none() {
                report.add(
                    "error",
                    "project.unavailable",
                    "Cannot canonicalize the explicit project root.",
                    "Restore access to that exact root; no alternate project is selected.",
                    json!({}),
                );
            }
            if let Some(selected) = &selected {
                if !catalogue
                    .projects
                    .iter()
                    .any(|p| &p.registered.root == selected)
                {
                    report.add("error", "project.unregistered", "The explicit canonical project is not registered.", "Run setup --project with this exact root; no repository is inferred from cwd.", json!({"canonical_root":selected}));
                }
            }
            for project in catalogue.projects {
                if options.project.is_some() && selected.as_ref() != Some(&project.registered.root)
                {
                    continue;
                }
                let root = &project.registered.root;
                match project.result {
                    Ok(catalogue) => {
                        report.add("ok", "project.identity", "Canonical project identity and private metadata were verified.", "Project sessions and backups remain authoritative and are never repaired by doctor.", json!({"canonical_root":root,"project_id":catalogue.project.id}));
                        match catalogue.sessions {
                            Ok(sessions) => {
                                for read in sessions {
                                    match read.result {
                                        Ok(session) => {
                                            report.add("ok", "session.valid", "Session schema, identity and invariants passed canonical Store validation.", "Doctor only reports metadata; session bodies are omitted.", json!({"session_id":session.id,"revision":session.revision}));
                                            backup(&mut report, root, &session);
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
            report.add(status, "registry.unavailable", "Registry coordination or validated metadata is unavailable.", "Keep the existing files unchanged. Missing/busy locks leave state unknown; inspect access or retry after the current writer finishes.", json!({"cause":cause}));
        }
    }
    providers(&mut report, data, version_root, options);
    report.value()
}

fn store_class(error: &StoreError) -> (&'static str, &'static str) {
    match error {
        StoreError::FutureSchema => ("error", "future_schema"),
        StoreError::UnsafePath { .. } => ("error", "unsafe_path_or_permissions"),
        StoreError::Busy => ("warning", "coordination_busy"),
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
    report.add(status, &format!("{kind}.{cause}"), "Existing data could not be validated safely.", "Keep these files unchanged. Restore access or inspect the original data; future schemas remain read-only and no backup is restored automatically.", facts);
}

fn backup(report: &mut Report, root: &Path, session: &Session) {
    let result = (|| -> Result<bool, StoreError> {
        let data = OwnedDirectory::root(root)?.child(".ariadne", false)?;
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
            "Checked the previous snapshot when present; absence is normal for a new session.",
            "Backups are retained and never automatically restored.",
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
    report.add(if unresolved>0 || binding.dispatch_state==DispatchState::RecoveryRequired {"warning"} else {"ok"}, "binding.recovery", "Saved outbox and unresolved attempts were inspected without resending.", &format!("Open Ariadne and choose \"Review recovery\" for binding {} to inspect it; make an explicit owner recovery decision.",binding.id.as_str()), json!({"binding_id":binding.id,"generation":binding.generation,"adapter_id":binding.adapter_id,"external_session_id":"[redacted]","endpoint_fingerprint":"[redacted]","queued":queued,"claimed":claimed,"uncertain":uncertain,"missing_result":missing,"unresolved":unresolved,"owner_paused":binding.owner_paused,"dispatch_state":binding.dispatch_state,"existing_session_capability":binding.capabilities.existing_session.supported,"domain_cli_capability":binding.capabilities.domain_cli.supported,"dispatch_ready":false}));
    let mut fresh_native = false;
    if control_available {
        let request = UuidV4::new(uuid::Uuid::new_v4().to_string()).expect("native UUID");
        match crate::bridge::connection_status(data.into(), binding.id.clone(), binding.generation.clone(), request) {
            Ok(status) if status.id==binding.id && status.generation==binding.generation => {
                let fresh=status.presence.as_ref().is_some_and(|p| p.generation==binding.generation && p.freshness==Freshness::Fresh);
                fresh_native = fresh && status.connection_state == ConnectionState::Connected;
                report.add(if fresh {"ok"} else {"warning"},"binding.presence","Read the matching desktop's current native status without claiming input.","Unknown or stale evidence does not mean ready; refresh the original session and inspect its host approvals.",json!({"binding_id":binding.id,"connection_state":status.connection_state,"freshness":status.presence.as_ref().map(|p|&p.freshness),"last_seen_at":status.presence.as_ref().and_then(|p|p.last_seen_at.as_ref()),"dispatch_ready":false}));
            }
            _=> report.add("warning","binding.presence_unknown","Fresh matching native status is unavailable.","Open the matching desktop and refresh the original host connection; no input is resent.",json!({"binding_id":binding.id,"dispatch_ready":false})),
        }
    } else {
        report.add("warning","binding.presence_unknown","The desktop is unavailable; live binding status is unknown.","Open the matching desktop for current observations. Saved connection state is not a heartbeat.",json!({"binding_id":binding.id,"dispatch_ready":false}));
    }
    if binding.adapter_id == "claude_code_mod" {
        report.add(if fresh_native {"ok"} else {"warning"},"claude.loaded_gate","Loaded Mod compatibility is reported only through fresh matching native connection evidence.",if fresh_native {"Keep approvals explicit in the original Claude terminal; this observation grants no dispatch authority."} else {"Run /reload-plugins then /ariadne-connect; decide host trust explicitly in Claude."},json!({"binding_id":binding.id,"adapter_gate":if fresh_native {"native_qualified_fresh"} else {"unknown"},"dispatch_ready":false}));
    }
    if binding.adapter_id == "codex" {
        if let Some(executable) = &options.codex_bin {
            let result = CodexOptions::from_environment(executable.clone()).and_then(|opts| {
                let deadline = Instant::now() + Duration::from_secs(5);
                CodexDaemonReader::open_before(opts, binding.endpoint.clone(), deadline)?
                    .qualify_selected_thread(&binding.external_session_id, root, deadline)
            });
            match result {
                Ok(qualified)=>report.add("ok","codex.selected_thread","Read-only qualification verified the saved endpoint, exact thread and project.","Host approvals remain explicit; this observation grants no dispatch authority.",json!({"binding_id":binding.id,"host_version":qualified.facts().host_version,"compatibility":qualified.facts().compatibility,"availability":qualified.facts().availability,"dispatch_ready":false})),
                Err(error)=>report.add("warning","codex.thread_unknown","The saved exact Codex thread could not be qualified.","Keep this binding unchanged. Inspect the original thread with /status; never start or resume another thread as fallback.",json!({"binding_id":binding.id,"error_code":error.code,"dispatch_ready":false})),
            }
        }
    }
}

fn providers(report: &mut Report, data: &Path, version_root: Option<&Path>, options: &Options) {
    if let Some(executable) = &options.claude_bin {
        let options = ClaudeOptions {
            executable: executable.clone(),
            installed_plugin: version_root
                .unwrap_or(data)
                .join("integrations/claude-mod/plugin"),
            helper: version_root.unwrap_or(data).join("bin/ariadne"),
            project_root: data.into(),
            app_version: crate::setup::resources::VERSION.into(),
        };
        match options.read_host_version(Instant::now()+Duration::from_secs(5)) {
            Ok(version)=>report.add(if version==SUPPORTED_HOST_VERSION {"ok"} else {"warning"},"claude.version","Read the explicit Claude CLI version; version alone does not qualify its SDK/Mod.","Only Claude Code 2.1.287 is qualified; unknown versions require conformance and live existing-session acceptance.",json!({"detected_version":version,"supported_baseline":SUPPORTED_HOST_VERSION,"adapter_gate":"unknown","dispatch_ready":false})),
            Err(error)=>report.add("warning","claude.version_unknown","The explicit Claude version command could not be verified.","Check the selected absolute executable; doctor runs only --version with a bounded deadline.",json!({"error_code":error.code})),
        }
    } else {
        report.add(
            "warning",
            "claude.version_unknown",
            "No trusted Claude executable was selected.",
            "Pass --claude-bin /absolute/claude to inspect its version.",
            json!({"supported_baseline":SUPPORTED_HOST_VERSION}),
        );
    }
    if let Some(executable) = &options.codex_bin {
        match CodexOptions::from_environment(executable.clone()) {
            Ok(options)=>{
                let deadline=Instant::now()+Duration::from_secs(5);
                match options.read_host_version(deadline) {
                    Ok(version)=>{
                        let supported=version=="0.160.0";
                        report.add(if supported {"ok"} else {"warning"},"codex.version","Read the explicit Codex CLI version; version alone does not qualify its daemon/thread.","Only Codex 0.160.0 is qualified; keep unsupported versions unavailable until conformance/live acceptance.",json!({"detected_version":version,"supported_baseline":"0.160.0","dispatch_ready":false}));
                        if supported {
                            let handshake=options.default_endpoint().and_then(|endpoint|CodexDaemonReader::open_before(options,endpoint,deadline));
                            match handshake {
                                Ok(_)=>report.add("ok","codex.daemon","Read-only handshake verified the existing default daemon/socket identity and supported version pair.","Loaded-thread discovery remains an explicit owner selection; no provider session was started or resumed.",json!({"adapter_gate":"daemon_compatible","selected_thread_gate":"unknown","dispatch_ready":false})),
                                Err(error)=>report.add("warning","codex.daemon_unknown","The existing configured/default daemon is unavailable or incompatible.","Check CODEX_HOME and the already-running app-server endpoint. Use /status for manual thread selection; doctor does not start a daemon.",json!({"error_code":error.code,"dispatch_ready":false})),
                            }
                        }
                    }
                    Err(error)=>report.add("warning","codex.version_unknown","The explicit Codex version command could not be verified.","Check the absolute executable and original supported host installation.",json!({"error_code":error.code})),
                }
            }
            Err(error)=>report.add("warning","codex.configuration_unknown","Codex's explicit executable/default home configuration is unavailable.","Use an absolute executable and the documented CODEX_HOME/default home; credentials are never read.",json!({"error_code":error.code})),
        }
    } else {
        report.add(
            "warning",
            "codex.version_unknown",
            "No trusted Codex executable was selected.",
            "Pass --codex-bin /absolute/codex to inspect its existing daemon/version.",
            json!({"supported_baseline":"0.160.0"}),
        );
    }
}
