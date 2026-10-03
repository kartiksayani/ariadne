# ADR-0010: Classify uninstrumented Rust declarations

Status: accepted
Supersedes: [ADR-0004](ADR-0004-account-for-scaffold-coverage-sources.md)
Superseded by: none

## Context

Real serde/schema/TypeScript tests do not cause LLVM to emit source records for
DTO declarations or module facades. A disposable pinned probe demonstrated this
with serde 1.0.228, schemars 1.2.2 and ts-rs 12.0.1. Workspace xtask/helper code,
meanwhile, needs testing and measured coverage without entering the application
denominator. Comment-only classification alone cannot account for these files.
The maintainer chose a narrow AST profile and independently measured tools over
fabricated hits, broad package exclusions or a general Rust name resolver.

## Decision

Preserve ADR-0004's canonical inventory/reports, hashes, unchanged comment-only
reason, three desktop configuration paths and >=80% application floor. Add the
explicit SHA-bound declaration reason described in Development checks, validated
by pinned syn 2.0.119. Accept only facades and recursively checked data declarations,
exact qualified core/verified external derives and demonstrated safe attributes.
Ordinary Rust comments are accepted by the AST parser; legacy comment-only
byte rules remain unchanged. Reject executable items, arbitrary derives/hooks, const/generic expressions,
unknown attributes, path/cfg/inline modules and aliases of protected bindings.
Normalize raw identifier spelling for identity checks; ordinary DTO raw field
names remain data declarations.

Require each DTO's canonical library root/module ancestor chain to be SHA-declared
verified facades. A real probe proved root `extern crate attacker as serde` can
redirect even `::serde::Serialize`; rejecting extern aliases/macros and verifying
actual dependency name/version/registry/checksum prevents that escape. Plain data
type paths need structural checks; other files' executable implementations remain
measured. Do not introduce general type-name resolution.

Verify fixed tools' package/manifest/target identities and all declared application
dependency edges, including inactive optional/target/dev/build/transitive paths.
Reject local root patch/replace overrides explicitly, including inactive renamed
substitutions; active resolve nodes alone cannot establish their declared closure.
Verify the helper's actual syn registry/version/checksum binding before exclusion.
Exclude tools from the application report only; all fmt/Clippy/tests remain.
Each present fixed tool gets its own complete report and >=80% line floor.
Reuse one workspace/all-feature test run for package-selected report-only exports.
Add only honest zero-line records for verified absent declarations; never discard
actual DA or accept duplicate/contradictory zero evidence. Both canonical reports
still need genuine executable line data.

## Consequences

Hashes and narrow grammar make every source change reviewable. Unsupported DTO
syntax requires normal measurement or another explicit policy decision. Macro
expansion is not covered source evidence. Serialized-output schemas/TS do not
prove input invariants: Serde accepts missing Option keys and out-of-range u64;
domain validation remains separate. Explicit generator exports avoid test source
writes. This maintenance adds no DTOs, product behavior or generator dependencies.

## Spec references

- [Development checks](../planning/DEVELOPMENT_CHECKS.md#application-scaffold-obligations)
