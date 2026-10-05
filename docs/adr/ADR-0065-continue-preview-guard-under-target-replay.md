# ADR-0065: Reject stale Continue previews after locked target replay

Status: accepted
Supersedes: none
Superseded by: none

## Context

Continue checks a saved operation before reading its immutable source snapshot.
An identical operation can commit after that initial replay miss. Rejecting a
changed source before the target transaction would then report `preview_stale`
even though the operation was saved, leaving the UI unable to safely prepare a
replacement Send.

## Decision

Keep the initial target replay to avoid source IO for saved requests. Capture the
owned source snapshot under its existing read lock and release that lock. Check
its preview revision/hash inside the target transaction, after that transaction's
locked exact-operation replay and before copying or allocation. The source is
never written and the two session locks are never held together.

The application retains the exact operation ID and body after uncertain failures.
A transactional `preview_stale` rejection proves that operation was unsaved and
permits an explicit new preview and Send. Generic routing, source IO and hash
errors retain the pending request. The existing canonical command and receipt
types remain the shared boundary.

## Consequences

A competing saved continuation wins over a stale captured source and returns its
original receipt without another copy or handoff. An unsaved stale request leaves
both sessions unchanged. A deterministic real Store test exercises the initial
miss, competing save, stale owned snapshot and locked replay; existing Core tests
retain full history, source isolation and target failure proof.

## Spec references

- [Continue guards](../planning/low-level/API_AND_MCP.md#restore-and-continue-guards)
- [Module contracts](../planning/MODULE_CONTRACTS.md)
