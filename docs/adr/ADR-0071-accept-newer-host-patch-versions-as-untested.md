# ADR-0071: Accept newer host patch versions as untested

Status: accepted by the maintainer under the owner's standing ruling that a
personal-use app must not be blocked by disproportionate gates; the owner may veto
before publication.
Supersedes: the exact-equality host-version clauses of
[ADR-0035](ADR-0035-captured-claude-mod-lifecycle.md) and the Compatibility row of
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
(`hostVersionStatus` in `hooks/contracts.js`). The qualified baselines stay 2.1.287
and 0.160.0.

- Same major.minor and a patch at or above the baseline is accepted; a patch above
  the baseline is `untested` (`Compatibility::Untested`).
- A different major or minor, an older patch or an unparsable version is rejected
  with the existing error codes, the message stating the accepted range.
- Claude requires the SDK engine version to equal the CLI version. Codex applies the
  rule to the CLI version and to the daemon `userAgent` independently; either being
  above the baseline makes the pair untested.
- There is no environment or flag override.
- The untested state is visible, never silent: `ProbeResult.compatibility` and a
  setup step, `ariadne doctor` (a warning, never a failure), and the discovery
  candidate row. Wording: "Claude Code 2.1.289 is newer than the tested 2.1.287; it
  should work, but has not been verified."
- Runtime safety is unchanged: wire or parse mismatches still fail closed into the
  existing uncertain/blocked states. The Codex wire generator and the 0.160.0
  contracts and fixtures are untouched.

## Consequences

`Compatibility` gains `untested`; core binding admission accepts `compatible` and
`untested`. Raising a baseline still needs conformance and live existing-session
evidence. A newer patch that changes a wire shape fails at runtime, not at the
version gate.

## Spec references

- [Process and protocols, Claude adapter](../planning/low-level/PROCESS_AND_PROTOCOLS.md#3-claude-code-21287-adapter)
- [Setup and delivery, supported hosts](../planning/low-level/SETUP_AND_DELIVERY.md#2-supported-hosts-and-preflight)
