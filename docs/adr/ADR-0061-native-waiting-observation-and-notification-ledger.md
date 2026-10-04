# ADR0061: Native Waiting observation and notification ledger

Status: Accepted; native integration remains pending P6.2.

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
an explicit owner action. One long-lived objc2 delegate will own permission,
schedule/remove, foreground policy and clicks through the existing registered
`NativeRoutes::open` route; bursts over three arrivals within 500 ms remain required.

## Checkpoint and acceptance

The pure capture, tray projection/coalescer and notification observation policy
have focused source tests. At the owner-requested pause, native menu installation,
owned feed, canonical preference writer, burst scheduler, delegate, explicit
permission command and startup wiring are unfinished. Generated contracts also
require regeneration before publication. This checkpoint is not P6.2 completion.
Packaged permission/denial, foreground/hidden/cold and already-answered click,
tray parity and native/release acceptance remain pending; no app, external host
or actual notification permission was exercised for this checkpoint.
