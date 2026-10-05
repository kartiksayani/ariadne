# ADR-0069: Release evidence is proportionate

Status: accepted
Supersedes: part of [VERIFICATION](../planning/low-level/VERIFICATION.md) V21, V29 and the exact host-version pins in V17, V18, V26, P7.2, P7.3 and P8.1
Superseded by: none

## Context

Ariadne is a personal, single-user macOS app. The owner ruled on 2026-10-06 (see
[ADR-0068](ADR-0068-performance-budgets-are-recorded-not-gating.md)) that
disproportionate acceptance gates are pruned: test Ariadne-owned behaviour, not
macOS mechanics. The release evidence rules still demanded OS-mechanics
automation, per-row retained seeds/hashes/logs, a five-way evidence taxonomy and
exact host versions.

## Decision

- V21 (native macOS) is a short manual checklist of Ariadne-owned behaviour: a
  notification click opens the right item, the tray count matches, a second launch
  routes to the running app, and quitting keeps external sessions running.
  Permission dialogs, monitors, minimise and pin checkmarks are not automated.
- V29 and P8.1: release evidence is one link to a passing required CI run on main.
  The "every code commit" wording and per-row retention of seeds, hashes and logs
  are dropped. The CI workflow is unchanged.
- The P8.1 evidence matrix has one "evidence kind" column (test / CI run / live
  run / manual check) instead of separating mock, transport, production, live and
  native evidence per row.
- V17, V18, V26, P7.2 and P7.3 no longer pin Claude Code 2.1.287 or Codex 0.160.0
  for live runs. Live runs use the installed host version, which must be one
  Ariadne accepts; record it in the evidence. The V26 exact-version schema hash
  drift test stays. The five-input live scope is unchanged.
- V21 also checks that a project path containing spaces works and that a
  cold-start notification click opens the right item.
- V15 and V27 are unchanged. V19 stays deferred.

## Consequences

Release sign-off needs one CI link, a manual checklist and the live run, not a
per-row evidence archive. Native OS-mechanics regressions are caught by use, not a
gate.

## Spec references

- [VERIFICATION](../planning/low-level/VERIFICATION.md)
- [PERSONAL_RELEASE](../planning/PERSONAL_RELEASE.md)
- [Release evidence matrix](../planning/evidence/release/MATRIX.md)
