//! Read-only build seam for the canonical immutable integration bundle.
use super::{invalid, resources};
use ariadne_core::CoreError;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Component, Path},
};

pub fn export(args: &[&str]) -> Result<Value, CoreError> {
    let ["--helper-path", helper] = args else {
        return Err(invalid(
            "Expected package-resources --helper-path /absolute/version/bin/ariadne.",
        ));
    };
    let path = Path::new(helper);
    // The future immutable path need not exist. Reject lexical aliases rather
    // than canonicalizing a staging path or reading any user installation.
    if !path.is_absolute()
        || helper.as_bytes().contains(&0)
        || path
            .components()
            .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
        || path.to_str() != Some(*helper)
        || path.components().collect::<std::path::PathBuf>().to_str() != Some(*helper)
    {
        return Err(invalid(
            "The package helper path must be absolute and normalized.",
        ));
    }
    let files: BTreeMap<String, String> = resources::bundle(path)
        .into_iter()
        .map(|(name, bytes)| String::from_utf8(bytes).map(|text| (name, text)))
        .collect::<Result<_, _>>()
        .map_err(|_| invalid("The bundled package resources are not UTF-8."))?;
    Ok(json!({"schema_version":1,"version":resources::VERSION,"files":files}))
}

pub fn run(args: &[&str], output: &mut dyn Write, errors: &mut dyn Write) -> i32 {
    crate::output::write(export(args), false, output, errors)
}
