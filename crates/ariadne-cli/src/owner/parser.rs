use ariadne_core::*;
use std::io::Read;

pub(super) enum Request {
    Query(OwnerQueryRequest),
    Mutation(OwnerMutationRequest),
    ReplayConnect(OwnerMutationRequest),
}

pub(super) fn invalid(message: &str) -> CoreError {
    CoreError::new(
        CoreErrorCode::InvalidArgument,
        message,
        "Use --help and pass the complete canonical request with explicit routing IDs.",
    )
}

pub(super) fn parse(args: &[&str], input: &mut dyn Read) -> Result<Request, CoreError> {
    let [noun, verb, rest @ ..] = args else {
        return Err(invalid("An owner command requires a noun and verb."));
    };
    let command = command(noun, verb).ok_or_else(|| invalid("Unknown owner command."))?;
    let mut stdin = false;
    let mut json = false;
    let mut replay_only = false;
    for flag in rest.iter() {
        match *flag {
            "--json-stdin" if !stdin => stdin = true,
            "--json" if !json => json = true,
            "--replay-only" if !replay_only => replay_only = true,
            _ => return Err(invalid("Unknown or repeated owner flag.")),
        }
    }
    if replay_only && (command != "binding_connect" || !stdin) {
        return Err(invalid(
            "--replay-only requires binding connect --json-stdin.",
        ));
    }
    let request = if stdin {
        let bytes = read_stdin(input)?;
        if is_query(command) {
            let request: OwnerQueryRequest = serde_json::from_slice(&bytes)
                .map_err(|_| invalid("Stdin must contain one canonical OwnerQueryRequest."))?;
            request.validate_wire()?;
            if query_name(&request.request) != command {
                return Err(invalid("CLI command differs from the canonical query tag."));
            }
            Request::Query(request)
        } else {
            let request: OwnerMutationRequest = serde_json::from_slice(&bytes)
                .map_err(|_| invalid("Stdin must contain one canonical OwnerMutationRequest."))?;
            request.validate_wire()?;
            if mutation_name(&request.command) != command {
                return Err(invalid(
                    "CLI command differs from the canonical command tag.",
                ));
            }
            if replay_only {
                Request::ReplayConnect(request)
            } else {
                Request::Mutation(request)
            }
        }
    } else {
        let request = match command {
            "project_list" => QueryRequest::ProjectList(ProjectListRequest {
                cursor: None,
                limit: PageLimit::new(20).expect("literal"),
            }),
            "session_list" => QueryRequest::SessionList(SessionListRequest {
                project_id: None,
                state: None,
                cursor: None,
                limit: PageLimit::new(20).expect("literal"),
            }),
            "preferences_get" => QueryRequest::PreferencesGet {},
            _ => return Err(invalid("This owner command requires --json-stdin.")),
        };
        Request::Query(OwnerQueryRequest {
            session: None,
            request,
        })
    };
    Ok(request)
}

