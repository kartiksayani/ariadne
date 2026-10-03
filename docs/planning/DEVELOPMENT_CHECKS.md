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

[ADR-0010](../adr/ADR-0010-classify-uninstrumented-rust-declarations.md) keeps
explicit `quality-gates.json` entries with exactly `path`, `sha256` and `reason`.
The new profile accepts ordinary Rust line/block comments parsed by syn; this
does not change the legacy comment-only byte grammar.
The existing `comment-only-rust-package-boundary` reason remains restricted to
blank/line-comment `crates/<member>/src/lib.rs` with its package manifest.
`uninstrumented-rust-declarations-v1` permits only the following verified Rust:

- Facades: ordinary public external modules and explicit public reexports,
  without aliases/globs, inline modules, path/cfg attributes or protected bindings.
- DTO structs/enums/type aliases: recursively checked data types, no functions,
  impls, traits, constants, statics, discriminants, macros or executable items.
  Plain argument-free DTO paths are allowed; only known containers take type
  arguments. Const arguments, qself, associated bindings and expressions fail.
- Qualified core Debug/PartialEq/Eq/Clone and serde Serialize/Deserialize,
  schemars JsonSchema and ts-rs TS derives only. The external packages/macros
  have exact verified registry/version/checksum identities: serde 1.0.228,
  schemars 1.2.2 and ts-rs 12.0.1. Cargo aliases cannot replace core/std or
  protected external derive bindings. Unknown derives/attributes fail.
- Only demonstrated serde tag/rename_all/deny_unknown_fields and the exact
  safe-integer u64 schemars range; no serialization/default/schema callbacks,
  crate overrides, `schemars(required)` or source-local ts export attributes.
  String doc attributes are allowed. Unsupported syntax needs normal measurement
  or a separately reviewed policy change.

Each classified file retains its exact SHA. Its library root and actual module
ancestors must also be SHA-classified verified facades, using unambiguous ordinary
`foo.rs`/`foo/mod.rs` paths; symlinks, hidden/inline/path-mapped ancestors fail.
Every child executable file remains inventoried. The pinned syn 2.0.119 AST helper
validates the whole source; syntax acceptance does not prove runtime validation.
The tested generator uses schemars draft07 `for_serialize()` and explicit ts-rs
Config large-int number exports. Serde still accepts missing Option keys and
out-of-range u64; domain validation must enforce those input contracts separately.

The gate rejects malformed/duplicate entries, missing files, stale hashes and
repository escapes. Canonical `apps`, `crates`, `integrations` remain recursively
inventoried, including shipped Mods and future `.mjs`/`.cjs`. Existing generated,
vendor, dependency, test and declaration classifications remain; no broad dist
exclusion. Vite output stays in root `target/desktop-dist`.

`coverage_tooling` still permits only the three exact desktop Vite/native-WDIO/
Tauri-build paths. In addition, fixed workspace packages `ariadne-coverage-inventory`
at `tools/coverage-inventory` and future `ariadne-xtask` at `tools/xtask` are
excluded only from the application report after strict metadata/target ownership
verification. The helper's actual syn 2.0.119 registry/checksum binding is verified
before excluding its report. Root local path patch/replace overrides are explicitly
unsupported; tool-root substitutions fail before active graph traversal. No application dependency may reach tooling through normal, dev,
build, renamed, optional, target-specific or transitive edges. Relevant unresolved
local/path/substituted identities fail. Every present tool has its own recursive
source inventory, fresh report and independent >=80% line floor; tool coverage
cannot compensate for application coverage. All workspace fmt/Clippy and all-feature
tests still run, including tools. One instrumented test run produces application
LCOV, then package-selected report-only exports reuse those same profiles.

Both canonical Rust/web reports must be fresh and each contain genuine DA lines.
Only verified non-executable sources receive explicit SF/LF:0/LH:0 records after
Rust measurement, adding no covered lines. Actual DA for a classified source,
duplicate zero evidence, missing executable sources, unverified zeros and zero-only
reports fail. The combined application executable-line floor remains >=80%.

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
