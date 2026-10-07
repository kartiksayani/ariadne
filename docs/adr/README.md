# Architecture decisions

Important product or implementation architecture gaps go to the maintainer before
dependent work. State the concrete gap, relevant spec, options and recommendation.
Routine choices within settled contracts do not need an ADR.

Record important resulting decisions in a short Markdown ADR in the affected PR:
context, decision, consequences and relevant spec links. Use [TEMPLATE](TEMPLATE.md)
and an unused ID; avoid IDs already reserved by paused work. Routine ownership/spec
updates can ride a product PR without a separate planning PR or machine declarations.

Owner requirements govern. Update affected canonical contracts alongside a decision.
When superseding an ADR, preserve its original prose, mark its status and add
reciprocal replacement links. Partial supersession must name the changed part and
retained controls. The independent reviewer and maintainer assess consistency at
the exact head; metadata does not prove judgment.

[ADR-0018](ADR-0018-recalibrate-delivery.md) retires machine receipt/ADR validation
and numeric caps while retaining meaningful tests, coverage, release controls and
independent review. Historical ADRs and delivery records remain preserved.

[ADR-0019](ADR-0019-restore-module-delivery.md) supersedes only ADR-0018's product
sequencing, restoring foundation/dependency intent and contract-ready parallel
modules while retaining its tooling, quality and review decisions.

[ADR-0078](ADR-0078-parallel-quality-stages.md) splits the `quality` workflow into
parallel `static`, `coverage` and `native` jobs behind the same required `quality` check.

[ADR-0060](ADR-0060-own-desktop-integration-seams.md) names desktop integration and
shared-file owners and keeps remaining delivery vertical on the assembled app.

Recent decisions: [ADR-0074](ADR-0074-claude-mod-static-validation.md) (Claude Mod
static validation), [ADR-0075](ADR-0075-claude-connect-output-and-skill-rules.md)
(short Claude connect result, rules in the skill),
[ADR-0076](ADR-0076-claude-framed-plugin-prompts-and-turn-correlation.md) (framed
plugin prompts and turn correlation) and [ADR-0077](ADR-0077-setup-instruction-names-the-exact-cli-invocation.md) (setup
instruction names the exact CLI invocation).

[ADR-0079](ADR-0079-prebuilt-alpha-package.md) adds a prebuilt alpha package
(`make package`, `install.py install --package`, tag-triggered release workflow)
beside the source install.

[ADR-0080](ADR-0080-app-bundle-in-applications.md) installs `~/Applications/Ariadne.app`
as a real owned copy of the bundle, because Finder, Spotlight and Launchpad ignore a
symlink into a hidden folder. It supersedes the symlink sentence of ADR-0062.

[ADR-0082](ADR-0082-project-store-under-data-root.md) moves the per-project store from
`<project>/.ariadne/` to `<data root>/projects/<project-id>/` and migrates legacy
stores automatically, with a byte-for-byte check before the old copy is removed.

[ADR-0081](ADR-0081-provider-paths-from-setup.md) trusts Claude's own version report
(the Claude adapter no longer needs an executable and the app locates its installed
Mod itself) and makes `ariadne setup` record the Codex path in `providers.json`, so
the app finds both when opened normally. Flags still override; the app never searches
PATH or launches a host.

[ADR-0083](ADR-0083-remove-commands.md) makes Remove a permanent owner command for
items, topics, sessions and projects. Each removal writes a `pre-remove-…` backup
first and returns its path; item and topic removal queue one `removed` notice for
the agent. Conversations and files outside Ariadne's store are never changed.
