//! Typed command normalization; route, actor and hashing belong to Store.
use crate::{CoreError, CoreErrorCode};
use serde::Serialize;
use serde_json::Value;

pub(crate) fn normalized(kind: &str, params: &impl Serialize) -> Result<Value, CoreError> {
    #[derive(Serialize)]
    struct Intent<'a, T> {
        command: &'a str,
        params: &'a T,
    }
    serde_json::to_value(Intent {
        command: kind,
        params,
    })
    .map_err(|_| {
        CoreError::new(
            CoreErrorCode::InvalidArgument,
            "Cannot normalize the typed owner command",
            "Submit a valid owner command.",
        )
    })
}
