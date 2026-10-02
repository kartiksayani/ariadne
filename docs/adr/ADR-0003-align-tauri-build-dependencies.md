# ADR-0003: Align the top-level Tauri API and Rust versions

Status: accepted
Supersedes: none
Superseded by: none

## Context

The disposable native probe reached a real lockfile and exposed a mismatch:
Tauri CLI 2.12.1 rejects top-level JavaScript API 2.11.1 with Rust Tauri 2.12.1.
API 2.12.1 is published. WDIO plugin 1.4.0 independently declares its nested
API 2.11.1; ignoring the CLI check would conceal the scaffold's incompatible pin.

## Decision

Pin the application's top-level `@tauri-apps/api` to 2.12.1 alongside CLI and
Rust Tauri 2.12.1. Retain the WDIO plugin's published nested API 2.11.1 in the
resolved lockfile and verify that exact graph with the real native run. Do not
use `--ignore-version-mismatches`.

## Consequences

The scaffold must commit its actual npm/Cargo lockfiles and exercise native
runtime compatibility; registry existence alone does not prove the integration.
This corrects the earlier setup table without upgrading the chosen WDIO plugins.
The standalone native smoke passed with this locked graph on 2026-10-03; the
application scaffold must still exercise its own graph and behavior gates.

## Spec references

- [Native dependency baseline](../planning/low-level/NATIVE_E2E.md#baseline-and-files)
- [Mac testing setup](../development/MACOS_TEST_SETUP.md)
