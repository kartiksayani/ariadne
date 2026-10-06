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
    /// Startup parsing. Only the first instance consumes provider flags;
    /// second-instance arguments stay navigation data in the existing plugin.
    /// Flags win; absent providers come from `<home>/providers.json` (see `read_provider_file`).
    /// These reads select existing documented data-root names, never credentials.
    pub fn from_startup_args(args: &[String]) -> Result<Self, CoreError> {
        Self::parse(args.get(1..).ok_or_else(invalid)?, |name| {
            std::env::var_os(name).map(PathBuf::from)
        })
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
        // Claude is trusted for its own version report, so it needs no executable:
        // the installed Mod and helper come from the app's own package. The flags
        // override that for isolated runs. Nothing is searched on PATH.
        if flags.contains_key("--claude-executable") {
            eprintln!(
                "Ariadne ignores --claude-executable; Claude's version comes from the loaded Mod."
            );
        }
        let package = environment("HOME")
            .map(|home| home.join(".local/share/ariadne"))
            .filter(|root| root.is_absolute() && root.join("current").is_dir());
        let packaged = |relative: &str| {
            package
                .as_ref()
                .map(|root| root.join("current").join(relative))
        };
        let installed_plugin = flags
            .get("--claude-plugin")
            .cloned()
            .or_else(|| packaged("integrations/claude-mod/plugin"));
        let helper = flags
            .get("--ariadne-helper")
            .cloned()
            .or_else(|| packaged("bin/ariadne"));
        let claude = installed_plugin
            .zip(helper.clone())
            .map(|(installed_plugin, helper)| ClaudeOptions {
                installed_plugin,
                helper,
                project_root: home.clone(),
                app_version: env!("CARGO_PKG_VERSION").into(),
            });
        // Codex: flags win; otherwise the path `ariadne setup` recorded.
        let flag_codex = flags.get("--codex-executable");
        let recorded = if flag_codex.is_some() {
            None
        } else {
            read_provider_file(&home)
        };
        let codex = match flag_codex {
            Some(executable) => {
                let codex_home = flags
                    .get("--codex-home")
                    .cloned()
                    .or_else(|| environment("CODEX_HOME"))
                    .or_else(|| environment("HOME").map(|home| home.join(".codex")))
                    .ok_or_else(invalid)?;
                Some(
                    CodexOptions::new(executable.clone(), absolute(codex_home)?)
                        .map_err(CoreError::from)?,
                )
            }
            None => recorded
                .as_ref()
                .and_then(|file| file.codex.as_ref())
                .and_then(|entry| {
                    let codex_home = flags
                        .get("--codex-home")
                        .cloned()
                        .unwrap_or_else(|| entry.home.clone());
                    // A bad recorded entry must not stop the app from starting.
                    CodexOptions::new(entry.executable.clone(), codex_home).ok()
                }),
        };
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
        let default_home = environment("HOME").map(|home| home.join(".ariadne"));
        let cli_invocation = cli_invocation(helper.as_ref(), &home, default_home.as_deref());
        Ok(Self {
            home,
            claude,
            codex,
            discovery_endpoints,
            cli_invocation,
        })
    }
}
const PROVIDER_FILE: &str = "providers.json";
const PROVIDER_FILE_LIMIT: u64 = 64 * 1024;

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordedCodex {
    executable: PathBuf,
    home: PathBuf,
}
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderFile {
    schema_version: u32,
    codex: Option<RecordedCodex>,
}

/// Reads the paths `ariadne setup` recorded. A missing file is normal; an unsafe or
/// malformed one is ignored (one line on stderr) and never stops startup.
fn read_provider_file(home: &std::path::Path) -> Option<ProviderFile> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let path = home.join(PROVIDER_FILE);
    let read = || -> Result<Option<ProviderFile>, &'static str> {
        let link = match std::fs::symlink_metadata(&path) {
            Ok(link) => link,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("it cannot be inspected"),
        };
        if !link.file_type().is_file() {
            return Err("it is not a regular file");
        }
        if link.permissions().mode() & 0o022 != 0 {
            return Err("it is writable by group or others");
        }
        if link.len() > PROVIDER_FILE_LIMIT {
            return Err("it is larger than 64 KiB");
        }
        // The opened file must be the inspected one, so a swapped-in link is never followed.
        let file = std::fs::File::open(&path).map_err(|_| "it cannot be opened")?;
        let opened = file.metadata().map_err(|_| "it cannot be inspected")?;
        if opened.dev() != link.dev() || opened.ino() != link.ino() {
            return Err("it changed while being read");
        }
        let mut bytes = Vec::new();
        file.take(PROVIDER_FILE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "it cannot be read")?;
        if bytes.len() as u64 > PROVIDER_FILE_LIMIT {
            return Err("it is larger than 64 KiB");
        }
        let parsed: ProviderFile = serde_json::from_slice(&bytes).map_err(|_| "it is malformed")?;
        let codex_ok = parsed.codex.as_ref().is_none_or(|c| {
            [&c.executable, &c.home]
                .into_iter()
                .all(|p| absolute(p.clone()).is_ok())
        });
        if parsed.schema_version != 1 || !codex_ok {
            return Err("it has an unsupported version or a non-absolute path");
        }
        Ok(Some(parsed))
    };
    match read() {
        Ok(file) => file,
        Err(reason) => {
            eprintln!(
                "Ariadne ignored {} because {reason}; run `ariadne setup` again.",
                path.display()
            );
            None
        }
    }
}

