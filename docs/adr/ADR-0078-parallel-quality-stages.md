# ADR-0078: Run quality stages as parallel CI jobs behind one required check

Status: accepted (2026-10-06).
Supersedes: none
Superseded by: none

## Context

The `quality` workflow was one serial job (about 40 minutes) running
`scripts/check-commit.py --ci`. Late failures, such as the native e2e step, cost the
full run and a rerun repeated every stage.

## Decision

- `scripts/check-commit.py` gains `--stage {all,static,coverage,native}`; `all` is the
  default and keeps the previous order for the pre-commit hook and local runs.
  - `static`: lint, roadmap check, Python tests, install coverage, `npm run build`,
    `cargo build`, Clippy, `key_event_tests`; the reference capture runs in this job.
  - `coverage`: `cargo llvm-cov` (workspace, xtask), `npm run test:coverage` and the
    combined line-coverage floor. Rust and web lcov are combined, so they share a stage.
  - `native`: `npm run test:e2e` (`test:native` without release isolation).
- The workflow runs the stages as a matrix job `stage` (`fail-fast: false`), shown as
  `quality / <stage>`. Each job uploads `coverage/` as
  `quality-evidence-<run>-<attempt>-<stage>`.
- A final job named `quality` (`needs: [stage]`, `if: always()`) fails unless every
  stage succeeded. It keeps the status check name the branch ruleset requires.
- `history.spec.mjs` clicks "Request reopen"/"Follow up" again once if the owner-input
  editor has not appeared after 2 s. CI showed the click landing during the re-render
  after a CLI-published result, leaving the previous saved receipt on screen.

## Consequences

- Wall-clock is bounded by the slowest stage, failures surface within minutes and a
  failed stage can be rerun alone.
- Each stage sets up its own runner: toolchain and `npm ci` repeat, and
  `cargo-llvm-cov` installs only for `coverage`.
- Test content, coverage floors and order inside a stage are unchanged; no retry
  policy is added.

## Spec references

- [Development checks](../planning/DEVELOPMENT_CHECKS.md)
- [Verification matrix](../planning/low-level/VERIFICATION.md#required-acceptance-matrix)
