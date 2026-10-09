//! Thin installed agent tools; native facts come from Registry, semantics from Core.
mod lenient;

use ariadne_core::{
    apply::summarize,
    native::{AgentResolver, NativeCoreService},
    *,
};
use ariadne_domain::models::*;

use std::{
    collections::BTreeMap,
    io::{Read, Write},
};

pub const HELP: &str = r#"Agent tools (explicit routing; no cwd/session default):
  ariadne read --binding UUID --generation UUID --view items [--topic ID|NUMBER] [--archived] [--limit 1..100] [--json]
  ariadne read --binding UUID --generation UUID --view topics [--archived] [--limit 1..100] [--json]
  ariadne read --binding UUID --generation UUID --json-stdin [--json]
  ariadne item messages|rounds --binding UUID --generation UUID --item ITEM [--json]
  ariadne item messages|rounds --binding UUID --generation UUID --json-stdin [--json]
  ariadne apply --binding UUID --generation UUID --json-stdin [--dry-run] [--full] [--json]
Read source scope: add both --source-input UUID and --attempt UUID, or neither.
--topic takes a topic id or its number (the `order` shown by --view topics);
--archived keeps only archived topics (and the items in them).
Stdin is the complete canonical SessionReadRequest, ItemMessagesRequest,
ItemRoundsRequest or ApplyRequest (not an actor/context envelope), at most 512KiB.
Apply stdin may leave out defaulted fields (below); creation statuses decided,
done and dropped are repaired to open with ack_to, including recursive children.
A malformed stdin request fails with exit 2 and the parser's message
(offending field, variant or type, with its position in operations); fix that
and send the corrected request. An omitted op_id is derived from the request, so
after an uncertain commit, a timeout or a killed call (exit 4 or no reply) the
identical request is safe to send again: the core replays it if it was saved
("replayed":true in the receipt) and files nothing twice. A changed request is a
new operation.
Use stdin for filters and all outer/nested continuation cursors. --json emits one
canonical envelope on stdout, including failures. Text failures use stderr.
ARIADNE_HOME selects the same existing application data directory as bridge;
the default is HOME/.ariadne. Models cannot select project/session paths.

Lenient apply input (the CLI expands it into the full ApplyRequest, then core
validates it exactly as before):
  Omit: op_id (a UUIDv4 is derived from the request and echoed in the receipt), source_input_id,
  attempt_id, input_result (null), expected_item_revisions, expected_topic_revisions
  ({}), summary (""), and any optional operation field (absent = null or empty).
  Defaults: ref on topic.add/item.add/reply = r1, r2, ...; item.add topic = the
  request's only topic.add (a child inherits its parent's topic); status =
  waiting_on_me when ask is set, else open; owner = the agent (this binding), or
  me when the status is waiting_on_me (core requires it); {"kind":"agent"} gets
  this binding; options[].id = 1, 2, ... and recommended = false; item.ask
  recipient_binding_id = this binding and options = []; input_result
  reply_refs and followup_item_refs = [].
  Nesting: item.add may carry "children": [item.add objects, recursively]. Each
  child's parent is its enclosing item, its topic is inherited, order is kept.
  Related items: item.add.related and item.edit.patch.related accept item numbers
  ("3.2"), {"id":"3.2"}, or batch references "finding" / {"ref":"finding"}.
  At most 32 related items. Omission keeps links; [] clears them. Duplicate,
  self and new missing targets fail. Re-sending a declared missing target prunes
  it; pruned_related in the receipt lists the source and removed item numbers.
  New items can link to later additions, including nested children: the CLI
  assigns those links just after their targets are created. Later explicit edits
  win. Item ids are their display numbers; read --view items shows related ids.
  Owner Ack: new items stay nonterminal. Creation status decided/done/dropped
  becomes open with ack_to = that status; outcome and why are preserved. An
  explicit open with ack_to is accepted. Choose each target deliberately:
  open if the owner just reads and work continues, in_progress if underway,
  decided/done only when truly finished once read, dropped for ruled-out work.
  There is no implicit done. New finding/explanation items without ask require
  ack_to: strict filing says "choose ack_to ..." when missing; this CLI repairs
  omission to open and reports it. Conflicting status and ack_to are refused;
  replaced creation is refused. item.status open/in_progress can set ack_to;
  item.edit patch.ack_to can change an open/in_progress Ack item's target, retaining status
  and prose. Owner Ack clears the target, preserves prose and sets that status;
  it sends no agent input. An ask can coexist, but Ack waits until no owner
  question is pending. Existing Ack terminal updates stay open for owner Ack,
  except owner-directed completion with source_input_id on that same item.
  Existing work without ack_to can close normally; item.replace clears ack_to.
  An item.add with an ask stays waiting_on_me even if open/in_progress was given;
  it may retain ack_to. item.ask also keeps an existing Ack target.
  Still required: type and question on item.add; outcome and why when changing
  an existing item to done/decided/dropped; expected_item_revisions for every
  existing item you touch.
