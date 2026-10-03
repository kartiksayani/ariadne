# ADR-0013: Validate domain primitives

Status: accepted
Supersedes: none
Superseded by: none

## Context

P0.3a needs validated Rust wire primitives before DTOs and storage depend on them.
The primitive shorthand left digest spelling and timestamp canonicalization
underspecified. A bounded probe showed Chrono 0.4.45 round-trips
`2024-02-29T12:34:60.123Z`, but jsonschema 0.58.5 rejects its `date-time` assertion.
Both libraries accept `2024-02-28T23:59:60.123Z`.

## Decision

Implement private-field validated primitives with checked constructors and
deserialization, canonical serialization, and generated schemas/wire aliases.
UUIDs are lowercase RFC4122 variant v4; ItemRef segments are positive decimal
safe integers without leading zeros and imply no ancestry. SchemaVersion is 1.
Positive/nonnegative counters end at 9007199254740991. RequestRef uses the existing
ASCII letter/letter-digit-underscore grammar with a 32-character maximum;
SHA-256 text is 64 lowercase hexadecimal characters.

UtcMillis requires canonical RFC3339 uppercase T/Z, exactly three fractional
digits, and the pinned Chrono millisecond/Z round-trip. Second 60 additionally
requires 23:59Z for parity with the pinned schema validator. Calendar validity
stays with the libraries; add no independent length cap, year range, month-end
rule or historical leap-second table. Preserve standard JSON Schema `date-time`
assertions with the canonical syntax pattern.

The tooling-only xtask generates deterministic draft 2020-12 serialization
schemas with Schemars 1.2.2 and TypeScript aliases with ts-rs 12.0.1. Read-only
`--check` detects missing, stale and unexpected artifacts. Tests never rewrite
source artifacts. Tool coverage is measured separately from application coverage.

## Consequences

Rust and asserted JSON Schema enforce lexical/calendar/range constraints;
TypeScript string/number aliases express wire kinds, and literal 1 expresses
SchemaVersion. Complete DTOs and fixtures remain P0.3b/P0.3. No production package
boundary or entry point changes.

## Spec references

- [Primitive conventions](../planning/low-level/DOMAIN_AND_STORAGE.md#1-primitive-conventions)
- [Agent request references](../planning/low-level/API_AND_MCP.md#3-agent-api-explicit-results-and-tree-operations)