/// The agent's tool shell inherits neither `ARIADNE_HOME` nor a PATH entry for
/// the helper, so the setup instruction must name both explicitly.
fn cli_invocation(
    helper: Option<&PathBuf>,
    home: &std::path::Path,
    default_home: Option<&std::path::Path>,
) -> String {
    let helper = match helper {
        Some(helper) => shell_word(&helper.to_string_lossy()),
        None => "ariadne".into(),
    };
    if default_home == Some(home) {
        helper
    } else {
        format!(
            "ARIADNE_HOME={} {helper}",
            shell_word(&home.to_string_lossy())
        )
    }
}
fn shell_word(value: &str) -> String {
    let plain = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-+=:,@%".contains(c));
    if plain {
        value.into()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
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
        let environment = |name: &str| (name == "HOME").then(|| PathBuf::from("/absent/user"));
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
    #[test]
    fn cli_invocation_names_helper_and_non_default_data_root() {
        let environment = |name: &str| (name == "HOME").then(|| PathBuf::from("/absent/user"));
        let invocation = |extra: &[&str], env: &dyn Fn(&str) -> Option<PathBuf>| {
            NativeConfiguration::parse(&args(extra), env)
                .unwrap()
                .cli_invocation
        };
        assert_eq!(invocation(&[], &environment), "ariadne");
        assert_eq!(
            invocation(&["--ariadne-helper", "/opt/bin/ariadne"], &environment),
            "/opt/bin/ariadne"
        );
        let custom = |name: &str| match name {
            "HOME" => Some(PathBuf::from("/absent/user")),
            "ARIADNE_HOME" => Some(PathBuf::from("/data/my root")),
            _ => None,
        };
        assert_eq!(
            invocation(&["--ariadne-helper", "/opt/bin/ariadne"], &custom),
            "ARIADNE_HOME='/data/my root' /opt/bin/ariadne"
        );
        assert_eq!(
            invocation(&[], &custom),
            "ARIADNE_HOME='/data/my root' ariadne"
        );
    }
    const RECORDED: &str = r#"{"schema_version":1,
        "codex":{"executable":"/rec/codex","home":"/rec/.codex"}}"#;
    fn home_with(contents: Option<&str>, mode: u32) -> tempfile::TempDir {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        if let Some(contents) = contents {
            let path = dir.path().join("providers.json");
            std::fs::write(&path, contents).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        dir
    }
    /// `user` is the HOME holding the installed package; `dir` is ARIADNE_HOME.
    fn parse_with(
        dir: &tempfile::TempDir,
        user: &std::path::Path,
        extra: &[&str],
    ) -> NativeConfiguration {
        let home = dir.path().to_path_buf();
        let user = user.to_path_buf();
        NativeConfiguration::parse(&args(extra), move |name| match name {
            "ARIADNE_HOME" => Some(home.clone()),
            "HOME" => Some(user.clone()),
            _ => None,
        })
        .unwrap()
    }
    fn parse_in(dir: &tempfile::TempDir, extra: &[&str]) -> NativeConfiguration {
        parse_with(dir, std::path::Path::new("/absent/user"), extra)
    }
    fn installed_package() -> tempfile::TempDir {
        let user = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(user.path().join(".local/share/ariadne/current")).unwrap();
        user
    }
    #[test]
    fn claude_is_composed_from_the_installed_package_without_any_flag() {
        let user = installed_package();
        let dir = home_with(None, 0);
        let config = parse_with(&dir, user.path(), &[]);
        let current = user.path().join(".local/share/ariadne/current");
        let claude = config.claude.unwrap();
        assert_eq!(
            claude.installed_plugin,
            current.join("integrations/claude-mod/plugin")
        );
        assert_eq!(claude.helper, current.join("bin/ariadne"));
        assert_eq!(claude.project_root, dir.path());
        assert!(config
            .cli_invocation
            .ends_with(&format!("{}/bin/ariadne", current.display())));
    }
    #[test]
    fn claude_is_none_without_an_installed_package_and_flags_override_it() {
        let user = tempfile::tempdir().unwrap();
        let dir = home_with(None, 0);
        assert!(parse_with(&dir, user.path(), &[]).claude.is_none());
        let installed = installed_package();
        let config = parse_with(
            &dir,
            installed.path(),
            &[
                "--claude-plugin",
                "/flag/plugin",
                "--ariadne-helper",
                "/flag/ariadne",
            ],
        );
        let claude = config.claude.unwrap();
        assert_eq!(claude.installed_plugin, PathBuf::from("/flag/plugin"));
        assert_eq!(claude.helper, PathBuf::from("/flag/ariadne"));
        // Flags alone also work in a dev run with no installed package.
        let config = parse_with(
            &dir,
            user.path(),
            &[
                "--claude-plugin",
                "/flag/plugin",
                "--ariadne-helper",
                "/flag/ariadne",
            ],
        );
        assert!(config.claude.is_some());
        // The retired --claude-executable flag is still validated but ignored.
        let config = parse_with(
            &dir,
            installed.path(),
            &["--claude-executable", "/flag/claude"],
        );
        assert!(config.claude.is_some());
    }
    #[test]
    fn recorded_codex_fills_in_when_no_flags_are_given() {
        let dir = home_with(Some(RECORDED), 0o600);
        let config = parse_in(&dir, &[]);
        let codex = config.codex.unwrap();
        assert_eq!(codex.executable, PathBuf::from("/rec/codex"));
        assert_eq!(codex.codex_home, PathBuf::from("/rec/.codex"));
        assert_eq!(config.discovery_endpoints.len(), 1);
        assert!(config.claude.is_none());
    }
    #[test]
    fn codex_flags_override_the_recorded_path() {
        let dir = home_with(Some(RECORDED), 0o600);
        let config = parse_in(
            &dir,
            &[
                "--codex-executable",
                "/flag/codex",
                "--codex-home",
                "/flag/.codex",
            ],
        );
        let codex = config.codex.unwrap();
        assert_eq!(codex.executable, PathBuf::from("/flag/codex"));
        assert_eq!(codex.codex_home, PathBuf::from("/flag/.codex"));
        // --codex-home still overrides the recorded home for a recorded executable.
        let config = parse_in(&dir, &["--codex-home", "/flag/.codex"]);
        let codex = config.codex.unwrap();
        assert_eq!(codex.executable, PathBuf::from("/rec/codex"));
        assert_eq!(codex.codex_home, PathBuf::from("/flag/.codex"));
    }
    #[test]
    fn unsafe_oversize_malformed_or_relative_provider_files_are_ignored() {
        let oversize = format!("{RECORDED}{}", " ".repeat(70 * 1024));
        let cases: Vec<(String, u32)> = vec![
            (RECORDED.into(), 0o620),
            (RECORDED.into(), 0o602),
            (oversize, 0o600),
            ("{not json".into(), 0o600),
            (
                RECORDED.replace("\"schema_version\":1", "\"schema_version\":2"),
                0o600,
            ),
            (RECORDED.replace("/rec/codex", "codex"), 0o600),
            (RECORDED.replace("\"home\"", "\"extra\":1,\"home\""), 0o600),
            (
                r#"{"schema_version":1,"claude":{"executable":"/c","installed_plugin":"/p","helper":"/h"}}"#
                    .into(),
                0o600,
            ),
        ];
        for (contents, mode) in cases {
            let dir = home_with(Some(&contents), mode);
            assert!(parse_in(&dir, &[]).codex.is_none(), "{contents:.40}");
        }
    }
    #[test]
    fn a_symlinked_or_missing_provider_file_is_ignored() {
        let dir = home_with(None, 0);
        assert!(parse_in(&dir, &[]).codex.is_none());
        let target = home_with(Some(RECORDED), 0o600);
        std::os::unix::fs::symlink(
            target.path().join("providers.json"),
            dir.path().join("providers.json"),
        )
        .unwrap();
        assert!(parse_in(&dir, &[]).codex.is_none());
    }
    #[test]
    fn ordinary_startup_consumes_argv_after_the_executable() {
        // The first argument is the executable, never a flag. Providers depend on the
        // real HOME here, so only argument handling is asserted.
        NativeConfiguration::from_startup_args(&args(&[
            "/Applications/Ariadne.app/Contents/MacOS/ariadne-desktop",
        ]))
        .unwrap();
        assert!(NativeConfiguration::from_startup_args(&[]).is_err());
    }
}
