# ADR-0026: Register explicit roots and verify binding setup before persistence

Status: accepted
Supersedes: none
Superseded by: none
Implementation: P1.4

## Context

Binding setup must serialize identity selection across projects without holding
filesystem locks during provider checks or creating tentative provider handles
with IDs that persistence later discards. Session snapshots remain authoritative;
a separate routing index cannot become a second copy of operation state.

## Decision

The maintainer approved a private schema-1 project registry containing canonical
roots, project UUIDs and exact actor-local setup registration receipts. The absent
registry has an internal zero counter; the first persisted registration and its
receipt have revision 1, followed by checked positive increments. Registration
validates immutable project metadata and never overwrites a conflicting identity.
Native wiring chooses the home directory; tests inject test-owned temporary homes.

The separate binding index stores typed identity tuples
`(adapter_id, endpoint_fingerprint, external_session_id)`. Rebuild scans only
explicit registered roots and validated authoritative session files. Duplicate
project/root metadata, binding handles or selected host identities stop with
affected paths. Unavailable roots remain registered and prevent a claim of complete
global uniqueness. Rebuild can replace a missing or stale typed-valid index;
malformed or future-version index bytes remain unchanged with a path-specific
error. There is no crawler, remapping, backup recovery or repair workflow.

Setup obeys global registry → project metadata → session lock order. A native
core-owned `VerifiedHost` carries verified provider-neutral facts, with no wire
deserialization or active provider handle. Trusted composition performs read-only
provider/configuration/version/endpoint/thread checks outside every store lock.
Core checks fact/request agreement, then reacquires locks and rechecks replay and
durable routing before allocating final IDs. No Adapter/CoreService signature or
package changes are needed. Production provider wiring belongs to P3.6/runtime.

The saved session/actor operation namespace stays intact. An explicit session
checks only its own receipt scope. Default connect scans the requested project's
receipts for one exact canonical route/actor/command digest match; unrelated
session mismatches are ignored, multiple exact matches are ambiguous. A match
replays before provider preflight or current-state guards. With no match, verified
identity resolution selects the intended session under locks; only that session's
conflicting operation key is rejected. No global operation map is introduced.

The selected `active_binding_id` reserves its host route even when paused,
disconnected, in recovery, or in a closed session. Historical inactive bindings
do not win routing. New connect into a closed session requires explicit reopen.
A new same-host reconnect preserves session/binding IDs and owner pause, rotates
generation, and retains history and original attempt generations. Unresolved work
requires recovery; it is never automatically resent. Different-host rebind needs
an active session, a paused/disconnected old binding and no queued, in-flight or
needs-attention inputs. It preserves history and frees the former historical
identity for a new default-connect session; old inputs are never retargeted.

First creation uses the existing atomic no-clobber publication and stores the
canonical owner receipt in session revision 1. Store supplies the same canonical
route/actor/command hash and receipt bookkeeping as ordinary transactions. Session
commit precedes index publication. An index failure after durable session commit
returns `commit_uncertain` with the operation ID; exact retry locates the saved
receipt, refreshes the index and returns the original IDs/generation without
another mutation. No journal or staged multi-file transaction is added.

Runtime subsequently calls Adapter.connect with durable IDs/generation outside
locks before lease/dispatch. Verified preflight observations are qualified facts,
not an active connection or dispatch guarantee. Unverified connection facts remain
Unknown. Final connect failure reports generation-scoped disconnected and cannot
dispatch. Runtime/provider tasks own that later connection and report wiring.

## Consequences

Independent project sessions remain separately locked for ordinary mutations.
Global setup serializes uniqueness without guessing routes from cwd, tabs or PIDs.
Tests prove canonical registration, separate writer processes, identity conflicts,
unavailable paths, replay/preflight ordering, generation fencing and history guards
against actual JSON persistence. Invalid/future authoritative data remains read-only.

MCP/Seezo remain disabled under the owner's current-session waiver. Organization
security guidance was not checked; no approval is claimed.

## Spec references

- [DOMAIN binding identity](../planning/low-level/DOMAIN_AND_STORAGE.md#binding-and-presence)
- [DOMAIN transaction algorithm](../planning/low-level/DOMAIN_AND_STORAGE.md#4-transaction-and-lock-algorithm)
- [SETUP paths and trust](../planning/low-level/SETUP_AND_DELIVERY.md#1-installed-files-project-data-and-bindings)
- [API connect](../planning/low-level/API_AND_MCP.md#4-bootstrap-and-tool-instructions)
