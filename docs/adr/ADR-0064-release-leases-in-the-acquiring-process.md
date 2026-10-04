# ADR-0064: Release leases in the acquiring process

Status: Accepted, 2026-10-05.

## Context

Desktop shutdown and an existing runtime test could not reacquire physical
ownership after the owning references were dropped. A small macOS reproduction
showed that a concurrent fork can retain the same open file description until
exec, despite close-on-exec. Dropping the parent's final file then leaves the
lock held by that inherited descriptor. This reproduces the failure class; the
exact process interleaving in CI was not captured.

## Decision

The final instance owner and binding lease explicitly unlock before closing
their files, only when the current process is the process that acquired the lock.
A child dropping an inherited object closes its copy without unlocking the
parent's live lease. Shared binding references still retain the instance owner,
and already admitted work retains its physical leases until it completes.

## Consequences

No admission, cancellation or drain order changes. An isolated subprocess
regression proves final release while a child retains inherited descriptors,
clone retention and protection against child drops. The strict native shutdown
test still requires physical reacquisition after completed shutdown; native CI
must prove that composition result. See [module contracts](../planning/MODULE_CONTRACTS.md).
