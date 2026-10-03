# ADR-0009: Stage truthful CLI entry points

Status: accepted
Supersedes: none
Superseded by: none

## Context

The catalogue requires ten compiling packages and three thin entry points before
the shared domain/MCP service is implemented. A successful placeholder service
would falsely claim the final transport boundary exists.

## Decision

Create the seven domain/provider library boundaries as comment-only compiling
packages under the accepted coverage classification. CLI and MCP binaries offer
truthful help/version output and nonzero unsupported/unimplemented responses.
Neither `ariadne mcp serve` nor `ariadne-mcp` claims a working service. Build the
shared `ariadne_mcp::serve_stdio()` transport in its actual service task.

## Consequences

All workspace members compile and thin entry points have real process tests.
No fake domain results, alternate persistence or uncompiled future modules are
introduced. The architecture's final shared-core and rmcp boundaries remain binding.

## Spec references

- [Workspace boundaries](../planning/ARCHITECTURE.md#ownership-and-implementation-map)
