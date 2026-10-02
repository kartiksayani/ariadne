> Historical research/evidence, not the current implementation contract. Use
> [LOW_LEVEL_DESIGN](LOW_LEVEL_DESIGN.md) and [BUILD_HANDOFF](BUILD_HANDOFF.md).

# Correction: Ariadne accompanies an existing terminal session

Owner clarification: 2 October 2026, after the live streaming smoke test.

**Later finding:** [Claude Mods](CLAUDE_MODS_RESEARCH.md) documents current-session prompt submission and loading via `/reload-plugins`. This is now the recommended Claude prototype. The Channels constraints below remain accurate for that particular route; they must not be generalized into a claim that all existing-session integration requires restart. The mod path is not yet runtime-tested.

## Required workflow

1. The owner is already working in a Claude Code terminal conversation, for example reviewing a PR.
2. Claude creates an Ariadne topic and seven findings through Ariadne's tools, choosing their states.
3. Ariadne displays those findings associated with that exact conversation.
4. The owner writes a message against any finding, including an Open item.
5. The message reaches that running Claude conversation automatically and becomes work for it to process.
6. Claude responds and updates the associated topic/items, with its existing context intact.

The primary requirement is accompaniment of a terminal conversation. Launching an application-owned headless conversation does not prove this workflow. The previous external-session “manual pickup” behavior does not satisfy it either. Codex remains required; equivalent attachment/delivery support must be established separately.

## Candidate Claude mechanism and its limits

Claude's documented **Channels** extension lets a locally connected MCP server push events into a running conversation. It requires session startup opt-in; merely installing a conventional MCP server is insufficient. Custom channels are still subject to research-preview loading/allowlist rules and applicable organization policy. The documentation does not establish retroactive attachment to an arbitrary running process without channel opt-in. [Official Channels guide](https://code.claude.com/docs/en/channels)

Channel events use `notifications/claude/channel`. The host queues them in order and can deliver several busy-period events together. Writing the notification is not a processing acknowledgment; the application needs an explicit tool response to establish receipt. [Official protocol reference](https://code.claude.com/docs/en/channels-reference)

Whether startup opt-in is acceptable is pending owner clarification. Do not silently substitute restart/resume, another process sharing a conversation ID, or terminal keystroke injection for attachment to the current running process.

## Proposed application path to prove

```text
Existing Claude terminal session
    └── calls Ariadne MCP tools → session/topic/items saved → app displays them

Owner types against item in Ariadne
    └── Rust saves item-linked message + durable input
        └── that conversation's channel bridge observes the saved input
            └── sends channel event over its existing MCP connection
                └── Claude processes it in the existing conversation
                    └── receipt/reply/update tool calls → app reflects results
```

The app continues to use Rust services directly. Claude is the MCP client; its connected Ariadne server also acts as the inbound channel. The existing shared-store watcher can wake the bridge without a public HTTP endpoint. Ariadne need not own the terminal's stdin.

These application choices follow the clarified requirement:

- **Item message is a first-class operation.** An Open item can receive free text. This is independent of answering a Waiting item and does not automatically change its status. Persist owner message, item association and delivery input atomically.
- **Explicit conversation binding.** Route by a registered live connection/conversation binding, never by selected UI tab or project path alone. Two Claude terminals in one project must remain distinguishable. Binding creation and its trusted host identity source require an executable proof; the model cannot choose an arbitrary destination through tool arguments.
- **Durable application queue.** Save before notification; retain stable message IDs and sequence. Show saved/queued, notification written, agent receipt and handled outcome as distinct facts. Disconnect or missing acknowledgment must not be displayed as successful receipt.
- **One outstanding application work item when sequential handling is requested.** Release another item only after the previous item has an explicit handled response. Receipt alone is insufficient. Missing handled response stalls the application queue visibly; no timer invents completion or resends possibly consumed work.
- **No false host-turn promise.** A model's handled response is an application acknowledgment, not a host terminal-result event. Actual turn boundaries and ordering relative to messages typed directly in the terminal are controlled by Claude. The earlier managed worker's one-turn-per-submission contract does not transfer unchanged.
- **Replies are recorded through tools.** A reply must identify the triggering input and affected item; tree updates preserve provenance. An input can be handled without closing its item. Existing `apply` remains useful; item-message receipt/reply contracts need to be added for this mode.
- **Permissions stay in the terminal for the first proof.** An item comment cannot approve a tool. Channel permission relay is a separate optional surface, not a prerequisite for proving this message path.

## Next executable acceptance proof

The existing smoke test is retained as evidence for application-owned transport only. The required new test is:

1. Start an interactive Claude terminal with a custom Ariadne test channel explicitly enabled; verify registration rather than just MCP connection.
2. In that terminal, ask for a harmless fixture review and have Claude create a topic with seven items through tools.
3. From a separate process simulating Ariadne, save a comment against an Open item. Do not type another terminal message, resume the conversation or launch a second Claude process to deliver it.
4. Observe that exact running conversation acknowledge the input, answer with existing review context and update the correct item.
5. Repeat while Claude is busy; inspect grouping/order and explicit handled receipts. Submit several messages, and verify what is actually guaranteed.
6. Run two terminals against one project and prove destination isolation. Test disconnected channel, restart/reconnect and an acknowledgment lost after processing.

A startup-enabled proof does not establish attachment to a previously unconfigured process. A Claude Channels proof does not establish Codex parity. Record both limits rather than marking the communication architecture complete prematurely.

## Impact on the current planning package

This correction takes precedence over managed-launch-only acceptance, external manual-pickup acceptance, the claim that Channels are unnecessary for the primary workflow, and the assumption that the app can always observe provider turn results. Those portions require revision after the attachment prerequisite and live mechanism are established. Storage, atomic tree mutations, UI tree/detail behavior and provenance remain reusable.

**Status: clarified requirement and candidate mechanism; this workflow has not yet been proved.** No channel was installed/enabled and no additional model session was run while recording this correction. The earlier the review tool waiver still applies; organization guidance was not checked.
