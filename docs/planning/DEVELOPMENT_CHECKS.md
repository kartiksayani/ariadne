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
The current history/rail components, their local CSS and the existing desktop
history test directory also skip capture: the reference gallery imports only its
reference components/styles and does not load these modules. Remove this narrow
exception when the gallery starts importing them. Other product modules retain
capture; this is not a general frontend exemption.
Application tests, frontend build/lint/types, weighted Rust+web coverage, Clippy,
native WebView smoke and selected packaged release checks run independently.

CI runs three parallel matrix jobs (`quality / static`, `quality / coverage`,
`quality / native`), each `scripts/check-commit.py --ci ... --stage <name>`
([ADR-0078](../adr/ADR-0078-parallel-quality-stages.md)). `--stage` defaults to `all`,
which runs every stage in the original order for local use:

| Stage | Runs |
| --- | --- |
| `static` | Lint, roadmap check, Python tests, install coverage, `npm run build`, `cargo build`, Clippy, `key_event_tests`; reference capture when selected |
| `coverage` | `cargo llvm-cov` (workspace and xtask), `npm run test:coverage`, combined line-coverage floor |
| `native` | `npm run test:e2e` (`test:native` without release isolation) |

Docs/tooling scopes run their cheap checks in `static`; `coverage` and `native`
report that nothing applies. A final `quality` job (the required status check) needs
all three and fails unless every one succeeded. Each job uploads `coverage/` as
`quality-evidence-<run>-<attempt>-<stage>`; rerunning a failed job reruns only that stage.
The coverage and native stages start with `cargo fetch --locked`, and docs-scope pushes
skip the setup of those two no-op stages.

CI caches the Rust build and npm between runs (owner ruling 2026-10-06, reversing
PR #23's no-cache choice for wall-clock): `Swatinem/rust-cache` per stage (key
`<stage>`, `target/native-e2e` included, saved on every branch), the `cargo-llvm-cov`
binary via `actions/cache` (installed only on a miss) and the `~/.npm` cache keyed on
`package-lock.json`. The isolated `RUSTUP_HOME` toolchain is not cached. Builds stay
`--locked`, so a cache cannot change inputs; clear a corrupted cache by changing the key
or from the Actions → Caches page.

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
External Rust integration tests in `ariadne-core/tests/` and
`ariadne-agent-protocol/tests/` do not enter production builds, so changes confined
to those `.rs` files retain all application/coverage/native checks without packaged
release isolation. Production crate sources, manifests/configuration, unknown paths,
missing bases and full/manual runs keep their existing release selection.
When frontend type/CSS checks run, `npm run check` owns the single repository-wide
ESLint pass. JS-only changes retain standalone ESLint; maintained inline HTML
scripts still receive their separate stdin lint.

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
these wiring files. Domain `src/models/primitives.rs` is fully measured.
The CLI `src/lib.rs` exclusion likewise covers only its bridge module export;
the executable main, bridge command, codec and lease logic remain measured.
The exact desktop Rust `src/native/mod.rs` and `src/native/window/mod.rs`
exclusions cover only module declarations and the `NativeWindow` re-export;
LLVM produces no executable lines for these files. Routes, geometry, lifecycle,
preferences, desktop window operations and macOS wake logic remain measured.
The exact desktop `src/data/index.ts` exclusion covers only re-exports. Vite
consumes the same reviewed exclusion patterns in project-relative and absolute
forms for external integration sources, so this zero-line barrel is omitted
from measured LCOV. Remove any wiring exclusion in the same PR that adds its first
executable logic; the independent reviewer checks the affected wiring files and
the real report.
The exact Claude `plugin/hooks/installed.js` exemption covers comments and the
installer descriptor data export (`export default null` in source). Claims,
contracts, registration and setup remain measured, including untested logic.
Remove this exemption in the same PR that adds executable logic; a pure installer
descriptor cannot contain hidden behavior.
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
