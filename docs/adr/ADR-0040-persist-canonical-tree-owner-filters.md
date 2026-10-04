# ADR-0040: Persist canonical tree owner filters

Status: accepted for the early P4.4 tree module.

The tree needs durable owner filtering, while the published UI preferences omit
that category. Add required `ViewFilters.owners: Vec<ItemOwner>` using the existing
domain owner union. An empty list means all owners; exact selected values combine
with OR and other filter categories with AND. Preserve Other.name bytes and its
existing nonblank/NUL-free constraint. Existing request bounds still apply. These
preferences have no production writer or shipped user-data version, so update
fixtures and generated contracts directly without defaults or migration machinery.

The tree writes through NavigationStore and the existing typed preference patches.
`saveSessionView(view, expectedPreferencesRevision)` and
`setLater(route, later, expectedPreferencesRevision)` capture the rendered revision,
reject/refresh a local mismatch and never resubmit a stale edit automatically.
Tree changes preserve navigation-owned tab state and unrelated preferences/drafts.
Uncertain operations keep the original operation ID, revision and exact body until
explicit reconciliation. A definitive revision conflict refreshes without overwrite.

This publishes reusable renderer composition. Actual native preferences/core and
full P4.4 acceptance remain their original joins; no second writer, LocalStorage,
new wire mutation, virtualization framework or production scripted fallback is added.
