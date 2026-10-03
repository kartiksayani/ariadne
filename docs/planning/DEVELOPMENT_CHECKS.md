# Development checks

[CONTRIBUTING](../../CONTRIBUTING.md) is the policy.
`scripts/check-commit.py` provides a small path map and ordinary checks.

## Current state

The pinned scaffold compiles and has real Rust/UI tests, native WebView smoke and
packaged release isolation. These prove scaffold wiring, not domain/provider completion.

The installed hook runs cheap format/lint/type checks for changed languages.
It does not run tests, coverage, native builds, size checks or staged-tree identity.
CI runs once per pushed head, cancels older runs on its ref and always reports
`quality`. Feature branches compare merge-base(origin/main, HEAD)..HEAD; main uses previous-push..HEAD.
Renames inspect old and new paths. Unknown paths/missing base select full checks.

Reference gallery capture and its Chromium provisioning use a separate conservative
selector. Changes confined to Rust sources or Cargo manifests in crates/desktop
Rust, root Cargo/toolchain files, Markdown documentation and the static task/chart
metadata skip that capture. Frontend, design, asset, browser-test, Node dependency/
configuration and other paths retain it; missing bases and manual full runs capture.
Application tests, frontend build/lint/types, weighted Rust+web coverage, Clippy,
native WebView smoke and selected packaged release checks run independently.

| Scope | Pushed-head checks |
| --- | --- |
| Docs/planning/static chart | Relevant data regeneration and ordinary inline JavaScript ESLint |
| Tooling | Ruff/ESLint and Python/integration tests |
| Application/shared Rust/build | All helper and application tests, rustfmt, Clippy, frontend lint/types, fresh Rust+web coverage and native WebView smoke |

Release isolation additionally runs for dependencies/features/config/capabilities,
native harness, desktop Rust and frontend bundling changes, plus gate/workflow/
coverage-policy changes. Use `--full` or manual CI dispatch at release milestones.
Native OS automation joins when native features exist. Live hosts need owner approval.
`ariadne-agent-protocol` has a default-off `test-support` feature for its scripted
fake; crate tests also compile the fake with `cfg(test)`. Its Rust source changes
trigger release isolation to keep the fake outside default release builds. Other
crate source edits retain application/native checks. A PR adding another crate
feature, feature-gated code or a desktop dependency on an internal crate must add
the relevant paths to `RELEASE_FILES` or the release path checks in `scope_for`
(`scripts/check-commit.py`) with a focused scope test.

```sh
.venv-quality/bin/python scripts/check-commit.py --working-tree
.venv-quality/bin/python scripts/check-commit.py --ci --base origin/main --merge-base
.venv-quality/bin/python scripts/check-commit.py --full
python3 scripts/regenerate-roadmap.py
```

## Application scaffold obligations

Keep pinned tools, real meaningful behavior tests and >=80% weighted application
executable-line coverage. Fresh `coverage/rust.lcov` and `coverage/web/lcov.info`
include untested handwritten logic; missing/stale reports or omitted sources fail.
Tool code never contributes to the application percentage. Ordinary helper tests remain.

`quality-gates.json` explicitly excludes the six current comment-only stub
files, declaration-only `dto.rs`/`dto/` paths and known build configuration.
The exact domain `src/lib.rs` and `src/models/mod.rs` exclusions cover only module
declarations/re-exports: real LLVM measurement produces no executable lines for
these wiring files. Domain `src/models/primitives.rs` is fully measured. Remove
either wiring exclusion in the same PR that adds its first executable logic;
the independent reviewer checks both files and the real report.
Generated/vendor/dependency/test sources are excluded by path. There is no blanket
`crates/**/lib.rs` exemption, AST parser, source SHA or dependency-identity classifier.
Remove a stub's exact exclusion when its first logic lands. Declaration paths must
never contain validators, constructors or other handwritten executable logic;
the independent reviewer checks this. Do not hide handwritten logic in generated files.
LCOV comes from real measurement; no invented zero-line records.

Native smoke keeps real UI → invoke → Rust → disk behavior, isolated temporary
data and actual PID/port cleanup. Packaged release proof keeps the test-only plugin,
permissions and frontend modules out of production. See
[Native E2E](low-level/NATIVE_E2E.md) and [Mac setup](../development/MACOS_TEST_SETUP.md).

Main requires the `quality` check with no bypass (details in CONTRIBUTING).
Organization security guidance was not checked under the
owner's current-session MCP/Seezo waiver.
