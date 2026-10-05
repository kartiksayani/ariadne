use ariadne_core::*;
use ariadne_domain::models::{SchemaVersion, UuidV4};
use rmcp::model::*;
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

type ResolveAgent = dyn Fn(UuidV4, UuidV4, Option<UuidV4>, Option<UuidV4>) -> Result<AgentContext, CoreError>
    + Send
    + Sync;

/// Trusted native startup supplies the actual service and registered binding
/// resolver. Tool callers cannot install either or choose an actor/path/ceiling.
#[derive(Clone)]
pub struct AgentMcpService {
    core: Arc<dyn CoreService>,
    resolve: Arc<ResolveAgent>,
    tools: Arc<Vec<Tool>>,
}
impl AgentMcpService {
    pub fn from_trusted_startup(
        core: Arc<dyn CoreService>,
        resolve: impl Fn(UuidV4, UuidV4, Option<UuidV4>, Option<UuidV4>) -> Result<AgentContext, CoreError>
            + Send
            + Sync
            + 'static,
    ) -> Result<Self, CoreError> {
        Ok(Self {
            core,
            resolve: Arc::new(resolve),
            tools: Arc::new(manifest()?),
        })
    }
    async fn call(
        &self,
        name: &str,
        arguments: Option<JsonObject>,
    ) -> Result<CallToolResult, ErrorData> {
        if !self.tools.iter().any(|tool| tool.name == name) {
            return Err(ErrorData::invalid_params(
                "Unknown bounded agent tool",
                None,
            ));
        }
        let call = decode(name, Value::Object(arguments.unwrap_or_default()));
        let operation_id = call.as_ref().ok().and_then(|call| match &call.operation {
            Operation::Apply(request) => Some(request.op_id.clone()),
            Operation::Query(_) => None,
        });
        let result = match call {
            Err(error) => Err(error),
            Ok(call) => {
                let service = self.clone();
                tokio::task::spawn_blocking(move || service.execute(call)).await
                    .unwrap_or_else(|_| Err(CoreError::new(
                        if operation_id.is_some() { CoreErrorCode::CommitUncertain } else { CoreErrorCode::IoError },
                        "Native agent tool worker ended before returning a result.",
                        match &operation_id {
                            Some(id) => format!("Effects may exist. Reconcile original operation {} before retrying; do not allocate a new operation ID.", id.as_str()),
                            None => "Keep the last valid query and inspect the local service before retrying.".into(),
                        },
                    )))
            }
        };
        Ok(tool_result(result))
    }
    fn execute(&self, call: Call) -> Result<Value, CoreError> {
        let context = (self.resolve)(
            call.binding_id.clone(),
            call.generation.clone(),
            call.source.clone(),
            call.attempt.clone(),
        )?;
        let matching_scope = match (context.read_scope(), &call.source, &call.attempt) {
            (AgentReadScope::Terminal { .. }, None, None) => true,
            (
                AgentReadScope::Dispatched {
                    source_input_id,
                    attempt_id,
                    ..
                },
                Some(source),
                Some(attempt),
            ) => source_input_id == source && attempt_id == attempt,
            _ => false,
        };
        if context.binding_id() != &call.binding_id
            || context.generation() != &call.generation
            || !matching_scope
        {
            return Err(CoreError::new(
                CoreErrorCode::BindingMismatch,
                "Trusted agent lookup returned a different scope.",
                "Resolve the original binding and source scope again.",
            ));
        }
        match call.operation {
            Operation::Apply(request) => {
                let receipt = self.core.apply(context.clone(), request.clone())?;
                validate_apply_receipt(&receipt, &context, &request)?;
                serde_json::to_value(receipt)
                    .map_err(|_| invalid("Cannot encode canonical apply receipt."))
            }
            Operation::Query(request) => {
                let context = QueryContext::agent(context);
                let result = self.core.query(context.clone(), request.clone())?;
                result.validate_for(&context, &request)?;
                serde_json::to_value(result)
                    .map_err(|_| invalid("Cannot encode canonical query result."))
            }
        }
    }
}
impl ServerHandler for AgentMcpService {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("ariadne", env!("CARGO_PKG_VERSION")))
            .with_instructions("Use an explicit registered binding_id and generation on every call. Preserve exact operation IDs and request content for Apply retries; no owner or provider tools are exposed.")
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        if request.is_some_and(|request| request.cursor.is_some()) {
            return Err(ErrorData::invalid_params(
                "Tool list has no continuation cursor",
                None,
            ));
        }
        Ok(ListToolsResult::with_all_items(self.tools.as_ref().clone()))
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if request.input_responses.is_some() || request.request_state.is_some() {
            return Err(ErrorData::invalid_params(
                "Agent tools do not accept multi-round request state",
                None,
            ));
        }
        self.call(&request.name, request.arguments)
            .await
            .map(Into::into)
    }
    // Leave SDK automatic schema-validation disabled. Canonical typed decoding
    // and validation below return actionable domain failures with isError=true.
}

