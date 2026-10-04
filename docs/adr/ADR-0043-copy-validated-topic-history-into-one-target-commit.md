# ADR-0043: Copy validated topic history into one target commit

Status: accepted
Supersedes: ADR-0022 imported-message interpretation, only for provenance-only copied Replies
Superseded by: none

## Context

Continue must preserve complete local history and source authorship while creating
new live target identities and exactly one queued handoff. Its source and target
are separate authoritative session files. Lifecycle controls also need concrete
blocking IDs without rewriting retained domain or delivery history.

## Decision

The owner selects a registered source topic and a different, active, explicitly
bound target session. Preview captures the source session revision and SHA-256 of
the deterministic canonical full Session plus selected topic ID. It discloses live
agent/recipient assignment to the selected target binding and any external
replacement transformation. Me/Other ownership and historical authorship remain.

Continue checks target operation replay before source IO. It captures a validated immutable source Session under the existing source read
lock, which is the freshness observation/linearization point, then releases that
lock. It computes/compares the captured revision/hash before one target transaction,
which checks replay again before mutable target guards and allocation. There are no simultaneous session locks or source writes. A source
change just after validation does not change the validated copy's provenance;
unrelated earlier revision changes conservatively invalidate the preview.

Allocate all copied topic/item/message/round/answer identities in two passes and
remap internal references. Copy full bodies, frozen questions/options/answers,
round links and status history. Preserve historical source binding/input/attempt
identities as provenance, without granting target authority. Live Agent owners and
recipients use the explicitly selected target binding. A replacement outside the
copied topic becomes an imported Dropped item with an explicit outcome/reason and
its prior replacement/outcome retained in source-qualified history. New system
provenance explains the transformation.

Every copied Message records a required `source_target` with the source project's
and session's IDs and the message's actual nullable direct topic/item/round route.
`MessageOrigin.topic_id` remains the continuation lineage scope. When a Reply's
direct item is outside the copied topic, preserve Reply kind, full body and actual
author, but clear all local topic/item/round pointers. It is historical provenance,
not a reply to a coincidentally equal target ItemRef. Acceptance requires validated
origin and an exact continuation message map. Included direct item/round pointers
must agree with the qualified source mapping. Live Replies still require a local
direct item. Recopying a provenance-only Reply retains its fully qualified original
`source_target`; it does not replace that route with nulls. Normal targeted copies
record their immediate source route. Activities/lifecycle messages retain their
existing contextual target-topic grouping and truthful source targets. This
partially supersedes ADR-0022's imported-message interpretation without changing
its live Reply or author/lineage rules. Item conversations use direct local item
matches, never `items_touched` activity/provenance backlinks.

The target atomically saves the immutable continuation mapping, one owner handoff
message and one FIFO Continue input. Its inert frozen context references the saved
continuation operation; no input, attempt, lease or delivery result is copied.
An unavailable host may leave the handoff queued. The owner-confirmed summary uses
the existing 16KiB UTF-8 owner-input bound. The actual staged input is checked with
the existing delivery formatter against its 64KiB payload budget before any
publication. Full copied bodies are separate retained history, never truncated to
fit the summary. The formatter's crate-private reuse requires only visibility
changes, with no duplicate rendering implementation.

Archive/close report actual nonterminal item and pending input IDs. Close also
requires persisted selected-binding dispatch Paused. Restore/reopen preserve IDs,
history and binding state, without resuming dispatch or contacting a provider.
Expected topic/session revisions and exact saved receipts use the existing Store
transaction. Rejected guards and definite prepublication failures save no effects.

## Consequences

No multi-file journal, distributed transaction or recovery framework is introduced.
Source files remain byte-for-byte unchanged by continuation. Exact retries return
the original mapping even if the source subsequently becomes unavailable. Native
history actions are implemented here; CLI and NativeCoreService consumer routing
remain their later composition tasks. No provider is launched or automatically
sent work by lifecycle or copy operations.

## Spec references

- [Domain lifecycle and continuation](../planning/low-level/DOMAIN_AND_STORAGE.md#6-continuation-repair-and-migration)
- [Restore and continue guards](../planning/low-level/API_AND_MCP.md#restore-and-continue-guards)
- [UI lifecycle](../planning/low-level/UI_AND_NATIVE.md#6-archive-sessions-and-binding-lifecycle)