Example (a topic, a summary item with one child, one ask with two options):
  printf '%s' '{"operations":[{"op":"topic.add","name":"Cache PR review","short":"Cache PR"},{"op":"item.add","short":"Review result","type":"finding","question":"Review finished: one race, one choice","status":"open","ack_to":"open","outcome":"Reviewed","why":"Read every changed file","children":[{"short":"Fill race","type":"finding","question":"Two writers race in fill()","status":"open","ack_to":"open","outcome":"Confirmed","why":"Reproduced locally"}]},{"op":"item.add","short":"Fallback merge","type":"decision","question":"Merge the fallback path now?","ask":"Merge now or wait?","options":[{"label":"Merge now","consequence":"Ships today"},{"label":"Wait","consequence":"Ships next week"}]}]}' | ariadne apply --binding "$B" --generation "$G" --json-stdin --json
Receipt (default, compact; data of the --json envelope):
  {"op_id":"...","session_revision":3,"topics":[{"id":"UUID","number":2,"short":"Cache PR","revision":1,"created":true}],"items":[{"id":"4","short":"Review result","revision":1,"created":true},{"id":"4.1","short":"Fill race","revision":1,"created":true}]}
  An item id is its number (1.2). revision is the value to send as the next
  expected_item_revisions entry. --full prints the complete saved receipt
  (allocated_refs, messages, every revision). Repairs are explained in the compact
  receipt's repairs array, or as stderr notes with --full, including retries.
  --dry-run runs every check against
  the current session, commits nothing and prints the same compact form with
  "dry_run":true (--full adds the full receipt shape).

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
    let result = execute(args, input, errors);
    crate::output::write(result, args.contains(&"--json"), output, errors)
}

