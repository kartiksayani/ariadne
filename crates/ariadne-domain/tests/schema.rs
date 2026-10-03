use ariadne_domain::models::*;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn check<T: JsonSchema + DeserializeOwned>(good: &[Value], bad: &[Value]) {
    let schema = schemars::generate::SchemaSettings::default()
        .for_serialize()
        .into_generator()
        .into_root_schema_for::<T>();
    let schema = serde_json::to_value(schema).unwrap();
    let validator = jsonschema::draft202012::options()
        .should_validate_formats(true)
        .build(&schema)
        .unwrap();
    for (values, expected) in [(good, true), (bad, false)] {
        for value in values {
            assert_eq!(validator.is_valid(value), expected, "schema {value}");
            assert_eq!(
                serde_json::from_value::<T>(value.clone()).is_ok(),
                expected,
                "Rust {value}"
            );
        }
    }
}

#[test]
fn primitive_schemas_enforce_actual_wire_constraints() {
    let max = 9_007_199_254_740_991_u64;
    check::<PositiveSafeInteger>(
        &[json!(1), json!(max)],
        &[json!(0), json!(max + 1), json!(1.5), json!("1")],
    );
    check::<NonnegativeSafeInteger>(
        &[json!(0), json!(max)],
        &[json!(-1), json!(max + 1), json!(1.5)],
    );
    check::<SchemaVersion>(&[json!(1)], &[json!(0), json!(2), json!("1")]);
    check::<Sha256>(
        &[json!("a".repeat(64))],
        &[
            json!("A".repeat(64)),
            json!("a".repeat(63)),
            json!(format!("{}\n", "a".repeat(64))),
        ],
    );
    check::<RequestRef>(
        &[json!("A"), json!("a".repeat(32))],
        &[
            json!("1a"),
            json!("a".repeat(33)),
            json!("a-b"),
            json!("A\n"),
        ],
    );
    check::<UuidV4>(
        &[json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")],
        &[
            json!("aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"),
            json!("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
            json!("aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa"),
            json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n"),
        ],
    );
    check::<ItemRef>(
        &[json!("1.2"), json!("9007199254740991.999999999999999")],
        &[
            json!("01"),
            json!("0"),
            json!("1.0"),
            json!("1..2"),
            json!("9007199254740992"),
            json!("9999999999999999"),
            json!("1.2\n"),
            json!("１"),
        ],
    );
}

#[test]
fn generated_map_schema_rejects_invalid_typed_keys() {
    check::<BTreeMap<UuidV4, String>>(
        &[
            json!({"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa":"value"}),
            json!({}),
        ],
        &[
            json!({"invalid":"value"}),
            json!({"aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa":"value"}),
            json!({"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA":"value"}),
        ],
    );
    check::<BTreeMap<ItemRef, String>>(
        &[json!({"9007199254740991.2":"value"})],
        &[
            json!({"9007199254740992":"value"}),
            json!({"01":"value"}),
            json!({"1.0":"value"}),
            json!({"1\n":"value"}),
        ],
    );
}

#[test]
fn item_reference_schema_matches_safe_integer_decimal_boundaries() {
    let max = 9_007_199_254_740_991_u64;
    let mut good = Vec::new();
    for value in [
        1,
        9,
        10,
        999_999_999_999_999,
        1_000_000_000_000_000,
        max - 1,
        max,
    ] {
        good.push(json!(value.to_string()));
        good.push(json!(format!("1.{value}.2")));
    }
    check::<ItemRef>(
        &good,
        &[
            json!((max + 1).to_string()),
            json!(format!("1.{}.2", max + 1)),
            json!("9999999999999999"),
            json!("10000000000000000"),
            json!("01.2"),
            json!("1.02"),
        ],
    );
}

#[test]
fn datetime_format_assertion_and_canonical_round_trip_agree() {
    check::<UtcMillis>(
        &[
            json!("0000-02-29T23:59:60.123Z"),
            json!("1900-02-28T23:59:60.123Z"),
            json!("2000-02-29T23:59:60.123Z"),
            json!("2023-02-28T23:59:60.123Z"),
            json!("2024-02-29T23:59:60.123Z"),
            json!("2024-01-31T23:59:60.999Z"),
            json!("2024-04-30T23:59:60.001Z"),
            json!("9999-12-31T23:59:60.123Z"),
            json!("2024-02-28T23:59:59.123Z"),
            json!("0000-02-28T23:59:60.123Z"),
            json!("2000-02-28T23:59:60.123Z"),
            json!("2024-02-28T23:59:60.123Z"),
            json!("2024-04-29T23:59:60.123Z"),
        ],
        &[
            json!("1900-02-29T23:59:60.123Z"),
            json!("2024-04-31T23:59:60.123Z"),
            json!("2024-02-29T12:34:60.123Z"),
            json!("2024-02-29T23:58:60.123Z"),
            json!("2024-02-29T23:59:60.123Z\n"),
            json!("2024-02-29T12:34:56.123+00:00"),
            json!("2024-02-29t12:34:56.123z"),
            json!("2024-02-29T12:34:56.12Z"),
            json!("+10000-01-01T00:00:00.000Z"),
            json!("2023-02-29T12:34:56.123Z"),
            json!("2024-02-29T24:00:00.123Z"),
            json!("2024-02-29T23:60:00.123Z"),
            json!("2024-02-29T12:34:61.123Z"),
        ],
    );
}
