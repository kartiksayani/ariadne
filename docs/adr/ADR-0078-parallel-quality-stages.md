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
- A final job named `quality` (`needs: [stage]`, `if: ${{ !cancelled() }}`) fails unless every
  stage succeeded. It keeps the status check name the branch ruleset requires.
- Caching (owner ruling 2026-10-06) reverses PR #23's deliberate no-cache choice; the
  reason is CI wall-clock. Application-scope runs use `Swatinem/rust-cache` on `.` and
  `target/native-e2e` (the workflow's `CARGO_TARGET_DIR`) with `key: <stage>`, so each
  stage has its own cache (coverage builds instrumented artifacts) and
  `cache-on-failure: true`. Every branch saves, so a pull request's second push benefits.
  The `cargo-llvm-cov` binary is cached with `actions/cache` (key
  `<os>-cargo-llvm-cov-0.9.1`) and installed only on a miss. `setup-node` caches `~/.npm`
  keyed on `package-lock.json`. The isolated `RUSTUP_HOME` toolchain is not cached.
  Scope detection, the toolchain install and the gate run as separate workflow steps so
  the cache step can follow the toolchain and be gated on the scope output.
- `history.spec.mjs` clicks "Request reopen"/"Follow up" again once if the owner-input
  editor has not appeared after 2 s. CI showed the click landing during the re-render
  after a CLI-published result, leaving the previous saved receipt on screen.

## Consequences

- Wall-clock is bounded by the slowest stage, failures surface within minutes and a
  failed stage can be rerun alone.
- Each stage sets up its own runner: the toolchain and `npm ci` repeat, and
  `cargo-llvm-cov` is needed only for `coverage`; build outputs and downloads come
  from the caches.
- A cache cannot change inputs, because every build is `--locked` and `npm ci` is exact.
  A corrupted cache is cleared by changing the key or from the Actions → Caches page.
- The `coverage` and `native` stages run `cargo fetch --locked` first because they
  start cold; `--stage all` is fetched by its earlier `cargo build`, so it skips this.
- `native` no longer runs after the coverage gate; only `--stage all` keeps the old
  "coverage before native" order.
- `RUSTUP_HOME` is the stable path `$RUNNER_TEMP/ariadne-rustup`, because
  `Swatinem/rust-cache` hashes `RUST*`/`CARGO*` environment values into its cache key.
- The three stage caches share GitHub's 10 GB per-repository quota; eviction only makes
  a build cold, never wrong.
- Docs and tooling scope skip the setup, check and evidence steps of `coverage` and
  `native`; the aggregate `quality` job uses `if: ${{ !cancelled() }}` so a superseded
  run does not report a red status.
- Test content, coverage floors and order inside a stage are unchanged; no retry
  policy is added.

## Spec references

- [Development checks](../planning/DEVELOPMENT_CHECKS.md)
- [Verification matrix](../planning/low-level/VERIFICATION.md#required-acceptance-matrix)
