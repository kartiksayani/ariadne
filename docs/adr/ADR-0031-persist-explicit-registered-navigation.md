# ADR 0031: Persist explicit registered navigation

Status: accepted

P4.2 publishes reusable Projects, project detail, All sessions and opened-session
navigation against the canonical renderer service. It consumes complete cursor
captures and backend counts, including registered unavailable roots whose
Project metadata is null. Failed captures preserve the last complete view.

GlobalPreferences gains required `selected_navigation`, a strict tagged
NavigationSelection union of projects, all_sessions, project ID and SessionRef.
SessionPreferences gains required `tab_open`. The existing revision-checked
SetGlobal/SetSessionView entries persist these fields. Closing a tab preserves
all other view settings and drafts and never invokes session/binding lifecycle.
No production preferences writer or userdata version exists yet, so current
schemas/fixtures change directly without defaults or migration machinery.

Composition owns the injected NavigationStore lifetime and disposes it explicitly;
React views subscribe to it and may mount/remount without stopping that shared
store. Subscriptions precede initial reads; focus/wake and two-second polling
reconcile missed hints. Only final complete pages replace a catalogue. Explicit
unknown-completion reconciliation uses the exact retained mutation and operation
ID, while canonical typed rejections remain actionable.

Manual binding receives typed installed-adapter presentation choices from trusted
composition, with canonical AdapterConfig rather than a renderer JSON editor or
new discovery DTO. These inputs confer no authority: core validates the explicit
external ID, typed endpoint, registered project and optional existing session.
The owner visibly chooses new versus existing Ariadne session. A successful
receipt supplies setup instruction/capabilities; current BindingSummary supplies
dispatch/connection facts. Preserved Ariadne history is distinct from old host
memory. The historical owner-context grant and Mod resume instruction are a
separate backend follow-up, which must also prove future-input isolation.

This early implementation does not switch the normal App or satisfy the native
core/store/runtime, durable preferences, discovery and full-navigation acceptance
joins. Ordinary uncomposed commands continue to return canonical Unsupported;
scripted transports belong only to tests, with no production fake fallback.
