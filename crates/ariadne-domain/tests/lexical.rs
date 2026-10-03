use ariadne_domain::models::*;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

fn wire<T: DeserializeOwned + Serialize>(good: &[Value], bad: &[Value]) {
    for value in good {
        let parsed: T = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), *value);
    }
    for value in bad {
        assert!(
            serde_json::from_value::<T>(value.clone()).is_err(),
            "accepted {value}"
        );
    }
}

#[test]
fn identifiers_preserve_only_canonical_wire_spelling() {
    let uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    assert_eq!(UuidV4::new(uuid).unwrap().as_str(), uuid);
    wire::<UuidV4>(
        &[json!(uuid)],
        &[
            json!(uuid.to_uppercase()),
            json!("aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"),
            json!("aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa"),
            json!(uuid.replace('-', "")),
            json!(format!("{uuid}\n")),
            json!("invalid"),
            json!(null),
            json!(1),
        ],
    );
    assert_eq!(ItemRef::new("1.2").unwrap().as_str(), "1.2");
    wire::<ItemRef>(
        &[json!("1"), json!("1.2"), json!("9007199254740991.1")],
        &[
            json!(""),
            json!("0"),
            json!("01"),
            json!("1.0"),
            json!("1..2"),
            json!(".1"),
            json!("1."),
            json!("+1"),
            json!("9007199254740992"),
            json!("18446744073709551616"),
            json!("1\n"),
            json!("１"),
            json!(null),
        ],
    );
    assert_eq!(RequestRef::new("Query_9").unwrap().as_str(), "Query_9");
    wire::<RequestRef>(
        &[json!("A"), json!("a123_"), json!("a".repeat(32))],
        &[
            json!(""),
            json!("1a"),
            json!("a".repeat(33)),
            json!("a-b"),
            json!("a b"),
            json!("é"),
            json!("a\0"),
            json!("a\n"),
            json!(false),
        ],
    );
    assert_eq!(
        Sha256::new("a".repeat(64)).unwrap().as_str(),
        "a".repeat(64)
    );
    wire::<Sha256>(
        &[json!("a".repeat(64)), json!("0".repeat(64))],
        &[
            json!("A".repeat(64)),
            json!("g".repeat(64)),
            json!("a".repeat(63)),
            json!("a".repeat(65)),
            json!(format!("{}\n", "a".repeat(64))),
            json!(null),
        ],
    );
}

#[test]
fn integers_enforce_safe_bounds_and_numeric_wire_types() {
    let max = 9_007_199_254_740_991_u64;
    assert_eq!(PositiveSafeInteger::new(max).unwrap().value(), max);
    assert!(PositiveSafeInteger::new(0).is_err());
    assert_eq!(NonnegativeSafeInteger::new(0).unwrap().value(), 0);
    assert!(NonnegativeSafeInteger::new(max + 1).is_err());
    assert_eq!(SchemaVersion::new(1).unwrap().value(), 1);
    assert!(SchemaVersion::new(2).is_err());
    let bad = [
        json!(-1),
        json!(1.5),
        json!(max + 1),
        json!("1"),
        json!(null),
    ];
    wire::<PositiveSafeInteger>(
        &[json!(1), json!(max)],
        &[vec![json!(0)], bad.to_vec()].concat(),
    );
    wire::<NonnegativeSafeInteger>(&[json!(0), json!(1), json!(max)], &bad);
    wire::<SchemaVersion>(&[json!(1)], &[json!(0), json!(2), json!("1"), json!(null)]);
}

#[test]
fn integer_numeric_spellings_normalize_and_invalid_values_stay_rejected() {
    fn normalized<T: DeserializeOwned + Serialize>(wire: &str, canonical: &str) {
        let value: T = serde_json::from_str(wire).unwrap();
        assert_eq!(serde_json::to_string(&value).unwrap(), canonical);
    }

    for wire in ["1.0", "1e0", "1.00e+0"] {
        normalized::<SchemaVersion>(wire, "1");
        normalized::<PositiveSafeInteger>(wire, "1");
        normalized::<NonnegativeSafeInteger>(wire, "1");
    }
    for wire in ["0.0", "0e0", "-0.0"] {
        normalized::<NonnegativeSafeInteger>(wire, "0");
        assert!(serde_json::from_str::<PositiveSafeInteger>(wire).is_err());
        assert!(serde_json::from_str::<SchemaVersion>(wire).is_err());
    }
    for wire in ["9007199254740991.0", "9.007199254740991e15"] {
        normalized::<PositiveSafeInteger>(wire, "9007199254740991");
        normalized::<NonnegativeSafeInteger>(wire, "9007199254740991");
        assert!(serde_json::from_str::<SchemaVersion>(wire).is_err());
    }
    for wire in [
        "-1",
        "-1.0",
        "1.5",
        "9007199254740992",
        "9007199254740992.0",
        "1e300",
        "1e309",
        "\"1\"",
        "null",
    ] {
        assert!(
            serde_json::from_str::<SchemaVersion>(wire).is_err(),
            "{wire}"
        );
        assert!(
            serde_json::from_str::<PositiveSafeInteger>(wire).is_err(),
            "{wire}"
        );
        assert!(
            serde_json::from_str::<NonnegativeSafeInteger>(wire).is_err(),
            "{wire}"
        );
    }

    type Error = serde::de::value::Error;
    assert_eq!(
        PositiveSafeInteger::deserialize(serde::de::value::I64Deserializer::<Error>::new(1))
            .unwrap()
            .value(),
        1
    );
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(NonnegativeSafeInteger::deserialize(
            serde::de::value::F64Deserializer::<Error>::new(value)
        )
        .is_err());
    }
}

#[test]
fn timestamps_validate_canonical_calendar_and_utc_leap_placement() {
    let good = [
        "2024-02-29T12:34:56.123Z",
        "0000-01-01T00:00:00.000Z",
        "9999-12-31T23:59:59.999Z",
        "2016-12-31T23:59:60.000Z",
        "2024-04-30T23:59:60.001Z",
        "2023-02-28T23:59:60.123Z",
        "2000-02-29T23:59:60.123Z",
        "2024-02-28T23:59:60.123Z",
        "2024-04-29T23:59:60.123Z",
    ];
    for value in good {
        assert_eq!(UtcMillis::new(value).unwrap().as_str(), value);
    }
    wire::<UtcMillis>(
        &good.map(|s| json!(s)),
        &[
            json!("2023-02-29T12:34:56.123Z"),
            json!("2024-04-31T12:34:56.123Z"),
            json!("2024-02-29T24:00:00.123Z"),
            json!("2024-02-29T12:34:61.123Z"),
            json!("2024-02-29T12:34:56.12Z"),
            json!("2024-02-29T12:34:56.1230Z"),
            json!("2024-02-29t12:34:56.123z"),
            json!("2024-02-29T12:34:56.123+00:00"),
            json!("2024-02-29T12:34:60.123Z"),
            json!("1900-02-29T23:59:60.123Z"),
            json!("2024-04-30T23:58:60.123Z"),
            json!("+10000-01-01T00:00:00.000Z"),
            json!("-0001-01-01T00:00:00.000Z"),
            json!("2024-02-29T12:34:56Z"),
            json!("2024-02-29T12:34:56.123456Z"),
            json!("2024-02-29T12:34:56.123Z\n"),
            json!("2024-02-29T12:34:56.12éZ"),
            json!(false),
        ],
    );
}
