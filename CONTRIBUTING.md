# Development and review

## Setup

Use Node 22.23.2 and Python 3.12 (minimum 3.11).

```sh
python3 -m venv .venv-quality
.venv-quality/bin/python -m pip install -r requirements-dev.txt
npm ci --ignore-scripts
git config --local core.hooksPath .githooks
.venv-quality/bin/python scripts/check-commit.py --working-tree
```

Use `rtk proxy` before shell commands when working in the owner's agent environment.

## Six rules

1. One useful behavior per PR, with its task ID and exact spec section. Prefer about
   500 changed handwritten lines; maximum 800 per authored commit and 1600 per PR,
   including tests/config. Main's integrated squash commits have the 1600-line PR
   cap; push checks enforce it separately for every commit in the event range.
   Docs, original assets and generated lockfiles are counted separately;
   the task catalogue `docs/delivery/tasks.json` is documentation too.
   Their exemption is not permission to hide application code there.
2. Run all lint and tests on every commit. The hook refuses unstaged/untracked changes
   so it tests exactly what is committed. Use a clean worktree, no automatic stash.
   CI repeats checks for every PR commit and GitHub's integrated merge result.
3. At least 80% measured line coverage. Quality helpers have their own measured gate.
   Application coverage combines covered/total executable Rust and JS/TS lines,
   includes untested files, and rejects missing/stale reports. The application is not
   built yet: its coverage is N/A, not a claimed pass. Its first source/Cargo commit
   must activate the application gate and install the real toolchain/test commands.
4. Test complete behavior too: real core/storage/CLI/UI with a fake only at the agent
   boundary. Every application commit runs deterministic E2E. Live Claude/Codex tests
   run at integration milestones, not on every commit. No placeholder passing tests.
5. An independent agent reviews the current PR diff; the maintainer adjudicates
   findings against the spec, verifies patches and checks the final head before
   merging. Changed code invalidates prior verification. Record tests, coverage and
   exact commit IDs on the PR; do not claim skipped checks passed.
6. Quality-policy changes are separate reviewed PRs. Never lower thresholds, disable
   tests, widen exclusions or bypass hooks merely to get another change through.

## Checks

Ruff covers maintained Python; ESLint covers maintained JavaScript, including
inline JavaScript in the interactive planning diagrams. Both allow zero
reported violations. Python tests include real temporary Git repositories and CLI
processes. Application gates additionally require rustfmt, Clippy with warnings as
errors, frontend/Mod lint and type checking, cargo-llvm-cov, frontend coverage, and
E2E. The scaffold task pins and installs the Rust/JS tools before these gates activate.

Planning checks validate source designs, links and interactive communication flows;
they are not application tests. No app code may be committed in planning mode.

## GitHub enforcement

Repository: private `kartiksayani/ariadne`. Always squash and merge PRs into main;
other merge methods are disabled. PR checks and the local hook retain the 800-line
cap for each authored source commit; main checks allow each resulting squash
commit up to the 1600-line PR cap. Main push ranges may contain multiple squashes.
Refresh feature branches with rebase when needed before final-head review.
Keep branches for traceability; do not auto-delete them.

**GitHub rejected branch protection with HTTP 403 on this private repository's
current plan (2026-10-02).** CI and the autonomous maintainer enforce the workflow,
but an account with write access can still bypass them. Do not call main protected.
The ready-to-apply payload is `.github/main-protection.json`; enable it after the
owner upgrades to GitHub Pro. Never change visibility or billing automatically.

Agents share the owner's GitHub identity. They post independent-context review
comments, not impossible self-approvals. `maintainer-spec-review` is a commit status
posted only after genuine review and final spec adjudication; it is not a fake CI
job. No checks can prevent a malicious account administrator from changing policy.

Organization security guidance was not checked: the owner explicitly requested
proceeding without the review tool/MCP. No organization-compliance claim is made.

## Bootstrap provenance

The initial dependency/checker commits were tested locally while installing the
hook itself. After the hook/CI foundation commit, normal commits use the same
complete gate. The archived planning/prototype import is on a reference branch,
not an application change or an exception for future feature PRs.
