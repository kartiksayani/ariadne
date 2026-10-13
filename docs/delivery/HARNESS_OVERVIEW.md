# How delivery works

Alpha.13 is released; alpha.14 (a Map you can follow) is in progress, with alpha.15
(Conversation view) next. [HANDOFF](HANDOFF.md) is the current resumption page.

The Claude Code maintainer runs Opus 5.5 and selects bounded work from
[tasks.json](tasks.json). At most 3 Codex companion jobs (gpt-6.1-sol, high effort)
implement eligible modules in isolated worktrees with declared, disjoint paths.
A separate Opus 5.5 context reviews the exact head; the author fixes findings and
one targeted re-review follows. The maintainer checks current head/base, green
`quality` and resolved review, uses `gh pr merge --squash --match-head-commit <head>`,
then verifies main equals the PR's merged head.

Codex jobs cannot run browsers, sockets, the app, native e2e or `git add`/commits.
The maintainer plans time for Playwright, design frames, the local native journey
before push, staging and commits. UI work first needs owner sign-off on a clickable
HTML mock under `designs/mocks/`; implementation follows it.

The hook runs cheap changed-language checks. Pushed-head CI selects docs, tooling
or application checks; application coverage stays >=80% and includes untested logic.
Release-sensitive changes and milestones retain packaged isolation checks.
Test Ariadne-owned behavior; latency is guidance, not a gate. Keep process changes
small and tied to recurring delivery costs under ORCHESTRATOR's process budget.

After merge, tag `v0.1.0-alpha.N` with `-m "Ariadne v0.1.0-alpha.N"`, wait for the
release workflow and edit notes with the fixed
[How to upgrade block](../planning/PERSONAL_RELEASE.md#release-notes).
Refresh HANDOFF, tasks.json and the roadmap chart.

Start with [ORCHESTRATOR](../../ORCHESTRATOR.md),
[CONTRIBUTING](../../CONTRIBUTING.md) and [BUILD_HANDOFF](../planning/BUILD_HANDOFF.md).
See [README](README.md) for static chart regeneration. Historical delivery records
remain evidence; no machine authorization helper is needed.
