# ADR-0085: Host location is a display label from the agent's terminal environment

Status: accepted (2026-10-07).
Supersedes: none
Superseded by: none

## Context

The redesigned session bar reads "claude-code · running · iTerm window 1" and the
empty state "… in iTerm". Ariadne did not record where the agent runs. Session cards
also say "3 topics", and `SessionSummary` had no topic count. Reading window titles
through AppleScript or OS calls would need permissions and couples Ariadne to one
terminal.

## Decision

- **`Binding.host_location: Option<String>`.** A trimmed one-line label of at most
  60 characters, cut at the first control character. Serde default and omitted when
  absent, so older stores load and re-serialize unchanged. Stored-session validation
  rejects a hand-edited label that is blank, untrimmed, multi-line, has control
  characters or is over 60 characters. `BindingSummary` carries
  the same field (`host_location?: string | null` in TypeScript).
- **Parsed from the agent-side environment only.** `ariadne_agent_protocol::host_location`
  maps `TERM_PROGRAM`: `iTerm.app` → "iTerm", `Apple_Terminal` → "Terminal",
  `vscode` → "VS Code", `WarpTerminal` → "Warp", anything else verbatim. For iTerm
  the window comes from `ITERM_SESSION_ID` (`w0t1p0:…` → "iTerm window 1", 1-based);
  a malformed id gives plain "iTerm". No AppleScript, no OS calls.
- **Claude: the helper fills it.** `ariadne bridge announce` runs inside Claude Code
  and inherits its terminal environment, so it adds `host_location` to the
  announcement when the Mod sent none. Discovery normalizes it at intake and drops an
  unusable label rather than refusing the announcement. Qualification copies it into
  `VerifiedHost`, which core validates and writes on connect and on reconnect.
- **Codex: none.** The desktop qualifies a Codex thread through the Codex daemon; no
  agent-side process reports its terminal on that path, so `host_location` stays
  `None`.
- **Not on the agent wire.** `bridge connection-status` keeps its earlier keys
  (`host_location` is never set there), because the Mod checks the exact key set.
- **`SessionSummary.topic_count`.** Every topic in the session, archived included;
  `counts.archived_topics` is the archived subset. Computed next to the other
  session counts in `queries/counts.rs`. Required on the wire: summaries are
  computed, never stored.

## Consequences

- The label is display text and grants nothing. A stale label stays until the next
  connect or reconnect; re-announcements (heartbeats) do not rewrite the store.
- A reconnect whose announcement carries no `host_location` clears the stored label
  to `None` rather than keeping the old one.
- A newer helper announcing to an older app is rejected, because `SessionAnnouncement`
  is `deny_unknown_fields`; helper and app versions must match, as the bundle already
  requires.
- Inside a terminal multiplexer the label is whatever `TERM_PROGRAM` the agent
  process sees, shown verbatim.
- Codex sessions show no location until a Codex-side source exists.

## Not verified

- A live Claude Code session in iTerm showing its window number. Unit tests cover
  the parser, intake normalization, the helper's environment read and core's
  connect and reconnect writes.

## Spec references

- [Domain and storage: Binding and presence](../planning/low-level/DOMAIN_AND_STORAGE.md)
- [API and MCP: summaries](../planning/low-level/API_AND_MCP.md)
- [ADR-0042](ADR-0042-native-discovery-and-announcement-intake.md)
