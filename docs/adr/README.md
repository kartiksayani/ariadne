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

[ADR-0084](ADR-0084-short-labels.md) adds an optional agent-written `short` label
(2-4 words, at most 40 characters) to items and topics for the graph and breadcrumbs.
An absent label in `item.edit` keeps it, `null` clears it; older stores load unchanged.

[ADR-0085](ADR-0085-host-location.md) records where the agent's terminal runs
("iTerm window 1") on the binding, parsed from the agent-side `TERM_PROGRAM` and
`ITERM_SESSION_ID` by the Claude helper, and adds `topic_count` to `SessionSummary`.

[ADR-0086](ADR-0086-paperwhite-design.md) makes the owner's v2 Paperwhite handoff the
desktop design: a ported presentation layer under `apps/desktop/src/ui/`, tokens
verbatim, JetBrains Mono, one keymap and one agent connection value. The pixel
harness (`npm run test:design`, thresholds = measured + 0.01) is the fidelity gate.

[ADR-0087](ADR-0087-supervisor-retry-health-and-log.md) amends ADR-0032. A binding
supervisor now logs a failure and retries with backoff (1 s to 30 s) and the same IDs.
It stops only when its scope has ended. Each Codex binding publishes running,
backing off or stopped health in plain words. The app writes
`$ARIADNE_HOME/logs/ariadne.log` and a health file that `ariadne doctor` reads.

[ADR-0088](ADR-0088-core-never-dead-ends.md) makes core lifecycle and delivery do the
safe thing itself. A committed result handles its input, resolve resumes dispatch,
close is one step, and removal and cancel take pending inputs. A `/clear` rebind
carries pending inputs to the new conversation.

[ADR-0089](ADR-0089-slim-input-envelope.md) slims the per-input envelope to about
500 bytes for a one-line answer. Context is pulled with `ariadne read`, never pushed,
and an input written for an older question is held for the owner's review instead of
being sent.

[ADR-0090](ADR-0090-archive-never-refuses.md) lets the owner archive a topic with
open items. Archive cancels the topic's unsent messages, items keep their status,
and agent writes to an archived topic return `topic_archived`.

[ADR-0091](ADR-0091-owner-session-names.md) lets the owner name a session and give it a
short description (`session_label_set`). The name leads on cards, the session bar, tabs,
pickers and confirmations; the agent line becomes the quieter label.

[ADR-0092](ADR-0092-lenient-apply-in-the-cli.md) makes `ariadne apply` input lenient
(generated `op_id`, defaults, nested `children`) while core stays strict, adds
`--dry-run`, makes the default receipt compact (`--full` for the old one) and gives
`ariadne read --view items` `--topic` and `--archived`.

[ADR-0093](ADR-0093-owner-acknowledgment.md) keeps new items nonterminal and adds
the owner's local Ack action for read-only work, with an agent-selected target.

[ADR-0095](ADR-0095-session-archive.md) puts finished sessions in a remembered,
folded Archived group, closes them safely, and restores them as Closed while
keeping their history readable.
