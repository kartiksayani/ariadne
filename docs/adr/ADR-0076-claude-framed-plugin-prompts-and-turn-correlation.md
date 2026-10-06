# ADR-0076: Submit Claude inputs as the owner and accept host-framed prompts

Status: accepted (2026-10-06).
Supersedes: none
Superseded by: none

## Context

Claude Code 2.1.291 frames a prompt submitted with `$.prompt.submit({text})` as:

```
The <plugin> plugin sent a message:
<text>
This is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.
```

Mid-turn, the first line reads "…sent a message while you were working:". The Mod
required `turn.start.text === formatted_payload` (`integrations/claude/plugin/hooks/claims.js`),
so the framed text never matched. The turn was not correlated and the input stayed
`in_flight`, although Claude committed the result. Live evidence (P7.2, 2026-10-06):
input d4fd3962, attempt 32e50360, result committed 11:28:22Z, `turn_state: unknown`.

## Decision

- The Mod submits with `asUser: true`. The Claude Mod API docs
  (https://code.claude.com/docs/en/plugins/mods/api.md) say: "Claude reads the text
  after a sentence that names your mod as the sender. To send it as the user's own
  words, without that sentence, add `asUser: true`."
- `carried()` in `claims.js` also accepts the payload embedded as whole lines inside
  host framing, so a host that still wraps the text correlates the turn.
- The whole-text digest check is dropped. `prepared()` already verifies the payload
  digest at claim time, so the turn check only needs to find the payload.

Observed form on 2.1.291: not yet recorded. The Mod logs one terminal-only line
`Ariadne: turn.start carried the exact|framed payload (N chars)` per loop; the owner
has not pasted it. Both forms correlate, so the decision does not depend on it.

## Consequences

- Inputs reach Claude as the owner's own words and the turn correlates on 2.1.291.
- A host that changes its framing wording still correlates while the payload stays
  whole lines.
- A turn carrying the payload plus extra text is now accepted; the claim-time digest
  is the integrity control.
- An attempt with a committed result and unknown turn state can only be sealed by
  `skip` or `resend` today (follow-up in HANDOFF).

## Related

Two sibling Mod fixes from the same run:

- `published()` wait in `hooks/setup.js` (commit 1a5077e): the app publishes the
  binding route after the bound announce and reconciliation, and status reports
  `not_found` until then. The Mod now waits for the route.
- Owner-paused claims return `invalid_transition` and were logged every second as a
  helper failure. They are now logged once per block reason (commit c924217).

## Spec references

- [Claude Code adapter](../planning/low-level/PROCESS_AND_PROTOCOLS.md#3-claude-code-21287-adapter)
- [Verification matrix](../planning/low-level/VERIFICATION.md#required-acceptance-matrix)
