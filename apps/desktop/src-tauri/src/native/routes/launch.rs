use ariadne_core::{CoreError, CoreErrorCode, OpenRoute};

/// App argv contains only an optional explicit canonical route; cwd is ignored.
pub(crate) fn parse(args: &[String]) -> Result<Option<OpenRoute>, CoreError> {
    if !args.iter().skip(1).any(|arg| arg == "--ariadne-route") {
        return Ok(None);
    }
    let [_, flag, json] = args else {
        return Err(invalid());
    };
    if flag != "--ariadne-route" || json.len() > 512 * 1024 {
        return Err(invalid());
    }
    serde_json::from_str(json).map(Some).map_err(|_| invalid())
}
fn invalid() -> CoreError {
    CoreError::new(
        CoreErrorCode::InvalidArgument,
        "Native launch arguments do not contain one valid bounded route.",
        "Use ariadne open with explicit registered project/session IDs.",
    )
}

#[cfg(test)]
#[path = "tests/launch.rs"]
mod tests;
