# ADR-0086: Paperwhite is the desktop design, gated by a pixel harness against the handoff

Status: accepted (2026-10-07).
Supersedes: none
Superseded by: none

## Context

P8.3 asked for a UX review and theme refresh. The owner then supplied a complete v2
design handoff (`designs/Ariadne-UI-mockups-v2.zip`): a written spec (`README.md`), a
running prototype (`Ariadne.dc.html`), component pages and rendered frames 1a-1ad. It
replaces the Nocturne look and the earlier per-screen restyling. Restyling the old
components could not reach the handoff's layout, states and keyboard model. Reviews
by eye also missed the drift between the app and the frames.

## Decision

- **Port the handoff, not a restyle.** A new presentation layer under
  `apps/desktop/src/ui/` reproduces the prototype's DOM and inline-style values as CSS
  classes. The views are shell, tree, graph, detail, Waiting on me, message rail,
  pages and dialogs. Data, stores and core commands are unchanged; components that
  are still needed (bindings, history actions, recovery) are kept and restyled.
- **Paperwhite tokens verbatim.** Dark is the default and light the alternative. The
  status colours come from the prototype's `THEMES`, and `--a-danger` is used only
  for Remove. Every Nocturne value is gone.
- **One font and one icon set.** JetBrains Mono 400/500 for all text, bundled locally.
  Phosphor regular and fill icons, as before.
- **The handoff's numbers.** Rows are 48/38/1fr/30. Columns are `300px |
  minmax(560px,1fr) | [400px detail] | [240px rail]`. The target is 1600×960 and the
  window minimum is 1300×760.
- **One keymap.** `ui/keys.ts` implements the README keyboard table, and every view
  reads it.
- **One agent connection.** `ui/shared/connection.ts` maps a binding and its presence
  to connected, reconnecting, not running or none. A stale host on a connected
  binding reads as Reconnecting (frame 1o): the agent still runs and sending waits.
  The header, session bar, detail, Waiting cards and submit all use this one value.
- **The design harness is the fidelity gate.** `npm run test:design` renders each
  handoff frame from the prototype and the same state from the app with fixtures
  (`tests/ui/design/`), then compares the pixels. Each frame has a threshold in
  `thresholds.json`, set to its measured ratio + 0.01. Harness states that are not on
  the board, such as `1b-hover` and `1b-hover-selected`, draw another frame's card
  and put both pages in the same state.

## Consequences

- Any layout or colour regression of more than one percent of a frame's pixels
  fails `test:design`. A threshold may go up only with a stated reason.
- Native specs select the Paperwhite DOM through stable markers
  (`data-owner-input`, `data-message-id`, `data-item-id`, `data-session-card`).
  The old history view switch and owner input no longer exist.
- The detail panel summarises each round (the ask, the choice or reply, and the
  result) and shows the item's own messages in its Timeline. A round's full option
  list and the former `why` of a reopened item are no longer displayed.
- Frames still above 0.02 are listed in the P8.3 finish PR with their causes. The
  largest is 1m, where the app keeps its recovery panel above the tree.

## Spec references

- [UI and native](../planning/low-level/UI_AND_NATIVE.md)
- [Native E2E](../planning/low-level/NATIVE_E2E.md)
