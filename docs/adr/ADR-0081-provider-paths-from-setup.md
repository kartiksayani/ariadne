# ADR-0081: Claude is trusted for its own version report; Codex paths are recorded at setup

Status: accepted (2026-10-07).
Supersedes: none
Superseded by: none

## Context

The desktop built its Claude provider only from `--claude-executable`,
`--claude-plugin` and `--ariadne-helper`, and its Codex provider only from
`--codex-executable`. Opened from Finder or `open`, the app has no flags, so
`binding connect` returned `unsupported` ("Selected native provider is not
configured"). The owner found the app unusable when opened normally on 2026-10-07
with `v0.1.0-alpha.1`. The live acceptance only ever passed because it launched the
binary with those flags.

For Claude the executable was needed only to run `claude --version` and to add its
file identity to the endpoint fingerprint. The owner ruled that Claude must work with
zero configuration when the app is opened from Finder.

## Decision

- **Claude needs no executable.** `ClaudeOptions` no longer has an `executable`. The
  adapter takes the host version from the loaded Mod's announcement
  (`engine_version`) and applies the same minimum check (at least 2.1.287; newer
  versions get the "newer than tested" note). It never runs `claude --version`. The
  endpoint fingerprint drops the executable identity (`claude-mod-v2`). The checks
  that anchor trust stay as they were: the loaded plugin bytes must equal the
  installed resources, plus the descriptor, helper and project-root checks.
- **The app locates its own package.** The Claude provider is always composed when
  `$HOME/.local/share/ariadne/current` exists: `installed_plugin` is
  `current/integrations/claude-mod/plugin` and `helper` is `current/bin/ariadne`.
  `--claude-plugin` and `--ariadne-helper` override these (isolated runs, e2e).
  `--claude-executable` is still accepted so old commands run; it is ignored with one
  line on stderr. Without an installed package the Claude provider is `None`.
- **Codex paths are recorded at setup.** `ariadne setup --agent codex|both` writes
  `<ARIADNE_HOME>/providers.json` (schema_version 1) with the Codex executable and
  Codex home. Setup finds `codex` on the `PATH` of the setup process, or takes
  `--codex-bin`, and stores the path as found, without resolving a symlink. A missing
  `codex` is not recorded; setup prints one line saying so and still succeeds.
  `--agent claude` records nothing.
- The file is written atomically (temporary file and rename), mode 0600, inside the
  0700 data directory, and never through a symlink. An unsafe or malformed existing
  file is refused and left as it is.
- The app reads the file at start only when the Codex flags are absent. It must be a
  regular file, not a symlink, at most 64 KiB, not writable by group or others, with
  absolute paths only. Anything else is ignored with one line on stderr; Codex stays
  unconfigured and the app still starts. Flags win.
- `ariadne doctor` uses the recorded Codex path for its version check when no flag is
  given, and adds a `providers.config` check (warning when the file is missing, or the
  recorded path is gone or not executable). Doctor keeps `--claude-bin` for an explicit
  Claude version check and stays read-only.
- The app still never searches PATH at runtime and never launches a host.

## Why trusting Claude's report is sound

- The loaded plugin's bytes are compared with the installed resources, and the helper
  and descriptor are checked. That is the trust anchor. The Mod's announcement is only
  as trustworthy as the plugin that sent it.
- A same-user attacker who can replace a `claude` binary can equally edit the Mod's
  reported version or the plugin directory. The executable check added nothing against
  that attacker.
- It made the app unusable from Finder, where no path is known.

## Consequences

- No `claude --version` probe. A tampered `claude` binary is not detected. This is
  accepted for a single-user local app.
- A Claude probe before any Mod announcement reports no host version and stays
  Unknown. The version appears once the Mod has announced itself.
- Existing Claude bindings qualified under `claude-mod-v1` fail the fingerprint check
  once and must be reconnected.
- Codex still needs its path. After `ariadne setup`, quit and reopen Ariadne; the app
  reads the file at start only. If Codex moves, `doctor` shows it and setup fixes it.
- The file is owner-only and holds paths, never credentials.
- Isolated runs and the live acceptance can keep passing flags.

## Not verified

- An opened-from-Finder app run against a real Claude Code or Codex host. That is the
  next owner acceptance.

## Spec references

- [ADR-0080](ADR-0080-app-bundle-in-applications.md)
- [Live acceptance plan](../planning/evidence/live-acceptance/PLAN.md)
