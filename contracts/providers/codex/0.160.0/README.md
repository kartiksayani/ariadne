# Private Codex 0.160.0 wire baseline

The installed `codex-cli 0.160.0` generated all 440 original JSON Schema files
on 2026-10-03 with the `schema_command` recorded in `manifest.json`. Files under
`schema/` are unchanged command output. The manifest records the executable
SHA-256 and every schema and fixture hash. Capture only generated files; no
daemon, thread, model turn, authentication file or live endpoint was opened.

`cargo xtask gen-codex-wire --version 0.160.0` generates ten consumed request and
response roots with pinned typify 0.5.0 and schemars 0.8.22. Initialization uses
v1 schemas; loaded discovery, metadata read, full turn history and queue reads
use v2 schemas. Each root has a separate private Rust module with its own
definitions. These wires are not Ariadne domain DTOs or public adapter contracts.
The CLI queue sender remains separate; no direct queue-add/start wire is published.

`cargo xtask gen-codex-wire --check` verifies the hash inventory, regenerates in
a temporary directory, formats with the pinned Rust toolchain and compares the
checked-in files. An ordinary xtask unit test runs the same check in CI.
Application builds use checked-in Rust and do not require Codex to be installed.

`fixtures/poc-live-exercise.json` is the unchanged, previously redacted retained
[POC evidence at a5e306f](https://github.com/kartiksayani/ariadne/blob/a5e306f/poc/codex-queue/evidence/live-exercise.json).
The other fixtures are **schema-valid reconstructed examples, not raw RPC
captures**. Initialization adds synthetic `/redacted/codex-home` because the
retained evidence omits required `codexHome`. Turn pages preserve the observed
input markers, message/turn/client IDs, replies, phases and timestamps, while
reconstructing their schema envelope and text elements. Metadata, loaded-thread
and nonempty queue examples are synthetic. `manifest.json` records these limits.
The fixtures prove wire decoding, not new live integration or P0.5 completion.

Unknown turn/item variants and missing required nonnullable fields fail decoding.
Unknown optional fields remain extensible. The only required nullable field in
these roots and their named definitions is `Thread.projectId`, unused provider
metadata. Typify represents it as `Option`; Serde also accepts its omission as
`None`. The fixture tests record this limitation. Rust decoding does not enforce
every JSON Schema keyword; the adapter must validate the identity, path and
capability fields it actually uses. No consumed request has a required nullable
field that could be lost during serialization.

Organization security guidance was not checked under the owner's explicit
MCP/the review tool waiver; no approval is claimed.
