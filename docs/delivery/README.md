# Delivery helper

[ORCHESTRATOR.md](../../ORCHESTRATOR.md) defines the autonomous workflow. The
helper performs repeatable GitHub checks; the live maintainer session delegates
and judges the work. It never starts an agent, stores credentials or enables MCP.

## Start the maintainer

Choose **Astra / High** in your agent host, open this repository, then send:

> Read AGENTS.md and ORCHESTRATOR.md. Execute the implementation roadmap from
> current main. Use Sol 6.1 High exclusively for every implementer, reviewer and
> patcher. Continue independently through eligible tasks and reviewed PRs. Pause
> for missing access or destructive actions. Preserve unrelated work and report
> actual tests and evidence; never waive a gate to claim completion.

Install the [development tools and hook](../../CONTRIBUTING.md#setup) first.
The host needs delegation, shell/Git access, GitHub authentication for this repo,
and eventually the Mac/native tooling and locally authenticated agents required
by the implementation milestones. The helper requires Python 3.11+, Git and `gh`.
There is no background service to install for the delivery workflow.

## Commands

Run the reviewed helper from the maintainer's clean checkout of current `main`,
with `origin` pointing to `kartiksayani/ariadne`. Keep its catalogue current after
each merge; do not run a worker's unreviewed copy as the merge authority:

```sh
rtk proxy .venv-quality/bin/python scripts/delivery.py ready
rtk proxy .venv-quality/bin/python scripts/delivery.py brief P0.1
rtk proxy .venv-quality/bin/python scripts/delivery.py ready --running P0.1
rtk proxy .venv-quality/bin/python scripts/delivery.py verify 123 --record .delivery/P0.1.json
rtk proxy .venv-quality/bin/python scripts/delivery.py merge 123 --record .delivery/P0.1.json
rtk proxy .venv-quality/bin/python scripts/delivery.py export
```

`123` and the record path are examples. `ready`/`export` derive completion from
fresh GitHub reads, actual merged PRs and validated records. `brief` prints a
task's owned paths, spec, acceptance and planned checks. `verify` is read-only;
`merge` publishes the maintainer record/status and requests the exact-head squash
merge. Save `export` stdout to a JSON file to import into the
[interactive chart](../planning/roadmap.html). Chart imports do not authorize work.

Readiness excludes open task PRs and locally reserved `--running` task IDs.
Returned candidates can still conflict with each other: reserve one, then call
again with the updated running set before assigning another. The maintainer
enforces one owner for each worktree/path and merges serially.

Prepare each worktree from fetched `origin/main`; use `git worktree add -b
task/P0.1 .worktrees/P0.1 origin/main` with the appropriate task. Install its
quality environment/dependencies and verify the shared hooks path resolves.
Do not remove an abandoned worktree or branch without the owner's authorization;
it may contain work worth preserving.

## PR and review evidence

The PR body contains exactly one task marker, with its real catalogue ID:

```text
<!-- ariadne-task:P0.1 -->
```

Write a normal readable PR description using the repository template. Append
human-readable independent review findings plus one fenced block labelled
`ariadne-review` to each GitHub COMMENT review. Publish it with the **current
`commit_id`**, so GitHub independently records which commit was reviewed.
Issue comments alone are not independent review evidence.
The final review also acknowledges the exact `architecture_decisions` and
`spec_updates` declarations described in the [ADR contract](../adr/README.md).

Write `.delivery/review.json` with the GitHub request fields `commit_id` (the
actual full head SHA), `event: "COMMENT"`, and `body` (readable review plus the
fenced block), then publish it:

```sh
rtk proxy gh api repos/kartiksayani/ariadne/pulls/123/reviews --method POST --input .delivery/review.json
```

Save the returned `node_id` as the review ID in the maintainer record. The helper
will fetch that review again through GraphQL before trusting it.

The JSON inside that fenced block has this shape (illustrative, not evidence):

```json
{
  "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "agent": "review-P0.1",
  "model": "gpt-6.1-sol",
  "effort": "high",
  "round": 1,
  "findings": [
    {"id": "F1", "priority": "P2", "summary": "Concrete behavior, location, consequence and fix"}
  ]
}
```

Use `findings: []` only after an actual clean review or completed patch
verification. Preserve IDs within a review; identify a disposition by the review
ID plus finding ID so separate rounds cannot accidentally collide. Every
structured review must be represented in the final record; selecting an older
clean review while omitting a later finding is invalid.

Use GraphQL to obtain the actual review node IDs and heads. Post review and
maintainer text with body files or structured JSON, preserving real newlines;
never interpolate untrusted prose into shell code. Agent IDs identify actual
contexts in the runtime. They do not have to be GitHub accounts.

## Maintainer record

After genuine final review, create the ignored `.delivery/TASK.json` file. It
contains the task, final head, reviewed base, **all** implementer/patcher context
IDs, every independent structured review, dispositions, and final spec decision.
The CLI publishes this record in an `ariadne-delivery` fenced block on the PR.

The helper validates its exact format; consult `delivery_core.py` alongside this
example when making a record. Do not copy these dummy IDs as real evidence.

```json
{
  "task_id": "P0.1",
  "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "base": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "authors": ["implement-P0.1", "patch-P0.1"],
  "reviews": [
    {"id": "PRR_first", "head": "cccccccccccccccccccccccccccccccccccccccc", "agent": "review-P0.1", "round": 1},
    {"id": "PRR_final", "head": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "agent": "review-P0.1", "round": 1}
  ],
  "architecture_decisions": [],
  "spec_updates": [],
  "decisions": [
    {"finding": "PRR_first:F1", "disposition": "fixed", "reason": "Verified the correction and its regression test at the final head", "spec": "Exact task spec section"}
  ],
  "spec_review": {
    "sections": ["Every spec reference from this task's catalogue entry"],
    "conclusion": "What the maintainer checked, acceptance/tests/E2E/coverage evidence, and why the final change satisfies this task"
  }
}
```

Reviews and CI must match the current final head; open PRs must also match the
recorded current base. The final review must have no remaining findings. The
helper validates file ownership and at most three consecutive review rounds,
including targeted verification in a round. Exact declared ADR files are narrow
ownership exceptions. Additional declared spec updates must be existing Markdown
files in this task's `spec`, changed and referenced/explained by a new accepted ADR.
List all these paths in final `spec_review.sections` and in the final review
block using the same two declaration arrays (defaults are [] for older records).
The maintainer reserves these exact extra paths and checks conflicts; `ready`
only schedules the catalogue globs. The helper reads ADRs at the actual reviewed
base/head, preserves superseded prose, and validates historical receipts at the
original PR head rather than today's main. See the [ADR contract](../adr/README.md)
for asking questions, supersession, precedence and unmarked maintenance PRs. A reviewer cannot be an author or
patcher. All workers' model/effort settings are part of the actual delegation;
structured review evidence additionally records the reviewer's settings.

The maintainer must evaluate correctness and whether a deferral is outside task
acceptance. A JSON field cannot establish that judgment. A valid-looking fake
record is still a violation of the workflow, not a substitute for doing the work.

## Everyday failures

| Situation | Action |
| --- | --- |
| Missing login/network/repository access | Report the concrete command/error; continue unrelated local work. Never print credentials. |
| Pending or failed CI | Wait for pending checks; assign fixes for failure. Missing/skipped checks do not pass. |
| Head or main changed | Rebase as needed, rerun checks and obtain final-head review; replace stale record fields. |
| Ownership overlap or unfinished dependency | Work on a different eligible task or wait for its owner. |
| Three rounds exhausted | Leave unmerged, preserve findings and re-scope/rework; no silent counter reset. |
| GitHub response lost during merge | Read actual PR state and main before retrying. The merge may already have happened. |
| Interrupted orchestrator | Reconcile ignored session note, live contexts, worktrees and GitHub; do not trust cached readiness. |
| Unexpectedly large GitHub history | Helper fails closed on truncated evidence; reduce/split scope or add tested pagination support. |

GitHub is the durable delivery record. `.delivery/` notes and exported chart data
are disposable mirrors. The repository currently lacks server-enforced branch
protection because of GitHub's private-repository plan restriction; see
[CONTRIBUTING](../../CONTRIBUTING.md#github-enforcement).
