# Development and review

## Setup

Use pinned Node 22.23.2, npm 10.9.8, Rust 1.98.1 and Python 3.12 (minimum 3.11).
Read [macOS testing setup](docs/development/MACOS_TEST_SETUP.md) for native prerequisites.

```sh
python3 -m venv .venv-quality
.venv-quality/bin/python -m pip install -r requirements-dev.txt
npm ci --ignore-scripts --engine-strict
git config --local core.hooksPath .githooks
.venv-quality/bin/python scripts/check-commit.py --working-tree
```

RTK is an outer agent convenience; repository checks and CI do not depend on it.

The pre-push hook reads a local newline-separated word list from the file named
by `ARIADNE_PRIVATE_WORDS`, or `~/.config/ariadne/private-words.txt`. Keep it outside
the repo; blank lines and `#` comments are ignored. Literal, case-insensitive
matches in added lines or pushed commit messages block the push. A missing list
prints a note and allows the push.

## Quality and review

Keep each PR coherent and reviewable. There are no numeric commit/PR caps.
The hook checks changed-language format, lint and types; it does not run full
tests, coverage or native builds and does not require a clean unstaged tree.

CI runs once on each pushed head and cancels an older run on the same ref.
A small map in `scripts/check-commit.py` selects docs, tooling or application
checks. It compares the whole feature branch against origin/main, or main's
previous push against its head. Missing bases and unknown paths run full checks.
The `quality` job always reports. See [Development checks](docs/planning/DEVELOPMENT_CHECKS.md)
for the commands, coverage exclusions and release-sensitive paths.

Tests find elements by role, label, text or `data-testid`, never by CSS class. The
`ariadne/no-class-selectors` lint rule (`scripts/eslint/`) enforces it on test files that are not in
`scripts/eslint/class-selector-baseline.json`. That list is frozen and may only shrink: when you convert
the last class selector in a listed file, delete the file from the list (a unit test fails on a stale entry).
Never add a file to it.

Application changes require meaningful tests, Clippy, >=80% weighted Rust+TS/JS
executable-line coverage including untested handwritten logic, and native WebView
smoke. Release-sensitive changes additionally prove packaged release isolation;
manual milestone checks run the full suite. Live paid hosts require owner approval.

An independent context reviews the latest GitHub diff at the exact head.
The author fixes findings; one targeted re-review follows. Required unresolved
issues remain unmerged. Before squash merge, update the PR against current main
and verify its head/base, independent exact-head review and green quality on that
integrated state. Monitor main's CI asynchronously after merging; a pending main
run does not block the next qualified PR, but a failed main run pauses further
merges until diagnosed and corrected. No structured
receipts or separate patcher are required. Never fake test results or skip hooks.

Important architecture decisions get short [ADRs](docs/adr/README.md).
Routine decisions and ownership/spec updates can ship in the product PR.

## GitHub enforcement

The repository `kartiksayani/ariadne` is public. Observed on 2026-10-03:
ruleset 24380843 (main-1) blocks deletion and non-fast-forward updates with no
bypass. Ruleset 24380844 (main-2) requires a PR with zero approvals and the GitHub
Actions `quality` check (not strict) with no bypass actors, so admins also need green
`quality` on the PR head. Independent agent review is still required by our workflow
because agents share one GitHub identity. Only squash merge is enabled. Do not change
visibility, billing, rulesets or other remote settings without owner authorization.