enum Tool {
    Read(ReadCall),
    Messages(AgentMessagesToolRequest),
    Rounds(AgentRoundsToolRequest),
    Apply(ApplyCall),
}
struct ReadCall {
    request: AgentReadToolRequest,
    /// `--topic N`: resolved to the topic id once the session is reachable.
    topic_number: Option<u64>,
}
struct ApplyCall {
    request: AgentApplyToolRequest,
    dry_run: bool,
    full: bool,
    /// Set when the CLI chose the `op_id` itself.
    generated_op_id: Option<UuidV4>,
    repairs: Vec<String>,
}
fn execute(
    args: &[&str],
    input: &mut dyn Read,
    errors: &mut dyn Write,
) -> Result<serde_json::Value, CoreError> {
    let tool = parse(args, input)?;
    match &tool {
        Tool::Read(call) => call.request.validate_wire()?,
        Tool::Messages(request) => request.validate_wire()?,
        Tool::Rounds(request) => request.validate_wire()?,
        Tool::Apply(call) => call.request.validate_wire()?,
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
        Tool::Read(call) => (
            &call.request.binding_id,
            &call.request.generation,
            &call.request.source_input_id,
            &call.request.attempt_id,
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
        Tool::Apply(call) => (
            &call.request.binding_id,
            &call.request.generation,
            &call.request.request.source_input_id,
            &call.request.request.attempt_id,
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
        Tool::Apply(call) => {
            let generated = call.generated_op_id.clone();
            let notes = if call.full {
                call.repairs.clone()
            } else {
                vec![]
            };
            let result = run_apply(&core, context, call, errors)
                .map_err(|error| name_generated_op(error, generated));
            if result.is_ok() {
                for note in notes {
                    // Advisory stderr must not turn a saved receipt into an apply failure.
                    let _ = writeln!(errors, "Repair: {note}");
                }
            }
            result
        }
        query => {
            let request = match query {
                Tool::Read(call) => {
                    let mut params = call.request.params;
                    if let Some(number) = call.topic_number {
                        let topic = topic_by_number(&core, &context, number)?;
                        if let ReadView::Items { topic_id, .. } = &mut params.selection {
                            *topic_id = Some(topic);
                        }
                    }
                    QueryRequest::SessionRead(params)
                }
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

/// Real apply prints the compact receipt (or the full one); `--dry-run` runs every
/// check against the current session and writes nothing.
fn run_apply(
    core: &NativeCoreService,
    context: AgentContext,
    mut call: ApplyCall,
    errors: &mut dyn Write,
) -> Result<serde_json::Value, CoreError> {
    let request = call.request.request;
    if call.dry_run {
        let (preview, repairs) = core.apply_preview_lenient(&context, &request)?;
        if call.full {
            for repair in &repairs {
                let _ = writeln!(errors, "Repair: {repair}");
            }
        }
        call.repairs.extend(repairs);
        let mut shown = if call.full {
            value(serde_json::to_value(&preview.receipt))?
        } else {
            value(serde_json::to_value(summarize(
                &preview.session,
                &preview.receipt,
            )?))?
        };
        if let Some(object) = shown.as_object_mut() {
            object.insert("dry_run".into(), true.into());
            if preview.replayed {
                object.insert("replayed".into(), true.into());
            }
            if !call.full && !call.repairs.is_empty() {
                object.insert("repairs".into(), serde_json::json!(call.repairs));
            }
        }
        return Ok(shown);
    }
    let (receipt, replayed, repairs) = core.apply_lenient(&context, &request)?;
    if call.full {
        for repair in &repairs {
            let _ = writeln!(errors, "Repair: {repair}");
        }
    }
    call.repairs.extend(repairs);
    let mut shown = None;
    if !call.full {
        // The commit already happened: a failed summary must not read as a failed apply.
        if let Ok(summary) = core.apply_summary(&context, &receipt) {
            shown = Some(value(serde_json::to_value(summary))?);
        }
    }
    let mut shown = match shown {
        Some(shown) => shown,
        None => value(serde_json::to_value(receipt))?,
    };
    if replayed && !call.full {
        if let Some(object) = shown.as_object_mut() {
            object.insert("replayed".into(), true.into());
        }
    }
    if !call.full && !call.repairs.is_empty() {
        if let Some(object) = shown.as_object_mut() {
            object.insert("repairs".into(), serde_json::json!(call.repairs));
        }
    }
    Ok(shown)
}

/// Number of a topic as `--view topics` shows it (`order`) to its id.
fn topic_by_number(
    core: &NativeCoreService,
    context: &AgentContext,
    number: u64,
) -> Result<UuidV4, CoreError> {
    let mut cursor = None;
    loop {
        let result = core.query(
            QueryContext::agent(context.clone()),
            QueryRequest::SessionRead(SessionReadRequest {
                selection: ReadView::Topics { archived: None },
                cursor: cursor.take(),
                limit: PageLimit::new(100).expect("literal page limit"),
                item_pages: vec![],
            }),
        )?;
        let QueryResult::SessionRead(SessionReadResult::Topics(page)) = result else {
            return Err(invalid("The topic list came back in another shape."));
        };
        if let Some(topic) = page.items.iter().find(|t| t.order.value() == number) {
            return Ok(topic.id.clone());
        }
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => {
                return Err(CoreError::new(
                    CoreErrorCode::NotFound,
                    format!("This session has no topic number {number}."),
                    "Run ariadne read --view topics to list topic ids and numbers.",
                ))
            }
        }
    }
}

/// The CLI derives an omitted `op_id` from the request, so after an uncertain
/// commit the identical request is safe to send again: the core replays it if it
/// was saved. The id is named for a caller that wants to pin it.
fn name_generated_op(mut error: CoreError, generated: Option<UuidV4>) -> CoreError {
    if let (Some(id), CoreErrorCode::CommitUncertain | CoreErrorCode::IoError) =
        (generated, &error.code)
    {
        let note = format!(
            " Sending the identical request again is safe: it replays if it was saved, and files once. The CLI used op_id {}.",
            id.as_str()
        );
        if error.hint.len() + note.len() <= 4096 {
            error.hint.push_str(&note);
        }
    }
    error
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
            "--json" | "--json-stdin" | "--dry-run" | "--full" | "--archived" => "",
            "--binding" | "--generation" | "--source-input" | "--attempt" | "--view" | "--item"
            | "--limit" | "--topic" => {
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
        && ["--view", "--item", "--limit", "--topic", "--archived"]
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
                    "--binding"
                        | "--generation"
                        | "--json"
                        | "--json-stdin"
                        | "--dry-run"
                        | "--full"
                )
            }))
    {
        return Err(invalid(
            "Apply source and revision guards belong in the full stdin request.",
        ));
    }
    if method != "apply" && (flags.contains_key("--dry-run") || flags.contains_key("--full")) {
        return Err(invalid("--dry-run and --full apply only to ariadne apply."));
    }
    let topic = flags.get("--topic").copied();
    let archived = flags.contains_key("--archived");
    if (topic.is_some() || archived) && method != "read" {
        return Err(invalid(
            "--topic and --archived apply only to ariadne read.",
        ));
    }
    let view = flags.get("--view").copied().unwrap_or("items");
    if topic.is_some() && view != "items" {
        return Err(invalid("--topic applies to --view items."));
    }
    if archived && !matches!(view, "items" | "topics") {
        return Err(invalid("--archived applies to --view items or topics."));
    }
    // A topic is a UUID, or its number (digits only; a UUID always has hyphens).
    let (topic_id, topic_number) = match topic {
        None => (None, None),
        Some(value) if value.bytes().all(|b| b.is_ascii_digit()) && !value.is_empty() => {
            let number = value
                .parse::<u64>()
                .ok()
                .filter(|number| PositiveSafeInteger::new(*number).is_ok())
                .ok_or_else(|| invalid("A topic number must be a positive integer."))?;
            (None, Some(number))
        }
        Some(value) => (
            Some(UuidV4::new(value).map_err(|_| {
                invalid("--topic takes a topic UUID or its number from --view topics.")
            })?),
            None,
        ),
    };
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
            let expanded = lenient::expand(&bytes, &binding_id)?;
            expanded.request.validate_wire()?;
            Ok(Tool::Apply(ApplyCall {
                request: AgentApplyToolRequest {
                    binding_id,
                    generation,
                    request: expanded.request,
                },
                dry_run: flags.contains_key("--dry-run"),
                full: flags.contains_key("--full"),
                generated_op_id: expanded.generated_op_id,
                repairs: expanded.repairs,
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
                let archived = archived.then_some(true);
                let selection = match view {
                    "items" => ReadView::Items {
                        topic_id,
                        item_id: None,
                        parent_item_id: None,
                        statuses: vec![],
                        archived,
                    },
                    "topics" => ReadView::Topics { archived },
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
            Ok(Tool::Read(ReadCall {
                request: AgentReadToolRequest {
                    binding_id,
                    generation,
                    source_input_id,
                    attempt_id,
                    params,
                },
                topic_number,
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
    bad_detail(kind, &error.to_string())
}

/// A lenient-apply failure that has no line/column, such as `operations[2] (item.add): ...`.
fn bad_request(detail: String) -> CoreError {
    bad_detail("ApplyRequest", &detail)
}

fn bad_detail(kind: &str, detail: &str) -> CoreError {
    let detail: String = detail
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uncertain_generated_operations_explain_that_an_identical_resend_is_safe() {
        let id = UuidV4::new("00000000-0000-4000-8000-000000000003").unwrap();
        for code in [CoreErrorCode::CommitUncertain, CoreErrorCode::IoError] {
            let error = CoreError::new(code, "Save failed", "Inspect the receipt.");
            let named = name_generated_op(error.clone(), Some(id.clone()));
            assert!(named
                .hint
                .contains("Sending the identical request again is safe"));
            assert!(named.hint.contains(id.as_str()));
            assert_eq!(named.code, error.code);
            assert_eq!(named.message, error.message);
            assert_eq!(name_generated_op(error.clone(), None).hint, error.hint);
        }
        let error = invalid("Fix the request.");
        assert_eq!(name_generated_op(error.clone(), Some(id)).hint, error.hint);
    }
}
