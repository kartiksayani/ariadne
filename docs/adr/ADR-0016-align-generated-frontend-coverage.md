# ADR-0016: Align generated frontend coverage with the source inventory

Status: accepted
Supersedes: none
Superseded by: none

## Context

The source inventory already excludes generated directories. A real pinned
Vitest probe nevertheless emitted an LCOV record for generated type-only
TypeScript, which the checker correctly rejected as outside application code.
Changing that inventory policy or inventing executable hits would misstate the
existing coverage contract.

## Decision

Preserve Vitest's pinned default coverage exclusions through its exported API
and additionally exclude `**/generated/**` from frontend measurement. Align the
report with the established inventory policy without changing source discovery,
thresholds, Rust coverage, ordinary UI tests or native/release gates.

## Consequences

A real Vitest regression uses pinned TypeScript compiler declaration and
executable outputs in a temporary generated directory. Both stay absent from
LCOV while executed and untested handwritten sources remain measured; the
actual inventory/checker accepts the matching report. This tests coverage-path
alignment, not domain-generation fidelity. Handwritten implementation cannot be
hidden in generated directories, and executable application coverage stays at
least 80% under the unchanged gates. Organization security guidance was not
checked in this session; no organization approval is claimed.

## Spec references

- [Development checks: scaffold obligations](../planning/DEVELOPMENT_CHECKS.md#application-scaffold-obligations)
