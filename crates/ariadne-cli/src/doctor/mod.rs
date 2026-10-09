//! Read-only installation and registered project diagnostics.
use ariadne_core::{CoreError, CoreErrorCode};
use serde_json::{json, Value};
use std::{io::Write, path::PathBuf};
mod human;
pub mod inspect;

pub const HELP: &str = "Diagnostics: ariadne doctor [--project /absolute/project] [--claude-bin /absolute/claude] [--codex-bin /absolute/codex] [--verbose | --json | --summary]\nChecks Ariadne's install, data, app and agent connections. It only reads: it never repairs data, resends messages, approves anything or starts an agent.\n--claude-bin and --codex-bin override the paths `ariadne setup` recorded. Codex is reached through its running app-server (CODEX_HOME, or the default folder).\nThe default view groups sessions by name; not connected is normal. --verbose keeps the detailed checks; --json keeps the machine report. --summary prints the short install summary.\n";

pub(crate) fn parse(args: &[&str]) -> Result<inspect::Options, CoreError> {
    let mut options = inspect::Options::default();
    let mut format = false;
    let mut i = 0;
    while i < args.len() {
        match args[i] {
            flag @ ("--project" | "--claude-bin" | "--codex-bin") => {
                let slot = match flag {
                    "--project" => &mut options.project,
                    "--claude-bin" => &mut options.claude_bin,
                    _ => &mut options.codex_bin,
                };
                if slot.is_some() {
                    return Err(invalid("Repeated doctor path flag."));
                }
                i += 1;
                let path = PathBuf::from(
                    args.get(i)
                        .copied()
                        .ok_or_else(|| invalid("--project requires a path."))?,
                );
                if !path.is_absolute() {
                    return Err(invalid(
                        "Doctor requires an explicit absolute project path.",
                    ));
                }
                *slot = Some(path);
            }
            "--json" | "--verbose" | "--summary" if !format => format = true,
            _ => return Err(invalid("Unknown or repeated doctor flag.")),
        }
        i += 1;
    }
    Ok(options)
}

pub(crate) fn invalid(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::InvalidArgument, message, HELP)
}

pub(crate) struct Report {
    at: String,
    checks: Vec<Value>,
}
impl Report {
    pub(crate) fn new() -> Self {
        Self {
            at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            checks: Vec::new(),
        }
    }
    pub(crate) fn add(
        &mut self,
        status: &str,
        code: &str,
        message: &str,
        hint: &str,
        facts: Value,
    ) {
        self.checks.push(json!({"status":status,"code":code,"message":message,"hint":hint,"checked_at":self.at,"facts":facts}));
    }
    pub(crate) fn value(self) -> Value {
        let status = if self.checks.iter().any(|c| c["status"] == "error") {
            "error"
        } else if self.checks.iter().any(|c| c["status"] == "warning") {
            "warning"
        } else {
            "ok"
        };
        json!({"app_version":crate::setup::resources::VERSION,"helper_version":crate::setup::resources::VERSION,"checked_at":self.at,"status":status,"checks":self.checks})
    }
}

pub(crate) fn write(
    result: Result<Value, CoreError>,
    json_output: bool,
    verbose: bool,
    summary: bool,
    sessions: &[human::Session],
    output: &mut dyn Write,
    errors: &mut dyn Write,
) -> i32 {
    let report = match result {
        Ok(report) => report,
        Err(error) => return crate::output::write(Err(error), json_output, output, errors),
    };
    let exit = if report["status"] == "error" { 4 } else { 0 };
    if json_output {
        let wrote = crate::output::write(Ok(report), true, output, errors);
        return if wrote == 0 { exit } else { wrote };
    }
    if !verbose {
        let text = human::render(&report, sessions, summary);
        return if output.write_all(text.as_bytes()).is_ok() {
            exit
        } else {
            4
        };
    }
    for check in report["checks"].as_array().expect("report checks") {
        if writeln!(
            output,
            "{} [{}]: {}\n  {}",
            check["status"].as_str().expect("status"),
            check["code"].as_str().expect("code"),
            check["message"].as_str().expect("message"),
            check["hint"].as_str().expect("hint")
        )
        .is_err()
        {
            return 4;
        }
    }
    if writeln!(
        output,
        "Result: {}",
        report["status"].as_str().expect("status")
    )
    .is_err()
    {
        4
    } else {
        exit
    }
}

pub fn run_in_installation(
    args: &[&str],
    data: &std::path::Path,
    version_root: Option<&std::path::Path>,
    output: &mut dyn Write,
    errors: &mut dyn Write,
) -> i32 {
    if args == ["--help"] || args == ["-h"] {
        return if output.write_all(HELP.as_bytes()).is_ok() {
            0
        } else {
            4
        };
    }
    let result =
        parse(args).map(|options| inspect::collect_for_display(data, version_root, &options));
    let (report, sessions) = match result {
        Ok((report, sessions)) => (Ok(report), sessions),
        Err(error) => (Err(error), Vec::new()),
    };
    write(
        report,
        args.contains(&"--json"),
        args.contains(&"--verbose"),
        args.contains(&"--summary"),
        &sessions,
        output,
        errors,
    )
}

/// Native CLI diagnostics never create or repair an installation or data root.
pub fn run(args: &[&str], output: &mut dyn Write, errors: &mut dyn Write) -> i32 {
    if args == ["--help"] || args == ["-h"] {
        return if output.write_all(HELP.as_bytes()).is_ok() {
            0
        } else {
            4
        };
    }
    let result = (|| {
        let options = parse(args)?;
        let data = crate::bridge::command::home_from_environment()?;
        let root = crate::setup::package_root_from_environment()?;
        let package = crate::open::installed_package(&root, crate::setup::resources::VERSION);
        let (mut report, sessions) = inspect::collect_for_display(
            &data,
            package.as_ref().ok().map(|p| p.version_root.as_path()),
            &options,
        );
        if let Err(error) = package {
            // Missing personal installations remain unknown. Existing invalid layouts
            // are explicit errors; their descriptors are never used for resource writes.
            if std::fs::symlink_metadata(&root).is_ok() {
                let checked_at = report["checked_at"].clone();
                report["checks"].as_array_mut().expect("checks").push(json!({
                    "status":"error", "code":"installation.invalid", "checked_at":checked_at,
                    "message":"Ariadne's installed package is damaged or doesn't match this version.",
                    "hint":"Install the matching Ariadne package again. Doctor didn't change anything.",
                    "facts":{"error_code":error.code}
                }));
                report["status"] = json!("error");
            }
        }
        Ok((report, sessions))
    })();
    let (report, sessions) = match result {
        Ok((report, sessions)) => (Ok(report), sessions),
        Err(error) => (Err(error), Vec::new()),
    };
    write(
        report,
        args.contains(&"--json"),
        args.contains(&"--verbose"),
        args.contains(&"--summary"),
        &sessions,
        output,
        errors,
    )
}