struct Call {
    binding_id: UuidV4,
    generation: UuidV4,
    source: Option<UuidV4>,
    attempt: Option<UuidV4>,
    operation: Operation,
}
enum Operation {
    Query(QueryRequest),
    Apply(ApplyRequest),
}
fn decode(name: &str, arguments: Value) -> Result<Call, CoreError> {
    if serde_json::to_vec(&arguments)
        .map_err(|_| invalid("Invalid tool arguments"))?
        .len()
        > 512 * 1024
    {
        return Err(invalid("Canonical tool arguments exceed 512KiB."));
    }
    macro_rules! query {
        ($ty:ty, $variant:ident) => {{
            let request: $ty = serde_json::from_value(arguments)
                .map_err(|_| invalid("Tool arguments do not match the canonical schema."))?;
            request.validate_wire()?;
            Call {
                binding_id: request.binding_id,
                generation: request.generation,
                source: request.source_input_id,
                attempt: request.attempt_id,
                operation: Operation::Query(QueryRequest::$variant(request.params)),
            }
        }};
    }
    Ok(match name {
        "session_read" => query!(AgentReadToolRequest, SessionRead),
        "item_messages" => query!(AgentMessagesToolRequest, ItemMessages),
        "item_rounds" => query!(AgentRoundsToolRequest, ItemRounds),
        "apply" => {
            let request: AgentApplyToolRequest = serde_json::from_value(arguments)
                .map_err(|_| invalid("Tool arguments do not match the canonical schema."))?;
            request.validate_wire()?;
            Call {
                binding_id: request.binding_id,
                generation: request.generation,
                source: request.request.source_input_id.clone(),
                attempt: request.request.attempt_id.clone(),
                operation: Operation::Apply(request.request),
            }
        }
        _ => return Err(invalid("Unknown bounded agent tool.")),
    })
}
fn invalid(message: &str) -> CoreError {
    CoreError::new(
        CoreErrorCode::InvalidArgument,
        message,
        "Use the canonical tool schema with explicit binding/generation and exact request content.",
    )
}
fn fallback() -> CoreError {
    CoreError::new(CoreErrorCode::ProtocolConflict, "Native service returned an invalid canonical envelope.", "Effects may exist. Reconcile the original operation ID and exact request before retrying; do not allocate a new operation ID.")
}
fn tool_result(result: Result<Value, CoreError>) -> CallToolResult {
    let result = result.map_err(|error| {
        if error.validate().is_ok() {
            error
        } else {
            fallback()
        }
    });
    let envelope = match result {
        Ok(data) => ApplicationEnvelope::Success(SuccessEnvelope {
            api_version: SchemaVersion::new(1).expect("literal"),
            ok: SuccessFlag,
            data,
        }),
        Err(error) => ApplicationEnvelope::Failure(FailureEnvelope {
            api_version: SchemaVersion::new(1).expect("literal"),
            ok: FailureFlag,
            error,
        }),
    };
    let mut value = serde_json::to_value(envelope).expect("canonical JSON values");
    if serde_json::to_vec(&value).expect("JSON value").len() > 1024 * 1024 {
        value = serde_json::to_value(ApplicationEnvelope::<Value>::Failure(FailureEnvelope { api_version: SchemaVersion::new(1).expect("literal"), ok: FailureFlag, error: CoreError::new(CoreErrorCode::CapacityExceeded, "Canonical application envelope exceeds 1MiB.", "Use the canonical page continuations; preserve original Apply operation IDs for reconciliation.") })).expect("canonical error");
    }
    if value["ok"] == false {
        CallToolResult::structured_error(value)
    } else {
        CallToolResult::structured(value)
    }
}

#[derive(Deserialize)]
struct Manifest {
    api_version: u64,
    tools: Vec<Definition>,
}
#[derive(Deserialize)]
struct Definition {
    name: String,
    #[serde(rename = "inputSchema")]
    input_schema: JsonObject,
    output_schema: String,
}
fn manifest() -> Result<Vec<Tool>, CoreError> {
    let manifest: Manifest = serde_json::from_str(include_str!(
        "../../../contracts/generated/core/mcp-tools.json"
    ))
    .map_err(|_| fallback())?;
    if manifest.api_version != 1
        || manifest
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>()
            != ["session_read", "item_messages", "item_rounds", "apply"]
    {
        return Err(fallback());
    }
    manifest.tools.into_iter().map(|definition| {
        let schema = match definition.output_schema.as_str() {
            "ApplicationEnvelope_QueryResult" => include_str!("../../../contracts/generated/core/ApplicationEnvelope_QueryResult.schema.json"),
            "ApplicationEnvelope_SavedReceipt" => include_str!("../../../contracts/generated/core/ApplicationEnvelope_SavedReceipt.schema.json"),
            _ => return Err(fallback()),
        };
        let description = match definition.name.as_str() {
            "session_read" => "Read a bounded page of items, topics, messages or inputs for an explicit binding and generation.",
            "item_messages" => "Read a bounded page of the full message history of one explicit item.",
            "item_rounds" => "Read a bounded page of the ask rounds of one explicit item.",
            _ => "Publish replies, item changes and the input result as one atomic ApplyRequest; retry uncertain saves with the same op_id and bytes.",
        };
        let mut tool = Tool::new_with_raw(definition.name, Some(description.into()), definition.input_schema);
        tool.output_schema = Some(Arc::new(serde_json::from_str(schema).map_err(|_| fallback())?));
        Ok(tool)
    }).collect()
}

#[cfg(test)]
mod tests;
