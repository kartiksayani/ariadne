# ADR-0081: Setup records the provider paths; the app reads them

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

## Decision

- `ariadne setup --agent claude|codex|both` also writes
  `<ARIADNE_HOME>/providers.json` (schema_version 1) with the explicit absolute
  paths: for Claude the executable, the installed plugin and the helper (both under
  `<package_root>/current/`, so an upgrade does not stale them); for Codex the
  executable and the Codex home. Only the agents being set up change; the other
  entry is kept.
- Setup finds each host on the `PATH` of the setup process, or takes
  `--claude-bin` / `--codex-bin`. It stores the path as found, without resolving a
  symlink. A host that is not found is not recorded; setup prints one line saying so
  and still succeeds.
- The file is written atomically (temporary file and rename), mode 0600, inside the
  0700 data directory, and never through a symlink. An unsafe or malformed existing
  file is refused and left as it is.
- The app reads the file at start. Flags win per provider. The file is read only
  when a provider's flags are absent. It must be a regular file, not a symlink, at
  most 64 KiB, not writable by group or others, with absolute paths only. Anything
  else is ignored with one line on stderr; the provider stays unconfigured and the
  app still starts.
- `ariadne doctor` uses the recorded paths for its version checks when no flag is
  given, and adds a `providers.config` check (warning when the file is missing, or
  a recorded path is gone or not executable). Doctor stays read-only.
- The app still never searches PATH at runtime and never launches a host. Only an
  explicit setup in the user's shell does the lookup.

## Consequences

- After `ariadne setup`, quit and reopen Ariadne. The app reads the file at start
  only; there is no live reload.
- The file is owner-only and holds paths, never credentials.
- If the user moves or reinstalls Claude or Codex, the recorded path goes stale.
  `doctor` shows it; running setup again fixes it.
- Isolated runs and the live acceptance can keep passing flags.

## Not verified

- An opened-from-Finder app run against a real Claude Code or Codex host. That is
  the next owner acceptance.

## Spec references

- [ADR-0080](ADR-0080-app-bundle-in-applications.md)
- [Live acceptance plan](../planning/evidence/live-acceptance/PLAN.md)
