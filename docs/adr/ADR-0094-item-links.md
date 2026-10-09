# ADR-0094: Related items

Status: accepted (2026-10-09)

## Context

The owner needs to see when a finding, decision or task connects to another item,
without filling the graph with every connection. Existing inline item links remain
useful references in prose.

## Decision

- Add optional `Item.related: ItemRef[]`, stored on the declaring item. There is
  one meaning, **related**, shown in both directions within the same session,
  including across topics. Missing fields stay absent when serialized; loading
  old data does not write or migrate it.
- Following [ADR-0092](ADR-0092-lenient-apply-in-the-cli.md), the CLI accepts item
  number strings such as `"3.2"` and local ref strings such as `"decision"`,
  alongside `{id}` and in-batch `{ref}` objects.
  Strict add/edit contracts accept reference objects and validate existing targets
  in the current session. Self-links and duplicate resolved targets are rejected
  with a plain error. Each item may declare at most 32 related targets; the CLI
  checks every original list before expansion, including superseded assignments,
  and strict core and domain validation enforce the same cap.
  Omitted/null related patches keep the list; `[]` clears it.
- Strict refs retain sequential allocation. The CLI expands nested children and
  forward related refs into an add followed by an edit after the targets are
  allocated. Later explicit related edits take precedence; expansion precedes
  deterministic operation-ID generation and normal atomic core validation.
- Removal tolerates dangling declarations rather than rewriting other items.
  Persisted missing targets do not invalidate a session. Reads and the UI expose
  only live targets. An explicit resend of a declaration already containing a
  removed target is accepted; the next related-list write prunes it and returns
  `pruned_related` in the saved receipt and compact summary, mapping declaring
  item numbers to removed target numbers. A newly introduced missing target is
  refused with the operation and offending id, display number or local ref.
  Continuation remaps links between copied items and drops targets outside the
  copied set, so destination numbers cannot accidentally point to unrelated items.
- Detail lists outgoing links and backlinks once, with number, label and status.
  Hidden targets remain listed with a hidden note; opening uses existing reveal
  and navigation history. Graph links are dashed, under parent edges, only for
  the selected item and available drawn targets. Inline `[label](item:3.2)` links
  remain independent references and do not automatically declare relations.
- Agents declare a relation only when it helps the owner understand a dependency,
  duplication or consequence, never by default.

## Consequences

Links carry no separate kind, direction, status or deletion policy. A removed
target can remain in saved history without blocking reads or unrelated edits;
rewriting its declaring list removes it with a visible receipt.
The field is additive, keeping the parallel acknowledgement change independent.

## References

- [Domain and storage](../planning/low-level/DOMAIN_AND_STORAGE.md)
- [Agent API](../planning/low-level/API_AND_MCP.md)
- [Agent rules](../../integrations/rules/source.md)
