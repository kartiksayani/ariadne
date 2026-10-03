# Adapter contract cases

These deterministic provider-neutral examples are shared by protocol producers
and consumers. They exercise the owned seam; they are not live host evidence or
the P0.3 canonical demo/invalid domain fixtures.

- `events.json` covers each normalized kind, explicit nullable fields, opaque
  Unicode identities, both visible-output operations and truncation/gap flags.
- `scenarios.json` preserves consistent replay, contradictory turn/outcome facts,
  delivery uncertainty and distinct chunks with identical text. Core owns their
  persisted effect/conflict interpretation.
- `terminal_ids.json` fixes the fallback identity encoding and distinguishes a
  null turn from the string `null`. Native source identity remains verbatim.

Rust contract tests validate emitted schemas, correlation, bounds and batch
scope. Scripted fake tests exercise repeated checkpoints before caller persistence,
explicit checkpoint advance, historical reconciliation and both delivery modes
without automatic submit retry. Generated TypeScript assignment tests consume
canonical domain imports. Tests do not claim the later core/result/FIFO join or
the first-party providers' live acceptance.
