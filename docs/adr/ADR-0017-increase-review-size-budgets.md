# ADR-0017: Increase review size budgets

Status: accepted
Supersedes: none
Superseded by: none

## Context

The owner suggested leaner delivery and delegated the choice of necessary
changes. Small size budgets had forced additional task splits and expensive
repeated full gates. The maintainer chose larger bounded review budgets and
retained the established 80% floor because measured coverage passes and the
generated-report mismatch is unrelated to the threshold. No prior ADR fixes
numeric line caps.

## Decision

Allow at most 1600 changed handwritten lines per staged/authored commit and
3200 per PR or integrated main squash. Keep roughly 500 lines as a review
preference. Continue checking every authored commit over the whole feature
branch and every squash separately in a main push range, with unchanged source
classifications, generated/documentation accounting and linear-history rules.

## Consequences

Correct bounded changes need fewer mechanical splits. Larger diffs require
careful independent review; exceeding the new limits still requires a coherent
split. Real temporary-Git tests cover exact passing/failing boundaries, an older
oversized commit behind a small latest push, real squash merges and multi-squash
main ranges. Hooks, lint, tests, native/release checks and >=80% measured
application/helper coverage remain required. No new framework or exemption is
introduced.

## Spec references

- [Contributing: six rules](../../CONTRIBUTING.md#six-rules)
- [Orchestrator: assign](../../ORCHESTRATOR.md#1-assign)
- [Harness: enforcement](../delivery/HARNESS_OVERVIEW.md#what-is-enforced-and-where)
- [Development checks: current state](../planning/DEVELOPMENT_CHECKS.md#current-state)
- [Roadmap: execution rules](../planning/ROADMAP.md#execution-and-pr-rules)
- [Native E2E: first scaffold smoke](../planning/low-level/NATIVE_E2E.md#first-scaffold-smoke-then-real-store-acceptance)
