# Configuration, setup, installation and operations

## 1. Files and scopes

```text
<root>/.ariadne/
  project.json                       # identity, session catalog/convenience default
  sessions/<uuid>.json                # authoritative domain + outbox/runtime records
  locks/<session>.lock                # stable transactional locks
  locks/runtime.lock                  # one managed worker per project
  backups/                            # previous snapshot, migration/repair originals
  setup-manifest.json                 # reversible project setup journal
  integrations/<resource-version>/    # canonical rules, plugin variants, launch templates
  runtime/<run-id>/                    # transient binding/config files, no credentials
~/.ariadne/
  projects.json                       # rebuildable registered project index
  preferences.json                    # UI/window/drafts, notification watermark
  launch-profiles.json                 # non-secret executable/model/config references
  trust.json                          # reviewed project/configuration digests
  integrations/                       # optional global resources + ownership journal
  install-manifest.json                # installed paths/versions/checksums
  logs/                               # bounded redacted operational metadata
```

All directories0700/files0600 where supported, executable bits only on owned binaries. Runtime files are written atomically and referenced by immutable run IDs. Delete a run's transient files only after cleanup confirmed, retaining needed hashed metadata in its session. Stale runtime directories with uncertain runs remain available for diagnosis; they do not authorize process relaunch.

## 2. Launch profile and preflight

Profile fields: ID, agent, executable path, tested version, optional model/effort, permission profile, config-home reference when explicitly set, normal provider-auth mode description, expected non-secret configuration sources. No secret values, OAuth copy, arbitrary launch args, or shell snippets.

Default Claude launch permission mode is `manual` (observed init metadata calls it `default`), Codex workspace-write with on-request approvals. Plan mode is an optional explicit profile. No bypass/auto-approval profile in initial UI. Provider's existing stricter policy always wins; setup must not loosen it to make a launch succeed.

Resolve executable from explicit saved path first, then PATH as seen by the app, then known user installation locations discovered during setup; verify executable/version and show chosen path. A macOS GUI's PATH may differ from the terminal's. Never source shell rc files to discover it. If unresolved, let the owner choose an executable file and run only its version check before saving. An unrelated named executable collision requires owner correction.

Preflight returns a structured manifest:

1. Project available, initialized, safe filesystem, unique project identity, no competing runtime/uncertain child.
2. Bundled helper/resource version matches desktop; selected provider version is in compatibility allowlist.
3. Current configuration source paths/digests, non-secret provider override variable **names**, selected model/permission profile, MCP inventory, inherited hooks and instructions.
4. Required domain MCP tool/permission bridge configuration is representable without editing global settings; managed policy conflicts are actionable failures.
5. Sufficient disk/capacity; prompts within bounds; owner-auth readiness checked through documented CLI behavior during startup, not credential file inspection.

The initial project launch requires explicit trust of the reviewed configuration. Digest hashes canonical root, executable identity/version, relevant settings/plugin/hook/MCP definitions, canonical rules version and policy choices. A change to executable/configuration that adds executable hooks/services invalidates trust; changing an ordinary source code file does not. Instructions can influence the agent, so changes to instruction sources are shown on resume even when they do not add a local hook. TOCTOU check: rehash executable configuration just before spawn; mismatch aborts preflight. This does not claim a sandbox against a hostile same-user process modifying files afterward.

## 3. Managed MCP/config generation

Claude generated configuration contains only Ariadne by default:

```json
{
  "mcpServers": {
    "ariadne": {
      "command": "<absolute-bundled-ariadne>",
      "args": ["mcp", "serve", "--binding-file", "<absolute-run-binding.json>"],
      "timeout": 660000
    }
  }
}
```

