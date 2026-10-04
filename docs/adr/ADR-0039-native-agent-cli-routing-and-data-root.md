# ADR-0039: Route agent CLI tools through retained native bindings

Status: Accepted

The installed agent CLI needs the actual bounded query and atomic apply services.
Their trusted native contexts are not renderer or tool parameters. A selected-host
index alone also cannot resolve exact saved Apply retries after a deliberate rebind.

`ariadne read`, `item messages`, `item rounds` and `apply` construct the existing
typed agent tool requests and call `QueryService` or `ApplyService` directly. They
do not introduce an incomplete `CoreService` implementation, alternate persistence,
operation semantics, owner routes or an implicit current session. Full typed stdin
parameters preserve filters, outer/nested cursors, source pairs, revision guards,
exact text and operation IDs. JSON mode writes one canonical application envelope;
text errors use stderr and the canonical error code controls the exit status.

Native routing scans current authoritative registered project/session snapshots,
including inactive historical binding IDs. Duplicate retained IDs or unavailable
registered data prevent an ambiguous resolution. Catalogue locks are released
before calling the core service. The supplied generation is forwarded unchanged;
the resolver does not reject a sealed, inactive or superseded route before Apply's
locked exact receipt replay. New effects still pass all existing core guards.

The terminal read ceiling is the binding's persisted issued watermark. Dispatched
scope requires the exact retained binding/input/attempt and source owner message;
its ceiling is at most both source issuance and persisted binding issuance. These
facts come from the snapshot, never CLI actor, ceiling or path flags. Core rereads
and checks them authoritatively. Historical read permission grants no new write,
claim, lease or retry authority.

CLI and bridge share `ARIADNE_HOME`, meaning the application data directory, with
default `HOME/.ariadne`. `Registry::open_data_directory` opens that existing private
directory relative to a canonical parent with the existing nofollow/owner/mode
checks. It creates no nested `.ariadne` or alternate root. `Registry::open(home)`
retains its existing owner-home setup behavior. This task implements agent commands;
owner/bootstrap commands, MCP and production bridge delivery composition remain
their separately owned tasks.
