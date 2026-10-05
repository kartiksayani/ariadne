# ADR-0062: Publish contained personal packages through one pointer

Status: Accepted

## Decision

P6.4 stages the release app, CLI, MCP and canonical integration bundle together
under `~/.local/share/ariadne/versions/<version>`. The real app lives there;
`~/Applications/Ariadne.app` is an owned relative symlink through `current`.
The existing v1 `install.json` still supplies its stable absolute app path,
matching version and schema. Atomically replacing the exact contained `current`
symlink switches the app and helpers together. Different same-version bytes,
foreign install targets and edited existing package contents are refused.

The descriptor extends v1 with a canonical inventory format: contained relative
file paths with SHA-256 and modes, application-contained relative symlinks, and
only the three fixed external install links and originally staged directories.
Unsupported or malformed ownership inventory cannot authorize removal. An
unchanged installed helper supplies the canonical integration names through its
read-only exporter; an edited/missing helper preserves the entire package.
Uninstall compares bytes/modes and retains no-follow directory descriptors from
the complete home ancestor chain through each validated package. File removal,
directory removal, descriptor cleanup and failed-publication cleanup use those
handles, so a later pathname/ancestor symlink swap cannot redirect deletion.
Modified files, unknown
files and nonempty directories survive. Session history and host settings are
outside this inventory. The stable install lock remains as coordination state.

The installer is Python build/install tooling; Python and Node are not bundled
with production. `package-resources --helper-path` is a read-only CLI build seam
over the existing `setup::resources::bundle`, avoiding a second Mod/rules
inventory or renderer. It validates the future absolute normalized helper path
and returns versioned UTF-8 JSON. Installation consumes bounded output and
renders resources against the final immutable version path before publication.

`make install` records macOS/architecture and pinned toolchain preflight, checks
generated artifacts, uses locked dependencies and ordinary release features,
then runs the installed read-only doctor. It never installs toolchains/providers,
uses sudo, edits shell profiles or performs host registration/trust. Rust
preflight uses `rustup run` without `--install` to inspect only an existing pin;
all build children select that pin with automatic Rustup installation disabled.
Missing toolchains/components require an explicit owner setup action. Failure
before pointer publication preserves the previous install and cleans only the
new attempt's paths. This is a personal unsigned source install, not a public
distribution or a general deployment/rollback framework.

## Acceptance boundary

Temporary-home fixtures prove ownership, repeat/upgrade identity, failure
preservation and symlink/race containment, with measured installer coverage.
Release CI reuses its already-built production app, builds matching release
helpers and validates install/repeat/doctor/uninstall in an isolated home. The
existing native WebView and packaged isolation checks remain required. Neither
fixtures nor an unrun CI command claim packaged or live-host acceptance.

MCP/the review tool remain disabled under the current-session owner waiver. Organization
security guidance was not checked; no organizational approval is claimed.
