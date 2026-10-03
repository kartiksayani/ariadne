# Development checks

[CONTRIBUTING](../../CONTRIBUTING.md) is the repository quality policy. The executable
source is `scripts/check-commit.py`; CI and the local hook run the same gate.

## Current state

- Locked Node/Python lint and coverage tools; lint rejects every reported violation.
- Quality tooling has measured coverage and real temporary-Git/CLI functional tests.
- The scaffold activates `phase: application` from its first application source
  and root Cargo manifest; every application snapshot runs all real gates.
- Every application commit: Rust format/Clippy, TS/JS/CSS lint and type checks, unit
  and integration tests, deterministic UI-to-Rust E2E, weighted Rust+TS/JS coverage
  of at least 80%, including untested production files. Live hosts are milestone tests.
- Prefer about 500 handwritten changed lines per PR; maximum 800 per commit and
  1600 per PR, including tests/config.
  Original design/spec imports and generated lockfiles are reported separately.
- Every PR commit and the integrated result run CI. Independent review and final
  spec adjudication belong to the maintainer, tied to the exact current head.

## Remote limitation

The private GitHub repository is connected. GitHub rejected branch protection on
its current plan with HTTP 403. CI and the maintainer workflow are enabled, but
server-enforced protection awaits GitHub Pro. Keep the repository private; do not
change billing/visibility or claim main is protected. The intended protection
payload is `.github/main-protection.json`.

## Application scaffold obligations

The scaffold task pins Rust/Tauri/React/Vite and coverage/browser tooling, installs
it in CI, activates application gates, and introduces an actual minimal UI-to-Rust
round trip test. Generated contracts have drift checks. Type-only/empty source files
must be represented explicitly by the coverage tooling; any instrumentation
exception is a narrow reviewed policy change, never a blanket module exclusion.

[ADR-0004](../adr/ADR-0004-account-for-scaffold-coverage-sources.md) permits only
these explicit classifications in `quality-gates.json`:

- `non_executable_sources`: objects with exactly `path`, `sha256` and `reason`.
  The reason is `comment-only-rust-package-boundary`; the path must be an existing
  `crates/<member>/src/lib.rs` with its package `Cargo.toml`. The SHA-256 covers
  the exact file bytes. Only blank lines and `//` line comments qualify; code,
  attributes and block comments fail even after a hash update. Adding executable
  Rust requires removing the classification and measuring the source normally.
- `coverage_tooling`: distinct exact paths from the fixed allowlist
  `apps/desktop/vite.config.ts`, `apps/desktop/wdio.native.conf.mjs` and
  `apps/desktop/src-tauri/build.rs`. These build/test configuration files remain
  subject to lint, compilation and relevant tests; their lines do not enter
  production coverage. Other paths and glob patterns fail.

The gate checks classification types, duplicate entries, missing files, hashes
and repository escapes. It recursively inventories canonical `apps`, `crates`
and `integrations` sources, including shipped Mods and future `.mjs`/`.cjs` files.
The existing generated/vendor/dependency/test/declaration classifications remain;
there is no broad `dist` exclusion. Vite output belongs in repository-root
`target/desktop-dist`, outside the production roots.

Both canonical reports, `coverage/rust.lcov` and `coverage/web/lcov.info`, must
be freshly produced and each must contain genuine executable `DA` line data.
After Rust measurement, the gate adds explicit `SF`/`LF:0`/`LH:0` records only
for verified comment-only boundaries. These records account for zero executable
lines and add no covered lines. Every other production source needs executable
line evidence; an omitted file, an unverified zero-line record or a zero-only
report fails. The combined executable-line floor stays at least 80% from the
first application commit.

[ADR-0005](../adr/ADR-0005-use-out-of-line-rust-coverage-tests.md) keeps Rust tests
out of production files, in `src/tests` or package `tests` directories, so inline
test code does not inflate the production denominator. Tests still execute real
validation, file operations and process behavior; no coverage flags are weakened.

[ADR-0008](../adr/ADR-0008-select-supported-native-ci-image.md) selects standard
arm64 `macos-26` for both CI jobs, using the image's selected full Xcode. Each
snapshot records actual macOS/architecture/Xcode rather than asserting the owner's
Xcode build. CI installs Node 22.23.2, npm 10.9.8, Rust 1.98.1 with rustfmt,
Clippy and llvm-tools-preview, and cargo-llvm-cov 0.9.1. Deployment target stays
13.0; two Cargo jobs and incremental compilation off bound resource usage.
Missing tools or a usable GUI are gate failures. Every PR commit and integrated
result run the same complete checks; no self-hosted host/settings/billing change.

The full workflow acceptance matrix lives in
[Verification](low-level/VERIFICATION.md). Planning checks validate the 30 mockup
frames, linked specifications, and the interactive communication simulator; those
checks do not prove the application has been implemented.

[Mac testing setup](../development/MACOS_TEST_SETUP.md) separates installed machine
tools from application evidence. The embedded WebView-to-Rust gate runs on every
application commit; Appium/Mac2 supplements genuine OS interaction checks as native
features are built. Neither result substitutes for measured Rust/frontend coverage.
