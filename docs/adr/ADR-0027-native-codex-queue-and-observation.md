# ADR-0027: Native Codex queue and acknowledged observation

Status: accepted
Supersedes: none
Superseded by: none

## Context

P3.5 provides blocking reads of the pinned existing Codex daemon. P3.6 must
implement the asynchronous canonical Adapter without blocking an executor or UI,
changing provider wire schemas, or substituting unproved direct queue/turn APIs.
A native queue receipt establishes acceptance only. Core owns persisted payloads,
claims, leases, attempt replay, domain results and recovery decisions.

## Decision

Use one dedicated provider IO worker, one active job and one waiting slot.
Nonblocking admission and pinned futures-channel oneshot replies supply wake and
cancellation without an async runtime. Budgets begin at admission: probe/connect
10s, submit 20s, observe 5s, reconciliation 10s and disconnect 5s. Expired waiting
jobs cannot start IO or sender side effects. Dropped pending replies skip work;
a dropped active submit reply never cancels a possibly delivered sender or loses
its retained outcome. Adapter drop does not join or block; only the observer
socket and short-lived queue child are owned, never the external host.

Submission checks the exact complete persisted payload SHA256 and exact first
line `[ARIADNE_INPUT:<input_uuid>:<attempt_uuid>]`, preserving every payload byte.
Total payload is at most 64KiB and cannot contain NUL. Capture a fresh pre-submit
turn anchor, recheck selected thread, endpoint/executable identity and pinned
CLI/daemon compatibility, then execute the canonical executable with argument
array `queue --remote unix://<resolved_socket> --thread <exact_id> --message
<exact_payload>`. No shell interpolation or queue editing. Drain both sender
pipes incrementally without retaining private provider output or parsing receipt
text. Exit 0 is acceptance with no invented provider receipt. A spawn failure or
expired pre-spawn budget is proven unsent; nonzero exit, lost receipt, timeout or
changed identity after spawn is uncertain. Timeout signals only the owned queue
sender. There is no automatic resend.

A verified exact original userMessage match supplies Accepted before TurnStarted
in observe/reconcile, including recovery after a lost sender receipt. Receipt
provider_reference preserves the actual nonempty clientId of at most 4KiB, else
the actual bounded user-message ID. Unusable optional clientId is absent for
selection, never truncated; required message ID validation stays strict. If no
valid reference exists, acceptance still has receipt None. These opaque provider
references are evidence, never Ariadne IDs or independent match/deduplication
keys. The accepted observation ID hashes compact JSON tuple
`["codex-accepted-v1",binding_id,originating_generation,attempt_id,host_turn_id,
original_message_id]`. It excludes volatile observation/receipt timestamps;
receipt observed_at uses the original normalized observation time. Cached replay
never refreshes it. CLI exit 0 continues to supply Accepted with receipt None.

Retain at most 100 simultaneous provider-private exact submit contexts/outcomes.
Check retained duplicate certainty before worker/capacity rejection: identical
pending attempts are uncertain, completed calls replay their saved outcome, and
changed request bytes/scope conflict. Only a new definitely unadmitted sender
can be rejected because the worker/context bound is full. Short bounded cache
bookkeeping uses a mutex; payload copies/hashing and all IO stay outside it. Acknowledged
terminal contexts retire so more than 100 sequential inputs remain usable.
This cache is not durable exactly-once authority. Cache absence, retirement,
reconnect or restart never requests resending. Runtime submits only explicitly
claimed fresh prepared attempts; possibly submitted persisted attempts recover
through verified reconciliation, not submit. No tombstone ledger is added.

Observation serially scans one retained attempt at a time, round-robin between
completed passes, with that attempt's proven pre-submit anchor. A private scan
continues bounded 1000-turn/50-page reads across polls. Incomplete/anchor-missing
searches never prove absence of delivery. Reconciliation accepts explicit
persisted historical evidence with fresh private continuation and originating
generations, including an old observation token; it does not parse that token
as a provider cursor. Runtime owns 250ms polling, transient-error backoff and
core persistence. History normalization remains ADR-0024's exact original
single-text marker/digest match, actual clientId/turn evidence and snapshot IDs.

Keep one bounded observation batch until acknowledgement. A private versioned
compact-JSON checkpoint includes fresh worker nonce, binding, generation,
batch number and offset. A returned next_checkpoint proposes progress only;
retire facts/terminal contexts when the caller echoes the offered token after
persisting every durable effect in that page. Repeating the current token and
limit replays the same retained snapshot. Unoffered, old or foreign tokens are
invalid_argument and cannot imply delivery absence. Restart uses explicit
persisted-attempt reconciliation followed by fresh observation with no token.
Presence-only observations are ephemeral: they retain no lifecycle batch and
return the last acknowledged token/None. Diagnostics alone cannot become a
permanent reconnect barrier; existing explicit truncation/gap rules apply.

A retained verified batch replays/acknowledges under its exact old scope even
when the live endpoint disappears. Its timestamps/provenance stay unchanged; no
new presence freshness is claimed. After acknowledgement, new reads reverify
identity. Otherwise connection loss would prevent both acknowledgement and
reconnect. An explicit reconnect/disconnect rejects before changing state while a durable
observation batch is unacknowledged, leaving its old scope and replay intact.
Same-generation reconnect to the same exact endpoint/thread preserves retained
submit context. Changed endpoint/thread cannot reuse that generation. Successful
new-generation connect may retire old context only after pending lifecycle
acknowledgement. Runtime may create a fresh adapter for recovery, drain or hand
off old-object facts when available, and reconcile durable attempts before fresh
claims. No cross-generation cache migration or provider journal is introduced.
The unbound P3.5 reader initializes and discovers before durable binding IDs;
full selected-thread queue/item qualification currently occurs during bind.
P1.4 owns the trusted verifier seam. Its later concrete provider wiring must
factor explicit-thread qualification before allocation without placeholder IDs;
that consuming task owns the needed provider-private factoring. No unused
preflight API or duplicate core witness is introduced here. Runtime connects
this Adapter only after final durable binding ID allocation.

## Consequences

This PR supplies the native provider implementation and local fixture/transport
proof. It does not complete P3.6's runtime acceptance join: P3.2 must compose
leases, persistence, polling, checkpoint acknowledgement and historical recovery.
It does not prove live original-session acceptance; M7 requires owner approval.
Private generated schemas and preserved POC evidence remain unchanged. All
handwritten worker/process/observation logic stays in measured source paths.

MCP/Seezo remain disabled under the owner's current-session waiver. Organization
security guidance was not checked; no organizational approval is claimed.

## Spec references

- [PROCESS: adapter deadlines and normalized events](../planning/low-level/PROCESS_AND_PROTOCOLS.md#2-shared-adapter-contract)
- [PROCESS: Codex native queue](../planning/low-level/PROCESS_AND_PROTOCOLS.md#4-codex-01600-adapter)
- [Queue recovery and exactly-once limits](../planning/low-level/QUEUES_AND_RECOVERY.md#3-idempotency-and-exactly-once-limits)
- [ADR-0024: original history evidence](ADR-0024-read-codex-existing-daemon-history.md)
