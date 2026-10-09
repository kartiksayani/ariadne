# ADR-0092: Lenient `ariadne apply` input, compact receipts and dry-run

Status: accepted (2026-10-08)
Supersedes: none
Superseded by: none

## Context

Real agent sessions showed that filing is expensive for the agent, not for Ariadne.
Every `item.add` spelled out about 16 fields, most of them null; the binding ID
repeated in every owner; `op_id` needed a separate `uuidgen`; parents needed ref
wiring; and the receipt echoed `allocated_refs`, so one agent truncated a receipt and
later re-read revisions it already had. Another wrote its own builder just to emit
valid requests.

## Decision

- Leniency lives in the CLI only. `ariadne apply` expands stdin into the unchanged
  strict `ApplyRequest` (`crates/ariadne-cli/src/agent/lenient.rs`), and core
  validates the result exactly as before. A fully explicit request expands to itself.
  Repeated object keys are still rejected. MCP `apply` keeps the strict shape.
- Omittable: `op_id` (the CLI derives a UUIDv4 and prints it), the top-level
  source, attempt, result, revision guards and `summary`, and every optional
  operation field. Defaults, all listed in `ariadne --help`: `ref` is `r1`, `r2`, ...;
  an `item.add` without `topic` uses the request's only `topic.add`; `status` is
  `waiting_on_me` when `ask` is set, otherwise `open`; `owner` is the calling
  binding, or `me` for a waiting item because core requires it; option `id` is its
  position and `recommended` false; `item.ask` recipient is the calling binding.
- `item.add` may carry `children`, recursively. The CLI flattens them in order
  (parent first), sets each `parent` and inherits `topic`.
- An omitted `op_id` is deterministic: SHA-256 over three byte strings in order,
  each prefixed by its byte length as a big-endian u64: ASCII `ariadne apply op_id v1`,
  the binding's lowercase UUID string, and
  compact JSON of the expanded typed `ApplyRequest` with `op_id` removed. JSON
  object keys are recursively sorted lexicographically; array order and exact prose
  are preserved. Defaults are filled, refs allocated and children flattened before
  hashing. Take the first 16 digest bytes, set byte 6's high nibble to `0100` (v4)
  and byte 8's high bits to `10` (RFC variant), then format as a lowercase UUID.
  Generation is excluded, matching Core's binding-scoped replay lookup. For binding
  `00000000-0000-4000-8000-000000000003` and `{"operations":[]}`, the derived ID is
  `47d12499-bc46-48f3-a2d3-33c007644020`.
  SHA-256 is already locked; the CLI moves it from a test to a runtime dependency.
- Resending the identical request with the same binding is safe across generation
  changes after an uncertain commit, I/O error, timeout or killed call, even with no receipt:
  a saved request replays instead of filing twice. Uncertainty hints also name the
  derived ID. An explicit `op_id` always wins and replays as before. Intentionally
  filing the identical request again requires a fresh explicit `op_id`.
- `--dry-run` runs the real validation without committing. `Store::preview` shares
  `stage_effect` with every commit (callback, receipt entry, candidate validation,
  encoding); `ApplyService::preview` runs the same wire checks, replay lookup and
  batch. The output is the compact receipt plus `dry_run: true`, and `replayed: true`
  when the same expanded request already committed.
- The default receipt is compact (`ApplySummary`): `op_id`, `session_revision`, and for
  each created or changed topic and item its id, number, short label, new revision and
  `created`. An item's id is its number; a topic's number is its `order`. `--full`
  prints the complete saved receipt. If building the compact form fails after a
  commit, the full receipt is printed so a committed apply never reads as failed.
  Real apply also adds `replayed: true` when the store replayed under the writer
  lock, in compact output (including its fallback); fresh commits omit it. Explicit
  `--full` output, saved receipts and strict API shapes stay unchanged.
- `ariadne read --view items` takes `--topic <id|number>` and `--archived`;
  `--view topics` takes `--archived`.

## Consequences

- Receipt consumers of the CLI must read the compact keys or pass `--full`.
  Native journey helpers that verify the saved session identity request `--full`.
- The agent skill teaches this shape. Every apply example in the generated Claude and
  Codex skill files is sent to the real `ariadne apply` by
  `crates/ariadne-cli/tests/agent_skill_examples.rs` (`--dry-run`, then a commit on a
  seeded session), so the skill cannot drift from the CLI's defaults.
- The skill folder is the only home of the rules: `integrations/rules/claude.md` and
  `codex.md` are no longer generated or bundled, and the Codex fallback in the setup
  instruction names the installed skill's `SKILL.md`, beside the on-demand files.
- `type` and `question` stay required on `item.add`, as do `outcome` and `why` for
  terminal statuses: no default for them is unambiguous.

## Spec references

- [API and MCP: agent API](../planning/low-level/API_AND_MCP.md)
- [Shared agent rules](../../integrations/rules/source.md)
