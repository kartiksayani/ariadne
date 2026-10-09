//! Explicit local owner commands; Core owns all durable business semantics.
mod native;
mod parser;
use ariadne_core::*;
use std::io::{Read, Write};

pub const HELP: &str = r#"Owner commands (explicit registered routes):
  ariadne project list|register [--json-stdin] [--json]
  ariadne session list|read|close|reopen|archive|restore [--json-stdin] [--json]
  ariadne binding connect|pause|resume|disconnect --json-stdin [--json]
  ariadne input submit|cancel|resolve --json-stdin [--json]
  ariadne topic archive|restore|continue|continue-preview --json-stdin [--json]
  ariadne item messages|rounds|reveal|ack --json-stdin [--json]
  ariadne preferences get|patch [--json-stdin] [--json]
  ariadne remove item|topic|session|project --json-stdin [--json]
Remove is permanent inside Ariadne; files and the agent's conversation stay.
Item and topic removal use a session route and queue a `removed` notice for
the told agent; session and project removal use session:null. Every removal
first writes a pre-remove backup and its receipt prints the backup path.
Item Ack finishes an item at its stored ack_to target using its expected revision;
the canonical owner command tag is ack. Ack is an owner action, not an agent tool.
Stdin is the complete canonical OwnerQueryRequest or OwnerMutationRequest,
at most 512KiB. Its command tag must match the CLI noun/verb. Stdin commands
return one canonical JSON envelope by default. Every mutation requires stdin;
only project list, session list and preferences get have argument-only defaults.
Session queries/mutations include explicit project/session IDs in the wrapper;
global, preference and bootstrap commands use session:null. No cwd or active
session is inferred. session_get is a desktop-only full snapshot operation.
ARIADNE_HOME selects the application data directory, default HOME/.ariadne.
Only explicit project register or demo initializes a missing private directory.

Examples (replace UUIDs and retain original operation IDs for exact retries):
  ariadne project list --json
  printf '%s' '{"session":null,"request":{"command":"preferences_get","params":{}}}' | ariadne preferences get --json-stdin
  printf '%s' '{"session":null,"command":{"command":"project_register","api_version":1,"op_id":"00000000-0000-4000-8000-000000000999","params":{"canonical_root":"/absolute/project"}}}' | ariadne project register --json-stdin
Binding connect recovers an exact saved operation without a provider check;
new connections require a qualified candidate in the running desktop. It never
launches/resumes a provider or changes its configuration. Draft persistence does
not submit an input. Exits: 0 success, 2 invalid, 3 conflict, 4 I/O, 5 unsupported.
"#;

pub fn handles(args: &[&str]) -> bool {
    if args.first() == Some(&"item") {
        // Keep the bound-agent item tools on their existing typed route.
        return !args.contains(&"--binding");
    }
    matches!(
        args.first(),
        Some(&("project" | "session" | "binding" | "input" | "topic" | "preferences" | "remove"))
    )
}

/// Installed owner commands use the same native Registry/Core composition as
/// the existing agent tools. No provider or mutable session is inferred.
pub fn run(
    args: &[&str],
    input: &mut dyn Read,
    output: &mut dyn Write,
    errors: &mut dyn Write,
) -> i32 {
    if args.contains(&"--help") || args.contains(&"-h") {
        return if output.write_all(HELP.as_bytes()).is_ok() {
            0
        } else {
            4
        };
    }
    crate::output::write(
        parser::parse(args, input).and_then(native::execute),
        args.contains(&"--json") || args.contains(&"--json-stdin"),
        output,
        errors,
    )
}

/// Thin native consumer seam. The resolver proves membership only; Core still
/// observes mutable state and exact operation replay under its own locks.
pub fn run_with(
    core: &dyn CoreService,
    resolve: &dyn Fn(&SessionRef) -> Result<RegisteredSession, CoreError>,
    args: &[&str],
    input: &mut dyn Read,
    output: &mut dyn Write,
    errors: &mut dyn Write,
) -> i32 {
    if args.contains(&"--help") || args.contains(&"-h") {
        return if output.write_all(HELP.as_bytes()).is_ok() {
            0
        } else {
            4
        };
    }
    let result = parser::parse(args, input).and_then(|request| execute(core, resolve, request));
    crate::output::write(
        result,
        args.contains(&"--json") || args.contains(&"--json-stdin"),
        output,
        errors,
    )
}

fn context(
    session: &Option<SessionRef>,
    preferences: bool,
    resolve: &dyn Fn(&SessionRef) -> Result<RegisteredSession, CoreError>,
) -> Result<OwnerContext, CoreError> {
    let scope = if let Some(route) = session {
        let registered = resolve(route)?;
        if registered.project_id() != &route.project_id
            || registered.session_id() != &route.session_id
        {
            return Err(CoreError::new(
                CoreErrorCode::BindingMismatch,
                "Native resolver returned a different registered session.",
                "Resolve the explicitly requested project/session route again.",
            ));
        }
        OwnerScope::Session(registered)
    } else if preferences {
        OwnerScope::Preferences
    } else {
        OwnerScope::Registry
    };
    Ok(OwnerContext::from_trusted_entrypoint(scope))
}

fn execute(
    core: &dyn CoreService,
    resolve: &dyn Fn(&SessionRef) -> Result<RegisteredSession, CoreError>,
    request: parser::Request,
) -> Result<serde_json::Value, CoreError> {
    let value = match request {
        parser::Request::Query(wrapper) => {
            let owner = context(
                &wrapper.session,
                matches!(wrapper.request, QueryRequest::PreferencesGet {}),
                resolve,
            )?;
            let context = QueryContext::owner(owner);
            let result = core.query(context.clone(), wrapper.request.clone())?;
            result.validate_for(&context, &wrapper.request)?;
            serde_json::to_value(result)
        }
        parser::Request::Mutation(wrapper) => {
            let owner = context(
                &wrapper.session,
                matches!(wrapper.command, OwnerCommand::PreferencesPatch { .. }),
                resolve,
            )?;
            let receipt = core.execute_owner(owner, wrapper.command.clone())?;
            validate_owner_receipt(&wrapper, &receipt)?;
            serde_json::to_value(receipt)
        }
    };
    value.map_err(|_| parser::invalid("Cannot serialize the canonical owner response."))
}
