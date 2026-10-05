# Claude Mod conformance evidence

`mod-events.json` is frozen output from the actual `lifecycle` producer and `claimLoop.stop` at `2026-10-04T00:00:00.123Z`. The JS consumer test regenerates these values in memory with a deterministic test clock and verifies exact wire values. Rust deserializes the same fixture through the real canonical `NormalizedEvent` DTO and validator; it does not reconstruct facts from text or silently retarget callbacks.

The nested receipt is supplied to the canonical lifecycle constructor solely to test DTO conformance. Actual Mod acceptance still uses receipt:null; this fixture is not evidence of a new host receipt source. Three terminal snapshots deliberately share identity and disagree in status, preserving facts for Core conflict handling.

The SDK baseline is the preserved 2.1.287 header's `plugin:{name,root}` loaded identity and actual callback shapes. `plugin.version` is not an SDK field. The native adapter uses an explicit trusted evidence seam planned for P3.7, with no production fake or second lifecycle transport. Temporary executable/resource fixtures test read-only native boundaries without launching Claude or issuing paid calls. Observed 2.1.289 (and any version above the 2.1.287 minimum) is accepted as untested, not qualified (ADR-0071). See ADR0037 and the archived Mod proof linked from PROCESS section3.
