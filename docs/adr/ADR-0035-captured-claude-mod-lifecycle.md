# ADR-0035: Capture Claude Mod lifecycle through the installed helper

Status: accepted
Supersedes: none
Superseded by: none

## Context

The preserved Claude Code 2.1.287 Mod proof used a Python broker and local queue
model. Production must consume the canonical owner, claim and event contracts
without another queue authority, shell interpolation or fabricated connection
evidence. The binding receipt/status projection does not contain a verified
endpoint fingerprint. The installed CLI was observed as 2.1.289 by a read-only
version probe; the preserved SDK header and live proof remain 2.1.287.

## Decision

The maintainer approved a static plugin-local ESM Mod using supported SDK
process/crypto/timer calls. An installer-rendered immutable JS descriptor supplies
the absolute installed helper path, matching app/plugin version and API version1.
The source descriptor is absent; there is no PATH, environment, filesystem, Node,
cache-root or checkout fallback. Exact host2.1.287 and helper/Mod version equality
are required before polling or connection. P6 owns rendering/version substitution;
P3.4 owns any new host compatibility proof.

Setup uses canonical `OwnerMutationRequest {session,command}` bodies through
`project register`, `binding connect`, `binding disconnect --json-stdin`. Explicit
bootstrap uses session:null; disconnect uses the registered SessionRef. Owner
operation IDs/bodies survive unknown receipts; a pending disconnect must be
recovered before a new connect. Installed provider identity is
adapter_id/namespace `claude_code_mod`, local_bridge name `claude-mod`, empty
configuration values. These identifiers are configuration, not readiness proof.

Native qualified connection owns canonical Connected because it verifies endpoint
fingerprint/capabilities. The Mod validates owner receipts and scoped status/
external session ID; it never manufactures Connected from incomplete data.
`bridge connection-status` forwards the existing private control method with an
explicit fresh request UUID and returns canonical BindingSummary. Status reachability
does not authorize dispatch. Claim request IDs remain stable after unknown helper
responses; only the desktop CoreService authorizes a prepared attempt.

The Mod captures binding/generation/attempt before detached prompt.submit and
submits the exact persisted formatted payload. Matching requires its exact first
marker line, complete original UTF8 SHA-256 and original SDK session identity.
Success with unchanged SDK result.text or a matching turn.start reports Accepted
with receipt:null; SDK text supplies no invented provider receipt. Start captures
the actual turn ID. Callback closures never retarget to a later connection.
SDK drop before turn evidence is Rejected; drop/rejection after start is Uncertain.
Promise failures/altered evidence are Uncertain, never a reason to resend.

Main turn.complete maps answer&&!isAborted to Completed, aborted/isAborted to
Interrupted, refusal/error to Failed; unsupported evidence is Uncertain. Final
visible answer is only a Unicode-safe64KiB diagnostic. Terminal IDs use the shared
compact-JSON fallback tuple; accepted/start IDs use a provider-private compact-JSON
tuple containing provider,binding,generation,attempt,actual turn when available,
kind. Observation timestamps are outside identity. Pending events retain their
original timestamps/bytes until exact matching durable EventReceipt. Core durable
replay follows the published semantic digest excluding observation timestamps.

Owner connect/disconnect transitions have one synchronous admission guard. Before
any owner mutation await, the prior loop closes claim admission and drains its
already admitted bounded poll. An in-flight poll is outstanding work: a late
prepared claim remains under its original binding/generation/attempt, is never
submitted after closure, and blocks rotation until recovery. Pending reports and
uncertain claim request IDs likewise block rotation; negative owner replies retain
the old loop and exact operation body/ID with admission closed. Concurrent owner
commands cannot replace an active loop. A final outstanding check after owner
receipts retains late original-scope evidence instead of replacing/clearing its
loop; the receipt is exposed with recovery required. An owner receipt may already
have committed rotation: the retained old loop reports captured facts only,
without restoring old claim authority, retargeting facts or claiming rollback.
Callback hashing/enqueue
work counts as outstanding. Session end closes admission even during
an owner call; a late successful receipt cannot restart polling.

One captured submission and serialized reporter bound retained facts; failed
receipts stop new claims. An unsettled detached promise also prevents reconnect
or another claim after terminal acknowledgment. Identical normalized terminal
callbacks coalesce by outcome/reason/diagnostic semantics, not timestamps. The
original and first contradictory terminal snapshots retain the same canonical
terminal ID so Core detects conflict; contradiction pauses claims. Further distinct
revisions retain one explicit Uncertain gap fact and expose unsupported-provider
failure. They cannot overwrite retained unsaved evidence; additional raw callbacks
are not represented as persisted or cleanly completed. A different turn/subagent
is a scope mismatch. With these guards a captured claim retains at most eight
lifecycle records in normal SDK delivery, plus bounded distinct sanitized failure
facts (at most sixteen total), at most two64KiB terminal diagnostic snapshots; the small
bounded retry state remains below the shared256-event/2MiB diagnostic ceilings.
No durable hook recovery guarantee or raw callback journal is introduced.

Session end cancels the timer, stops new claim admission and reports Disconnected
best effort through the captured route. Accepted external turns are never killed.
Pending reports remain explicit if the helper fails; host exit may lose volatile
evidence, requiring reconciliation, not an inference of non-delivery.

## Consequences

Existing Vitest Node project tests inject only SDK/helper transport seams; no
production fake, eligibility state machine or new dependency/runner is added.
Default application coverage includes all handwritten integration JS, including
untested files, using the existing external-file coverage option. The exact
installer descriptor data-only export is exempt because it has no executable
lines; adding logic requires removing that exemption in the same PR. The real CLI
status case uses a bounded private socket and subprocess.

P3.3 implementation is reviewable before full acceptance: owner CLI/P2.4, durable
Core/report/P2.2, trusted native Claude connection/P3.4, discovery/P3.7 and installer/
P6 composition remain explicit joins. The current executable owner/report gaps
fail honestly; no live host launch, prompt, install, setting or paid call was made.

## Spec references

- [PROCESS §2/§3](../planning/low-level/PROCESS_AND_PROTOCOLS.md#3-claude-code-21287-adapter)
- [Setup §3](../planning/low-level/SETUP_AND_DELIVERY.md#3-claude-mod-installation-and-binding)
- [API bootstrap](../planning/low-level/API_AND_MCP.md#4-bootstrap-and-tool-instructions)
- [Implementation/acceptance joins](../planning/MODULE_CONTRACTS.md#implementation-prerequisites-and-acceptance-joins)
