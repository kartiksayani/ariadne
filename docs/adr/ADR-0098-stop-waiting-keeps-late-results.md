# ADR-0098: Stop waiting keeps a valid late result

Status: accepted (2026-10-10).
Supersedes: only the result-write finality of missing-result Skip in [ADR-0088](ADR-0088-core-never-dead-ends.md)
Superseded by: none

## Context

A host can finish an accepted turn before its structured result reaches Ariadne.
After the existing five-second grace, Core records `result_missing` and requires
owner attention. Choosing Skip then sealed the attempt and rejected an otherwise
valid late answer. The owner wants this choice to stop waiting and free dispatch,
while preserving the completed work's answer if it arrives later.

## Decision

- The missing-result grace, expiry state and dispatch barrier remain unchanged.
- For a completed attempt with acceptance or a recorded host turn and an expired
  missing result, Skip means **Stop waiting**. It settles the input and releases
  its barrier as before.
- Stop waiting applies to the current attempt only when its turn is completed,
  its result state is missing and its error is `result_missing`. It requires no
  idle evidence, even when the host is currently busy, and records only evidence
  the owner actually supplied. Resend, result repair and other Skip cases retain
  their idle observation or explicit attestation gate.
- A later apply carrying `input_result` may commit against that exact skipped
  attempt. It saves the result and replies, marks the input handled, and retains
  the missing-result warning and owner decision in history. It neither restores
  the barrier nor clears a different input currently active on the binding.
  The attempt keeps the original Stop waiting seal time.
- This exception requires the original selected binding and generation, trusted
  issued grant, current target work, and the latest attempt and Skip decision.
  Cancellation, removal, resend, result repair, a replaced attempt and other
  skipped failures retain their existing write rejection. Skip does not grant
  permission for an apply without a result.
- Late host facts about settled attempts still have no effect. Exact saved
  operation replay, result deduplication, owner pause and unrelated barriers keep
  their existing behavior. The legacy **Mark as handled** action is unchanged.
- Request missing result remains a distinct result-only repair turn inspecting
  completed work; it does not resend the original owner action.

## Consequences

The owner can move on without losing a delayed answer. A valid late result uses
the usual atomic apply, history linking and result validation. Core and Domain
share a pure eligibility helper so reply provenance agrees with apply admission,
without temporarily reactivating or unsealing the attempt. Core checks that source
work is live before applying operations; later changes to that work in the same
batch do not change reply provenance. Existing public
signatures, persisted fields and scheduling policy remain unchanged.

## Spec references

- [Queue and recovery](../planning/low-level/QUEUES_AND_RECOVERY.md)
- [API and MCP](../planning/low-level/API_AND_MCP.md)
- [UI and native](../planning/low-level/UI_AND_NATIVE.md)
