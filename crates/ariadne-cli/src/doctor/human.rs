use serde_json::Value;
use std::{fmt::Write, ops::Range};

pub(crate) struct Session {
    pub name: String,
    pub checks: Range<usize>,
    pub binding_ids: Vec<String>,
    pub active_binding_id: Option<String>,
    pub recovery_binding_ids: Vec<String>,
}

#[derive(PartialEq)]
enum Connection {
    Connected,
    NotConnected,
    Unknown,
}

fn connection(session: &Session, checks: &[Value]) -> Connection {
    let Some(active) = session.active_binding_id.as_deref() else {
        return Connection::NotConnected;
    };
    for check in &checks[session.checks.clone()] {
        if check["code"] != "binding.presence"
            || check["facts"]["binding_id"].as_str() != Some(active)
        {
            continue;
        }
        let facts = &check["facts"];
        if check["status"] == "ok"
            && facts["connection_state"] == "connected"
            && facts["freshness"] == "fresh"
        {
            return Connection::Connected;
        }
        if facts["connection_state"] == "disconnected"
            || facts["connection_state"] == "reconnecting"
        {
            return Connection::NotConnected;
        }
        return Connection::Unknown;
    }
    if checks.iter().any(|check| {
        check["code"] == "control.socket" && check["facts"]["validated_socket"] == true
    }) {
        Connection::Unknown
    } else {
        Connection::NotConnected
    }
}

fn issue(check: &Value, needs_review: bool) -> Option<String> {
    let status = check["status"].as_str()?;
    if status != "warning" && status != "error" {
        return None;
    }
    if note(check).is_some() {
        return None;
    }
    let code = check["code"].as_str()?;
    let facts = &check["facts"];
    let text = match code {
        // These observations don't establish a connection, but need no repair.
        "binding.presence" | "binding.presence_unknown" | "claude.loaded_gate" | "control.socket" => return None,
        "claude.version_unknown" | "codex.version_unknown" if facts["error_code"].is_null() => return None,
        "desktop.supervisor_health" if facts["state"] == "missing" || facts["state"] == "stale" => return None,
        "codex.daemon_unknown" | "codex.thread_unknown" if facts["error_code"] == "host_unreachable" => return None,
        "binding.recovery" if !needs_review && facts["uncertain"] == 0 && facts["missing_result"] == 0 && facts["dispatch_state"] != "recovery_required" => return None,
        "project.unregistered" => "This project hasn't been added to Ariadne. Run `ariadne setup --project <folder>` with its folder.".to_owned(),
        "installation.resources_unknown" => "Ariadne couldn't check its installed files. Install the matching Ariadne package again.".to_owned(),
        "codex.daemon_unknown" | "codex.thread_unknown" if facts["error_code"] == "unsupported_host_version" => "This Codex version isn't supported. Update Codex, then reopen it and reconnect in Ariadne.".to_owned(),
        "codex.daemon_unknown" | "codex.thread_unknown" if facts["error_code"] == "permission_denied" => "Ariadne couldn't access Codex's connection. Check folder access, then reconnect in Ariadne.".to_owned(),
        "codex.thread_unknown" => "Couldn't check this Codex conversation. Run /status in Codex, then reconnect the conversation in Ariadne.".to_owned(),
        "codex.daemon_unknown" => "Couldn't check Codex's connection. Check Codex in its terminal, then reopen it and reconnect in Ariadne.".to_owned(),
        "codex.thread_not_loaded" => "Codex isn't sharing this conversation. Quit Codex, start it with --remote, and reopen the conversation. Run `ariadne doctor --verbose` for the full command.".to_owned(),
        "binding.recovery" => "Earlier messages need your review. Open this session in Ariadne and choose \"Review recovery\".".to_owned(),
        "installation.resource_parity" => "Some Ariadne files are missing or changed. Run `ariadne setup`, then /reload-plugins in Claude.".to_owned(),
        "registry.binding_index" if facts["state"] == "missing" || facts["state"] == "stale" => "The saved list of agent connections needs updating. Open Ariadne again, then run `ariadne doctor`.".to_owned(),
        "desktop.supervisor_health" if facts["state"] == "stopped" => "The Codex connection stopped. Reconnect this conversation in Ariadne.".to_owned(),
        "desktop.supervisor_health" if facts["state"] == "backing_off" => "The Codex connection is retrying. Check Codex in its terminal; if this continues, reconnect in Ariadne.".to_owned(),
        _ if code.ends_with(".future_schema") => "This data was saved by a newer Ariadne version. Install that version to read it.".to_owned(),
        _ => format!("{} {}", check["message"].as_str()?, check["hint"].as_str()?),
    };
    Some(format!(
        "{}: {}",
        if status == "error" {
            "Error"
        } else {
            "Warning"
        },
        plain(&text)
    ))
}

