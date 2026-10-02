# Autonomous delivery

The owner launches this session using **Astra with High effort**. Every subagent
uses **Sol 6.1 with High effort**. This session owns scheduling, adjudication and
main. Subagents own implementation, independent review or a bounded patch.
Use your agent runtime's delegation tools; the helper does not start a model or
pretend to be an autonomous process after this session ends.

## Start and resume

1. Read [CONTRIBUTING](CONTRIBUTING.md), [BUILD_HANDOFF](docs/planning/BUILD_HANDOFF.md),
   [PERSONAL_RELEASE](docs/planning/PERSONAL_RELEASE.md) and the
   [roadmap](docs/planning/ROADMAP.md). Read the exact task spec sections before
   deciding implementation or adjudicating a review.
2. Verify the actual session model/effort and delegation capability. If the runtime
   cannot supply the requested model, report that concrete access gap; do not
   silently downgrade or use the maintainer as its own independent reviewer.
3. Check Git status, worktrees, hooks and GitHub access. Preserve local changes.
   Fetch `origin/main`; do not force-reset an existing worktree. Run the complete
   local gate once in a clean checkout to establish the starting state.
4. Run `scripts/delivery.py ready` through the quality Python environment. It
   re-reads GitHub; local checkboxes or imported chart data never mark work done.
   Inspect open task PRs and existing worker contexts before creating duplicates.
5. Continue existing work first, then reserve eligible tasks with disjoint owned
   paths. Keep at most three worker contexts active, leaving the maintainer slot
   free. Add locally reserved task IDs with `ready --running TASK` until their PRs
   exist. Recompute eligibility after each reservation and merge.

All example shell commands below use `rtk proxy` in the owner's environment.
The setup and helper reference are in [docs/delivery/README.md](docs/delivery/README.md).

## One delivery loop

### 1. Assign

Use a fresh worktree/branch from current `origin/main`. Give the implementer:
task ID, goal, owned paths, dependencies, exact spec references, acceptance,
required checks, worktree/branch, model/effort, and the reminder that other agents
are working nearby. `delivery.py brief TASK` provides the catalogue details.
The worker chooses implementation details within those boundaries.

Tell the worker to commit small changes through the hook and open a PR containing
the marker `<!-- ariadne-task:P0.1 -->` with the actual task ID. The PR must explain
behavior, scope, tests/E2E, coverage, limitations and spec references. Keep it draft
until the required behavior and checks exist. The worker returns PR URL, final
head, commands/results, coverage and any remaining concern. It never merges.

If a task cannot fit one correct PR under the 800-line handwritten cap, first
split its catalogue entry in a small reviewed planning PR, updating dependants,
owned paths and embedded chart data. Do not submit a half-working task or claim
it complete with several ambiguous task markers. Maintenance PRs without a task
marker do not satisfy product dependencies and follow the same review/check rules.

### 2. Review independently

Spawn a reviewer in a **fresh separate context** using Sol 6.1 High. It must not
have authored or patched this PR. Give it the PR, task/spec and concrete test
evidence; let it inspect the latest `gh pr diff` and relevant code itself.
It checks behavior against acceptance, design fidelity, ordinary failure paths,
ownership, tests/coverage, lint and unnecessary complexity. Run relevant checks;
do not replace evidence with the author's summary.

The reviewer posts a real GitHub **COMMENT review bound to `commit_id`**. Include
human-readable findings and the compact structured review block from the helper
reference. Use stable finding IDs, priorities and concrete fixes. Zero findings
is a valid outcome; do not invent a quota. Shared GitHub login means these are
independent agent reviews, not GitHub self-approvals.

### 3. Adjudicate and patch

Read every finding and its spec section. Record **fixed**, **deferred**, or
**rejected**, with a reason and spec reference. “Fixed” is a claim to verify,
not a request to waive testing. Deferral is allowed only outside required task
acceptance; give it a future catalogue task or a concrete later-release note.
Never defer a broken gate or required behavior to make a PR mergeable.

For accepted findings, spawn a separate patch agent (Sol 6.1 High), owning only
the affected task paths. It adds or updates meaningful regression tests, commits
through the hook and returns the new head. The independent reviewer verifies the
patch and posts a new review at that head. An unrelated new finding begins the
next review round; targeted verification belongs to its existing round.

At most **three review rounds** per PR. Stop early when no findings remain.
After round three, unresolved required work stays unmerged. Continue independent
tasks and rework/split the blocked task when there is a concrete new approach.
Carry unresolved finding IDs and exhausted-round history forward; reopening a PR
does not reset review limits to bypass a bad result. Decide implementation
trade-offs from the accepted spec and record necessary clarifications in a small
reviewed spec PR. Ask the owner for missing access or a destructive action.

### 4. Maintain and merge

The maintainer reads the final diff and task spec once more. Confirm every
acceptance condition, actual tests/E2E/coverage, all review dispositions, and
that the final head includes current main. Rebase and rerun checks if main moved;
changed commits need fresh final-head review. Do not merge concurrently.

Create the small `.delivery/` record described in the helper reference, listing
all author/patcher context IDs, every structured review, dispositions and the
final spec conclusion. Run `delivery.py verify`, then `delivery.py merge`.
Resolve addressed GitHub review threads only after the reviewer has verified the
fix or the maintainer has recorded a justified rejection/deferral.
The merge command re-reads GitHub, checks ownership/reviews/CI/head/base, publishes
the durable maintainer record and `maintainer-spec-review` status, and requests a
rebase merge with the exact head. It never uses force/admin overrides.

Only an actual merged PR with valid recorded evidence satisfies a dependency.
Fetch main and confirm its post-merge CI before merging another PR. A failed main
check pauses new merges; delegate the smallest corrective PR and review it.
If a network reply is lost, re-read PR/main state before retrying a mutation.
Do not retry merges or publish duplicate evidence blindly.

### 5. Repeat or hand off

Re-run readiness and continue until the assigned release scope is complete.
Keep a short ignored `.delivery/session.md` with running context IDs, task/PR/head,
worktree paths and concrete blockers. This is a resumption aid, not completion
authority. Durable review/decision/test evidence lives on the PR; definitions live
in the catalogue. `delivery.py export` produces optional chart evidence.

On interruption, summarize active work and the next safe action. On resumption,
reconcile that note against GitHub, worktrees and actual live agents. Do not
assume a disappeared agent is still working. On completion report actual merged
scope, passing acceptance evidence, known limitations and the build/install path.

## Improve the harness without growing bureaucracy

Fix a demonstrated workflow failure with the smallest regression-tested,
independently reviewed maintenance PR. Preserve the user's model choices,
coverage floor, review independence, size caps and scope. Do not add a new policy
for every speculative failure or let a feature PR weaken its own gates.

The reference projects contributed ownership, dependency scheduling, separate
review and a compact delivery record. This harness deliberately has one task
catalogue and GitHub evidence instead of multiple manually synchronized ledgers.

## Enforcement boundary

GitHub rejected branch protection for this private repository's current plan.
Hooks, CI and this maintainer workflow are active; a writer can still bypass them.
The prepared protection payload is documented in CONTRIBUTING. Do not change
billing/visibility automatically or describe main as server-protected.

The helper validates evidence structure and current GitHub state. The maintainer
still judges correctness, spec adherence, review independence and valid deferrals.
The repository lock serializes local harness merges; it cannot lock out an owner
writing through GitHub. Keep one maintainer and recheck state after every mutation.
