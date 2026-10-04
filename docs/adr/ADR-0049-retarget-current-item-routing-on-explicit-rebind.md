# ADR-0049: Retarget current item routing on explicit rebind

Status: Accepted
Supersedes: none; clarifies mutable routing in [ADR-0038](ADR-0038-explicit-structured-session-handoff.md)
Superseded by: none

## Context

Explicit different-host handoff makes existing structured history readable, but
retained item recipient assignments still point at the retired binding. Owner
answers therefore fail their canonical recipient guard and agent item routing
continues to identify the retired conversation.

## Decision

After the existing active-session, old paused/disconnected binding and pending
input guards, the same connect transaction remaps only current Item.owner Agent
binding IDs and recipient_binding_id equal to the retired selected binding.
Include terminal items and archived topics so closed-item followups remain usable.
Preserve Me, Other and unrelated binding assignments.

Each changed item increments its item revision once and sets updated_at to the
connect timestamp. Counter overflow aborts the whole transaction. Preserve
question_revision, current/source round pointers, messages and their authorship,
origins, status history, rounds, answers, inputs, attempts and prior receipts.
This changes current routing, not historical authority or provenance.

Same-host reconnect and all existing guards stay unchanged. Exact operation
replay comes first and returns the saved receipt without another route, revision
or timestamp change. The new selected binding may apply using its current native
grant; old binding/generation writes remain denied. Captured item revision guards
become stale after remapping.

## Consequences

Real filesystem tests exercise new-binding replies and owner answers on existing
unfinished work, closed-item followups, archived routing, unchanged history,
unrelated assignments, old authority denial, stale drafts, exact replay and
overflow with unchanged bytes. No queued input is retargeted and no host is
launched or automatically dispatched.
