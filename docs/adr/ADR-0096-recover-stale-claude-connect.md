# ADR-0096: Recover stale Claude connect state

Status: accepted (2026-10-09)
Amends: ADR-0035, ADR-0051 and the Claude live-conversation exception in ADR-0088

## Context

A resumed Claude process can keep an unconfirmed claim after the desktop loses
its dispatch route. A pending connect for another session also blocked the owner
after reloading the plugin. Neither state explained how to reconnect safely.

## Decision

Before an explicit connect, close claim admission, drain admitted work and retry
an unconfirmed claim with its original request ID. If only that unconfirmed
request remains, query the desktop's scoped connection status. A missing or
obsolete route, or Disconnected status, permits retiring the local request.
Active turns, captured payloads, detached submissions and unsaved reports still
block rotation. Losing a route does not establish absence of delivery.

Add `binding connect --replay-only --json-stdin` as a narrow CLI projection of
the existing exact saved-connect replay. It returns a validated receipt or null
without initiating provider qualification or a new connection. A saved hit may
refresh the rebuildable index; it does not change the saved session.

The plugin checks a pending connect's saved receipt and, when present, the
desktop's current scoped status before deciding to reuse it. A changed session
selection or Claude conversation, or a removed, obsolete or disconnected route,
discards that obsolete connect request and begins a fresh operation. A not-found
route alone may mean activation is still pending: an unchanged request keeps its
exact body and operation ID and republishes the same saved scope. An unchanged
request without a receipt also retains its exact body and operation ID. An unreachable
desktop, invalid receipt or uncertain lookup retains recovery state.

A missing receipt is only a snapshot: an earlier native call may commit after
its caller times out (ADR-0048). Registry and session locks, exact receipt replay,
host-route uniqueness and the live-conversation guard remain authoritative for
competing requests. Recovery never claims rollback or automatically resends work.
If host-route uniqueness refuses moving an already-saved Claude conversation to
another Ariadne session, explain how to use a new Claude conversation instead;
disconnecting alone does not release its saved session association. A live
conversation already occupying the chosen session must still disconnect first.
Core's existing reconnect/rebind transaction keeps never-sent messages queued in
FIFO order and preserves potentially sent messages as needing owner attention.

A different host identity cannot replace a Claude conversation unless its saved
connection state is Disconnected, including a paused conversation or one whose
presence is Unknown or Reconnecting. Native qualification initially saves Unknown
even for a live announced conversation; it cannot establish permission to replace
it. The old conversation must disconnect first. Same-identity reconnect remains
allowed; `/clear` reports
the old conversation's end before connecting the new one. Other adapters keep
their existing replacement rules.

Owner command output and notices use plain sentences with a next step. Only an
unreachable desktop asks the owner to open the app. Exact operation IDs stay in
the plugin's bounded local `connect-log` diagnostic records and canonical helper
requests; they are absent from owner output. Claude receives required routing
through the existing internal conversation note rather than the command summary.

## Validation

Node hook tests cover lost desktop routes, disconnected and replaced connections,
changed pending session selection, receipt lookup, exact timeout retry, live-session
refusal and closed-app guidance. Existing plugin tests retain lifecycle/report and
publication coverage. Production CLI tests cover replay-only hits, misses and
conflicts. Core tests prove atomic live-Claude refusal and preservation of queued
messages and uncertain attempts after disconnect and rebind.
