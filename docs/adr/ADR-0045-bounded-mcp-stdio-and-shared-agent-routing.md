# ADR-0045: Bound MCP stdio and reuse authoritative agent routing

Status: Accepted

## Context

P2.5 adds the optional MCP transport over the canonical synchronous CoreService.
The installed agent CLI already resolves explicit retained binding IDs, generation
and source input/attempt pairs from registered native data. Copying that resolver
into another entrypoint would let visibility and historical replay drift. The SDK
also reads JSON lines before typed tool validation, so argument limits alone do
not bound its incoming frame allocation.

## Decision

Use pinned rmcp 3.5.0 with only server and IO transport features. Both installed
entrypoints call one `serve_stdio` library. Advertise only the existing generated
`session_read`, `item_messages`, `item_rounds` and `apply` tools and their canonical
Rust-authored input/output schemas. Every call carries binding and generation;
no path, actor or mutable current-session selector is introduced.

Move the existing CLI authoritative agent resolver into native Core after its
actual NativeCoreService prerequisite merges. CLI and MCP then consume that one
resolver and its existing canonical error classification. Preserve its retained
historical lookup, exact source-message issuance ceiling and caller generation;
Core still performs current read authorization and replay-first transactional
checks. There is no crate cycle or alternate context algorithm.

The transport accepts a trusted startup CoreService and resolver. Entire native
lookup plus synchronous query/apply runs on Tokio's existing blocking pool. The
renderer/tool caller cannot install a service, choose a trusted actor or supply
storage paths. Transport tests may inject the default-off scripted CoreService;
they prove framing and canonical forwarding, not persistence or a state machine.
Installed native routing, real dual-process replay/race and Store parity remain
required before claiming P2.5 completion.

Wrap AsyncRead before SDK JSON decode. A request line has at most 1 MiB before
its LF; complete typed canonical arguments have the existing 512 KiB budget.
Track split chunks and multiple lines independently. Overflow or a nonempty
incomplete EOF poisons and closes the transport; no suffix becomes another
request, partial input is never dispatched, and raw input is never logged.
Invalid JSON-RPC and unknown methods use SDK protocol failures. Canonical argument
or Core failures return the same bounded CoreError with MCP `isError=true`.
Malformed Core errors become a bounded nonretryable existing protocol_conflict
without claiming effects were absent or suggesting a new operation ID.

The complete canonical application envelope has the existing 1 MiB response
budget before MCP wrapping. Return that entire identical envelope in
structuredContent and the required text content. Do not truncate bodies, change
page limits or strip provenance to pay for the second representation. SDK JSON-RPC
adds bounded protocol overhead: the structured envelope is at most 1 MiB, JSON
encoding its serialized text at most twice that, and the response ID comes from
the bounded incoming frame. Tool names, server metadata and instructions are
fixed. Protocol wrapping is a distinct bound from the application envelope.

Stdout contains only SDK JSON-RPC. Help/version are explicit CLI modes; diagnostics
and startup failures go to stderr. Installation never enables an external host
MCP configuration or a connector.

## Validation

Focused SDK transport cases cover initialize/tool schema inventory, identical
structured/text failures, unknown methods, split/exact/overflow/EOF lines and no
mutation after framing failure. Real installed-entrypoint acceptance additionally
requires multi-session reads, complete history/cursor behavior, visibility,
generation checks, Apply replay/conflict and separate CLI/MCP writers sharing real
Store receipts. Expensive native and release proof stays in CI.
