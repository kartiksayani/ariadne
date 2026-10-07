//! Explicit offline demo publication through the real Registry and Store.
use ariadne_core::{CoreError, CoreErrorCode, SessionRef};
use ariadne_domain::models::*;
use ariadne_store::{registry::Registry, session::Store};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const HELP: &str = "Offline demo: ariadne demo --root /absolute/project [--json]\nNo root is inferred and no provider is launched. Existing project/session data is never overwritten. Registration may remain if later demo publication fails; the error reports that partial outcome.\n";

pub fn run(args: &[&str], output: &mut dyn std::io::Write, errors: &mut dyn std::io::Write) -> i32 {
    if args == ["--help"] || args == ["-h"] {
        return if output.write_all(HELP.as_bytes()).is_ok() {
            0
        } else {
            4
        };
    }
    crate::output::write(execute(args), args.contains(&"--json"), output, errors)
}

fn execute(args: &[&str]) -> Result<serde_json::Value, CoreError> {
    let mut root = None;
    let mut json = false;
    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "--root" if root.is_none() => {
                i += 1;
                root = Some(args.get(i).copied().ok_or_else(|| {
                    error(
                        CoreErrorCode::InvalidArgument,
                        "--root requires an absolute path.",
                    )
                })?);
            }
            "--json" if !json => json = true,
            _ => {
                return Err(error(
                    CoreErrorCode::InvalidArgument,
                    "Unknown or repeated demo flag.",
                ))
            }
        }
        i += 1;
    }
    let root =
        root.ok_or_else(|| error(CoreErrorCode::InvalidArgument, "Demo requires --root."))?;
    if !Path::new(root).is_absolute() {
        return Err(error(
            CoreErrorCode::InvalidArgument,
            "Demo requires an explicit absolute --root.",
        ));
    }
    let data = crate::bridge::command::home_from_environment()?;
    let prepared = prepare(Path::new(root), &data)?;
    let registry = Registry::create_data_directory(&data)?;
    let operation_id = UuidV4::new(uuid::Uuid::new_v4().to_string()).expect("native UUIDv4");
    let route = prepared.publish(&registry, &operation_id)?;
    serde_json::to_value(route).map_err(|_| {
        error(
            CoreErrorCode::ProtocolConflict,
            "Cannot serialize the canonical demo route.",
        )
    })
}

pub struct PreparedDemo {
    root: PathBuf,
    session: Session,
}

/// An ordinary existing-session collision is rejected before registration.
/// This observation is a preflight; final Store creation is still authoritative.
/// `data` is the data root; the demo session lives under `data/projects/<id>`.
pub fn prepare(root: &Path, data: &Path) -> Result<PreparedDemo, CoreError> {
    if !root.is_absolute() {
        return Err(error(
            CoreErrorCode::InvalidArgument,
            "Demo requires an explicit absolute --root.",
        ));
    }
    let root = fs::canonicalize(root).map_err(|_| {
        error(
            CoreErrorCode::IoError,
            "Cannot resolve the explicit demo root.",
        )
    })?;
    let mut session: Session = serde_json::from_str(include_str!(
        "../../../fixtures/domain/demo/session.json"
    ))
    .map_err(|_| {
        error(
            CoreErrorCode::CorruptSession,
            "The bundled canonical demo is invalid.",
        )
    })?;
    let path = data
        .join("projects")
        .join(session.project_id.as_str())
        .join("sessions")
        .join(format!("{}.json", session.id.as_str()));
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            return Err(error(
                CoreErrorCode::BindingConflict,
                "Existing demo session preserved; project registration was not attempted.",
            ))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            return Err(error(
                CoreErrorCode::IoError,
                "Cannot check the explicit demo session path; registration was not attempted.",
            ))
        }
    }
    for binding in session.bindings.0.values_mut() {
        binding.connection_state = ConnectionState::Disconnected;
        binding.dispatch_state = DispatchState::Disconnected;
    }
    Ok(PreparedDemo { root, session })
}

impl PreparedDemo {
    /// Registration may remain if final creation fails. No existing file is
    /// replaced and no cross-file transaction or automatic repair is implied.
    pub fn publish(
        self,
        registry: &Registry,
        operation_id: &UuidV4,
    ) -> Result<SessionRef, CoreError> {
        registry.register_fixed(&self.root, operation_id, &self.session.project_id)?;
        let result = Store::open_registered(
            &registry.project_dir(&self.session.project_id),
            self.session.project_id.clone(),
        )
        .and_then(|store| store.create(&self.session));
        if let Err(cause) = result {
            let mut cause = CoreError::from(cause);
            cause.message = "Project registered; demo publication was not confirmed. Existing session bytes were not replaced; inspect the explicit root.".into();
            cause.hint = "Keep the registration operation ID. Reload the explicit root; a publication uncertainty must be reconciled before another demo action.".into();
            return Err(cause);
        }
        Ok(SessionRef {
            project_id: self.session.project_id,
            session_id: self.session.id,
        })
    }
}

fn error(code: CoreErrorCode, message: &str) -> CoreError {
    CoreError::new(code, message, "Use ariadne demo --root /absolute/project. Existing project/session data is never overwritten; no provider is launched.")
}
