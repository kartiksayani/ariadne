# Delivery

The owner starts the maintainer on **Astra High**; delegated implementers and
independent reviewers use **Sol 6.1 High**. Product implementation remains paused
until the owner resumes it. Do not reactivate old contexts.

Read CONTRIBUTING, BUILD_HANDOFF, PERSONAL_RELEASE and ROADMAP. Fetch origin/main,
inspect worktrees and current task PRs, and preserve unrelated edits/history.
Use fresh isolated worktrees for dependency-eligible parallel modules. Declare
bounded owned paths, goal, settled contracts, spec and acceptance. Reviewers join
when ready. Product scheduling waits for the corrected plan and owner resumption.
No automatic readiness engine or receipt workflow is required.

Follow the [implementation order](docs/planning/BUILD_HANDOFF.md#implementation-order)
and actual task prerequisites. Foundations and contract readiness enable parallel
work; no phase-wide barrier or single-implementer restriction applies. Preserve
the provider-neutral core, atomic locked JSON, binding identity/generation,
operation deduplication and explicit result/host-completion semantics. Live host
acceptance remains M7 and needs owner approval.

Select work from actual merged prerequisite PRs and current GitHub state. A draft,
local commit or partial task does not satisfy a dependency. Reserve disjoint paths
before assigning work; overlapping ownership serializes work even when dependency
edges allow parallelism. Assign one owner for shared manifests, exports and wiring,
and settle a contract change before dependent implementation. Keep independent
work moving while a concrete access or architecture blocker is resolved.

Workers propose shared-interface changes to the maintainer with affected consumers
and tests. The maintainer adjudicates, updates the authoritative contract and
dispatches all affected implementation/test work under declared ownership. Workers
do not change shared signatures or semantics unilaterally or maintain duplicate
contract copies. Important architecture changes get a short ADR; routine compatible
contract amendments are tracked in the affected PR.

The implementer adds meaningful behavior tests, commits through the cheap hook,
runs relevant pushed-head checks and opens a reviewable PR with behavior and real
validation evidence. Routine ownership/spec updates can ride it. Important
architecture gaps go to the maintainer before dependent work and resulting
important choices get a short ADR. No mandatory ADR for routine choices.

A separate reviewer context reads the latest GitHub diff and relevant contracts,
checks acceptance/tests/coverage and unnecessary complexity, and posts readable
findings bound to the exact head. Zero findings is valid. The maintainer adjudicates
findings; the author fixes them. Use one targeted re-review. Required unresolved
issues stay unmerged. No separate patcher, JSON context proof or service-wide
pre-mortem checklist is required.

Before squash merge, the maintainer checks:
- current PR head and base;
- genuine independent review at that head and resolved required findings;
- green quality for that head and acceptance evidence;
- squash merge, followed by a check of main.

Changed head/base requires relevant checks and current-head review. If a merge
reply is lost, read PR/main state before retrying. Only the maintainer merges.
Update task completion in tasks.json with actual PR links, then regenerate the
static chart. Preserve historical .delivery records without creating new receipts.

A tooling blocker gets one cheap attempt (about 15 minutes), then explain the cost
and cheaper route to the owner. Change harness/gates only for a demonstrated
delivery issue or repeatedly solved manual work; keep changes small and
proportionate while preserving quality. Do not grow another delivery framework.
The maintainer writes
retrospectives/docs directly and reports delivered capability, completed tasks and
concrete blockers. Use concise handoffs on interruption; reconcile them with
actual worktrees, GitHub and live contexts on resumption.

Repository rulesets and their limits are documented in CONTRIBUTING. Do not change
remote settings, remove existing worktrees/branches/history or read credentials.
MCP/Seezo remain disabled under the current-session waiver; organization guidance
was not checked.
