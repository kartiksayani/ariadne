//! Executable scalar validation stays in application coverage.
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::borrow::Cow;

pub(crate) fn nullable_patch<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ts_rs::TS)]
#[ts(type = "number")]
pub struct PageLimit(u8);
impl PageLimit {
    pub fn new(value: u64) -> Result<Self, String> {
        if (1..=100).contains(&value) {
            Ok(Self(value as u8))
        } else {
            Err("Page limit must be an integer in 1..=100".into())
        }
    }
    pub fn value(self) -> usize {
        usize::from(self.0)
    }
}
impl Serialize for PageLimit {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(self.0)
    }
}
impl<'de> Deserialize<'de> for PageLimit {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = ariadne_domain::models::PositiveSafeInteger::deserialize(deserializer)?;
        Self::new(value.value()).map_err(serde::de::Error::custom)
    }
}
impl JsonSchema for PageLimit {
    fn schema_name() -> Cow<'static, str> {
        "PageLimit".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({"type":"integer","minimum":1,"maximum":100})
    }
}

macro_rules! boolean_literal {
    ($name:ident, $value:literal, $ts:literal) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, ts_rs::TS)]
        #[ts(type = $ts)]
        pub struct $name;
        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> { serializer.serialize_bool($value) }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                if bool::deserialize(deserializer)? == $value { Ok(Self) } else { Err(serde::de::Error::custom("Invalid envelope ok flag")) }
            }
        }
        impl JsonSchema for $name {
            fn schema_name() -> Cow<'static, str> { stringify!($name).into() }
            fn json_schema(_: &mut SchemaGenerator) -> Schema { schemars::json_schema!({"type":"boolean","const":$value}) }
        }
    };
}
boolean_literal!(SuccessFlag, true, "true");
boolean_literal!(FailureFlag, false, "false");

macro_rules! envelope_deref {
    ($($name:ident($data:ty)),+ $(,)?) => { $(
        impl std::ops::Deref for crate::$name {
            type Target = crate::ApplicationEnvelope<$data>;
            fn deref(&self) -> &Self::Target { &self.0 }
        }
    )+ };
}
envelope_deref!(
    QueryEnvelope(crate::QueryResult),
    MutationEnvelope(crate::MutationReceipt),
    ApplyEnvelope(crate::ApplyReceipt),
    ClaimEnvelope(Option<crate::PreparedAttempt>),
    ReportEnvelope(crate::EventReceipt)
);
