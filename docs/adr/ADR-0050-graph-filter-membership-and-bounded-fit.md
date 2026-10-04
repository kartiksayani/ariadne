# ADR-0050: Filtered graph membership and bounded Fit

Status: accepted
Supersedes: none
Superseded by: none

## Context

The graph shares tree filters, while replacement pointers can reach filtered-out
or other-topic items. Fit also promises full bounds plus padding within a fixed
0.25–2.0 zoom range, which cannot fit every possible topic into every viewport.

## Decision

Use the canonical tree selector's filtered selected-topic membership and ordinary
ancestor context. Draw a labelled dashed replacement edge only when both ends
are in that layout. Keep other replacement targets accessible through the common
registered reveal route; never inject them or rewrite filters. An explicit topic
must exist and agree with a nonnull saved topic filter. Missing or contradictory
selection produces an empty selection state without a preference mutation.

Fit uses the complete layout bounds, adds 32px padding, centers that geometry and
clamps its final scale to 0.25–2.0. If the bounds cannot fit at minimum zoom, show
the actual zoom and a concise overflow explanation with pan and tree controls.
Never crop geometry or relax the range to imply a successful fit.

## Consequences

Graph selection uses the existing registered detail route and revision-checked
navigation preferences. Geometry stays independent of viewport transforms and
exposes conservative edge bounds for the separate P5.2 culling implementation.
Focused geometry and component tests cover hidden/cross-topic replacements, topic
mismatch, range-limited Fit and registered selection. Native assembled selection
and P5.2 performance acceptance remain their original integration joins.

Contract: [UI_AND_NATIVE §4](../planning/low-level/UI_AND_NATIVE.md#4-graph).
