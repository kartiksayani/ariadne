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
The registration command contains only its root. Under the metadata lock, first
creation derives the display name from the canonical UTF-8 root basename; an
existing authoritative name is preserved. The operation digest contains the
command kind and exact requested root, never the derived name.

The separate binding index stores typed identity tuples
`(adapter_id, endpoint_fingerprint, external_session_id)`. Rebuild scans only
explicit registered roots and validated authoritative session files. Duplicate
project/root metadata, binding handles or selected host identities stop with
affected paths. Unavailable roots remain registered and prevent a claim of complete
global uniqueness. Rebuild can replace a missing or stale typed-valid index;
malformed or future-version index bytes remain unchanged with a path-specific
error. There is no crawler, remapping, backup recovery or repair workflow.
Absence captured under the registry lock uses the existing atomic no-clobber
publication for first registry/index writes too, so an ordinary external restored
file appearing before publication survives unchanged. Existing validated files
keep atomic replacement; post-session index publication failure remains uncertain.

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
generation, and retains history and original attempt generations. Unresolved
prepared/in-flight/needs-attention work or an existing recovery reason blocks
dispatch until reconciliation; it is never automatically resent. Never-prepared
queued work and resolved/sealed historical attempts do not themselves imply
uncertain delivery. Different-host rebind needs
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
Unknown connection always persists disconnected dispatch while retaining owner
pause and real recovery reasons; only qualified Connected facts can derive
recovery/paused/enabled dispatch. Pause/resume do not label healthy queued or
in-flight work as recovery. Resume cannot clear a real recovery blocker.

Native `bindings::BindingService` delegates registration/connect/state commands to
the real store without replacing the shared CoreService or Adapter signatures.
Its `BindingError` retains core, registry and store causes, including affected
paths and operation identity for uncertain commits. Definite pre-publication I/O
must not be described as corrupt data or a saved commit. Command normalization
includes the command discriminant and complete typed params; pause and resume
with identical params are distinct intents. Operation/envelope IDs are excluded
from hashing only after canonical version validation.
Registered session scans retain the failing session filename and original typed
schema/validation cause; explicit session read/transaction errors stay unchanged.

Codex's current unbound reader can discover without IDs, but its selected-thread
queue/full-item qualification is currently performed by bind after durable IDs
exist. Later production composition needs a small provider-private read-only
selected-thread qualifier before IDs. P1.4 supplies the trusted verifier seam;
it does not add an unused adapter API, placeholder IDs or another VerifiedHost.

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
