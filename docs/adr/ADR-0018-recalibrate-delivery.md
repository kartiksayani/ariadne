# ADR-0018: Recalibrate delivery around the first walking slice

Status: accepted; product sequencing partially superseded by ADR-0019
Supersedes: [ADR-0001](ADR-0001-record-architecture-decisions.md) (machine declarations),
[ADR-0010](ADR-0010-classify-uninstrumented-rust-declarations.md) (coverage classifier),
[ADR-0017](ADR-0017-increase-review-size-budgets.md) (caps),
[ADR-0007](ADR-0007-gate-scaffold-release-isolation.md) (cadence only),
[ADR-0002](ADR-0002-test-webview-and-macos-surfaces.md) (cadence only),
[ADR-0014](ADR-0014-check-only-final-pr-snapshot-in-ci.md) (full local hooks/caps only)
Superseded by: [ADR-0019](ADR-0019-restore-module-delivery.md) (only the product
sequencing paragraph beginning "Product work stays paused"; tooling, quality and
review decisions remain accepted, with current enforcement documented in CONTRIBUTING)

## Context

The owner's 2026-10-03 recalibration accepts the rev3 review's delivery critique:
tooling and receipt work delayed product progress, and docs changes paid for full
native/release builds. Reduce machinery while preserving actual correctness proof.

## Decision

Use cheap changed-language pre-commit checks and one pushed-head CI run with a
small docs/tooling/application map. Unknown paths/missing base run full checks;
quality always reports. Application changes keep meaningful tests, Clippy,
>=80% weighted Rust+web coverage including untested logic and native WebView smoke.
Release-sensitive changes and full/manual milestones retain all ADR-0007 production
isolation controls and actual PID cleanup. This policy change receives full validation.

Delete numeric caps, delivery/readiness/receipt/ADR authorization helpers and
custom planning validators. Keep genuine separate-context exact-head review;
the author fixes findings, with one targeted re-review. The maintainer checks
head/base, review, green quality, squash merge and main. Routine spec/ownership
updates ride product PRs; important architecture choices still get short ADRs.
A tooling blocker gets one cheap attempt, then its cost and cheaper route go to owner.

Replace coverage SHA/AST/dependency classification with explicit reviewed exclusions:
the exact seven comment-only stubs until first logic, declaration-only DTO paths,
generated/vendor/tests and known build configuration. No blanket lib.rs exclusion,
hidden handwritten logic, fake zero LCOV or tool coverage in application percentage.
Keep fresh genuine Rust/web reports and fail missing/stale/omitted-source evidence.

Keep tasks.json as the single catalogue and maintainer completion source, with real
PR links and a tiny static HTML regeneration command. Drop live-chart work and
receipt import, preserving its paused worktree and historical evidence.
The observed public rulesets require PR approval and block deletion/non-fast-forward
updates with documented admin limits; neither requires status checks. Change no settings.

Product work stays paused. On resumption use one implementer and a reviewer when
ready; prioritize CLI publish → atomic locked JSON → Waiting UI → answer queue →
fake provider boundary → explicit agent CLI reply/result → UI update in one manual
binding. Keep provider neutrality, binding identity/generation, operation dedup and
separate domain result/host completion. Paid/live early Claude needs owner approval.
Defer schema/DTO depth until needed; preserve paused drafts, existing ten packages
and final Codex/MCP/discovery/graph/Continue/native scope.

## Consequences

The repository loses machinery rather than gaining a policy framework. Independent
review must check exclusion honesty and acceptance. Historical ADR prose and
.delivery records remain preserved; their old procedures are superseded here.
MCP/the review tool remain disabled under the current-session waiver; organization guidance
was not checked. No live host call or remote-setting change is authorized here.

## Spec references

- [Contributing](../../CONTRIBUTING.md)
- [Development checks](../planning/DEVELOPMENT_CHECKS.md)
- [First slice](../planning/BUILD_HANDOFF.md#thin-first-slice)
- [Personal release](../planning/PERSONAL_RELEASE.md)