pub(super) fn command(noun: &str, verb: &str) -> Option<&'static str> {
    Some(match (noun, verb) {
        ("project", "list") => "project_list",
        ("project", "register") => "project_register",
        ("session", "list") => "session_list",
        ("session", "read") => "session_read",
        ("session", "close") => "session_close",
        ("session", "reopen") => "session_reopen",
        ("session", "archive") => "session_archive",
        ("session", "restore") => "session_restore",
        ("item", "messages") => "item_messages",
        ("item", "rounds") => "item_rounds",
        ("item", "reveal") => "reveal_item",
        ("item", "ack") => "ack",
        ("item", "restore") => "item_restore",
        ("binding", "connect") => "binding_connect",
        ("binding", "pause") => "binding_pause",
        ("binding", "resume") => "binding_resume",
        ("binding", "disconnect") => "binding_disconnect",
        ("input", "submit") => "input_submit",
        ("input", "cancel") => "input_cancel",
        ("input", "resolve") => "input_resolve",
        ("topic", "archive") => "topic_archive",
        ("topic", "restore") => "topic_restore",
        ("topic", "restore-removed") => "topic_removed_restore",
        ("topic", "continue") => "topic_continue",
        ("topic", "continue-preview") => "topic_continue_preview",
        ("preferences", "get") => "preferences_get",
        ("preferences", "patch") => "preferences_patch",
        ("session", "label") => "session_label_set",
        ("remove", "item") => "item_remove",
        ("remove", "topic") => "topic_remove",
        ("remove", "session") => "session_remove",
        ("remove", "project") => "project_remove",
        _ => return None,
    })
}
fn is_query(command: &str) -> bool {
    matches!(
        command,
        "project_list"
            | "session_list"
            | "session_read"
            | "item_messages"
            | "item_rounds"
            | "reveal_item"
            | "topic_continue_preview"
            | "preferences_get"
    )
}
fn query_name(request: &QueryRequest) -> &'static str {
    match request {
        QueryRequest::ProjectList(_) => "project_list",
        QueryRequest::SessionList(_) => "session_list",
        QueryRequest::SessionGet {} => "session_get",
        QueryRequest::SessionRead(_) => "session_read",
        QueryRequest::ItemMessages(_) => "item_messages",
        QueryRequest::ItemRounds(_) => "item_rounds",
        QueryRequest::TopicContinuePreview(_) => "topic_continue_preview",
        QueryRequest::PreferencesGet {} => "preferences_get",
        QueryRequest::RevealItem { .. } => "reveal_item",
    }
}
fn mutation_name(command: &OwnerCommand) -> &'static str {
    match command {
        OwnerCommand::ProjectRegister { .. } => "project_register",
        OwnerCommand::BindingConnect { .. } => "binding_connect",
        OwnerCommand::BindingPause { .. } => "binding_pause",
        OwnerCommand::BindingResume { .. } => "binding_resume",
        OwnerCommand::BindingDisconnect { .. } => "binding_disconnect",
        OwnerCommand::InputSubmit { .. } => "input_submit",
        OwnerCommand::InputCancel { .. } => "input_cancel",
        OwnerCommand::InputResolve { .. } => "input_resolve",
        OwnerCommand::TopicArchive { .. } => "topic_archive",
        OwnerCommand::TopicRestore { .. } => "topic_restore",
        OwnerCommand::SessionClose { .. } => "session_close",
        OwnerCommand::SessionReopen { .. } => "session_reopen",
        OwnerCommand::SessionArchive { .. } => "session_archive",
        OwnerCommand::SessionRestore { .. } => "session_restore",
        OwnerCommand::TopicContinue { .. } => "topic_continue",
        OwnerCommand::PreferencesPatch { .. } => "preferences_patch",
        OwnerCommand::ItemRemove { .. } => "item_remove",
        OwnerCommand::ItemRestore { .. } => "item_restore",
        OwnerCommand::TopicRemovedRestore { .. } => "topic_removed_restore",
        OwnerCommand::TopicRemove { .. } => "topic_remove",
        OwnerCommand::SessionRemove { .. } => "session_remove",
        OwnerCommand::ProjectRemove { .. } => "project_remove",
        OwnerCommand::SessionLabelSet { .. } => "session_label_set",
        OwnerCommand::Ack { .. } => "ack",
    }
}
fn read_stdin(input: &mut dyn Read) -> Result<Vec<u8>, CoreError> {
    let mut bytes = Vec::new();
    input
        .take(512 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            CoreError::new(
                CoreErrorCode::IoError,
                "Cannot read owner stdin.",
                "Pass one complete canonical JSON request; retain its original operation ID.",
            )
        })?;
    if bytes.len() > 512 * 1024 {
        return Err(CoreError::new(
            CoreErrorCode::CapacityExceeded,
            "Owner stdin exceeds 512KiB.",
            "Reduce the request before retrying the same operation ID.",
        ));
    }
    Ok(bytes)
}
