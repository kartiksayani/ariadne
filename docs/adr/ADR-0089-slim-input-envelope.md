# ADR-0089: Slim per-input envelope; context is pulled, never pushed

Status: accepted (owner rulings, 2026-10-07)
Supersedes: none
Superseded by: none

## Context

Each dispatched owner input (`[ARIADNE_INPUT:<input>:<attempt>]` plus JSON) was
4.5-14 KB, up to about 3.5k tokens for a one-line answer. It repeated a fixed
instruction, the project and session IDs, the whole current topic and item, the
frozen target snapshot inside `saved_input`, the tool list and up to 16 KiB of
`recent_context` (the agent's own earlier replies). The owner: "otherwise using
Ariadne will be very expensive". The Codex setup instruction likewise inlined
the whole rule sheet (~2k words) although setup installs the Ariadne skill.

## Decision

- The work envelope carries only `source_input_id`, `attempt_id`, `binding_id`,
  `generation`, `owner_message_number`, `input_kind`, the target (`item_id` with
  the item's current `item_revision` and `question_revision`, or `topic_id` for a
  topic-level input such as `continue` or `topic_reply`), `selected_option_id` and
  `selected_option_label` when the owner picked an option, and `text`. A one-line
  answer is about 500 bytes including the marker. The `removed` and
  `result_repair` envelopes drop their instruction, project/session IDs and tools
  the same way and keep their own references.
- The fixed instructions move once into the shared rules (`integrations/rules/source.md`),
  generated into both skills. Context is a pull: the agent runs `ariadne read`
  once when its context is fresh (connect, `/clear`, `/compact`, an unknown item
  ID) and `ariadne item messages|rounds` for one item's history.
- Never ship a snapshot. Claim skips a queued item input whose saved
  `payload.target_snapshot.question_revision` is behind the item's current
  `question_revision` (`ariadne_core::delivery::held_for_review`). It stays
  `queued` with no attempt, does not block later inputs, and waits for the owner
  to review it (cancel and send again against the current question). No new state
  or field.
- The setup instruction is a short block: a line naming the Ariadne skill (and,
  for Codex, the installed rule sheet path as a fallback when present), the
  fresh-context pull, then Core's routing IDs and the exact helper commands.

## Consequences

- An agent that lost its context must run `ariadne read` before acting on an
  input; the skill says so.
- Owner messages written against a question the agent has since changed wait in
  the queue until the owner acts; the app must show why.
- Stored `Input.payload` is unchanged; only the formatted payload is smaller.

## Spec references

- [PROCESS: injected envelope](../planning/low-level/PROCESS_AND_PROTOCOLS.md)
- [API: removal notice envelope](../planning/low-level/API_AND_MCP.md)
- [ADR-0075: Claude rules in the skill](ADR-0075-claude-connect-output-and-skill-rules.md)
