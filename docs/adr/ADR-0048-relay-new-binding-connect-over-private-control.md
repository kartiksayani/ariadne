# ADR-0048: Relay new binding connect over private desktop control

- Status: Accepted
- Date: 2026-10-04
- Related: ADR-0029, ADR-0041, ADR-0047; PROCESS section 1; API bootstrap instructions

## Context

A new owner connection must use the desktop's trusted qualified provider candidate
and configured native Core service. A standalone helper has no authority to infer
that evidence from stdin, guessed files or temporary binding IDs. Exact saved
connection receipts still need to replay while desktop is closed.

## Decision

Add only `binding_connect` to the existing peer-UID-checked private control socket.
Its params are the unchanged canonical OwnerMutationRequest with null session and
BindingConnect command, and its UUID envelope ID equals the original operation ID.
No caller-supplied context is accepted. Native opt-in reuses the configured Arc
CoreService, constructs trusted Registry OwnerContext and executes the exact command.
The default server leaves this handler unsupported. Claims retain their existing
mandatory lease and startup gate; bootstrap grants neither.

The CLI bridge function accepts the canonical wrapper and returns the canonical
MutationReceipt. Its owner-command consumer first invokes Core's exact native
saved-connect replay seam without verification/allocation. An existing receipt or
operation-reused conflict is returned directly; only no-receipt operations use the
socket. That consuming seam is implemented separately and must be actually merged
before wiring it. New connections need the matching open desktop and actual native
provider verification, with no launch or fallback evidence file.

Reuse the one-frame 1 MiB protocol, absolute five-second deadline and 16 admission
permits. A blocking Core call must start before its deadline and retains its permit
until completion after socket timeout, caller loss or listener shutdown. Lost
response cannot establish non-commit; the exact original operation and parameters
remain the recovery identity. No retry loop, operation cache or new ID is introduced.
Both ends reject wrong receipt operation, saved variant or explicit target session;
setup instruction bytes stay exact and bounded. Canonical errors are validated,
preserved when valid and replaced with bounded nonretryable protocol errors when
malformed, without exposing raw data or advertising safe resend.

## Consequences and validation

Real socket tests cover the bootstrap whitelist without a binding lease, exact
command/receipt replay, missing/unconfigured app, malformed receipt/error producer
and consumer, and all 16 started owner calls retaining admission past the actual
five-second timeout. The CLI consumer uses the same private codec. No broad RPC,
shared DTO, provider dependency or dispatch behavior changes.

This is a transport module, not complete owner connection composition. Provider-owned
pre-ID facts/qualification consumption, saved replay-first owner dispatch and dynamic
supervisor/claim-route activation must join after their actual implementations merge.
A connection receipt alone never promises current host reachability or readiness.
