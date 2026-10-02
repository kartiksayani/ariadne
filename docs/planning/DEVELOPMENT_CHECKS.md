# Repository quality checks

This is the step-1 foundation for a private GitHub repository under
`kartiksayani/ariadne`. The existing local history is preserved. Remote creation,
branch publication and protection activation remain pending until access works.

## A small set of rules

1. One independently useful change per PR. Include its task/spec reference, the
   behavior changed and the tests proving it. Fixes include a regression test.
2. Every commit is linted and tested. Do not push work that only becomes correct
   in a later commit. Run the same checks locally and in CI.
3. At least 80% overall line coverage over all hand-authored application code.
   Passing coverage does not replace a test of the actual user workflow.
4. Keep commits and PRs small. Prefer around 200 lines; the gate caps hand-authored code/test/config changes
   at400 lines per commit and800 per PR, including tests. Documentation is
   reported separately and still needs a focused review. Split larger work by behavior; generated
   lockfiles/assets are reported separately. Initial source/spec imports are
   identified explicitly and reviewed as imports, not hidden in feature PRs.
5. Main accepts reviewed PRs with current passing checks. No force-push, branch
   deletion or direct feature pushes. Re-run checks/review after the PR changes.
6. Changing lint/coverage/CI policy is a separate reviewed change. Never weaken a
   gate, expand coverage exclusions or disable a test just to make another PR pass.

## Coverage meaning

Overall coverage is `(covered executable lines across Rust + JS/TS) / (all
executable lines across those languages)`, not the average of their percentages.
The first-party Mod JavaScript and Rust native/CLI wrappers are application code.
Coverage configuration must include files with zero test hits. Generated/vendor
code, test code, original design exports, documentation and research-only POCs
are excluded; exclude no hand-authored product module to reach the threshold.

Rust: cargo-llvm-cov produces `coverage/rust.lcov`. Frontend and shipped Mod:
Vitest with V8 coverage produces `coverage/web/lcov.info`. The check script merges
line records and rejects missing/empty reports, stale outputs and totals below80%.
At M0 pin the Rust toolchain/coverage tool and npm versions, generate lockfiles,
configure coverage include globs and make those artifacts reproducible.

Current `quality-gates.json` is in `planning` phase because no app exists. The
first Cargo/application code commit must change it to `application` and wire all
commands below. Planning validation never substitutes for product coverage. The
80% requirement is not claimed achieved while application coverage is N/A.

## Tests that matter

Every application commit runs unit tests, real core/CLI integration tests, and a
deterministic end-to-end workflow through the UI and actual Rust backend. Use an
in-process or local fake at the provider boundary only: do not mock the domain,
store or queue that the end-to-end test is meant to exercise. Required journeys:

- Create a project/session/topic/items; render them; submit an item message.
- Deliver five queued messages in order; publish targeted replies/status/children;
  verify the full conversation and Waiting/Sent behavior.
- Reload/reopen and read saved state; keep routing isolated across two sessions.
- Handle repeated submissions, stale edits, disconnected agent and missing result.
- Exercise tree/graph selection and viewport behavior with the optimized graph.

Real Claude/Codex five-input smoke runs are milestone/integration-change checks,
not per-commit paid inference. Reuse live evidence only for unchanged primitives;
record the actual tested host versions. Native smoke testing uses the owner's
Mac. Do not require broad OS matrices or exotic crash/corruption/recovery tests.

## Install local development tools and hook

From the repo root, in a terminal with network and Git metadata write access:

```sh
rtk proxy uv venv .venv-quality
rtk proxy uv pip install --python .venv-quality/bin/python -r requirements-dev.txt
rtk proxy npm install --ignore-scripts
rtk proxy git config --local core.hooksPath .githooks
rtk proxy python3 scripts/check-commit.py --working-tree
```

Commit the resulting npm lockfile; CI uses npm ci. The hook runs on normal local
commits. Git hooks can be bypassed locally, so GitHub protections and CI are the
merge boundary. No bypass flag is used by the agents. The hook requires intended
work to be staged so tests cover the same tree that will be committed; it does
not auto-stash or rewrite files. `--working-tree` is for checking edits, not a hook
option. CI uses an isolated checkout and `--ci`.

Current planning checks: Ruff over maintained Python, ESLint over maintained JS,
quality-tool unit tests, planning artifact validation and offline POC tests when
those research files are present. Documentation/fixture scripts are not app tests.
A missing linter or test tool fails; it is never silently treated as a pass.

Application checks add:

```sh
rtk proxy cargo fmt --all -- --check
rtk proxy cargo clippy --workspace --all-targets --all-features -- -D warnings
rtk proxy npm run lint
rtk proxy cargo llvm-cov --workspace --all-features --lcov --output-path coverage/rust.lcov
rtk proxy npm run test:coverage
rtk proxy npm run test:e2e
```

`npm run lint` covers all hand-authored frontend/Mod code and config, including
TypeScript checking and CSS Modules linting. It allows zero lint warnings/errors.
Do not add a placeholder successful command for an unimplemented test suite.

## Remote protections and independent review

Enable required PRs, current successful quality/change-policy checks, resolved
review conversations, linear history, no force pushes/deletions, and protections
for administrators too. A maintainer spec-review status is tied to the exact PR
head commit. Step3 will automate it after independent review and adjudication;
until then it is based on an actual independent agent review, not an empty check.
An agent-authored PR cannot approve itself just because its tests pass.

If agents share one GitHub account, their independent execution contexts do not
create separate GitHub identities. Use PR review comments and the maintainer
status for the autonomous workflow; do not require an impossible self-approval.
For stronger separation later, a dedicated maintainer GitHub App can own the
status. This is a workflow safeguard, not a sandbox against malicious local code.

Sources for the selected tools: [Git hooks](https://git-scm.com/docs/githooks),
[cargo-llvm-cov](https://github.com/taiki-e/cargo-llvm-cov),
[Vitest coverage](https://vitest.dev/guide/coverage.html), and
[GitHub branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

## Current access limitations

The attempted local hook activation failed because `.git/config` is read-only in
this session. npm/PyPI dependency installation and GitHub API access failed due
to network/DNS restrictions. Consequently hook activation, full lint execution,
lockfile resolution, remote publication and branch-protection verification are
not yet complete. Remove this note only after those operations actually succeed.
