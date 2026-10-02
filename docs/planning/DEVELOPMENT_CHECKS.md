# Development checks

[CONTRIBUTING](../../CONTRIBUTING.md) is the repository quality policy. The executable
source is `scripts/check-commit.py`; CI and the local hook run the same gate.

## Current state

- Locked Node/Python lint and coverage tools; lint rejects every reported violation.
- Quality tooling has measured coverage and real temporary-Git/CLI functional tests.
- Application code does not exist yet. Its coverage is **N/A**; the first application
  source or root Cargo manifest requires `phase: application` and all real gates.
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

The full workflow acceptance matrix lives in
[Verification](low-level/VERIFICATION.md). Planning checks validate the 30 mockup
frames, linked specifications, and the interactive communication simulator; those
checks do not prove the application has been implemented.

[Mac testing setup](../development/MACOS_TEST_SETUP.md) separates installed machine
tools from application evidence. The embedded WebView-to-Rust gate runs on every
application commit; Appium/Mac2 supplements genuine OS interaction checks as native
features are built. Neither result substitutes for measured Rust/frontend coverage.
