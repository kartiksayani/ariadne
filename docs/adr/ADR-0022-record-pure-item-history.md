# ADR-0022: Record pure item history without owning submission or delivery

Status: accepted
Supersedes: none
Superseded by: none
Implementation: P1.2

## Context

The complete schema-v1 DTOs carry full messages, immutable answer/round snapshots,
result references and copied authorship, but P1.2's callable history boundary was
not settled. Combining Input construction, queue state and result commit behavior
with history would duplicate the later core owners. Original and copied records
also have different live provenance lookup requirements.

## Decision

The maintainer settled pure candidate-returning history helpers over canonical
records. Core stages the owner Input and prepares agent transitions; history
records owner messages/answers, explicit replies, ask rounds, explicit closure,
child forks and already committed result links. It never changes Input/Attempt/
Result state, submits to a host, imports transcripts, writes files or increments
session revision. Core/store compose final validators, replay and atomic saves.

Owner and reply appends increment item revision/time and add backlinks without
changing status/question revision. Ask uses the already transitioned candidate,
closes the old open round and freezes snapshots without a second item increment.
Explicit close preserves its timestamp and increments item revision only when
clearing its matching pointer. Fork linking increments child revision only on the
first reverse-link assignment; existing forks cannot be reassigned. Result linking
closes only explicitly selected related rounds and may cite verified prior effects
for a result-repair attempt. Repeated linking preserves ordered history.

A result follow-up must have a creation message from this input and the current
attempt or verified original-work repair attempt. Earlier incremental creation
by that same input qualifies; merely replying to or editing an existing item does
not. A source-round child also requires the actual parent and reciprocal fork
membership. V1's item.add creates these children; it has no existing-item reparent
or source-round patch. The fork helper can link an already inserted candidate
child, but that helper alone is not creation/result provenance. Both result linking
and full history validation enforce this same rule.

An option-only answer keeps its actual empty/whitespace text. It is valid only with
a matching canonical Answer and deliberate option present in its frozen choices;
generic owner messages and replies require nonblank text. Corrections append with
an explicit link to the latest answer in the same item/question episode. A changed
question requires a generic follow-up. Former terminal outcomes/reasons remain in
the agent transition's status history and history helpers preserve that audit.

A reply has exactly one direct item target, while touched items can describe
other operations' provenance. Activity summaries can reference a round and several
items without becoming item replies. Created/updated backlinks remain distinct
from the complete targeted conversation. A same-item current pointer may retain a
closed historical round; generic owner input then creates a fresh round.

Copied Message source binding/input/attempt identities are historical attribution,
not target dispatch. Validate their local mappings and source scope/revision;
copied Answers require consistent answer mapping plus their mapped owner message
and frozen round snapshots. Origin round result input IDs remain source-scoped
with matching continuation lineage. No blanket origin exemption or new schema
field is added. P2.6 owns actual copy construction and source access.

## Consequences

Store/core can assemble history on an owned snapshot and abandon any rejected
candidate without partial effects. Bodies, choices, accepted answers, old rounds,
close timestamps and fork links remain reachable and append-only. A deterministic
five-round fixture and canonical demo/source fixtures prove serialized retention,
not atomic file durability, provider delivery, paging or UI rendering; those remain
with their declared roadmap tasks.

MCP/Seezo remain disabled under the owner's current-session waiver. Organization
security guidance was not checked; no approval is claimed.

## Spec references

- [DOMAIN: full messages, answers and rounds](../planning/low-level/DOMAIN_AND_STORAGE.md#full-messages-answers-and-rounds)
- [DOMAIN: input, attempt and result](../planning/low-level/DOMAIN_AND_STORAGE.md#input-attempt-and-result)
- [API: explicit results and tree operations](../planning/low-level/API_AND_MCP.md#3-agent-api-explicit-results-and-tree-operations)
- [Design D05/D06](../planning/DESIGN_TRACEABILITY.md#acceptance-checks)
