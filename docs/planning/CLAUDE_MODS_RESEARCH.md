> Historical research/evidence, not the current implementation contract. Use
> [LOW_LEVEL_DESIGN](LOW_LEVEL_DESIGN.md) and [BUILD_HANDOFF](BUILD_HANDOFF.md).

# Claude Mods: existing-session delivery candidate

**POC follow-up: live communication passed on 2.1.287.** The [prototype](../../poc/claude-mods/README.md)
delivered three external messages into the user's existing interactive conversation,
preserved context, queued messages while busy and captured replies in order.
See [recorded evidence and remaining gates](../../poc/claude-mods/RESULTS.md).
The research below predates that implementation.

Researched 2 October 2026. **Recommendation: prototype a small Ariadne mod as the primary Claude inbound adapter.** This is documentation/source research, not a passed runtime proof. No mod was installed or executed during this investigation.

## Evidence

- Mods run inside Claude Code. Version 2.1.287 enables them by default; it is the version observed in our earlier CLI test. Installing a mod from the shell and running `/reload-plugins` loads it into an open session, subject to policy. [Official overview](https://code.claude.com/docs/en/plugins/mods/overview)
- `$.prompt.submit({text})` is documented to wait for idle and start a turn. A timer can call it between events. Its resolution is not completion; avoid awaiting it from a hook that blocks ongoing work. `$.model.complete` and `$.model.fork` serve separate calls and are not the required delivery primitive. [API guide](https://code.claude.com/docs/en/plugins/mods/api#start-a-turn-from-a-background-job)
- `session.start` runs again on reload, but not after `/clear`, `/resume` or `/branch`. Timers, session identity access and turn lifecycle hooks are available. [Reference](https://code.claude.com/docs/en/plugins/mods/reference)
- Published declarations identify `turnId` on start/completion and completion reasons `answer|aborted|refusal|error`. Their header says 2.1.277, older than our CLI. Their submit-result commentary permits a queued result; this differs from a strict reading of the current guide. Generate installed-version types and observe actual start events before marking an input running. [Official declarations](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts)

## Proposed Ariadne adapter

```text
Owner message on any Ariadne item
  → core commits immutable message and ordered outbox input
  → Ariadne mod in the correct Claude terminal claims that input
  → mod calls $.prompt.submit({text: attributed item message})
  → matching turn.start records actual start
  → Claude replies/updates items through Ariadne tools
  → matching turn.complete records outcome
  → next eligible input is submitted
```

The external macOS app remains the main tree UI. The mod supplies the connection into Claude; it does not require moving the whole app into terminal panes. Existing CLI/MCP tree mutations remain usable.

Prototype design choices:

1. A mod timer checks its explicitly bound queue through the Ariadne core-backed CLI helper. Empty polls cause no model calls. Use a non-overlapping callback and one outstanding submitted input.
2. Read the current host session ID through the mod API and bind it with project identity. Recheck before claiming/submitting. Never route by directory alone. A session switch invalidates the old binding and pauses dispatch until reconciled.
3. All durable writes use the existing Rust transaction service; do not rewrite session JSON with `$.fs.write`, which is not an atomic store operation. The mod is an adapter, not a second storage implementation.
4. Include input/item IDs and owner text in a bounded attributed prompt; keep the default mod attribution. Do not use `asUser:true` to disguise delivery provenance.
5. Record prepared/submitted, matched turn-start, matched completion and semantic item receipt separately. Handle `drop`/exceptions and crash uncertainty without blind retries. Confirm correlation against the installed-version events; a submit promise alone does not prove work finished.
6. Match main-conversation turns only; a subagent's completion must not advance the queue. Preserve ordering among Ariadne inputs without promising priority over terminal input or other plugins.
7. On reload, stop old callbacks and reconcile durable outstanding work before creating another dispatcher. On interruption/error/refusal, pause later inputs. Do not await a queued submission while holding a turn hook or a storage lock.
8. Keep normal tool permissions. The adapter requires no automatic approval, model substitution, transcript rewriting, credential access, or channel allowlist exception.

## Decisive proof before revising the complete roadmap

Load into an already-open interactive session via the documented install/reload flow. Have that session create a topic with seven fixture findings. Send a comment against an Open item from a separate process. Observe that the same session starts work without another owner prompt and associates its reply with the input. Then prove busy delivery, three sequential inputs, manual terminal input interleaving, two sessions in one directory, interruption, reload and session switch behavior.

Use the installed build's generated types. Record exact submit returns and start/complete events; do not let the older public types settle ambiguous scheduling behavior. A successful headless test is insufficient for the reload/interactive acceptance case.

This route directly addresses the previous attachment gap and should be tested before investing in a custom Channels implementation. Mods use plugin loading and applicable mod policy; the earlier Channels startup/allowlist restrictions do not automatically apply to Mods. **Codex parity remains a separate investigation.**

The existing the review tool waiver remains in effect; organization guidance was not checked.
