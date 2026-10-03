# Delivery

The owner starts the maintainer on **Astra High**; delegated implementers and
independent reviewers use **Sol 6.1 High**. Product implementation remains paused
until the owner resumes it. Do not reactivate old contexts.

Read CONTRIBUTING, BUILD_HANDOFF, PERSONAL_RELEASE and ROADMAP. Fetch origin/main,
inspect worktrees and current task PRs, and preserve unrelated edits/history.
Use one implementer in a new isolated worktree until the first walking slice.
Declare bounded owned paths, goal, spec and acceptance. Reviewers join when ready.
No automatic readiness engine or receipt workflow is required.

Prioritize the [thin first slice](docs/planning/BUILD_HANDOFF.md#thin-first-slice)
before deepening foundations. Keep the provider-neutral core, atomic locked JSON,
binding identity/generation, operation deduplication and explicit result/host
completion semantics. No paid/live host call without owner approval.

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
and cheaper route to the owner. Do not expand the harness. The maintainer writes
retrospectives/docs directly and reports delivered capability, completed tasks and
concrete blockers. Use concise handoffs on interruption; reconcile them with
actual worktrees, GitHub and live contexts on resumption.

Repository rulesets and their limits are documented in CONTRIBUTING. Do not change
remote settings, remove existing worktrees/branches/history or read credentials.
MCP/Seezo remain disabled under the current-session waiver; organization guidance
was not checked.
