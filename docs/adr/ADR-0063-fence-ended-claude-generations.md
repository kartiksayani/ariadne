# ADR-0063: Fence ended Claude binding generations

Status: accepted
Supersedes: none
Superseded by: none

## Context

The installed Claude Mod can report actual SDK session end while its original
bound announcement still awaits native activation. Persisting Disconnected alone
allows that delayed activation to persist Connected and re-enable the ended scope.
A Mod timeout cannot cancel native work that already began.

## Decision

The maintainer reserved `claude:session-ended:<binding UUID>:<generation UUID>`
for the exact non-attempt Disconnected event on a Claude binding. Core persists
its existing Event receipt even when already disconnected and rejects fresh
Connected under the same Store transaction lock. Exact event replay retains its
existing precedence and never rewrites current state.

One protocol identity implementation and one Core receipt lookup serve report
and native activation. Native current-scope checks reject ended generations before
activation and publication. The Mod retains the exact event for failed-ack retries.

## Consequences

The fence survives restarts and delayed work without new DTO fields or service
methods. Ordinary transport loss remains reconnectable, and a deliberate connect
rotates generation. Diagnostic reason strings carry no lifecycle authority. Core
claim admission remains authoritative across races after native checks.

The installed consuming fixture holds the real bound callback and sends actual
SDK session.end before releasing native activation. It uses production CLI,
NativeActivation, Core and Store; the SDK and host version response are scripted.

## Spec references

- [Claude installed-helper contract](../planning/MODULE_CONTRACTS.md#claude-installed-helper-acceptance-join)
