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
block rotation. Recheck this evidence after status lookup and immediately before
removing the loop, since session end and late turn callbacks can arrive across
either wait. Keep a recovered loop reachable until its reports drain. Losing a
route does not establish absence of delivery.

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
request without a receipt also retains its exact body and operation ID. A failed
receipt lookup also permits discarding a changed request: a removed session may
produce a store I/O error, and Core fences competing requests regardless of the
lookup outcome. An unchanged request retains recovery state on failed lookup.
Invalid saved receipts still refuse connection.

A missing receipt is only a snapshot: an earlier native call may commit after
its caller times out (ADR-0048). Registry and session locks, exact receipt replay,
host-route uniqueness and the live-conversation guard remain authoritative for
competing requests. Recovery never claims rollback or automatically resends work.
If host-route uniqueness refuses moving an already-saved Claude conversation to
another Ariadne session, explain how to reconnect to the session chosen earlier
by copying it in Ariadne and using that selection with `/ariadne-connect`, or use
a new Claude conversation for a different Ariadne session;
disconnecting alone does not release its saved session association. A live
conversation already occupying the chosen session must still disconnect first.
Core's existing reconnect/rebind transaction keeps never-sent messages queued in
FIFO order and preserves potentially sent messages as needing owner attention.

A different Claude conversation cannot replace the current one unless its saved
connection state is Disconnected, including a paused conversation or one whose
presence is Unknown or Reconnecting. Native qualification initially saves Unknown
even for a live announced conversation; it cannot establish permission to replace
it. The old conversation must disconnect first. For this guard, the adapter and
external conversation ID establish the same conversation; the endpoint fingerprint
does not. Helper, plugin and Claude updates change that fingerprint without ending
the conversation. Exact host identity still controls route reuse; a changed
fingerprint uses the existing rebind transaction. Same-conversation reconnect
remains allowed; `/clear` reports the old conversation's end before connecting the
new one. Other adapters keep their existing replacement rules.

Retiring an unconfirmed claim also clears its stopped loop from the plugin's
current and pending loop slots, preserving the remembered session so heartbeats
can reconnect after a later connect failure. If recovery status was reachable,
or connect already returned its saved receipt, a later control timeout asks the
owner to run `/ariadne-connect` again rather than describing the app as closed.

Owner command output and notices use plain sentences with a next step. Status
before connecting asks the owner to connect. Only an unreachable desktop asks the
owner to open the app. Exact operation IDs stay in the plugin's bounded local
`connect-log` diagnostic records and canonical helper
requests; they are absent from owner output. Claude receives required routing
through the existing internal conversation note rather than the command summary.
Explicit connect notes describe the owner's request; automatic reconnect notes
describe the plugin reconnecting by itself.

## Validation

Node hook tests cover lost desktop routes, disconnected and replaced connections,
changed pending session selection, receipt lookup, exact timeout retry, live-session
refusal, removed-session lookup, late commits, heartbeat recovery after control
timeouts, explicit routing notes and closed-app guidance. Existing plugin tests
retain lifecycle/report and publication coverage. Deferred-status tests preserve
unsaved session-end and late terminal reports through recovery. Production CLI
tests cover replay-only hits, misses and conflicts. Core tests prove atomic
live-Claude refusal and preservation of queued
messages and uncertain attempts after disconnect and rebind. Core tests also prove
same-conversation reconnect after a fingerprint change and non-Claude live
same-adapter replacement with pending work.
