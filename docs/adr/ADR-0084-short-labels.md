# ADR-0084: Agent-written short labels on items and topics

Status: accepted (2026-10-07).
Supersedes: none
Superseded by: none

## Context

The owner's UI redesign shows a 2-4 word label per item and topic: the graph node
title and the breadcrumb path ("SDK cache PR › test fixtures › fallback-merge
test"). Item questions and topic names are full sentences, too long for either.
Deriving a label in the UI would truncate mid-thought; the agent knows what the
item is about, so it should write the label.

## Decision

- `Topic` and `Item` gain `short: Option<String>`. `ItemSnapshot` (the items
  query view) carries it too. The field is `#[serde(default)]` and omitted from
  JSON when absent, so stores written before it load unchanged and an unlabelled
  record re-serializes to the same bytes. Generated TypeScript is
  `short?: string | null`.
- A label is trimmed on write and must then be nonblank, one line (no `\n` or
  `\r`) and at most 40 Unicode characters. Stored labels are checked again by
  `validate_session_items`. Failures use the existing `ValidationError`, with two
  new kinds, `TooManyChars { maximum_chars }` and `Multiline`; an untrimmed stored
  label is `InvalidState`. On the apply wire a bad label is `invalid_argument`.
- Agent writes: `topic.add` and `item.add` take an optional `short` (absent or
  null stores no label). `item.edit.patch.short` follows the `note` rule: absent
  keeps the label, `null` clears it, a string replaces it. An explicit `""` is
  rejected as blank rather than read as a clear, so clearing is always the
  deliberate `null`.
- There is no topic rename operation and no owner-side item or topic edit, so
  nothing else accepts `short`. A topic's label is set at `topic.add` only.
- The shared rules tell agents to give every topic and item they create a `short`
  noun phrase and keep it stable; every `topic.add`/`item.add` example carries one
  and one example labels an older item through `item.edit`.

## Consequences

- Items and topics created before this, or by agents that ignore the rule, have
  no label; the UI must fall back to the question or name.
- An older topic cannot be labelled until a topic edit operation exists.
- The JSON Schema's `maxLength: 40` is guidance for MCP clients; the real bound
  is measured after trimming, so a padded label longer than 40 characters still
  passes core validation.

## Spec references

- [Domain and storage: Topic and item](../planning/low-level/DOMAIN_AND_STORAGE.md)
- [API and MCP: apply operations](../planning/low-level/API_AND_MCP.md)
- [Shared agent rules](../../integrations/rules/source.md)