Pass it with strict MCP mode and pass the generated overlay through `--settings`. The overlay's `permissions.allow` contains only `mcp__ariadne__session_read`, `mcp__ariadne__apply`, `mcp__ariadne__answer_fetch`, `mcp__ariadne__answer_ack` and `mcp__ariadne__permission_prompt`. It does not auto-allow Bash/Edit or override policy deny rules. Disable auto-background in the child with `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`. The per-server `timeout` is 660000 milliseconds, above the bridge's 600000-millisecond local deadline; domain tools enforce 5 seconds internally. These configuration controls are documented in the [official environment reference](https://code.claude.com/docs/en/env-vars). Their raw-CLI schema/precedence and long-wait behavior must pass C03/C04. Earlier host cancellation expires the request; a late owner click cannot authorize it.

Codex spawn-time overrides set the Ariadne server command/args and supported timeout settings using `-c key=value`; disable every other discovered MCP entry for the default managed profile. Use a TOML serializer for values/key segments, then pass each full assignment as one argv element. Confirm effective inventory in N02. The profile does not rely on undocumented `thread/start.config` merging. Other MCP services are a later explicitly authorized profile feature, not automatic inherited activation.

Both providers inherit existing authentication configuration. Do not remove API/cloud variables silently; if the requested CLI/subscription profile conflicts with an API/provider override, show its name and require profile correction before inference. Do not display its value or promise that deleting one variable guarantees a billing route. V1 has no account switching/key management UI. Official CLI login remains the prerequisite.

## 4. Rules, plugins and optional external mode

Generate artifacts from `packages/agent-rules/RULES.md`:

- Managed Claude: append canonical rules; optional skill/plugin variant contains discovery/help but no duplicate answer-injection hook.
- Managed Codex: append canonical developer instructions while preserving host base/project instructions.
- External Claude opt-in: plugin skill + UserPromptSubmit hook + owned bootstrap in effective CLAUDE.md.
- External Codex opt-in: owned effective AGENTS/override block + documented hook, with manual-fetch fallback.

All generated Ariadne hooks first check `ARIADNE_MANAGED_RUN_ID`; in managed runs they emit no answer context and do not create bindings. They do not disable unrelated user's hooks. External hooks have a3s budget, bounded16KiB context, non-destructive answer issue and no acknowledgment on successful stdout alone. Error returns a concise warning/manual-fetch hint without preventing the owner's terminal prompt. Global resources activate only inside initialized registered projects.

Setup mode is explicit: `setup --agent claude|codex|both` defaults managed; `--external-terminal` adds those host files. Global mode installs availability/resources, not arbitrary project initialization. Setup twice must have an empty change set. `--dry-run` uses the same planner and performs no writes.

## 5. Reversible setup algorithm

1. Acquire scope-specific setup lock; resolve effective instruction/settings paths without following foreign symlinks into unexpected locations.
2. Parse all targets and identify owned marker blocks/JSON entries/resource dirs. If malformed or foreign same-name content exists, return exact collision with no writes.
3. Compute a change plan with old/new hashes and retained content. Print it. Record journal `prepared` plus backups of changed owned bytes before applying.
4. Immediately before each edit verify current checksum still equals planned preimage; atomic-write that file; mark journal step applied. On conflict, stop and roll back only files whose current hash still matches this setup's written bytes.
5. Mark committed, record resources/references, add marked ignore entry and register project. A registry failure is a discovery warning after session/project initialization, not a reason to erase data.
6. On retry after interruption, inspect journal and checksums: resume deterministic remaining steps or restore owned matching writes. Never blindly restore a whole historical settings file over later user edits.

Uninstall uses journal identity, markers and checksums. Remove only unchanged owned sections/entries/resources; preserve edited owned content and print manual cleanup instructions. Remove files created by setup only when they contain no foreign content. Keep global resources still referenced by another setup. Host trust databases and credentials are never edited. Retain session JSON, backups and ignore entry while data remains. User data deletion is outside uninstall and outside v1 UI.

## 6. Build and installation

`make install` is the future documented entry point. Tasks: preflight → locked dependency resolution → generate DTOs/schema/rules → Rust/TS build → app/helper packaging → verification → staged local install. Node is a build dependency only. Commit Cargo/npm locks, toolchain version, target architecture and deployment baseline in M0. Default target is current Mac architecture; no untested universal bundle.

Preflight checks macOS, Xcode command-line tools, Rust/Node/npm versions, free space, application destination writable, and selected CLI destination. It does not automatically install those toolchains or use sudo. If an install destination needs privileges, produce the finished artifacts and one exact remaining operation; no global permission changes.

Install `/Applications/Ariadne.app`; choose explicit BIN_DIR else an existing writable user PATH directory, preferring `~/.local/bin`, then `~/.cargo/bin` when already on PATH. No shell startup edits. Before replacement, compare manifest ownership; never overwrite unrelated `ariadne` or a foreign app bundle. Quit/restart the owned app for upgrade; preserve old app/helper until staged replacement succeeds. Package manifest records previous/current versions and checksums for rollback. CLI/helper/app version mismatch makes managed launch fail before work.

Bundle resources are signed consistently if local ad-hoc signing is used; no Developer ID/notarization/public distribution is promised. Document supported macOS Open Anyway steps for an unsigned local bundle. Never advise disabling Gatekeeper globally. Native notification and bundle identity are tested after installation, not inferred from a dev window. [Tauri macOS bundle guidance](https://v2.tauri.app/distribute/macos-application-bundle/)

`make uninstall` removes package-owned app/CLI artifacts only and leaves domain data/settings history. `ariadne uninstall` removes integrations first. Running workers must be stopped through the application's lifecycle; installer does not kill unknown same-name processes. No remote, auto-updater or publication step.

## 7. Operational diagnostics and retention

`doctor` is read-only and returns checks with `ok|warning|error`, code and actionable hint: executable resolution/version; bundled version parity; project path/identity/filesystem/permissions; schema/backup validity; lease/previous-run state; setup ownership/conflicts; configuration trust digest; managed/external mode; unacknowledged/uncertain input counts; notification authorization. Never fetch provider usage/billing or refresh tokens merely to inspect a project.

Default logs store component/error code/run ID/sequence/timing, not prompt/answer/tool payloads or host environment. Rolling limit5 files×1MiB under owner-only log directory. A deliberate diagnostic export includes sanitized metadata and versions, not session contents unless explicitly selected. There is no automatic upload. Activity is in memory; authoritative session history is retained until the owner removes it intentionally. File size limits are explained before new work is accepted.
