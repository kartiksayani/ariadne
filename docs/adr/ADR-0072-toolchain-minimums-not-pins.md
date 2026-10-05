# ADR-0072: Install requires toolchain minimums, not exact versions

Status: accepted
Supersedes: none
Superseded by: none

## Context

`make install` required exactly Node 22.23.2, npm 10.9.8 and Rust 1.98.1, so almost
every new user failed preflight. The owner's principle: "not a good idea pinning
exact version; minimum required version is fine". Nothing depends on exactness:
`Cargo.lock` and `package-lock.json` fix dependencies, and the receipt's
`preflight` record is written but never compared by reinstall, uninstall or
`ariadne doctor`. `rust-toolchain.toml` names an exact channel, which rustup
would download when missing; that conflicts with the no-download contract.

## Decision

- The installer preflight accepts Node >= 22.23.2, npm >= 10.9.8 and Rust >= 1.98.1
  (any newer version) and rejects only older or unparsable versions with a plain
  message. The receipt still records the versions actually used.
- Rust: use the pinned 1.98.1 toolchain when already installed; otherwise use the
  owner's default toolchain, resolved outside the checkout so `rust-toolchain.toml`
  does not apply. The build sets `RUSTUP_TOOLCHAIN` to the chosen toolchain and
  `RUSTUP_AUTO_INSTALL=0`. Nothing is downloaded.
- `package.json` `engines` become `>=` ranges so `npm ci --engine-strict` agrees.
- CI keeps its exact pins; they serve reproducibility, not a user requirement.

## Consequences

A newer patch toolchain installs and reinstalls normally. Dependency `engines`
ranges can still reject unsupported Node lines under `--engine-strict`.

Spec: `docs/planning/low-level/SETUP_AND_DELIVERY.md` section 7, task P6.4.