fn note(check: &Value) -> Option<String> {
    if check["status"] != "warning" {
        return None;
    }
    let code = check["code"].as_str()?;
    let message = check["message"].as_str()?;
    if matches!(code, "claude.version" | "codex.version")
        && check["facts"]["host_version_status"] == "untested"
        || code == "store.legacy" && message.ends_with("identical to the store; safe to delete.")
    {
        Some(format!("Note: {}", plain(message)))
    } else {
        None
    }
}

// Names, paths and diagnostic hints can contain IDs or line breaks too.
fn plain(text: &str) -> String {
    let mut result = String::new();
    let mut rest = text;
    while !rest.is_empty() {
        if rest.len() >= 36
            && rest.is_char_boundary(36)
            && uuid::Uuid::parse_str(&rest[..36]).is_ok()
        {
            result.push_str("[hidden]");
            rest = &rest[36..];
        } else {
            let ch = rest.chars().next().expect("nonempty text");
            result.push(if ch.is_control() { ' ' } else { ch });
            rest = &rest[ch.len_utf8()..];
        }
    }
    result
}

pub(super) fn render(report: &Value, sessions: &[Session], summary: bool) -> String {
    let checks = report["checks"].as_array().expect("report checks");
    let projects = checks
        .iter()
        .filter(|check| check["code"] == "project.identity")
        .count();
    let connected_count = sessions
        .iter()
        .filter(|session| connection(session, checks) == Connection::Connected)
        .count();
    let unknown_count = sessions
        .iter()
        .filter(|session| connection(session, checks) == Connection::Unknown)
        .count();
    let unreadable = checks.iter().any(|check| {
        let code = check["code"].as_str().unwrap_or_default();
        code == "registry.unavailable"
            || code.starts_with("project.") && code != "project.identity"
            || code.starts_with("session.") && code != "session.valid"
            || code.starts_with("session_catalogue.")
    });
    let counts = if unreadable && sessions.is_empty() {
        "Session counts are unavailable".to_owned()
    } else {
        format!(
            "{}{} {} in {} {}",
            if unreadable { "At least " } else { "" },
            sessions.len(),
            if sessions.len() == 1 {
                "session"
            } else {
                "sessions"
            },
            projects,
            if projects == 1 { "project" } else { "projects" }
        )
    };
    let mut result = format!(
        "{counts}; {}.\n",
        if unknown_count > 0 {
            format!("{connected_count} connections confirmed; live status unavailable for {unknown_count}")
        } else if connected_count == 0 {
            "none connected right now".to_owned()
        } else {
            format!("{connected_count} connected right now")
        }
    );
    let mut names: Vec<String> = sessions
        .iter()
        .map(|session| plain(&session.name))
        .collect();
    for index in (0..names.len()).rev() {
        let occurrence = names[..=index]
            .iter()
            .filter(|name| **name == names[index])
            .count();
        if occurrence > 1 {
            let mut suffix = occurrence;
            let mut name = format!("{} ({suffix})", names[index]);
            while names.contains(&name) {
                suffix += 1;
                name = format!("{} ({suffix})", names[index]);
            }
            names[index] = name;
        }
    }
    let mut notes = Vec::new();
    let mut global = Vec::new();
    let mut grouped = vec![Vec::new(); sessions.len()];
    for (index, check) in checks.iter().enumerate() {
        if let Some(note) = note(check) {
            if !notes.contains(&note) {
                notes.push(note);
            }
        }
        let group = sessions.iter().position(|session| {
            session.checks.contains(&index)
                || check["facts"]["binding_id"]
                    .as_str()
                    .is_some_and(|id| session.binding_ids.iter().any(|known| known == id))
        });
        let needs_review = group.is_some_and(|group| {
            check["facts"]["binding_id"].as_str().is_some_and(|id| {
                sessions[group]
                    .recovery_binding_ids
                    .iter()
                    .any(|known| known == id)
            })
        });
        if let Some(issue) = issue(check, needs_review) {
            let issue = (check["status"] == "error", issue);
            let destination = if let Some(group) = group {
                &mut grouped[group]
            } else {
                &mut global
            };
            if !destination.contains(&issue) {
                destination.push(issue);
            }
        }
    }
    if summary {
        let mut problems = global;
        for (name, issues) in names.iter().zip(grouped) {
            problems.extend(
                issues
                    .into_iter()
                    .map(|(error, issue)| (error, format!("{name}: {issue}"))),
            );
        }
        problems.sort_by_key(|(error, _)| !error);
        problems.dedup();
        for (_, problem) in problems.iter().take(2) {
            writeln!(result, "{problem}").expect("string write");
        }
        for note in &notes {
            writeln!(result, "{note}").expect("string write");
        }
        if sessions.is_empty() {
            result.push_str("Open Ariadne. Start a Claude session and run /ariadne-connect, or start Codex and use Connect existing session in Ariadne.\n");
        } else {
            result.push_str("Open Ariadne. In Claude, run /reload-plugins, then /ariadne-connect. For Codex, use Connect existing session in Ariadne and paste the copied instruction into Codex.\n");
        }
        if problems.len() > 2 {
            writeln!(
                result,
                "Run `ariadne doctor` for details and {} more {}.",
                problems.len() - 2,
                if problems.len() == 3 {
                    "problem"
                } else {
                    "problems"
                }
            )
            .expect("string write");
        } else {
            result.push_str("Run `ariadne doctor` for details.\n");
        }
    } else {
        for note in &notes {
            writeln!(result, "{note}").expect("string write");
        }
        for (_, issue) in &global {
            writeln!(result, "{issue}").expect("string write");
        }
        for ((session, name), issues) in sessions.iter().zip(&names).zip(&grouped) {
            writeln!(
                result,
                "{}: {}.",
                name,
                match connection(session, checks) {
                    Connection::Connected => "connected",
                    Connection::NotConnected => "not connected",
                    Connection::Unknown => "live status unavailable",
                }
            )
            .expect("string write");
            for (_, issue) in issues {
                writeln!(result, "  {issue}").expect("string write");
            }
        }
        if unknown_count > 0
            || checks.iter().any(|check| {
                check["code"] == "desktop.supervisor_health" && check["facts"]["state"] == "stale"
            })
            || !checks.iter().any(|check| {
                check["code"] == "control.socket" && check["facts"]["validated_socket"] == true
            })
        {
            result.push_str("Live status is unavailable. Open Ariadne to connect agents.\n");
        }
        if global.is_empty() && grouped.iter().all(Vec::is_empty) {
            result.push_str("No problems found.\n");
        }
        result.push_str(
            "For detailed checks, run `ariadne doctor --verbose` or `ariadne doctor --json`.\n",
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> (Value, Vec<Session>) {
        let report = json!({"checks":[
            {"code":"project.identity","status":"ok"},
            {"code":"binding.presence","status":"warning","facts":{"binding_id":"00000000-0000-4000-8000-000000000001","connection_state":"reconnecting","freshness":"stale"}},
            {"code":"claude.loaded_gate","status":"warning"},
            {"code":"binding.presence","status":"ok","facts":{"binding_id":"00000000-0000-4000-8000-000000000002","connection_state":"connected","freshness":"fresh"}}
        ]});
        let sessions = vec![Session {
            name: "Notes".to_owned(),
            checks: 1..4,
            binding_ids: vec![
                "00000000-0000-4000-8000-000000000001".to_owned(),
                "00000000-0000-4000-8000-000000000002".to_owned(),
            ],
            active_binding_id: Some("00000000-0000-4000-8000-000000000001".to_owned()),
            recovery_binding_ids: Vec::new(),
        }];
        (report, sessions)
    }

    #[test]
    fn reconnecting_is_normal_and_a_retained_connection_does_not_make_the_session_connected() {
        let (report, sessions) = sample();
        let text = render(&report, &sessions, false);
        assert!(text.contains("1 session in 1 project; none connected right now."));
        assert!(text.contains("Notes: not connected."));
        assert!(text.contains("No problems found."));
        assert!(!text.contains("Warning"));
        assert!(!text.contains("00000000"));
    }

    #[test]
    fn fresh_active_connection_is_counted_once() {
        let (report, mut sessions) = sample();
        sessions[0].active_binding_id = Some("00000000-0000-4000-8000-000000000002".to_owned());
        let text = render(&report, &sessions, false);
        assert!(text.contains("1 connected right now."));
        assert!(text.contains("Notes: connected."));
    }

    #[test]
    fn summary_is_bounded_and_reports_extra_problems_without_claiming_health() {
        let (mut report, sessions) = sample();
        for n in 0..4 {
            report["checks"].as_array_mut().unwrap().push(json!({
                "code":"example.problem", "status":"warning",
                "message":format!("Problem {n}."), "hint":"Open Ariadne and check it."
            }));
        }
        let text = render(&report, &sessions, true);
        assert_eq!(text.lines().count(), 5);
        assert!(text.contains("Problem 0. Open Ariadne and check it."));
        assert!(text.contains("2 more problems"));
        assert!(!text.contains("00000000"));
    }

    #[test]
    fn ids_and_control_characters_in_names_paths_and_hints_are_hidden() {
        let (mut report, mut sessions) = sample();
        sessions[0].name = "Notes\n00000000-0000-4000-8000-000000000001".to_owned();
        report["checks"].as_array_mut().unwrap().push(json!({
            "code":"store.legacy", "status":"warning",
            "message":"Check /tmp/00000000-0000-4000-8000-000000000002.\u{1b}",
            "hint":"Compare the old copy before deleting it."
        }));
        let text = render(&report, &sessions, false);
        assert!(!text.contains("00000000"));
        assert!(!text.contains('\u{1b}'));
        assert!(text.contains("Notes [hidden]: not connected."));
        assert!(text.contains("Compare the old copy before deleting it."));
    }

    #[test]
    fn normal_in_flight_work_needs_no_recovery_action_but_uncertainty_and_missing_results_do() {
        let mut check = json!({"code":"binding.recovery","status":"warning","facts":{
            "unresolved":1,"claimed":1,"uncertain":0,"missing_result":0,"dispatch_state":"enabled"
        }});
        assert!(issue(&check, false).is_none());
        for key in ["uncertain", "missing_result"] {
            check["facts"][key] = json!(1);
            assert!(issue(&check, false).unwrap().contains("Review recovery"));
            check["facts"][key] = json!(0);
        }
        check["facts"]["dispatch_state"] = json!("recovery_required");
        assert!(issue(&check, false).is_some());
        check["facts"]["dispatch_state"] = json!("disconnected");
        assert!(issue(&check, false).is_none());
        assert!(issue(&check, true).unwrap().contains("Review recovery"));
    }

    #[test]
    fn offline_codex_is_normal_but_configuration_and_protocol_failures_need_action() {
        for code in ["codex.daemon_unknown", "codex.thread_unknown"] {
            let mut check = json!({"code":code,"status":"warning","facts":{"error_code":"host_unreachable"},
                "message":"Couldn't check Codex.","hint":"Check Codex in its terminal."});
            assert!(issue(&check, false).is_none());
            for error in [
                "permission_denied",
                "unsupported_host_version",
                "protocol_conflict",
            ] {
                check["facts"]["error_code"] = json!(error);
                let text = issue(&check, false).unwrap();
                assert!(text.starts_with("Warning:"));
                assert!(text.contains("reconnect"));
            }
        }
    }

    #[test]
    fn a_native_status_without_presence_is_unknown_instead_of_disconnected() {
        let session = Session {
            name: "Notes".to_owned(),
            checks: 0..1,
            binding_ids: vec!["active".to_owned()],
            active_binding_id: Some("active".to_owned()),
            recovery_binding_ids: Vec::new(),
        };
        let report = json!({"checks":[{"code":"binding.presence","status":"warning","facts":{
            "binding_id":"active","connection_state":"connected","freshness":null
        }}]});
        let text = render(&report, &[session], false);
        assert!(text.contains("Notes: live status unavailable."));
        assert!(text.contains("0 connections confirmed; live status unavailable for 1"));
        assert!(!text.contains("not connected"));
        assert!(!text.contains("Warning"));
    }

    #[test]
    fn summary_prioritizes_a_late_error_and_uses_the_singular_remaining_problem() {
        let (mut report, sessions) = sample();
        for (status, message) in [
            ("warning", "First warning."),
            ("warning", "Second warning."),
            ("error", "Late error."),
        ] {
            report["checks"].as_array_mut().unwrap().push(json!({
                "code":"example.problem", "status":status, "message":message, "hint":"Check it."
            }));
        }
        let text = render(&report, &sessions, true);
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines[1], "Error: Late error. Check it.");
        assert_eq!(lines[2], "Warning: First warning. Check it.");
        assert!(!text.contains("Second warning"));
        assert!(text.contains("1 more problem."));
        assert!(!text.contains("1 more problems"));
    }

    #[test]
    fn fresh_presence_with_a_warning_does_not_confirm_a_connection() {
        let (mut report, mut sessions) = sample();
        sessions[0].active_binding_id = Some("00000000-0000-4000-8000-000000000002".to_owned());
        report["checks"][3]["status"] = json!("warning");
        report["checks"].as_array_mut().unwrap().push(json!({
            "code":"control.socket", "status":"ok", "facts":{"validated_socket":true}
        }));
        for summary in [false, true] {
            let text = render(&report, &sessions, summary);
            assert!(text.contains("0 connections confirmed; live status unavailable for 1"));
            assert!(text.contains("Open Ariadne"));
            assert!(!text.contains("Notes: connected."));
        }
    }

    #[test]
    fn stale_heartbeat_prompts_opening_the_app_even_with_a_socket_and_no_sessions() {
        let report = json!({"checks":[
            {"code":"control.socket","status":"ok","facts":{"validated_socket":true}},
            {"code":"desktop.supervisor_health","status":"warning","facts":{"state":"stale"}}
        ]});
        let text = render(&report, &[], false);
        assert!(text.contains("Open Ariadne to connect agents."));
        assert!(!text.contains("Warning"));
    }

    #[test]
    fn untested_versions_and_identical_parked_copies_are_notes_outside_problem_slots() {
        let report = json!({"checks":[
            {"code":"codex.version","status":"warning","message":"Newer Codex is untested.","facts":{"host_version_status":"untested"}},
            {"code":"claude.version","status":"warning","message":"Newer Claude is untested.","facts":{"host_version_status":"untested"}},
            {"code":"store.legacy","status":"warning","message":"Parked copy is identical to the store; safe to delete."},
            {"code":"example.first","status":"warning","message":"First problem.","hint":"Check it."},
            {"code":"example.second","status":"warning","message":"Second problem.","hint":"Check it."}
        ]});
        for summary in [false, true] {
            let text = render(&report, &[], summary);
            assert!(text.contains("Note: Newer Codex is untested."));
            assert!(text.contains("Note: Newer Claude is untested."));
            assert!(text.contains("Note: Parked copy is identical to the store; safe to delete."));
            assert!(text.contains("Warning: First problem."));
            assert!(text.contains("Warning: Second problem."));
            assert!(!text.contains("more problems"));
        }
        let mut unsupported = report["checks"][0].clone();
        unsupported["facts"]["host_version_status"] = json!("unsupported");
        unsupported["hint"] = json!("Update Codex.");
        assert!(issue(&unsupported, false).unwrap().starts_with("Warning:"));
    }

    #[test]
    fn connection_instructions_cover_both_hosts_and_empty_or_unreadable_installs() {
        let (report, sessions) = sample();
        let text = render(&report, &sessions, true);
        assert!(text.contains("In Claude, run /reload-plugins, then /ariadne-connect."));
        assert!(text.contains("For Codex, use Connect existing session in Ariadne and paste the copied instruction into Codex."));
        assert!(!text.contains("session id"));
        let report = json!({"checks":[]});
        let text = render(&report, &[], true);
        assert!(text.contains("0 sessions in 0 projects"));
        assert!(text.contains("Start a Claude session and run /ariadne-connect, or start Codex and use Connect existing session in Ariadne."));
        let report = json!({"checks":[{"code":"registry.unavailable","status":"error","message":"Can't read saved sessions.","hint":"Check folder access."}]});
        let text = render(&report, &[], true);
        assert!(text.contains("Session counts are unavailable"));
        assert!(!text.contains("At least 0"));
    }

    #[test]
    fn duplicate_session_names_have_distinct_lines_and_problem_labels_without_ids() {
        let (mut report, mut sessions) = sample();
        report["checks"][2] = json!({"code":"example.problem","status":"warning","message":"Check this session.","hint":"Open it."});
        for name in ["Notes", "Notes (2)"] {
            sessions.push(Session {
                name: name.to_owned(),
                checks: 0..0,
                binding_ids: Vec::new(),
                active_binding_id: None,
                recovery_binding_ids: Vec::new(),
            });
        }
        report["checks"].as_array_mut().unwrap().push(json!({"code":"example.problem","status":"warning","message":"Check the other session.","hint":"Open it."}));
        sessions[1].checks = 4..5;
        let text = render(&report, &sessions, false);
        for name in ["Notes", "Notes (3)", "Notes (2)"] {
            assert!(text.contains(&format!("{name}: not connected.")), "{text}");
        }
        let text = render(&report, &sessions, true);
        assert!(text.contains("Notes: Warning: Check this session."));
        assert!(text.contains("Notes (3): Warning: Check the other session."));
        assert!(!text.contains("00000000"));
    }
}
