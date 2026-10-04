use super::NativeConfiguration;
use ariadne_adapter_claude::ClaudeOptions;
use ariadne_adapter_codex::CodexOptions;
use ariadne_core::{CoreError, CoreErrorCode};
use ariadne_domain::models::EndpointRef;
use ariadne_runtime::discovery::CodexEndpoint;
use std::{
    collections::BTreeMap,
    path::{Component, PathBuf},
};

impl NativeConfiguration {
    /// Pure startup parsing. Only the first instance consumes provider flags;
    /// second-instance arguments stay navigation data in the existing plugin.
    /// These reads select existing documented data-root names, never credentials.
    pub fn from_startup_args(args: &[String]) -> Result<Self, CoreError> {
        Self::parse(args, |name| std::env::var_os(name).map(PathBuf::from))
    }
    fn parse(
        args: &[String],
        environment: impl Fn(&str) -> Option<PathBuf>,
    ) -> Result<Self, CoreError> {
        let mut flags = BTreeMap::new();
        let mut args = args.iter();
        while let Some(flag) = args.next() {
            if flag == "--ariadne-route" {
                args.next().ok_or_else(invalid)?;
                continue;
            }
            if !matches!(
                flag.as_str(),
                "--claude-executable"
                    | "--claude-plugin"
                    | "--ariadne-helper"
                    | "--codex-executable"
                    | "--codex-home"
                    | "--codex-endpoint"
            ) {
                return Err(invalid());
            }
            let value = args.next().ok_or_else(invalid)?;
            if flags
                .insert(flag.as_str(), absolute(PathBuf::from(value))?)
                .is_some()
            {
                return Err(invalid());
            }
        }
        let home = absolute(
            environment("ARIADNE_HOME")
                .or_else(|| environment("HOME").map(|home| home.join(".ariadne")))
                .ok_or_else(invalid)?,
        )?;
        let claude = match (
            flags.get("--claude-executable"),
            flags.get("--claude-plugin"),
            flags.get("--ariadne-helper"),
        ) {
            (Some(executable), Some(installed_plugin), Some(helper)) => Some(ClaudeOptions {
                executable: executable.clone(),
                installed_plugin: installed_plugin.clone(),
                helper: helper.clone(),
                project_root: home.clone(),
                app_version: env!("CARGO_PKG_VERSION").into(),
            }),
            _ => None,
        };
        let codex = flags
            .get("--codex-executable")
            .map(|executable| {
                let home = flags
                    .get("--codex-home")
                    .cloned()
                    .or_else(|| environment("CODEX_HOME"))
                    .or_else(|| environment("HOME").map(|home| home.join(".codex")))
                    .ok_or_else(invalid)?;
                CodexOptions::new(executable.clone(), absolute(home)?).map_err(CoreError::from)
            })
            .transpose()?;
        let discovery_endpoints = if let Some(options) = &codex {
            let endpoint = match flags.get("--codex-endpoint") {
                Some(path) => EndpointRef::UnixSocket {
                    path: path.to_str().ok_or_else(invalid)?.into(),
                },
                None => options.default_endpoint().map_err(CoreError::from)?,
            };
            vec![CodexEndpoint {
                options: options.clone(),
                endpoint,
            }]
        } else {
            vec![]
        };
        Ok(Self {
            home,
            claude,
            codex,
            discovery_endpoints,
        })
    }
}
fn absolute(path: PathBuf) -> Result<PathBuf, CoreError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
        || path.as_os_str().is_empty()
    {
        return Err(invalid());
    }
    Ok(path)
}
fn invalid() -> CoreError {
    CoreError::new(CoreErrorCode::InvalidArgument,
        "Native startup requires documented data roots and explicit absolute provider paths.",
        "Use ARIADNE_HOME or HOME and matching installed provider/helper/Mod paths; no provider is launched or discovered through PATH.")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }
    #[test]
    fn native_configuration_is_pure_explicit_and_preserves_existing_data_root_defaults() {
        let environment = |name| (name == "HOME").then(|| PathBuf::from("/absent/user"));
        let config = NativeConfiguration::parse(&[], environment).unwrap();
        assert_eq!(config.home, PathBuf::from("/absent/user/.ariadne"));
        assert!(config.claude.is_none() && config.codex.is_none());
        let config = NativeConfiguration::parse(
            &args(&["--codex-executable", "/absent/bin/codex"]),
            environment,
        )
        .unwrap();
        assert_eq!(
            config.codex.as_ref().unwrap().codex_home,
            PathBuf::from("/absent/user/.codex")
        );
        assert_eq!(
            config.discovery_endpoints[0].endpoint,
            EndpointRef::UnixSocket {
                path: "/absent/user/.codex/app-server-control/app-server-control.sock".into(),
            }
        );
        assert!(NativeConfiguration::parse(
            &args(&["--claude-executable", "relative"]),
            environment
        )
        .is_err());
        assert!(NativeConfiguration::parse(
            &args(&[
                "--codex-executable",
                "/bin/codex",
                "--codex-executable",
                "/bin/other"
            ]),
            environment
        )
        .is_err());
        assert!(NativeConfiguration::parse(&args(&["--codex-home"]), environment).is_err());
    }
}
