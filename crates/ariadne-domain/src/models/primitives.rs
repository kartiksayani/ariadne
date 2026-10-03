use chrono::Timelike;
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::borrow::Cow;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const UUID_PATTERN: &str =
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])";
const UTC_PATTERN: &str =
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z(?![\s\S])";

macro_rules! string_primitive {
    ($name:ident, $valid:ident, $schema:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, ts_rs::TS)]
        #[ts(type = "string")]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, String> {
                let value = value.into();
                if $valid(&value) {
                    Ok(Self(value))
                } else {
                    Err(concat!("Invalid ", stringify!($name)).into())
                }
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.0)
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }
        impl JsonSchema for $name {
            fn schema_name() -> Cow<'static, str> {
                stringify!($name).into()
            }
            fn json_schema(_: &mut SchemaGenerator) -> Schema {
                $schema()
            }
        }
    };
}

string_primitive!(UuidV4, valid_uuid, uuid_schema);
string_primitive!(ItemRef, valid_item_ref, item_schema);
string_primitive!(UtcMillis, valid_utc, utc_schema);
string_primitive!(Sha256, valid_sha256, sha256_schema);
string_primitive!(RequestRef, valid_request_ref, request_schema);

fn valid_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| {
        id.get_version_num() == 4
            && id.get_variant() == uuid::Variant::RFC4122
            && id.hyphenated().to_string() == value
    })
}
fn valid_item_ref(value: &str) -> bool {
    value.split('.').all(|segment| {
        segment
            .parse::<u64>()
            .is_ok_and(|n| n > 0 && n <= MAX_SAFE_INTEGER && n.to_string() == segment)
    })
}
fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn valid_request_ref(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=32).contains(&bytes.len())
        && bytes[0].is_ascii_alphabetic()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}
fn valid_utc(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|time| {
        time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true) == value
            // Match JSON Schema's UTC date-time assertion for second 60.
            && (time.nanosecond() < 1_000_000_000 || (time.hour() == 23 && time.minute() == 59))
    })
}

fn uuid_schema() -> Schema {
    schemars::json_schema!({"type": "string", "format": "uuid", "pattern": UUID_PATTERN})
}
fn sha256_schema() -> Schema {
    schemars::json_schema!({"type": "string", "pattern": r"^[0-9a-f]{64}(?![\s\S])"})
}
fn request_schema() -> Schema {
    schemars::json_schema!({"type": "string", "pattern": r"^[A-Za-z][A-Za-z0-9_]{0,31}(?![\s\S])"})
}
fn item_schema() -> Schema {
    // A bounded decimal alternative, reused for every segment, including map keys.
    let maximum = MAX_SAFE_INTEGER.to_string();
    let mut alternatives = vec!["[1-9][0-9]{0,14}".to_string()];
    for (index, digit) in maximum.bytes().enumerate() {
        let minimum = if index == 0 { b'1' } else { b'0' };
        if digit > minimum {
            let upper = digit - 1;
            let choice = if upper == minimum {
                char::from(minimum).to_string()
            } else {
                format!("[{}-{}]", char::from(minimum), char::from(upper))
            };
            alternatives.push(format!(
                "{}{}[0-9]{{{}}}",
                &maximum[..index],
                choice,
                maximum.len() - index - 1
            ));
        }
    }
    alternatives.push(maximum);
    let segment = format!("(?:{})", alternatives.join("|"));
    let pattern = format!(r"^{segment}(?:\.{segment})*(?![\s\S])");
    schemars::json_schema!({"type": "string", "pattern": pattern})
}
fn utc_schema() -> Schema {
    schemars::json_schema!({
        "type": "string", "format": "date-time", "pattern": UTC_PATTERN
    })
}

macro_rules! integer_primitive {
    ($name:ident, $minimum:literal, $maximum:expr, $ts:literal) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, ts_rs::TS)]
        #[ts(type = $ts)]
        pub struct $name(u64);
        impl $name {
            pub fn new(value: u64) -> Result<Self, String> {
                if ($minimum..=$maximum).contains(&value) {
                    Ok(Self(value))
                } else {
                    Err(concat!("Invalid ", stringify!($name)).into())
                }
            }
            pub fn value(self) -> u64 {
                self.0
            }
        }
        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_u64(self.0)
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                struct IntegerVisitor;
                impl<'de> serde::de::Visitor<'de> for IntegerVisitor {
                    type Value = $name;

                    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                        write!(formatter, "an integer in {}..={}", $minimum, $maximum)
                    }

                    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<$name, E> {
                        $name::new(value).map_err(E::custom)
                    }

                    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<$name, E> {
                        self.visit_u64(u64::try_from(value).map_err(E::custom)?)
                    }

                    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<$name, E> {
                        if !value.is_finite()
                            || value.fract() != 0.0
                            || value < $minimum as f64
                            || value > $maximum as f64
                        {
                            return Err(E::custom(concat!("Invalid ", stringify!($name))));
                        }
                        self.visit_u64(value as u64)
                    }
                }
                deserializer.deserialize_any(IntegerVisitor)
            }
        }
        impl JsonSchema for $name {
            fn schema_name() -> Cow<'static, str> {
                stringify!($name).into()
            }
            fn json_schema(_: &mut SchemaGenerator) -> Schema {
                schemars::json_schema!({"type": "integer", "minimum": $minimum, "maximum": $maximum})
            }
        }
    };
}
integer_primitive!(SchemaVersion, 1, 1, "1");
integer_primitive!(PositiveSafeInteger, 1, MAX_SAFE_INTEGER, "number");
integer_primitive!(NonnegativeSafeInteger, 0, MAX_SAFE_INTEGER, "number");
