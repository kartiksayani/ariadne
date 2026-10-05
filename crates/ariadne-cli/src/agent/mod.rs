//! Thin installed agent tools; native facts come from Registry, semantics from Core.
use ariadne_core::{
    native::{AgentResolver, NativeCoreService},
    *,
};
use ariadne_domain::models::*;

use std::{
    collections::BTreeMap,
    io::{Read, Write},
};

pub const HELP: &str = r#"Agent tools (explicit routing; no cwd/session default):
  ariadne read --binding UUID --generation UUID --view items [--limit 1..100] [--json]
  ariadne read --binding UUID --generation UUID --json-stdin [--json]
  ariadne item messages|rounds --binding UUID --generation UUID --item ITEM [--json]
  ariadne item messages|rounds --binding UUID --generation UUID --json-stdin [--json]
  ariadne apply --binding UUID --generation UUID --json-stdin [--json]
Read source scope: add both --source-input UUID and --attempt UUID, or neither.
Stdin is the complete canonical SessionReadRequest, ItemMessagesRequest,
ItemRoundsRequest or ApplyRequest (not an actor/context envelope), at most 512KiB.
A malformed stdin request fails with exit 2 and the parser's message (offending
field, variant or type, plus line/column); fix that and send the corrected
request with a new op_id (the same op_id is only for replaying the same bytes
after an uncertain commit).
Worked ApplyRequest examples are in the Ariadne rules text given to you at setup.
Use stdin for filters and all outer/nested continuation cursors. --json emits one
canonical envelope on stdout, including failures. Text failures use stderr.
ARIADNE_HOME selects the same existing application data directory as bridge;
the default is HOME/.ariadne. Models cannot select project/session paths.

Executable examples with registered binding/generation values B and G:
  ariadne read --binding "$B" --generation "$G" --view topics --limit 10 --json
  printf '%s' '{"selection":{"view":"items","filters":{"topic_id":null,"item_id":null,"parent_item_id":null,"statuses":[],"archived":null}},"cursor":null,"limit":10,"item_pages":[]}' | ariadne read --binding "$B" --generation "$G" --json-stdin --json
  printf '%s' '{"op_id":"00000000-0000-4000-8000-000000000999","source_input_id":null,"attempt_id":null,"expected_item_revisions":{},"expected_topic_revisions":{},"summary":"","operations":[],"input_result":null}' | ariadne apply --binding "$B" --generation "$G" --json-stdin --json
Invalid: ariadne read --binding not-a-uuid --generation "$G" --view items
Invalid: ariadne apply --binding "$B" --generation "$G" (missing --json-stdin)
Exits: 0 success, 2 invalid request, 3 conflict, 4 local/host I/O, 5 unsupported/future schema.
Retain exact Apply op_id and request bytes for retries; new effects require current authority.
"#;

pub fn handles(args: &[&str]) -> bool {
    matches!(
        args.first(),
        Some(&("read" | "session_read" | "item" | "item_messages" | "item_rounds" | "apply"))
    )
}
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
        execute(args, input),
        args.contains(&"--json"),
        output,
        errors,
    )
}

