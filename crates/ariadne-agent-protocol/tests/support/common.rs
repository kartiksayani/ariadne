use crate::*;

pub fn id(digit: char) -> UuidV4 {
    UuidV4::new(format!("{0}{0}{0}{0}{0}{0}{0}{0}-{0}{0}{0}{0}-4{0}{0}{0}-8{0}{0}{0}-{0}{0}{0}{0}{0}{0}{0}{0}{0}{0}{0}{0}", digit)).unwrap()
}
pub fn events() -> Vec<NormalizedEvent> {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/contracts/adapter/events.json"
    )))
    .unwrap()
}
pub fn observe() -> ObserveRequest {
    ObserveRequest {
        binding_id: id('a'),
        generation: id('b'),
        checkpoint: None,
        limit: ObserveLimit::new(100).unwrap(),
    }
}
pub fn reconcile() -> ReconcileRequest {
    ReconcileRequest {
        binding_id: id('a'),
        generation: id('f'),
        checkpoint: None,
        attempts: vec![AttemptEvidenceRequest {
            input_id: id('c'),
            attempt_id: id('d'),
            binding_generation: id('b'),
            payload_sha256: Sha256::new("a".repeat(64)).unwrap(),
            wire_marker: "persisted-marker".into(),
            host_turn_id: None,
        }],
    }
}
