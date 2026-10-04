# ADR-0046: Explicit owner CLI and saved routing instructions

Status: Accepted
Supersedes: [ADR-0038](ADR-0038-explicit-structured-session-handoff.md) only for new saved instruction construction
Superseded by: none

## Context

The Claude Mod invokes canonical owner commands with complete JSON wrappers.
Owner commands also need deliberate registered routes and pasteable instructions
that remain usable on exact retries after rule or provider changes.

## Decision

The CLI validates its noun/verb against the canonical wrapper command, reads at
most 512KiB from stdin, and uses the existing CoreService and canonical output
validator. Stdin commands return JSON by default. Native membership resolution
does not check mutable eligibility before Core's exact receipt replay. No actor,
permission ceiling, inferred cwd/session, persistence semantics or generic Core
dispatcher is introduced.

BindingService exposes a narrow replay_connect helper using the same validation,
normalized intent, registry scope and authoritative replay/index synchronization
as connect. It performs no provider verification or ID allocation. Only a new
BindingConnect may use the running desktop's private control relay and trusted
qualification; missing desktop/candidate is actionable unavailability. Bound
domain operations and saved connect replay do not require starting the desktop.
The original operation ID survives caller loss or timeout because admitted work
may still commit.

At connect_receipt, retain the exact verified instruction prefix and append
deterministic commands using the allocated binding and generation. The first
line says “Use these routing IDs for Ariadne commands”, without claiming an
Unknown/disconnected host is ready. Instructions explain full replies and
explicit item references. Validate the whole nonblank/NUL-free 64KiB instruction
and actual 1MiB canonical response before committing state. Replay returns exact
saved bytes, never a newly generated instruction.

One authored integrations/rules/source.md produces both Claude and Codex rules.
It preserves explicit structured-session resume guidance, full replies, rounds
versus children, revision/receipt guards, valid statuses and exactly one explicit
result per dispatched input. Generation is deterministic and check-only drift
checks write nothing.

The desktop's pure receipt validator is shared in Core and takes the original
OwnerMutationRequest plus receipt. Owner CLI and desktop retain identical
operation/route/variant validation without adding authority or persistence.

The offline demo uses Registry's native register_fixed helper under the existing
registry/project locks. Its semantic digest includes project_register_fixed,
canonical root and expected fixture project ID; ordinary registration keeps its
existing digest unchanged. Exact replay precedes preflight, cross-mode or changed
expected-ID operation reuse conflicts, and existing project metadata must match
the expected ID before publication. No wire field or alternate persistence path
is introduced.

Demo requires an explicit root and keeps the canonical fixture identity/content
with disconnected binding dispatch. Ordinary preflight rejects an observable
existing demo before registration; final Store.create is authoritative no-clobber
publication if a restore appears later. If registration succeeds but session
creation fails, deliberate registration may remain. The error reports that
partial outcome and preserves existing bytes, including uncertainty semantics.
There is no cross-file atomicity promise, journal or automatic recovery.

## Consequences

Provider qualification, private relay and native entrypoint composition consume
their actual merged implementations; this module does not fake them or claim
the full bootstrap acceptance before those joins work. Saved drafts remain inert.
No host is launched, resumed or configured by these commands.

## Spec references

- [API bootstrap and instructions](../planning/low-level/API_AND_MCP.md#4-bootstrap-and-tool-instructions)
- [Claude existing-session setup](../planning/low-level/SETUP_AND_DELIVERY.md#3-claude-code-existing-session-binding)
