# ADR-0004: Account for non-executable scaffold coverage sources

Status: accepted
Supersedes: none
Superseded by: none

## Context

The first application commit requires real Rust/frontend reports and at least
80% weighted executable-line coverage across every production source. The
planned Rust package boundaries contain only comments, which produce no `DA`
records. Recursive source discovery also encounters desktop build and test
configuration. Requiring fabricated executable hits or excluding whole packages
would contradict the coverage contract. The orchestrator chose explicit narrow
classifications over either alternative.

## Decision

Keep canonical roots, both fresh reports, recursive inventory and the 80% floor.
Permit hash-bound `non_executable_sources` entries only for actual
`crates/<member>/src/lib.rs` package boundaries containing blank or `//` lines.
Reject code, attributes, block comments, malformed or duplicate declarations,
missing files and repository escapes. Add explicit zero-line LCOV records after
fresh Rust measurement; each canonical report still needs genuine `DA` evidence.

Permit `coverage_tooling` only for the three exact desktop Vite, native WDIO and
Tauri build-script paths declared in Development checks. They retain ordinary
lint/build/test obligations. Every other executable source, including shipped
Mods, remains mandatory. Put frontend build output in root `target/desktop-dist`
instead of introducing a broad `dist` exclusion.

## Consequences

Empty scaffold packages are accounted for without inventing covered lines.
Changes to boundary bytes require updated hashes; adding Rust code requires
normal measurement and removal of the classification. The application still
cannot pass with only empty packages, missing reports or omitted production
files. This maintenance PR adds policy support; it does not activate application
mode or claim application/native test evidence.

## Spec references

- [Development checks: scaffold obligations](../planning/DEVELOPMENT_CHECKS.md#application-scaffold-obligations)
- [Native E2E: test-only build recipe](../planning/low-level/NATIVE_E2E.md#test-only-build-recipe)
