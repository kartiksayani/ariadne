# ADR-0057: Owner input modules and restored operation identity

Status: Accepted by the maintainer, 2026-10-04.

## Context

P4.6's forms and draft controller need the merged canonical Core/renderer owner
commands, native preferences and navigation/tree modules. They do not need the
unfinished Waiting component to start implementation. Original assembled and
native acceptance still joins Waiting, tree and renderer integration.

The canonical OwnerDraft preserved every input-submit request field and operation
ID, but could not distinguish an unsent draft from an attempted submission after
restart. Editing the latter could reuse a committed operation with changed
contents. Freezing every restored draft would prevent ordinary unsent editing.
No existing application producer submits persisted drafts; the audited earlier
producers only write inert preference fixtures.

## Decision

P4.6 implementation prerequisites are P0.6, P4.1 and P4.4. Remove only P4.3 from
the earlier implementation edges; retain the original P4.1/P4.3/P4.4 acceptance
dependencies, every acceptance criterion and all required quality/native checks.
This changes module scheduling, not roadmap scope or task completion.

Add OwnerDraft.submission_attempted with a backward-compatible false default.
False is omitted from serialization, preserving the exact normalized shape of
legacy preference commands and their replay digests; generated TS treats the
optional marker as false when absent. True persists with the exact request-bearing
draft fields. Native preferences refuse changes to an attempted draft's contents
or marker under the same operation ID.

Before input_submit, the controller persists true and awaits a validated durable
preference receipt. A restart never sends anything. An attempted draft restores
as an explicit same-operation retry with the original session, binding, target,
kind, text bytes, option, question revision and superseded-answer ID. Replay does
not retarget to the latest question. Only a validated input_submit receipt clears
its draft, independently of later bridge delivery or agent work.

After a current submit attempt returns a definitive pre-commit question/revision,
binding, active-state or queue-capacity guard rejection, an explicit Prepare
revised input action may create a new operation. It retains the old frozen record,
requires current-target review and a separate deliberate submit. Unknown saves,
restored attempts, malformed responses, transport/store errors and operation reuse
do not themselves permit this recovery. No marker reset or proof framework is added.

## Consequences

The owner controls share one composition-owned draft store and the existing
RendererService, SessionStore and canonical preference writer. Waiting/Sent and
history integrations consume actual merged components; App startup is a later
composition join. Focused component/controller and native preference tests cover
the seam. Full assembled/native P4.6 acceptance remains pending until proven.

See [UI state and owner inputs](../planning/low-level/UI_AND_NATIVE.md#5-owner-input-and-delivery-ui)
and [module acceptance joins](../planning/MODULE_CONTRACTS.md#implementation-prerequisites-and-acceptance-joins).
MCP/Seezo remain disabled under the owner waiver; organization guidance was not checked.
