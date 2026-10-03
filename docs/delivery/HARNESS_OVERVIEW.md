# How delivery works

The pinned Tauri/Rust/React scaffold and native WebView smoke are implemented.
Domain storage, provider integration and the final personal release remain work ahead.

The maintainer selects bounded work from [tasks.json](tasks.json); one implementer
works in an isolated worktree until the first walking slice. A separate context
reviews when the change is ready. The author fixes findings; the maintainer checks
the exact head/base, green quality, independent review, squash merge and main.

The hook runs cheap changed-language checks. Pushed-head CI selects docs, tooling
or application checks; application coverage stays >=80% and includes untested logic.
Release-sensitive changes and milestones retain packaged isolation checks.

Start with [ORCHESTRATOR](../../ORCHESTRATOR.md),
[CONTRIBUTING](../../CONTRIBUTING.md) and [BUILD_HANDOFF](../planning/BUILD_HANDOFF.md).
See [README](README.md) for static chart regeneration. Historical delivery records
remain evidence; no machine authorization helper is needed.