enum Tool {
    Read(AgentReadToolRequest),
    Messages(AgentMessagesToolRequest),
    Rounds(AgentRoundsToolRequest),
    Apply(AgentApplyToolRequest),
}
fn execute(args: &[&str], input: &mut dyn Read) -> Result<serde_json::Value, CoreError> {
    let tool = parse(args, input)?;
    match &tool {
        Tool::Read(request) => request.validate_wire()?,
        Tool::Messages(request) => request.validate_wire()?,
        Tool::Rounds(request) => request.validate_wire()?,
        Tool::Apply(request) => request.validate_wire()?,
    }
    let data = crate::bridge::command::home_from_environment()?;
    let registry = AgentResolver::open_data_directory(&data)?;
    let core = NativeCoreService::new(
        registry,
        || UuidV4::new(uuid::Uuid::new_v4().to_string()).expect("UUIDv4 generator"),
        || {
            UtcMillis::new(
                chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
            .expect("native UTC clock")
        },
        |_| {
            Err(CoreError::new(
                CoreErrorCode::Unsupported,
                "No provider verifier is composed for the agent CLI.",
                "Use native owner setup with an installed adapter.",
            ))
        },
    );
    let (binding, generation, source, attempt) = match &tool {
        Tool::Read(request) => (
            &request.binding_id,
            &request.generation,
            &request.source_input_id,
            &request.attempt_id,
        ),
        Tool::Messages(request) => (
            &request.binding_id,
            &request.generation,
            &request.source_input_id,
            &request.attempt_id,
        ),
        Tool::Rounds(request) => (
            &request.binding_id,
            &request.generation,
            &request.source_input_id,
            &request.attempt_id,
        ),
        Tool::Apply(request) => (
            &request.binding_id,
            &request.generation,
            &request.request.source_input_id,
            &request.request.attempt_id,
        ),
    };
    let context = AgentResolver::resolve(
        core.registry(),
        binding.clone(),
        generation.clone(),
        source.clone(),
        attempt.clone(),
    )?;
    match tool {
        Tool::Apply(request) => {
            let result = core.apply(context, request.request)?;
            value(serde_json::to_value(result))
        }
        query => {
            let request = match query {
                Tool::Read(request) => QueryRequest::SessionRead(request.params),
                Tool::Messages(request) => QueryRequest::ItemMessages(request.params),
                Tool::Rounds(request) => QueryRequest::ItemRounds(request.params),
                Tool::Apply(_) => unreachable!("handled above"),
            };
            value(serde_json::to_value(
                core.query(QueryContext::agent(context), request)?,
            ))
        }
    }
}
fn value(
    value: Result<serde_json::Value, serde_json::Error>,
) -> Result<serde_json::Value, CoreError> {
    value.map_err(|_| invalid("Cannot serialize the canonical result."))
}

fn parse(args: &[&str], input: &mut dyn Read) -> Result<Tool, CoreError> {
    let (method, rest) = match args {
        ["read" | "session_read", rest @ ..] => ("read", rest),
        ["item", "messages", rest @ ..] | ["item_messages", rest @ ..] => ("messages", rest),
        ["item", "rounds", rest @ ..] | ["item_rounds", rest @ ..] => ("rounds", rest),
        ["apply", rest @ ..] => ("apply", rest),
        _ => return Err(invalid("Unknown agent command.")),
    };
    let mut flags = BTreeMap::new();
    let mut i = 0;
    while i < rest.len() {
        let name = rest[i];
        let value = match name {
            "--json" | "--json-stdin" => "",
            "--binding" | "--generation" | "--source-input" | "--attempt" | "--view" | "--item"
            | "--limit" => {
                i += 1;
                rest.get(i)
                    .copied()
                    .ok_or_else(|| invalid("Flag requires a value."))?
            }
            _ => return Err(invalid("Unknown agent flag.")),
        };
        if flags.insert(name, value).is_some() {
            return Err(invalid("Repeated agent flag."));
        }
        i += 1;
    }
    let binding_id = required_uuid(&flags, "--binding")?;
    let generation = required_uuid(&flags, "--generation")?;
    let source_input_id = flags
        .get("--source-input")
        .map(|value| uuid_value(value))
        .transpose()?;
    let attempt_id = flags
        .get("--attempt")
        .map(|value| uuid_value(value))
        .transpose()?;
    if source_input_id.is_some() != attempt_id.is_some() {
        return Err(invalid(
            "Source input and attempt must both be supplied or both absent.",
        ));
    }
    let stdin = flags.contains_key("--json-stdin");
    if stdin
        && ["--view", "--item", "--limit"]
            .iter()
            .any(|key| flags.contains_key(key))
    {
        return Err(invalid(
            "Stdin parameters cannot be combined with convenience parameter flags.",
        ));
    }
    if method == "apply"
        && (source_input_id.is_some()
            || flags.keys().any(|key| {
                !matches!(
                    *key,
                    "--binding" | "--generation" | "--json" | "--json-stdin"
                )
            }))
    {
        return Err(invalid(
            "Apply source and revision guards belong in the full stdin request.",
        ));
    }
    let limit = flags.get("--limit").map_or(Ok(20), |value| {
        value
            .parse::<u64>()
            .map_err(|_| invalid("Limit must be an integer in 1..100."))
    })?;
    let limit = PageLimit::new(limit).map_err(|_| invalid("Limit must be in 1..100."))?;
    let item = flags
        .get("--item")
        .map(|value| {
            ItemRef::new(*value).map_err(|_| invalid("Item must be a canonical item reference."))
        })
        .transpose()?;
    // Deserialize the existing typed records, preserving all optional guards,
    // exact text, filter and nested cursor fields. There is no alternate schema.
    let bytes = if stdin {
        Some(read_stdin(input)?)
    } else {
        None
    };
    match method {
        "apply" => {
            let bytes = bytes.ok_or_else(|| invalid("Apply requires --json-stdin."))?;
            let request: ApplyRequest = serde_json::from_slice(&bytes)
                .map_err(|error| bad_stdin("ApplyRequest", &error))?;
            request.validate_wire()?;
            Ok(Tool::Apply(AgentApplyToolRequest {
                binding_id,
                generation,
                request,
            }))
        }
        "read" => {
            if item.is_some() {
                return Err(invalid("Use full read stdin parameters for item filters."));
            }
            let params = if let Some(bytes) = bytes {
                serde_json::from_slice(&bytes)
                    .map_err(|error| bad_stdin("SessionReadRequest", &error))?
            } else {
                let selection = match flags.get("--view").copied().unwrap_or("items") {
                    "items" => ReadView::Items {
                        topic_id: None,
                        item_id: None,
                        parent_item_id: None,
                        statuses: vec![],
                        archived: None,
                    },
                    "topics" => ReadView::Topics { archived: None },
                    "messages" => ReadView::Messages {
                        topic_id: None,
                        item_id: None,
                    },
                    "inputs" => ReadView::Inputs {
                        topic_id: None,
                        item_id: None,
                        states: vec![],
                    },
                    _ => {
                        return Err(invalid(
                            "Read view must be items, topics, messages or inputs.",
                        ))
                    }
                };
                SessionReadRequest {
                    selection,
                    cursor: None,
                    limit,
                    item_pages: vec![],
                }
            };
            Ok(Tool::Read(AgentReadToolRequest {
                binding_id,
                generation,
                source_input_id,
                attempt_id,
                params,
            }))
        }
        "messages" | "rounds" => {
            if flags.contains_key("--view") {
                return Err(invalid("Item history has no --view flag."));
            }
            if method == "messages" {
                let params = if let Some(bytes) = bytes {
                    serde_json::from_slice(&bytes)
                        .map_err(|error| bad_stdin("ItemMessagesRequest", &error))?
                } else {
                    ItemMessagesRequest {
                        item_id: item.ok_or_else(|| invalid("Explicit --item is required."))?,
                        cursor: None,
                        limit,
                    }
                };
                Ok(Tool::Messages(AgentMessagesToolRequest {
                    binding_id,
                    generation,
                    source_input_id,
                    attempt_id,
                    params,
                }))
            } else {
                let params = if let Some(bytes) = bytes {
                    serde_json::from_slice(&bytes)
                        .map_err(|error| bad_stdin("ItemRoundsRequest", &error))?
                } else {
                    ItemRoundsRequest {
                        item_id: item.ok_or_else(|| invalid("Explicit --item is required."))?,
                        cursor: None,
                        limit,
                        round_pages: vec![],
                    }
                };
                Ok(Tool::Rounds(AgentRoundsToolRequest {
                    binding_id,
                    generation,
                    source_input_id,
                    attempt_id,
                    params,
                }))
            }
        }
        _ => unreachable!("known method"),
    }
}
fn required_uuid(flags: &BTreeMap<&str, &str>, key: &str) -> Result<UuidV4, CoreError> {
    uuid_value(
        flags
            .get(key)
            .ok_or_else(|| invalid("Explicit --binding and --generation are required."))?,
    )
}
fn uuid_value(value: &str) -> Result<UuidV4, CoreError> {
    UuidV4::new(value).map_err(|_| invalid("Routing flags require canonical UUIDv4 values."))
}
fn read_stdin(input: &mut dyn Read) -> Result<Vec<u8>, CoreError> {
    const LIMIT: u64 = 512 * 1024;
    let mut bytes = Vec::new();
    input
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            CoreError::new(
                CoreErrorCode::IoError,
                format!("Read agent stdin: {error}"),
                "Pass one complete JSON request.",
            )
        })?;
    if bytes.len() as u64 > LIMIT {
        return Err(invalid("Agent request exceeds 512KiB."));
    }
    Ok(bytes)
}

/// Names the first serde failure (field, variant or type, with line/column) so a
/// model can correct its own request. Only the caller's own bytes are echoed.
fn bad_stdin(kind: &str, error: &serde_json::Error) -> CoreError {
    let detail: String = error
        .to_string()
        .chars()
        .map(|c| if c.is_control() { '?' } else { c })
        .take(400)
        .collect();
    invalid(&format!(
        "Stdin must contain one canonical {kind}: {detail}"
    ))
}

fn invalid(message: &str) -> CoreError {
    CoreError::new(
        CoreErrorCode::InvalidArgument,
        message,
        "Use ariadne --help; supply explicit binding/generation and canonical JSON parameters.",
    )
}
