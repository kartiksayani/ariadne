# Canonical domain v1 fixtures

These are deterministic synthetic records, with fixed UUID v4 IDs, core-style
UTC millisecond timestamps and complete prose. They contain no provider
transcript, credentials or live-host evidence.

`demo/project.json` and `demo/session.json` are canonical stored DTOs, not command
envelopes or alternate demo models. The session includes every stored entity,
all seven item statuses, all five item types, all three owners, full owner/agent/
system messages, answer correction snapshots, round forks, both endpoint shapes,
work and result-repair attempts, acceptance/error/checkpoint/evidence records,
all ten typed saved-receipt variants and continuation provenance. A repair
references the original reply and child rather than repeating their mutations.
`demo/presence.json` is a separate qualified observation, never a heartbeat in
the stored session. The source project/session records make continuation mapping
and the source snapshot digest reproducible.

`projections/` contains canonical query DTOs linked to the same session. Item and
round snapshots retain their canonical fields; historical lists have independent
pages. The partial answer, owner-message and updated-message pages carry distinct
cursors, while exhausted pages emit null. `cursors/` contains separate canonical
cursor records for all eight typed sort positions; these samples do not claim
that another page exists. Summary counts describe the saved demo state.

`invalid/` exercises declared wire constraints: lexical primitives and typed map
keys, safe numeric bounds, calendar validity, tagged payloads, required collections
and unknown fields on DTOs that declare `deny_unknown_fields`. Duplicate map and
nested adapter-configuration keys are preserved as raw JSON text. `future/`
contains version 2 project, session and cursor records, rejected by v1 decoding.
These checks read fixtures without rewriting them. They do not prove a store's
read-only future-schema handling.

The domain schema tests deserialize raw records, compare canonical emission with
the checked-in JSON values, validate those emitted values against the checked-in
generated schemas, and compile the exact emitted values as TypeScript literals
using `satisfies` against the checked-in generated types. Invalid fixtures also
receive TypeScript negative checks where the type system expresses the constraint.
No casts or generic `savedResult` payloads substitute for typed records.

Representational limits are deliberate:

- Rust rejects duplicate keys before a parsed JSON object loses them; JSON Schema
  and TypeScript cannot detect duplicates in an already-parsed object.
- TypeScript wire aliases cannot enforce string spelling, calendar validity,
  integrality or safe integer bounds. Rust and JSON Schema enforce those limits.
- Checkpoint's JSON Schema `maxLength` counts Unicode characters; Rust enforces
  its 4096 UTF-8 byte limit. Existing focused shape tests retain this distinction.
- Serde accepts omitted optional fields on read; canonical serialization emits
  explicit nulls, and generated emission schemas/types require those fields.
- Shape conformance is separate from semantic validation. These fixtures do not
  implement transition guards, graph validation, content bounds, FIFO/result join,
  continuation mutation or five-round history behavior (P1.1/P1.2 and later tasks).

Run `cargo test -p ariadne-domain --test schema` for fixture conformance and
`cargo xtask gen-contracts --check` for regeneration drift. Existing primitive
lexical, DTO shape and generator tests remain intact.
