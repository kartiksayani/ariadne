# Delivery catalogue

[HANDOFF](HANDOFF.md) is the sole current resumption page. It records active owners,
unpushed work, current GitHub state and the next three steps; historical records
remain evidence rather than additional current handoffs.

[tasks.json](tasks.json) is the single source for task definitions and maintainer-updated
completion metadata. [ORCHESTRATOR](../../ORCHESTRATOR.md) describes implementation,
independent exact-head review and squash merge. [CONTRIBUTING](../../CONTRIBUTING.md)
defines checks and observed GitHub enforcement.

After an actual merge, add the task's `completion.pr_url` and regenerate:

```sh
python3 scripts/regenerate-roadmap.py
```

The [static Gantt/dependency graph](../planning/roadmap.html) embeds this data so
`file://` works. It has no polling, server, credentials or live evidence export.
The chart shows maintainer-recorded completion; the maintainer checks actual
GitHub state before scheduling or merging. Partial work is not a completed task.

Historical `.delivery/` records and PR comments remain intact. The old delivery
helper, structured receipts and maintainer-spec-review workflow have been retired
by [ADR-0018](../adr/ADR-0018-recalibrate-delivery.md).
