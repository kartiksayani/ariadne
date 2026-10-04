# ADR0053: Native window lifecycle and registered open routes

Status: Accepted

## Decision

P6.1 uses the canonical `OpenRoute` and registered project/session membership for
CLI launch, second-instance delivery and renderer reveal. User-authored text and
filesystem paths are never routing authority. Single-instance registration runs
before other plugins. Native window actions run on the main thread.

The macOS single-instance plugin is navigation/convergence convenience, not
dispatch authority: notify/bind failures can permit another process to continue.
Owning runtime and watcher startup occurs only in application setup after the
first plugin intercepts ordinary second launches, and only after existing native
control ownership and physical binding leases succeed. A losing startup cannot
start its own workers or disturb the established socket, owner or external host.
Simultaneous cold-start packaged proof remains an acceptance requirement.

Trusted Rust startup supplies one `FnOnce` executed in Tauri setup after the
first-plugin interception. It returns owning shutdown/wake callbacks only after
existing control ownership succeeds; failure aborts setup. Unknown composition
keeps explicit Quit unsupported. Only startup that explicitly establishes no
owned runtime/watchers may permit diagnostic-only process exit, without claiming
runtime shutdown. Quit suppresses new geometry writes, joins the native writer,
and runs owning shutdown off the UI thread before allowing exit. An unconfirmed
preference operation or failed shutdown keeps the process running. Wake is
coalesced and serialized with shutdown; it cannot acquire another owner.

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
to `/usr/bin/open -n -a <app_path> --args --ariadne-route <OpenRoute JSON>`.
Each value is a separate argument, including paths with spaces. There is no app
scan or guessed fallback. Only `current` is constrained to the exact versioned
directory; the manifest may locate the installed app in `~/Applications`.
P6.4 writes this same descriptor and may extend its owned-file inventory for
uninstall. Unknown non-routing fields are ignored within v1; required fields,
duplicate known fields and unsupported schema versions remain strict.

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
