# ADR-0012: Complete the domain v1 contract

Status: accepted
Supersedes: none
Superseded by: none
Implementation: [PR #32 — domain v1 DTO contracts](https://github.com/kartiksayani/ariadne/pull/32)

## Context

P0.3b must publish stored entities, durable replay receipts and bounded query
records before store/core/protocol/UI consumers. The accepted specifications
named several nested records without exact members and omitted round question/
option snapshots, fork reverse links and copied-message authorship. No production
schema has shipped. This fills initial schema v1; it adds no migration or storage
implementation.

## Decision

The maintainer adjudicated the missing shapes against DOMAIN/API/PROCESS/QUEUES:

- Rust declarations are canonical. Optional reads accept omitted/null values and
  emit explicit null; collections remain required. Schemas describe emitted
  records. Typed deterministic maps reject duplicate keys and retain validated
  primitive key constraints, including arbitrary nested configuration objects.
- Round stores question/options/ask snapshots and origin; Item stores the reverse
  source-round link. Status history preserves previous terminal/replacement fields
  and reason. Typed origins preserve source entity IDs and message author/host
  identity without substituting target-agent provenance.
- Input keeps immutable target/question/options/context. Attempts keep ordered
  history, independent acceptance evidence/time and exact submitted payload.
  Recovery evidence explicitly identifies owner attestation; observed adapter
  evidence remains in normalized events.
- Stored operation UUIDs map to actor-scoped receipt buckets, avoiding an invented
  composite-key format while retaining actor-qualified replay identity. Saved
  receipt results are a typed tagged union; allocated refs are typed and message
  IDs/numbers are paired records. Continuations keep immutable typed remapping
  tables and confirmed summary/source snapshot evidence.
- Provider-neutral support records use local-only symbolic bridge/socket refs,
  opaque endpoint fingerprints, namespaced JSON configuration, the exact v1
  capability set, and presence with independent source/freshness. Historical
  freshness or heartbeat alone never establishes execution state.
- Bounded item/round snapshots omit unbounded historical arrays. Each nested
  history page has its own structured cursor; ordinal paths use explicit parent
  and ordinal data. Counts retain the existing exact seven-status and Waiting/
  Sent/completeness contract. There are no new endpoints or service unions.

## Consequences

Consumers share complete deterministic schema/TypeScript exports; they need no
local entity copies or generic saved-result JSON. P0.6 still owns command/query
unions; P1.1/P1.2 own semantic validation/transitions/history and P0.3 owns full
demo/invalid fixtures. The focused records in tests prove wire shapes, not those
later behavior tasks.

Checkpoint validation enforces 4096 UTF-8 bytes. JSON Schema maxLength bounds
characters only and cannot prove that byte limit. Endpoint fingerprints use the
same 4 KiB opaque-metadata semantic limit, enforced in P1.1. TypeScript cannot
express lexical UUID/ItemRef or safe-integer validation. JSON Schema cannot detect
duplicate keys already discarded by a JSON parser.

The pinned ts-rs derive does not interpret serde's unknown-field guards,
transparent/custom-deserializer attributes. Its local no-serde-warnings feature
silences those parser notices; explicit shape/assignment tests prove the emitted
wrappers and maps. Rust/Clippy warnings remain denied. Only exact declaration-only
model files receive coverage exclusions; executable map/checkpoint/configuration
validation stays measured. No generic delivery or validation framework is added.

MCP/the review tool remain disabled under the owner's current-session waiver. Organization
security guidance was not checked; no approval is claimed.

## Spec references

- [DOMAIN: conventions and stored records](../planning/low-level/DOMAIN_AND_STORAGE.md#1-primitive-conventions)
- [DOMAIN: continuation](../planning/low-level/DOMAIN_AND_STORAGE.md#6-continuation-repair-and-migration)
- [API: projections](../planning/low-level/API_AND_MCP.md#summary-projections-and-command-naming)
- [PROCESS: provider-neutral support](../planning/low-level/PROCESS_AND_PROTOCOLS.md#2-shared-adapter-contract)
- [QUEUES: owner recovery evidence](../planning/low-level/QUEUES_AND_RECOVERY.md#4-owner-recovery-commands)
