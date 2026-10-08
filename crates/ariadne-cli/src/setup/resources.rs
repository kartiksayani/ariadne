//! Fixed integration inventory shared by setup and its read-only parity check.
use std::{collections::BTreeMap, path::Path};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const RECEIPT: &str = "setup.json";

macro_rules! resource {
    ($name:expr) => {
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../integrations/",
            $name
        ))
    };
}

/// The skill's files beside `SKILL.md` for both hosts: loaded on demand.
macro_rules! on_demand_files {
    ($($file:literal),*) => {
        [$(
            (
                concat!("claude-mod/plugin/skills/ariadne/", $file),
                resource!(concat!("claude/plugin/skills/ariadne/", $file)).as_slice(),
            ),
            (
                concat!("codex-skills/ariadne/", $file),
                resource!(concat!("codex/skills/ariadne/", $file)).as_slice(),
            ),
        )*]
    };
}

/// No runtime source checkout, host cache or environment fallback is used.
pub fn bundle(helper: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    for (name, bytes) in [
        (
            "claude-mod/.claude-plugin/marketplace.json",
            resource!("claude/.claude-plugin/marketplace.json").as_slice(),
        ),
        (
            "claude-mod/plugin/.claude-plugin/plugin.json",
            resource!("claude/plugin/.claude-plugin/plugin.json").as_slice(),
        ),
        (
            "claude-mod/plugin/hooks/contracts.js",
            resource!("claude/plugin/hooks/contracts.js").as_slice(),
        ),
        (
            "claude-mod/plugin/hooks/setup.js",
            resource!("claude/plugin/hooks/setup.js").as_slice(),
        ),
        (
            "claude-mod/plugin/hooks/hooks.json",
            resource!("claude/plugin/hooks/hooks.json").as_slice(),
        ),
        (
            "claude-mod/plugin/hooks/register.js",
            resource!("claude/plugin/hooks/register.js").as_slice(),
        ),
        (
            "claude-mod/plugin/hooks/discovery.js",
            resource!("claude/plugin/hooks/discovery.js").as_slice(),
        ),
        (
            "claude-mod/plugin/hooks/claims.js",
            resource!("claude/plugin/hooks/claims.js").as_slice(),
        ),
        (
            "claude-mod/plugin/skills/ariadne/SKILL.md",
            resource!("claude/plugin/skills/ariadne/SKILL.md").as_slice(),
        ),
        (
            "codex-skills/ariadne/SKILL.md",
            resource!("codex/skills/ariadne/SKILL.md").as_slice(),
        ),
        ("rules/claude.md", resource!("rules/claude.md").as_slice()),
        ("rules/codex.md", resource!("rules/codex.md").as_slice()),
    ]
    .into_iter()
    .chain(on_demand_files!(
        "inputs.md",
        "errors.md",
        "reconnect.md",
        "report.md",
        "review.md",
        "checklist.md",
        "follow-up.md"
    )) {
        files.insert(name.to_owned(), bytes.to_vec());
    }
    let manifest = files
        .get_mut("claude-mod/plugin/.claude-plugin/plugin.json")
        .expect("inventory");
    let mut value: serde_json::Value = serde_json::from_slice(manifest).expect("bundled manifest");
    value["version"] = VERSION.into();
    *manifest = serde_json::to_vec_pretty(&value).expect("manifest JSON");
    files.insert(
        "claude-mod/plugin/hooks/installed.js".into(),
        format!(
            "export default Object.freeze({{helperPath:{},appVersion:{},apiVersion:1}});\n",
            serde_json::to_string(helper).expect("UTF-8 installed helper"),
            serde_json::to_string(VERSION).expect("version JSON")
        )
        .into_bytes(),
    );
    files
}

pub fn selected(name: &str, agent: &str) -> bool {
    let codex = name == "rules/codex.md" || name.starts_with("codex-skills/");
    agent == "both" || if agent == "claude" { !codex } else { codex }
}

pub fn host_commands(stable_integrations: &Path, agent: &str) -> Vec<String> {
    let mut commands = Vec::new();
    if agent != "codex" {
        let path = stable_integrations.join("claude-mod");
        let text = path.to_string_lossy();
        let quoted = if text
            .chars()
            .any(|c| c.is_whitespace() || c == '"' || c == '\\')
        {
            serde_json::to_string(text.as_ref()).expect("path JSON")
        } else {
            text.into_owned()
        };
        commands.extend([
            format!("/plugin marketplace add {quoted}"),
            "/plugin install ariadne@ariadne-local".into(),
            "/reload-plugins".into(),
            "/ariadne-connect".into(),
        ]);
    }
    if agent != "claude" {
        let rules = stable_integrations.join("rules/codex.md");
        commands.push(format!(
            "In the existing Codex terminal, run /status and select that thread in Ariadne; keep host approvals explicit. After connecting, paste the short setup instruction Ariadne shows into that Codex thread once per binding; the installed Ariadne skill holds the rules (also at {}).",
            rules.display()
        ));
    }
    commands
}
