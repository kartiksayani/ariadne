# CoreService conformance cases

`cases.json` supplies typed wire requests and application envelopes for the
synchronous CoreService seam. It reuses the canonical domain demo's complete
messages, rounds, receipts and copied author provenance. `inventory.json` covers
all owner commands, read views and apply operations, including local unsent UI
preferences. IDs and content are synthetic; no host is contacted.

The core scripted producer and independent generated-schema/TypeScript consumers
read the same cases. Tests validate requests/responses, replay identity, bounded
visibility, independent history cursors and caller ordering. The shared Rust
driver in `tests/support/core_service` accepts any CoreService, so later tests can
seed a real store and run it against the actual producer.

These scripts do not prove state transitions, save atomicity, outcome joins,
reconciliation or provider behavior. Later core/store/runtime tasks retain that
semantic and native acceptance. No checkpoint advance is a core fake method;
the caller may advance only after every report in its batch succeeds. Failed
persistence retains the previous checkpoint and never authorizes resubmission.
