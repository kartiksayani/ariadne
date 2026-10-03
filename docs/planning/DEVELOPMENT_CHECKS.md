# Development checks

[CONTRIBUTING](../../CONTRIBUTING.md) is the policy.
`scripts/check-commit.py` provides a small path map and ordinary checks.

## Current state

The pinned scaffold compiles and has real Rust/UI tests, native WebView smoke and
packaged release isolation. These prove scaffold wiring, not domain/provider completion.

The installed hook runs cheap format/lint/type checks for changed languages.
It does not run tests, coverage, native builds, size checks or staged-tree identity.
CI runs once per pushed head, cancels older runs on its ref and always reports
`quality`. Feature branches compare origin/main..head; main uses previous-push..head.
Renames inspect old and new paths. Unknown paths/missing base select full checks.

| Scope | Pushed-head checks |
| --- | --- |
| Docs/planning/static chart | Relevant data regeneration and ordinary inline JavaScript ESLint |
| Tooling | Ruff/ESLint and Python/integration tests |
| Application/shared Rust/build | All helper and application tests, rustfmt, Clippy, frontend lint/types, fresh Rust+web coverage and native WebView smoke |

Release isolation additionally runs for dependencies/features/config/capabilities,
native harness, desktop Rust and frontend bundling changes, plus gate/workflow/
coverage-policy changes. Use `--full` or manual CI dispatch at release milestones.
Native OS automation joins when native features exist. Live hosts need owner approval.

```sh
.venv-quality/bin/python scripts/check-commit.py --working-tree
.venv-quality/bin/python scripts/check-commit.py --ci --base origin/main
.venv-quality/bin/python scripts/check-commit.py --full
python3 scripts/regenerate-roadmap.py
```

## Application scaffold obligations

Keep pinned tools, real meaningful behavior tests and >=80% weighted application
executable-line coverage. Fresh `coverage/rust.lcov` and `coverage/web/lcov.info`
include untested handwritten logic; missing/stale reports or omitted sources fail.
Tool code never contributes to the application percentage. Ordinary helper tests remain.

`quality-gates.json` explicitly excludes the seven current comment-only stub
files, declaration-only `dto.rs`/`dto/` paths and known build configuration.
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

Observed public-repository rulesets are described in CONTRIBUTING; neither currently
requires status checks. Organization security guidance was not checked under the
owner's current-session MCP/the review tool waiver.
