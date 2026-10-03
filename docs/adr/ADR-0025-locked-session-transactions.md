# ADR-0025: Compose domain callbacks inside locked session transactions

Status: accepted
Supersedes: none
Superseded by: none
Implementation: P1.3

## Context

P1.3 must publish a real persistence boundary before core behavior depends on it.
The planned `ActorContext` and `command` names did not settle ownership between
store and core. Putting serialized core commands or authorization in the store
would create a dependency cycle and duplicate business semantics.

## Decision

The maintainer approved a synchronous native callback seam documented in DOMAIN
section 4. Trusted registry wiring selects the project root and UUID; the store
canonicalizes that root and verifies existing project metadata. Session UUIDs
generate contained filenames. Separate creation validates a complete Session
under its stable lock and rejects an existing target without replacing it.
Publication uses directory-relative `linkat` to atomically reject a target that
appears after the initial absence check, then removes the exclusive temporary
name and syncs the directory. Existing restored bytes survive unchanged.

Transactions receive the canonical `ReceiptActorScope`, operation UUID and an
ephemeral normalized command JSON value. The store hashes the route, actor scope
and command together using recursively sorted JSON. Core supplies explicit
defaults, expected revisions and exact text, excluding transport request IDs.
The JSON value is only digest input; durable success remains `SavedReceiptData`.
The operation UUID selects an actor-scoped receipt rather than entering the digest.

The store locks, rereads and validates before returning an exact saved replay.
Only a new operation invokes core's callback on an owned candidate. Core owns
authorization, expected revisions, timestamps, message IDs and domain/history
assembly; the callback performs no host/socket/lease waits. Store protects live
identity, revision and prior receipts, increments session revision once, adds the
typed receipt and validates before saving.

Validation composes canonical typed decoding, P1.1 item/tree checks, the merged
P1.2 history validator and transaction receipt identity/scope uniqueness. These
checks do not establish future delivery/result state machines or command
authorization. Their owning core/domain tasks extend validation as behavior is
introduced; store does not claim or implement those semantics ahead of them.

All descendant IO uses directory-relative no-follow opens, safe types, owner UID
and 0700 directories/0600 files. Keyed process mutexes and a permanent sibling
`flock` share a bounded two-second acquisition budget. A synced exclusive temp
candidate replaces live only after a synced previous-valid backup. Sync failure
after live rename is `CommitUncertain` with the operation UUID; a retry resolves
through the persisted receipt. First creation has no backup and an uncertain
creation is resolved by reading its session. There is no journal or automatic
backup recovery.

## Consequences

Core can adopt the native transaction seam without a store-to-core dependency
or a second command DTO. Separate-process writers reread under the same stable
lock; per-item checks in the callback preserve unrelated updates and reject
stale same-item writes. Replays preserve the exact durable result despite later
revisions. Ordinary save/path/validation errors retain typed failures, and invalid
or future snapshots are never overwritten.

MCP/Seezo remain disabled under the owner's current-session waiver. Organization
security guidance was not checked; no approval is claimed.

## Spec references

- [DOMAIN: transaction algorithm](../planning/low-level/DOMAIN_AND_STORAGE.md#4-transaction-and-lock-algorithm)
- [SETUP: storage paths and trust](../planning/low-level/SETUP_AND_DELIVERY.md#1-installed-files-project-data-and-bindings)
- [Module contracts](../planning/MODULE_CONTRACTS.md#shared-contract-changes)
