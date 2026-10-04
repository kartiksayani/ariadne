//! Explicit integration setup. Host trust stays in the host UI.
pub mod owned;
pub mod resources;

use ariadne_core::{CoreError, CoreErrorCode};
use ariadne_domain::models::UuidV4;
use ariadne_store::registry::Registry;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const HELP: &str = "Integration setup: ariadne setup --agent claude|codex|both [--project /absolute/project] [--json]\nIntegration removal: ariadne uninstall [--agent claude|codex|both] [--json]\nInstall the matching personal app/helpers first. Setup prints host commands; run them explicitly in the original host. All project sessions/backups and foreign settings survive uninstall.\n";

#[derive(Debug)]
pub(crate) struct Request {
    pub agent: String,
    pub project: Option<PathBuf>,
    pub uninstall: bool,
}

pub(crate) fn parse(args: &[&str], uninstall: bool) -> Result<Request, CoreError> {
    let mut agent = None;
    let mut project = None;
    let mut json = false;
    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "--agent" if agent.is_none() => {
                i += 1;
                let value = args
                    .get(i)
                    .copied()
                    .ok_or_else(|| invalid("--agent requires a value."))?;
                if !["claude", "codex", "both"].contains(&value) {
                    return Err(invalid("Choose --agent claude, codex or both."));
                }
                agent = Some(value.to_owned());
            }
            "--project" if project.is_none() && !uninstall => {
                i += 1;
                let path = PathBuf::from(
                    args.get(i)
                        .copied()
                        .ok_or_else(|| invalid("--project requires an absolute path."))?,
                );
                if !path.is_absolute() {
                    return Err(invalid("--project requires an explicit absolute path."));
                }
                project = Some(path);
            }
            "--json" if !json => json = true,
            _ => return Err(invalid("Unknown or repeated setup/uninstall flag.")),
        }
        i += 1;
    }
    Ok(Request {
        agent: agent
            .or_else(|| uninstall.then(|| "both".into()))
            .ok_or_else(|| invalid("Setup requires --agent."))?,
        project,
        uninstall,
    })
}

pub(crate) fn invalid(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::InvalidArgument, message, HELP)
}

/// The entrypoint supplies the validated immutable installation, never a checkout.
pub fn execute_in_installation(
    args: &[&str],
    uninstall: bool,
    data: &Path,
    version_root: &Path,
    stable_integrations: &Path,
) -> Result<Value, CoreError> {
    let request = parse(args, uninstall)?;
    let project=request.project.as_ref().map(|root|root.canonicalize().map_err(|_|CoreError::new(CoreErrorCode::IoError,"Cannot resolve the explicitly selected project; integration setup was not attempted.","Restore access to that exact project path."))).transpose()?;
    let mut result = owned::apply(version_root, &request.agent, request.uninstall)?;
    if let Some(project) = project {
        let registered = (|| -> Result<Value, CoreError> {
            let registry = Registry::create_data_directory(data)?;
            if let Some(existing) = registry
                .registered_projects()?
                .into_iter()
                .find(|p| p.root == project)
            {
                registry.resolve_project(&existing.project_id)?;
                return Ok(
                    json!({"state":"already_registered","canonical_root":project,"project_id":existing.project_id}),
                );
            }
            let uuid = || UuidV4::new(uuid::Uuid::new_v4().to_string()).expect("native UUID");
            let receipt = registry.register(&project, &uuid(), uuid)?;
            Ok(json!({"state":"registered","canonical_root":project,"receipt":receipt}))
        })();
        match registered {
            Ok(project) => result["project"] = project,
            Err(mut error) => {
                error.message="Integration resources were checked/created, but project registration was not confirmed. Existing project data was preserved.".into();
                error.hint=format!("Inspect the explicit root and registration before another setup. Integration outcome: {}",result);
                return Err(error);
            }
        }
    }
    result["host_commands"] = json!(if request.uninstall {
        Vec::<String>::new()
    } else {
        resources::host_commands(stable_integrations, &request.agent)
    });
    result["host_configuration"]=json!("Host registration/trust remains explicit. No host settings were edited; remove only the original unchanged Ariadne named entries through the host UI if desired.");
    Ok(result)
}

pub(crate) fn write(
    result: Result<Value, CoreError>,
    json_output: bool,
    output: &mut dyn std::io::Write,
    errors: &mut dyn std::io::Write,
) -> i32 {
    if json_output || result.is_err() {
        return crate::output::write(result, json_output, output, errors);
    }
    let data = result.expect("checked success");
    let written = (|| -> std::io::Result<()> {
        for change in data["changes"].as_array().expect("changes") {
            writeln!(
                output,
                "{}: {}",
                change["action"].as_str().expect("action"),
                change["path"].as_str().expect("path")
            )?;
        }
        for entry in data["already_present"].as_array().expect("present") {
            writeln!(
                output,
                "already present: {}",
                entry["path"].as_str().expect("path")
            )?;
        }
        for entry in data["retained"].as_array().expect("retained") {
            writeln!(
                output,
                "retained: {} — {}",
                entry["path"].as_str().expect("path"),
                entry["reason"].as_str().expect("reason")
            )?;
        }
        if !data["project"].is_null() {
            writeln!(output, "project: {}", data["project"])?;
        }
        writeln!(
            output,
            "{}",
            data["host_configuration"]
                .as_str()
                .expect("host instruction")
        )?;
        for command in data["host_commands"].as_array().expect("commands") {
            writeln!(output, "{}", command.as_str().expect("command"))?;
        }
        Ok(())
    })();
    if written.is_ok() {
        0
    } else {
        4
    }
}

pub fn run_in_installation(
    args: &[&str],
    uninstall: bool,
    data: &Path,
    version_root: &Path,
    stable_integrations: &Path,
    output: &mut dyn std::io::Write,
    errors: &mut dyn std::io::Write,
) -> i32 {
    if args == ["--help"] || args == ["-h"] {
        return if output.write_all(HELP.as_bytes()).is_ok() {
            0
        } else {
            4
        };
    }
    write(
        execute_in_installation(args, uninstall, data, version_root, stable_integrations),
        args.contains(&"--json"),
        output,
        errors,
    )
}

pub(crate) fn package_root_from_environment() -> Result<PathBuf, CoreError> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .map(|home| home.join(".local/share/ariadne"))
        .ok_or_else(|| invalid("An absolute native HOME is required for the installed package."))
}

/// Native CLI composition uses the same package descriptor as explicit open routes.
pub fn run(
    args: &[&str],
    uninstall: bool,
    output: &mut dyn std::io::Write,
    errors: &mut dyn std::io::Write,
) -> i32 {
    if args == ["--help"] || args == ["-h"] {
        return if output.write_all(HELP.as_bytes()).is_ok() {
            0
        } else {
            4
        };
    }
    let result = (|| {
        parse(args, uninstall)?;
        let package_root = package_root_from_environment()?;
        let package = crate::open::installed_package(&package_root, resources::VERSION)?;
        let data = crate::bridge::command::home_from_environment()?;
        execute_in_installation(
            args,
            uninstall,
            &data,
            &package.version_root,
            &package_root.join("current/integrations"),
        )
    })();
    write(result, args.contains(&"--json"), output, errors)
}
