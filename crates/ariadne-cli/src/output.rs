//! One canonical JSON envelope or human text, with errors on stderr in text mode.
use ariadne_core::{
    ApplicationEnvelope, CoreError, FailureEnvelope, FailureFlag, SuccessEnvelope, SuccessFlag,
};
use ariadne_domain::models::SchemaVersion;
use std::io::Write;

pub fn write(
    result: Result<serde_json::Value, CoreError>,
    json: bool,
    output: &mut dyn Write,
    errors: &mut dyn Write,
) -> i32 {
    let result = result.map_err(ariadne_runtime::control::validated_error);
    let exit = result
        .as_ref()
        .err()
        .map_or(0, |error| error.code.cli_exit());
    let written = if json {
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
        serde_json::to_writer(&mut *output, &envelope)
            .map_err(std::io::Error::other)
            .and_then(|()| output.write_all(b"\n"))
    } else {
        match result {
            Ok(data) => serde_json::to_writer_pretty(&mut *output, &data)
                .map_err(std::io::Error::other)
                .and_then(|()| output.write_all(b"\n")),
            Err(error) => writeln!(
                errors,
                "{:?}: {}\n{}",
                error.code, error.message, error.hint
            ),
        }
    };
    if written.is_err() {
        4
    } else {
        exit
    }
}
