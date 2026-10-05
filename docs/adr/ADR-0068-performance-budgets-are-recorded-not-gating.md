# ADR-0068: Performance budgets are recorded, not gating

Status: accepted
Supersedes: part of [ADR-0066](ADR-0066-project-local-search-before-save-confirmation.md) (the "retain the 150 ms p95 limit" clause)
Superseded by: none

## Context

The owner ruled on 2026-10-06 that Ariadne is a personal, single-user macOS app and
that performance budgets and disproportionate proof requirements are not acceptance
gates. A 150 ms local-search p95 assertion in the native tree journey blocked
delivery despite functionally correct behaviour.

## Decision

Latency and scale numbers (first usable view, local search p95, save latency,
2,000-item/5,000-message fixtures) remain documented targets and are recorded as
evidence; they are not pass/fail conditions. The native timing assertions in
`apps/desktop/tests/e2e/tree.spec.mjs` are removed, while the measurements are
still written to the evidence files. Functional timing behaviour (debounce,
250 ms coalescing, expiry) stays tested. Correctness on large fixtures (counts,
filters, culling, focus, persistence) stays tested.

## Consequences

Slow-but-correct behaviour no longer blocks delivery. Regressions are visible in
recorded evidence rather than caught by a gate; the maintainer reviews them when
relevant. Delivery tasks and planning docs drop latency/exact-size pass conditions.

## Spec references

- [PRODUCT](../planning/PRODUCT.md#quality-and-acceptance)
- [VERIFICATION](../planning/low-level/VERIFICATION.md)
- [NATIVE_E2E](../planning/low-level/NATIVE_E2E.md)
