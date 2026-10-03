# ADR-0008: Select a supported native CI image

Status: accepted
Supersedes: none
Superseded by: none

## Context

The application gate needs a real macOS GUI and full Xcode. GitHub has announced
macOS 14 runner retirement; an owner-machine Xcode version cannot be assumed on
a standard hosted image.

## Decision

Use standard arm64 `macos-26` for both jobs and its selected default full Xcode.
Record actual macOS, architecture, Xcode selection/version for every checked
snapshot. Install exact Node 22.23.2, npm 10.9.8, Rust 1.98.1 with rustfmt,
Clippy and llvm-tools-preview, and cargo-llvm-cov 0.9.1. Keep deployment target
13.0, two Cargo build jobs and incremental compilation off.

## Consequences

Missing/unsupported tools or unusable GUI fail the gate, never a passing skip.
CI need not share the owner's exact Xcode build. No runner account, repository
setting, self-hosted host or billing change is required.

## Spec references

- [Development checks](../planning/DEVELOPMENT_CHECKS.md#application-scaffold-obligations)
- [GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [macOS 14 retirement](https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/)
