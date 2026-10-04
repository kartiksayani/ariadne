# ADR-0058: Keep integration ownership explicit and doctor strictly read-only

Status: Accepted

## Context

P6.3 installs integration resources and diagnoses an existing personal installation.
Registry/Store's ordinary reads may create permanent coordination files. Those
reads cannot satisfy doctor's promise to create no files or directories.
Provider adapters already own bounded version and socket qualification.

## Decision

Setup consumes the validated installed version root, embeds the canonical generated
rules and fixed Claude Mod inventory, and renders a static descriptor pointing to
that immutable version's helper. It creates missing selected resources, preserves
matching unowned resources and refuses different same-version bytes. A small
canonical ownership receipt records only the files setup creates. Uninstall removes
only unchanged owned files; edited/nonregular resources, all project/session/backup
data and foreign settings survive. Stable coordination files remain. Host marketplace,
installation, trust, reload and connection actions remain explicit host commands.
Global setup does not infer a project; only `--project` invokes registration.

Store exposes its existing anchored directory helper with component validation,
bounded streaming reads and unchanged-file removal under the integration lock.
Private unbounded reads stay private. Additive Registry/Store diagnostic APIs open
only existing coordination state, use the existing two-second lock bound and reuse
the canonical schema, identity, invariant and route-uniqueness validators. Missing
or busy locks produce unknown observations. Index comparison requires complete
authoritative observations; it never rebuilds or repairs data and is not an atomic
global readiness guarantee. No Store lock spans provider or control I/O.

Doctor accepts explicit absolute `--claude-bin` and `--codex-bin` paths. Without
trusted selection it reports unknown. Provider-owned version readers reuse their
existing executable identity, output limits and original deadline/maximum five-second
budget. Codex retains its exact qualified version gate and existing read-only daemon
and selected-thread APIs. Current native control status supplies timestamped binding
presence without claiming input. Version strings and matching files alone never
establish a loaded Mod, current host readiness or permission to dispatch.

## Consequences

No installation journal, rollback framework, host configuration crawl, duplicated
provider probe or new diagnostic state machine is introduced. Setup errors may
leave explicitly reported partial resource creation; no rollback is claimed.
Doctor omits credentials, environment dumps, domain bodies and raw host payloads.
P6.4 owns app/helper packaging and version-pointer publication; packaged/native and
live existing-host acceptance remain their original task joins.

MCP/Seezo remain disabled under the current-session owner waiver. Organization
security guidance was not checked; no organizational approval is claimed.

See [SETUP §§3,6,8](../planning/low-level/SETUP_AND_DELIVERY.md),
[ADR-0037](ADR-0037-claude-native-compatibility-and-normalization.md), and
[MODULE_CONTRACTS](../planning/MODULE_CONTRACTS.md#implementation-prerequisites-and-acceptance-joins).
