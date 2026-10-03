# ADR-0021: Publish pure item validation and transitions

Status: accepted
Supersedes: none
Superseded by: none

## Context

P1.1 must publish callable item validation before store implementation. Canonical
DTOs exist, but prose did not settle same-status and terminal-to-terminal updates,
or how a pure Ask returns an item before its new round is assembled. A whole
session validator would misleadingly imply the later delivery/history state
machines were already implemented.

## Decision

The maintainer adjudicated the native `validate_session_items`, `validate_item`
and `transition_item` seam documented in DOMAIN section 3. The helpers borrow
canonical DTOs, return typed failures and an owned Item candidate, and perform no
IO or mutation. Store/core compose item checks with their later transaction,
history, lifecycle and delivery checks. There is no second serialized command
model or consumer-local entity contract.

Same-status and terminal-to-terminal updates are allowed with their required
fields and appended history. Replaced cannot reopen or ask; edits and messages
remain available. Reopening decided/done/dropped requires a reason and preserves
prior terminal fields before clearing them. Waiting is entered only by Ask;
replacement only by Replace. Each ask creates a new question revision and waiting
episode. Caller/history owns closing the old round and assembling the canonical
new Round before final validation. Parent/topic/ID never change and children do
not cascade. Ask sets owner to me; a stored waiting item created with an explicit
owner may retain valid agent/other responsibility, so no global waiting-owner
restriction is added.
Imported Item origin also provides context for original historical binding IDs
absent from the target session. Preserve those IDs while requiring registered
target bindings for live owner/recipient and every new transition. The existing
history shape has no per-entry origin; reference validation does not establish
historical authorization or invent chronological proof.

Agent context requires the registered binding/current generation, a matching
agent cause message and revisions. Terminalization respects issued/handled owner
message watermarks. Only newer unresolved live inputs block terminalization;
handled/cancelled/skipped inputs and copied history are exempt without changing
their state or history. Orphan live owner-input messages fail validation. This
lets an owner cancel an unissued input without forcing an earlier agent turn to
read/acknowledge an owner body the API forbids it to access. Owner input and host
events cannot directly change status.
Core retains source-attempt and replay authorization. Only specified UTF-8 content
limits and endpoint-fingerprint bounds are enforced; unrelated metadata caps are
not invented.
An option-only answer preserves its submitted empty/whitespace text. The owner
Message nonblank exception requires a matching canonical Answer and a valid
selected option in its frozen snapshot; it does not synthesize prose. Other owner
messages and agent replies require text. Full linkage stays with history/core.

## Consequences

The store has a concrete item validator it can compose under its lock; it cannot
claim full history or delivery validation from this seam alone. Focused tests
prove the transition matrix, canonical relationships, content bounds, prior-field
history and unchanged caller state on rejection. P1.2 supplies immutable rounds
and conversation semantics; P2 supplies owner/apply/result behavior.

MCP/the review tool remain disabled under the owner's current-session waiver. Organization
security guidance was not checked; no approval is claimed.

## Spec references

- [DOMAIN: pure item seam](../planning/low-level/DOMAIN_AND_STORAGE.md#pure-item-validation-and-transition-seam)
- [DOMAIN: content bounds](../planning/low-level/DOMAIN_AND_STORAGE.md#5-capacity-queries-and-errors)
- [API: agent operations](../planning/low-level/API_AND_MCP.md#3-agent-api-explicit-results-and-tree-operations)
