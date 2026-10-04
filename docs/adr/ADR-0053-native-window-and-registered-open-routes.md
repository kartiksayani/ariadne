# ADR0053: Native window lifecycle and registered open routes

Status: Accepted

## Decision

P6.1 uses the canonical `OpenRoute` and registered project/session membership for
CLI launch, second-instance delivery and renderer reveal. User-authored text and
filesystem paths are never routing authority. Single-instance registration runs
before other plugins. Native window actions run on the main thread.

Before the main webview acknowledges readiness after subscribing to the route
event, retain the latest valid explicit route. Another valid route supersedes
that navigation intent; an invalid or unregistered route cannot erase it. This
coalesces navigation only, without dropping durable work. The ordinary renderer
continues to use its existing registered reveal and missing-item behavior.

The package owns one install descriptor at
`~/.local/share/ariadne/current/install.json`. Version 1 contains
`schema_version: 1`, `version` and absolute `app_path`. Resolve `current` only
inside the existing `versions/<version>` directory, require helper/version
agreement and bounded validated manifest input, and pass structured arguments
to `/usr/bin/open`. There is no app scan or guessed fallback. P6.4 writes this
same descriptor and may extend its owned-file inventory for uninstall.

Window geometry and pin use canonical revision-checked global preferences,
preserving unrelated preferences. Display reconciliation clamps the whole
window to a current native work area. Hide-on-close preserves the app; Quit
uses the trusted owning-runtime shutdown callback and never terminates an
external host. Wake uses the trusted reconciliation callback and cannot infer
idle state, clear owner pauses or resend uncertain work.

## Acceptance boundary

Temporary package fixtures and focused native routing tests prove the module
contract. A missing lifecycle composition cannot report successful runtime
shutdown or wake reconciliation. Recorded packaged macOS hidden/minimized/cold
launch, monitor change, wake, pin and path-with-spaces acceptance remains
required for full P6.1 completion; no temporary renderer or alternate resolver
substitutes for that proof.
