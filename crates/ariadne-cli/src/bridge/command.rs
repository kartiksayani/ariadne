//! Structured executable bridge route; production report composition stays explicit.
use super::{claim, connection_status};
use ariadne_core::{
    ApplicationEnvelope, ClaimRequest, CoreError, CoreErrorCode, FailureEnvelope, FailureFlag,
    SuccessEnvelope, SuccessFlag,
};
use ariadne_domain::models::{SchemaVersion, UuidV4};
use std::{
    io::{Read, Write},
    path::PathBuf,
};

fn invalid(message: &str) -> CoreError {
    CoreError::new(CoreErrorCode::InvalidArgument, message, "Use bridge claim --binding UUID --generation UUID --request-id UUID; retain request-id on retry.")
}
pub fn home_from_environment() -> Result<PathBuf, CoreError> {
    std::env::var_os("ARIADNE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".ariadne")))
        .ok_or_else(|| invalid("Set ARIADNE_HOME or HOME for the fixed private control endpoint."))
}
pub fn run(args: &[&str], input: &mut dyn Read, output: &mut dyn Write) -> i32 {
    let result = execute(args, input);
    let (envelope, exit) = match result {
        Ok(data) => (
            ApplicationEnvelope::Success(SuccessEnvelope {
                api_version: SchemaVersion::new(1).expect("schema version 1"),
                ok: SuccessFlag,
                data,
            }),
            0,
        ),
        Err(error) => {
            let error = ariadne_runtime::control::validated_error(error);
            let exit = error.code.cli_exit();
            (
                ApplicationEnvelope::Failure(FailureEnvelope {
                    api_version: SchemaVersion::new(1).expect("schema version 1"),
                    ok: FailureFlag,
                    error,
                }),
                exit,
            )
        }
    };
    if serde_json::to_writer(&mut *output, &envelope).is_err() || output.write_all(b"\n").is_err() {
        return 4;
    }
    exit
}
fn execute(args: &[&str], input: &mut dyn Read) -> Result<serde_json::Value, CoreError> {
    let Some((method, rest)) = args.split_first() else {
        return Err(invalid("A bridge method is required."));
    };
    let mut binding = None;
    let mut generation = None;
    let mut request_id = None;
    let mut json_stdin = false;
    let mut index = 0;
    while index < rest.len() {
        let name = rest[index];
        if name == "--json-stdin" {
            if json_stdin {
                return Err(invalid("Repeated --json-stdin flag."));
            }
            json_stdin = true;
            index += 1;
            continue;
        }
        let target = match name {
            "--binding" => &mut binding,
            "--generation" => &mut generation,
            "--request-id" => &mut request_id,
            _ => return Err(invalid("Unknown bridge flag.")),
        };
        if target.is_some() {
            return Err(invalid("Repeated bridge routing flag."));
        }
        let value = rest
            .get(index + 1)
            .ok_or_else(|| invalid("Bridge routing flag requires a UUID."))?;
        *target = Some(
            UuidV4::new(*value)
                .map_err(|_| invalid("Bridge routing flags require canonical UUIDv4 values."))?,
        );
        index += 2;
    }
    let binding_id = binding.ok_or_else(|| invalid("Explicit --binding is required."))?;
    let generation = generation.ok_or_else(|| invalid("Explicit --generation is required."))?;
    match *method {
        "connection-status" => {
            if json_stdin {
                return Err(invalid("Connection status does not accept stdin payloads."));
            }
            let request_id = request_id.ok_or_else(|| {
                invalid("Explicit --request-id is required for status correlation.")
            })?;
            serde_json::to_value(connection_status(
                home_from_environment()?,
                binding_id,
                generation,
                request_id,
            )?)
            .map_err(|_| invalid("Cannot serialize canonical binding summary."))
        }
        "claim" => {
            if json_stdin {
                return Err(invalid("Claim does not accept stdin payloads."));
            }
            let request_id =
                request_id.ok_or_else(|| invalid("Explicit stable --request-id is required."))?;
            serde_json::to_value(claim(
                home_from_environment()?,
                ClaimRequest {
                    binding_id,
                    generation,
                    request_id,
                },
            )?)
            .map_err(|_| invalid("Cannot serialize canonical prepared claim."))
        }
        "report" => {
            if request_id.is_some() || !json_stdin {
                return Err(invalid(
                    "Report requires --json-stdin and has no claim request-id.",
                ));
            }
            let mut bytes = Vec::new();
            input
                .take((control_limit() + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|e| {
                    CoreError::new(
                        CoreErrorCode::HostUnreachable,
                        format!("Read bridge report input: {e}"),
                        "Pass one complete normalized event through --json-stdin.",
                    )
                })?;
            if bytes.len() > control_limit() {
                return Err(invalid("Bridge report JSON exceeds 1MiB."));
            }
            let event: ariadne_agent_protocol::NormalizedEvent = serde_json::from_slice(&bytes)
                .map_err(|_| {
                    invalid("Report stdin must contain one canonical normalized event.")
                })?;
            event.validate().map_err(CoreError::from)?;
            if event.binding_id != binding_id || event.generation != generation {
                return Err(invalid(
                    "Report event and explicit binding/generation disagree.",
                ));
            }
            Err(CoreError::new(CoreErrorCode::Unsupported, "Production bridge report composition is not available yet; no lifecycle event was persisted.", "P2.2 core persistence and P1.4/P3.2 registered routing must be composed before this executable can report. Retain the same event ID for later reporting."))
        }
        _ => Err(invalid("Unknown bridge method.")),
    }
}
fn control_limit() -> usize {
    ariadne_runtime::control::MAX_FRAME_BYTES
}
