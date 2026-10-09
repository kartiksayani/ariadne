# Claude Mod

This plugin uses the Claude Code **2.1.287** SDK proven by the preserved
[POC](https://github.com/kartiksayani/ariadne/tree/reference/planning-and-pocs/poc/claude-mods).
A read-only installed CLI observation returned **2.1.289** during implementation.
Per [ADR-0071](../../docs/adr/ADR-0071-require-minimum-host-version.md),
2.1.287 is the qualified baseline and the minimum required version; any newer
version (such as 2.1.289 or 2.2.0) is accepted but marked untested; only older or
unparsable versions are rejected.

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

Use `/ariadne-connect <session-id>` in a fresh conversation to explicitly attach
an existing active Ariadne session in the registered project. Its previous binding
must be paused/disconnected with no queued, in-flight or needs-attention input.
No argument retains normal new-session/current-local-reconnect behavior. An
uncertain operation retains its exact target/body/ID; do not switch targets while
it is pending. Matching receipts and scoped status precede a new local claim loop.
The command appends human guidance to read and summarize the issued structured
history, reuse existing items and respect cancelled work, preserving the canonical
setup instruction. This transfers neither old host memory nor a transcript, and
does not automatically submit a prompt. Native binding history issuance and query
tests cover the captured ceiling; actual helper/Core composition remains required.

Claims use the original exact persisted prompt; the marker is its first line and
SHA-256 covers all UTF8 bytes. Submission is detached (`prompt.submit` asUser, so an
idle Claude starts a turn) and callbacks capture the original attempt and binding
generation. The Mod treats the payload as opaque: item- and topic-level inputs take
the same path. A prompt Claude folds into a running turn has no `turn.start`; the
running turn's `turn.complete` finishes it once the next turn starts without the
prompt, or no turn starts within `FOLD_GRACE_MS`. If the next turn carries the
prompt, Claude ran it as its own turn and that turn finishes it. When a
conversation ends or changes before the prompt is seen starting a turn, the Mod
reports it uncertain so the owner decides whether to send it again; a stopped loop
only finishes a turn it saw start. The Mod retains exact pending lifecycle
events until matching durable receipts and retries them, and a failed claim, with
the same IDs on the next poll. A claim the app refused before saving it (paused,
closed, needs attention, or no desktop lease after only refusals) drops its
request ID; Core replays a saved claim before it checks those barriers. A new
claim waits for those saves; the app's own
refusals (paused, closed, needs attention) decide when dispatch resumes. Each such
state prints one plain notice when it starts. A removed session or replaced
connection stops the loop with one notice. Session end is reported best effort
without stopping the external host.

`/ariadne-connect` and `/ariadne-disconnect` first finish outstanding claims and
reports, refuse in plain words only if that fails, and always reopen the claim
loop afterwards.

The Mod remembers, in the plugin's own SDK store (`$.store`, never `~/.ariadne`),
which Ariadne session each Claude conversation ID was connected to. On start, a
remembered conversation (`claude --resume`) reconnects automatically; a new one only
announces itself and stays discoverable through its heartbeat while idle. `/clear`
and `/resume` (`session.end` with that reason) end the conversation, not the
process: the Mod reports the old conversation's end, follows the new conversation
ID to the same Ariadne session and announces it at once (when Claude keeps the
conversation ID, on the next poll tick). Each reconnect rotates the generation, so
the Mod adds a note with the new routing to the conversation with
`$.session.append` (a meta row Claude reads on its next turn, not a prompt) and
retries it on the poll tick while the engine has no conversation to take it. If the app refuses the
rebind because the session is live on another conversation, the Mod says so once
and retries quietly. `/ariadne-disconnect` forgets the entry.

Run focused contract consumers with
`npm run test:integration -- --project claude-mod`. These inject SDK/helper seams;
they do not simulate domain eligibility or persistence. Default application
coverage includes all handwritten Mod JS, including untested files.

Real installer rendering, owner CLI commands, durable core/report composition,
trusted native Claude qualification, discovery announcements, and live host
acceptance remain the P6/P2.4/P2.2/P3.4/P3.7 joins. The installed `ariadne` helper provides
the owner, bridge and agent commands; if one is unavailable the Mod fails clearly
instead of pretending to connect or persist. No live host was launched or prompted.

Native compatibility/normalization follows ADR0037: actual SDK plugin{name,root},
immutable imported descriptor and exact-root native resource/version checks. There is
no SDK plugin.version property. Lifecycle timestamps are canonical ISO UTC milliseconds;
the same source-backed fixtures are consumed by Rust. Missing fresh native announcement
is Unknown/unavailable; 2.1.289 is accepted as untested (ADR-0071). P3.7 intake/P6 installation and the
production owner/report/Core join remain pending. PR54/ADR0038 tracks the optional
existing-session selector and structured context handoff; it does not transfer host memory.
