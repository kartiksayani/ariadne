# ADR-0030: Save owner inputs atomically and cancel only before preparation

Status: accepted
Supersedes: none
Superseded by: none
Implementation: P1.5

## Context

Owner submissions need durable full text and the question/options originally
shown to the owner, independently of later agent changes or delivery. Cancellation
must remove a pending owner blocker without deleting its history or inventing
attempt-bound recovery evidence. Ordinary submission cannot bypass the atomic
preview/mapping required by topic continuation.

## Decision

The native `inputs::InputService` resolves a trusted owner/session context through
the actual Registry, then uses Store's stable locked transaction. It normalizes
the command discriminant and all typed params after wire/version validation.
Store adds canonical project/session routing and owner actor to the digest and
replays an exact saved operation before current-state guards or ID allocation.
Operation keys remain session/actor scoped. Native errors preserve core, registry
and store causes, including definite I/O and uncertain commit identity.

Under the session lock, submission validates active session, unarchived item/topic
membership, selected binding and the 100-pending-input capacity. Paused or offline
bindings still accept saved queued inputs. Checked input sequence allocation and
P1.2's `record_owner_history` build a complete candidate with the full owner
Message, optional Answer, FIFO queued Input and frozen snapshots. Store validates
and commits that candidate and typed receipt with one session revision. History
owns Answer/correction/round validation and Message/Answer counters; submission
never applies a status transition. Terminal intents remain legal, except reopening
a replaced item in place.

Ordinary input context has only the target item, no caller-selected message IDs,
the chosen existing or fresh round, and no continuation operation. P2.2 may add
current target context to persisted formatted attempts without rewriting this
original payload. Continue and topic-only submissions fail with `invalid_argument`
directing the caller to P2.6 `topic_continue`; no mapping-free continuation is saved.

A supplied expected question revision is a guard for non-Answer intents too.
Staleness returns `question_changed`. Superseding an Answer requires Answer kind;
the current eligible Answer is an optimistic correction guard. A stale correction
returns `revision_conflict`, current session revision and reload-current-answer
guidance. Option-only Answers preserve exact empty or whitespace text and still
validate the frozen option/question/recipient and correction chain.

Cancellation requires the expected session revision, queued state, empty attempt
history and no active attempt. It changes Input state to cancelled and saves the
typed receipt and one session update/revision. Full Message, Answer, payload,
counters and item/round history remain unchanged. No ResolutionHistoryEntry,
attempt, cancellation time or reason is fabricated. Exact saved cancellation replay
returns its original receipt even after state/revision changes.

## Consequences

Tests use registered test-owned temporary roots and actual JSON persistence,
including separate writer subprocesses proving independent submissions preserve
FIFO counters and a shared operation produces one identical durable receipt.
Invalid/stale guards leave bytes unchanged; future or invalid snapshots remain
read-only. No provider I/O, dispatch lease, formatter, recovery or lifecycle service
is added. Shared CoreService and wire DTO signatures remain unchanged.

## Spec references

- [API owner command inventory](../planning/low-level/API_AND_MCP.md#2-query-and-owner-command-inventory)
- [DOMAIN immutable input](../planning/low-level/DOMAIN_AND_STORAGE.md#input-attempt-and-result)
- [QUEUE save/claim/join](../planning/low-level/QUEUES_AND_RECOVERY.md#1-save-claim-join)
