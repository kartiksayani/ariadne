# Architecture decisions

Important product or implementation architecture gaps go to the maintainer before
dependent work. State the concrete gap, relevant spec, options and recommendation.
Routine choices within settled contracts do not need an ADR.

Record important resulting decisions in a short Markdown ADR in the affected PR:
context, decision, consequences and relevant spec links. Use [TEMPLATE](TEMPLATE.md)
and an unused ID; avoid IDs already reserved by paused work. Routine ownership/spec
updates can ride a product PR without a separate planning PR or machine declarations.

Owner requirements govern. Update affected canonical contracts alongside a decision.
When superseding an ADR, preserve its original prose, mark its status and add
reciprocal replacement links. Partial supersession must name the changed part and
retained controls. The independent reviewer and maintainer assess consistency at
the exact head; metadata does not prove judgment.

[ADR-0018](ADR-0018-recalibrate-delivery.md) retires machine receipt/ADR validation
and numeric caps while retaining meaningful tests, coverage, release controls and
independent review. Historical ADRs and delivery records remain preserved.

[ADR-0019](ADR-0019-restore-module-delivery.md) supersedes only ADR-0018's product
sequencing, restoring foundation/dependency intent and contract-ready parallel
modules while retaining its tooling, quality and review decisions.

[ADR-0060](ADR-0060-own-desktop-integration-seams.md) names desktop integration and
shared-file owners and keeps remaining delivery vertical on the assembled app.
