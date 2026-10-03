# ADR-0006: Isolate scaffold ping storage

Status: accepted
Supersedes: none
Superseded by: none

## Context

The native smoke specified a runner-owned receipt root but left ordinary scaffold
startup unspecified. Reusing E2E environment paths in production or accepting a
renderer path would establish an unnecessary filesystem interface.

## Decision

Ordinary startup owns a private `tempfile` directory for the process lifetime,
with RAII cleanup. Retain its guard outside managed state, use supported macOS
`App::run_return`, and drop the guard before returning its exit code to the process;
`Builder::run` exits the process without guaranteeing managed-state destructors.
This guarantees ordinary graceful-exit cleanup, not crash/forced-signal recovery.
The E2E feature alone reads a canonical runner-created
`/private/tmp/ariadne-e2e-*` directory with exact 0700 permissions and a 64-hex
expected nonce, and writes its startup witness before starting Tauri. Failure
to validate or write fails startup. Both modes use the same typed ping handler;
the renderer supplies only nonce and a nonempty, control-free payload of at most
128 UTF-8 bytes. Reject before writing and acknowledge only after writing.

## Consequences

This is temporary wiring evidence, not domain/session persistence. Production
ignores E2E environment switches. The bounded test root needs no additional UID
dependency or general recovery mechanism. Organization security guidance was not
checked under the owner's explicit session waiver; no compliance claim is made.

## Spec references

- [First scaffold smoke](../planning/low-level/NATIVE_E2E.md#first-scaffold-smoke-then-real-store-acceptance)
