use super::*;

#[test]
fn valid_strict_project_and_session_decode_to_exact_dtos() {
    let project = Project {
        schema_version: SchemaVersion::new(1).unwrap(),
        id: UuidV4::new("00000000-0000-4000-8000-000000000001").unwrap(),
        display_name: "Complete project".into(),
    };
    let bytes = encode(&project).unwrap();
    assert_eq!(decode::<Project>(&bytes).unwrap(), project);
    let session: Session = serde_json::from_str(include_str!(
        "../../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap();
    let bytes = encode(&session).unwrap();
    assert_eq!(decode::<Session>(&bytes).unwrap(), session);
}

#[test]
fn future_schema_precedes_other_typed_failures_with_the_original_last_key_semantics() {
    // These are valid JSON but invalid strict DTOs. Future-version diagnostics
    // must survive missing fields, malformed fields and unknown fields.
    for bytes in [
        br#"{"schema_version":2}"#.as_slice(),
        br#"{"schema_version":2,"id":false,"unknown":"field"}"#,
        br#"{"id":[],"schema_version":2}"#,
        br#"{"schema_version":1,"schema_version":2}"#,
        br#"{"schema_version":null,"schema_version":2}"#,
    ] {
        assert!(matches!(
            decode::<Project>(bytes),
            Err(StoreError::FutureSchema)
        ));
        assert!(matches!(
            decode::<Session>(bytes),
            Err(StoreError::FutureSchema)
        ));
    }
    for bytes in [
        br#"{"schema_version":2,"schema_version":1}"#.as_slice(),
        br#"{"schema_version":2,"schema_version":null}"#,
        br#"{"schema_version":2,"schema_version":"2"}"#,
    ] {
        assert!(matches!(
            decode::<Project>(bytes),
            Err(StoreError::InvalidSnapshot)
        ));
        assert!(matches!(
            decode::<Session>(bytes),
            Err(StoreError::InvalidSnapshot)
        ));
    }
}

#[test]
fn malformed_trailing_and_duplicate_current_json_remain_invalid() {
    for bytes in [
        br#"{"schema_version":2"#.as_slice(),
        br#"{"schema_version":2} trailing"#,
        br#"{"schema_version":2}{"schema_version":1}"#,
        br#"{"schema_version":1,"schema_version":1}"#,
        br#"{"schema_version":0}"#,
        br#"{"schema_version":"1"}"#,
        b"null",
        b"[]",
        b"",
    ] {
        assert!(matches!(
            decode::<Project>(bytes),
            Err(StoreError::InvalidSnapshot)
        ));
        assert!(matches!(
            decode::<Session>(bytes),
            Err(StoreError::InvalidSnapshot)
        ));
    }
    let current = include_str!("../../../../../fixtures/domain/history/seed.json");
    let duplicate = current.replacen(
        "\"schema_version\": 1",
        "\"schema_version\": 1, \"schema_version\": 1",
        1,
    );
    assert!(matches!(
        decode::<Session>(duplicate.as_bytes()),
        Err(StoreError::InvalidSnapshot)
    ));
    let unknown = current.replacen(
        "\"schema_version\": 1",
        "\"schema_version\": 1, \"unknown\": null",
        1,
    );
    assert!(matches!(
        decode::<Session>(unknown.as_bytes()),
        Err(StoreError::InvalidSnapshot)
    ));
}
