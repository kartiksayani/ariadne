# ADR0061: Native Waiting observation and notification ledger

Status: Accepted; implementation awaits integrated native acceptance.

## Decision

Native Waiting consumes the canonical registered catalogue, `SummaryCounts`,
validated session snapshots and core unanswered predicate. It shares global
Waiting's archived-topic exclusion and waiting-time/project/session/item order.
The tray shows the authoritative count, oldest ten rows and an incomplete marker;
binding and owning lifecycle diagnostics remain separate. One owned feed listens
to existing watcher/owner revision hints and reconciliation, with 250 ms tray
coalescing. It does not introduce another scanner or runtime manager.

Global preferences gain a typed notification ledger, bounded to 256 episode
identities (`SessionRef`, item ID, question revision), and an opt-in preview flag.
Episode identity follows the domain contract; waiting time is ordering evidence.
Missing ledger/preview fields default to empty/false and those defaults serialize
without new fields, preserving historical normalized preference operation digests.
Existing revision-checked atomic preferences remain the sole durable authority.

The first complete revision-consistent catalogue establishes a watermark without
announcing its backlog. Initial partial catalogues leave notifications unavailable
while the tray and in-app queue remain usable. After that baseline, partial
captures can observe new episodes while ledger capacity remains. Capacity pressure
pauses notifications rather than silently evicting entries and redelivering them.
Only a complete capture advances the watermark and compacts older identities.
Identities at the watermark remain retained to dedupe timestamp ties.

The owning feed confirms its canonical preferences patch before scheduling new
arrivals. Notifications are a best-effort aid; this adds no notification delivery
transaction or journal and never changes durable Waiting membership. Scheduling
errors and denied permission leave in-app answering usable. Native permission is
an explicit owner action. One long-lived objc2 delegate owns permission,
schedule/remove, foreground policy and clicks through the existing registered
`NativeRoutes::open` route. More than three arrivals within a fixed 500 ms window
produce one generic summary linked to the first arrival; every question remains
in the canonical queue. Previews are rechecked at scheduling and default to generic
content on a failed preference read. Complete captures remove resolved pending
bursts and reconcile native notification identifiers; partial captures never infer
absence in an inaccessible root.

The aggregate page revision is the registry revision, so unchanged counts and
registry revision alone cannot prove a consistent capture. The feed rechecks the
complete session inventory and each session revision after loading snapshots.
This uses existing registered queries and retains the last valid tray on failure.

The delegate is installed synchronously during setup for cold-launch callbacks.
Its retained Objective-C object stays in one main-thread-local slot; the feed
reacquires its own center handle and no unsafe Send/Sync bridge is introduced.
Shutdown fences callbacks before joining the owned feed and queues main-thread
delegate teardown afterward. Failures leave callbacks inactive and preserve any
unconfirmed preferences operation for an exact retry. Inactive callbacks still
invoke the required UserNotifications completion handlers.

Composition can replace a bounded lifecycle diagnostic snapshot through the
same coalesced feed. It remains a display of existing owned outcomes, not a second
recovery authority or an append-only log. Truncation is visible; late publication
after stop is ignored.

## Checkpoint and acceptance

Capture, projection/coalescing, notification policy, exact-operation preference
writer, burst grouping and bounded diagnostic replacement have focused source
tests. The native menu/feed/delegate and explicit permission command are implemented;
Rust-derived schema and TypeScript contracts are regenerated. Desktop composition
owns startup, watcher/fallback/focus refresh, lifecycle diagnostics and shutdown
wiring. This implementation checkpoint is not packaged P6.2 completion.
Packaged permission/denial, foreground/hidden/cold and already-answered click,
tray parity and native/release acceptance remain pending; no app, external host
or actual notification permission was exercised for this checkpoint.
