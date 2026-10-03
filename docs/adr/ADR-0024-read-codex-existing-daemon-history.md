# ADR-0024: Read history from the existing Codex daemon

Status: accepted
Supersedes: none
Superseded by: none

## Context

P3.5 consumes the merged private Codex 0.160.0 wire baseline before P3.6
implements native CLI queue submission. The protocol already carries exact
persisted attempt marker/digest and originating generation. Its checkpoint
must advance only after core commits effects, while bounded provider pagination
needs a separate continuation. Loaded-thread metadata is qualified presence,
not proof of terminal visibility or pending input delivery.

## Decision

The maintainer approved a standalone synchronous read-only client, with canonical
ConnectRequest/ConnectResult and ReconcileRequest/ReconcileResult at its outward
seam. Runtime must execute blocking methods off its async executor. P3.6 owns
submission and the complete Adapter implementation. An unbound CodexDaemonReader
can open/initialize and return discovery pages before owner selection; explicit
bind rechecks identity and consumes the same transport for the chosen thread.
The connect convenience composes these paths with one deadline. P3.7 still owns
user-facing discovery orchestration and refresh acceptance. This client does not expose
turn/queue mutation APIs or launch/resume hosts.

Use pinned tungstenite on UnixStream with masked client frames, validated HTTP
Upgrade, ping/pong and 8 MiB fragmented-message/frame limits. Resolve permitted
provider endpoint symlinks deliberately, verify final socket owner and peer UID,
then initialize the already-running daemon. Canonical executable identity,
mtime and exact CLI/daemon version gate every connection; changed executable or
socket identity and incompatible required history data fence further reads
until a fresh connect. Native readiness polling retains an absolute deadline
across partial Upgrade traffic and fragmented frames. This layer owns no domain storage or saved owner inputs.

Loaded discovery pages join only daemon thread/read metadata. Explicit thread
status supplies qualified HostPoll presence; loaded membership or missing events
never imply idle or a visible terminal. Unsupported discovery permits explicit
manual binding; malformed identity or required wire data fails closed.

History uses private generated full-item pages, newest first. A provider-private
HistoryScan carries exact endpoint/thread/request scope, continuation cursor and
optional proven pre-submit anchor; it is never a domain checkpoint. Each call
reads at most 1000 turns in 50 pages under ten seconds. An incomplete or
anchor-missing search remains unresolved, never proves non-delivery. Callers
schedule another bounded call/pass and choose checkpoint persistence only after
core commits normalized effects. Requests are limited to 100 attempts and
one nonempty marker line of at most 4 KiB; larger batches return an actionable
invalid_argument. Diagnostic outputs are limited to 256 records/2 MiB across
the requested attempts, each text at most 64 KiB. Retain newest snapshots with
explicit gaps/truncation and always retain matching lifecycle facts.

Only the original single-text userMessage, exact first-line marker and persisted
payload digest can correlate a turn. DOMAIN_AND_STORAGE defines that digest
over exactly the submitted payload. Hash the complete original text bytes; never
normalize, truncate or join content blocks when matching. User clientId remains provider evidence,
never an Ariadne ID. Matched events retain originating binding generation;
multiple/conflicting matches stop reconciliation. Agent-message text becomes
bounded visible diagnostic output only; private reasoning/tools are never
exported, and successful turn completion is separate from domain results.
History supplies message IDs but no source event IDs. Generated visible-output
observation IDs hash a serde_json compact JSON tuple of binding, originating
generation, attempt, turn, kind, a snapshot label and the serialized complete
normalized snapshot payload (message ID, phase, replacement text and
truncation/gap fields). Unchanged rereads replay consistently; changed text or
phase receives a distinct event ID. The actual host_message_id remains separate.
Only terminal events use the canonical terminal fallback helper. Fixture tests
prove historical correlation, retained client IDs, changed-phase identity,
replay, anchor/continuation, diagnostic limits and independent terminal facts.

## Consequences

The read primitive can ship and receive transport/fixture coverage independently
of native queue delivery. Runtime and P3.6 can reuse its identity, discovery and
bounded reconciliation without leaking generated provider types into core or
renderer. Fixture servers do not prove live original-session product acceptance;
that remains the owner-approved M7 milestone.

MCP/the review tool remain disabled under the owner's current-session waiver. Organization
security guidance was not checked; no organizational approval is claimed.

## Spec references

- [PROCESS: Codex adapter](../planning/low-level/PROCESS_AND_PROTOCOLS.md#4-codex-01600-adapter)
- [PROCESS: presence](../planning/low-level/PROCESS_AND_PROTOCOLS.md#5-session-discovery-and-presence--included-in-v1)
- [PROCESS: compatibility](../planning/low-level/PROCESS_AND_PROTOCOLS.md#6-compatibility-and-permissions)
- [SETUP: existing daemon](../planning/low-level/SETUP_AND_DELIVERY.md#4-codex-existing-daemon-binding)
