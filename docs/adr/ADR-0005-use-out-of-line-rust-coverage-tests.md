# ADR-0005: Use out-of-line Rust coverage tests

Status: accepted
Supersedes: none
Superseded by: none

## Context

The scaffold must measure production Rust from its first commit. A concrete
cargo-llvm-cov probe showed that inline unit tests also contribute lines to their
production source file, while the existing inventory excludes test directories.

## Decision

Keep Rust tests in `src/tests` or package `tests` directories. Exercise the real
validation and file operations there. Preserve the existing all-features LCOV
command, canonical reports, inventory and weighted 80% floor.

## Consequences

Tests remain compiled and executed without inflating the production denominator.
Native behavior and production isolation still need their separate process proofs;
their success is not a claimed contribution to instrumented coverage.

## Spec references

- [Application scaffold obligations](../planning/DEVELOPMENT_CHECKS.md#application-scaffold-obligations)
