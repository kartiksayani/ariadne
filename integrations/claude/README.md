# Claude Mod

This plugin uses the Claude Code **2.1.287** SDK proven by the preserved
[POC](https://github.com/kartiksayani/ariadne/tree/a5e306f/poc/claude-mods).
A read-only installed CLI observation returned **2.1.289** during implementation;
that version has no compatibility proof here and remains rejected.

The entry is `plugin/hooks/hooks.json` → `register.js`. Static plugin-local ESM
imports are supported by the captured SDK. The production source imports no Node
API, filesystem API, environment, shell, `require`, or dynamic `import()`.

P6 must package this root as
`~/.local/share/ariadne/current/integrations/claude-mod/`, with the local marketplace
and plugin manifests. It must render `plugin/hooks/installed.js` as an ESM module
exporting `Object.freeze({helperPath: ABSOLUTE_INSTALLED_HELPER_PATH,
appVersion: MATCHING_APP_AND_PLUGIN_VERSION, apiVersion: 1})`. Source checkouts
export `null`, so they cannot accidentally use a development helper or cached
plugin-relative executable. App/helper version is currently `0.1.0`; the Mod
manifest must match it. The installer owns rendering and version substitution.

`/ariadne-connect` sends actual SDK session ID/cwd through canonical owner commands,
then validates the saved receipt and scoped `bridge connection-status` projection.
Native qualification owns canonical `Connected` evidence. The Mod never invents
endpoint fingerprints or treats control reachability as provider readiness.

Claims use the original exact persisted prompt; the marker is its first line and
SHA-256 covers all UTF8 bytes. Submission is detached and callbacks capture the
original attempt and binding generation. The Mod retains exact pending lifecycle
events until matching durable receipts, pauses new claims during failures, and
reports session end best effort without stopping the external host.

Run focused contract consumers with
`npm run test:integration -- --project claude-mod`. These inject SDK/helper seams;
they do not simulate domain eligibility or persistence. Default application
coverage includes all handwritten Mod JS, including untested files.

Real installer rendering, owner CLI commands, durable core/report composition,
trusted native Claude qualification, discovery announcements, and live host
acceptance remain the P6/P2.4/P2.2/P3.4/P3.7 joins. The currently shipped helper
truthfully cannot perform those owner/report operations, so this Mod fails clearly
instead of pretending to connect or persist. No live host was launched or prompted.

Native compatibility/normalization follows ADR0037: actual SDK plugin{name,root},
immutable imported descriptor and exact-root native resource/version checks. There is
no SDK plugin.version property. Lifecycle timestamps are canonical ISO UTC milliseconds;
the same source-backed fixtures are consumed by Rust. Missing fresh native announcement
is Unknown/unavailable;2.1.289 remains unqualified. P3.7 intake/P6 installation and the
production owner/report/Core join remain pending. PR54/ADR0038 tracks the optional
existing-session selector and structured context handoff; it does not transfer host memory.
