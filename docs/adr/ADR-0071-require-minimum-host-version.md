# ADR-0071: Require a minimum host version; accept newer versions as untested

Status: accepted. Revised 2026-10-06 on the owner's decision: "not a good idea
pinning exact version; minimum required version is fine". The first revision
accepted only a newer patch of the same major.minor; this revision accepts any
version at or above the baseline.
Supersedes: the exact-equality host-version clauses of
[ADR-0035](ADR-0035-captured-claude-mod-lifecycle.md),
[ADR-0037](ADR-0037-claude-native-compatibility-and-normalization.md) and the Compatibility row of
[DECISIONS.md](../../DECISIONS.md)
Superseded by: none

## Context

Every host-version check was exact equality with no override (Claude 2.1.287, Codex
0.160.0). The owner's installed hosts are Claude Code 2.1.289 and codex-cli 0.160.1,
and hosts auto-update, so Ariadne could not run on them and would break on every
update. The 0.160.1 app-server JSON schema regenerated offline with
`codex app-server generate-json-schema --experimental` is byte-identical to the
vendored 0.160.0 schema.

## Decision

One shared rule per host, implemented once in Rust
(`ariadne_agent_protocol::host_version`) and once in the Claude plugin
(`hostVersionStatus` in `hooks/contracts.js`). The qualified baselines, 2.1.287
and 0.160.0, are the minimum required versions.

- Components compare numerically (major, minor, patch). Exactly the baseline is
  qualified. Any version above it, including a newer minor or major (2.2.0, 3.0.0,
  0.161.0, 1.0.0), is accepted and `untested` (`Compatibility::Untested`). The
  untested notice is informational and blocks nothing.
- A version below the minimum or an unparsable version is rejected with the
  existing error codes, the message stating "requires Claude Code 2.1.287 or
  newer" or "requires Codex 0.160.0 or newer".
- Claude requires the SDK engine version to equal the CLI version. Codex applies the
  rule to the CLI version and to the daemon `userAgent` independently; either being
  above the baseline makes the pair untested.
- There is no environment or flag override.
- Numeric components must be plain decimals without leading zeros (`2.1.0288` and
  `02.1.287` are rejected).
- The untested state is surfaced where each path can observe it:
  - Discovery candidate rows: Codex rows carry `Compatibility::Untested` when the CLI
    or daemon is newer than the minimum; Claude rows carry it when the announced host
    version is newer. Baseline rows stay `Unknown` (unqualified until bound). A failed
    bind attempt re-derives the row's compatibility from its host version with the
    same rule, so a rejected row stays `Incompatible`. A Claude
    row with a rejected version (older than the minimum, unparsable) carries
    `Compatibility::Incompatible` and the desktop app disables "Use host session" for
    it. Codex rejected versions never open a reader, so they produce no row.
  - Qualified bindings and `ProbeResult.compatibility` carry `Untested`.
  - `ProbeResult.setup_steps` carries the notice, naming the newer side (the Codex
    CLI or the Codex daemon). The desktop app shows it only where a caller runs the
    adapter probe; discovery rows show the compatibility value only.
  - `ariadne doctor` reports a warning, never a failure.

  Wording: "Claude Code 2.1.289 is newer than the tested 2.1.287; it should work, but
  has not been verified."
- Runtime safety is unchanged: wire or parse mismatches still fail closed into the
  existing uncertain/blocked states. The Codex wire generator and the 0.160.0
  contracts and fixtures are untouched.

## Consequences

`Compatibility` gains `untested`; core binding admission accepts `compatible` and
`untested`. Raising a baseline still needs conformance and live existing-session
evidence. A newer version that changes a wire shape fails at runtime, not at the
version gate.

Risk accepted: a future host release may change undocumented surfaces (the Claude
Mod SDK, the private Codex app-server wire). Ariadne does not block on that at the
version gate. Delivery then stops in the existing visible blocked or uncertain
states, because wire and parse mismatches still fail closed.

## Spec references

- [Process and protocols, Claude adapter](../planning/low-level/PROCESS_AND_PROTOCOLS.md#3-claude-code-21287-adapter)
- [Setup and delivery, supported hosts](../planning/low-level/SETUP_AND_DELIVERY.md#2-supported-hosts-and-preflight)
