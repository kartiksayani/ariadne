//! Executable wire validation; kept in application coverage.
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::de::{Error, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Number, Value};
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt;
use std::marker::PhantomData;

/// Deterministically serialized map that rejects duplicate keys on read.
#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema, ts_rs::TS)]
#[serde(transparent)]
#[ts(type = "{ [key in K & string]?: V }")]
#[ts(bound = "K: ts_rs::TS, V: ts_rs::TS")]
pub struct UniqueMap<K: Ord, V>(pub BTreeMap<K, V>);

impl<'de, K: Ord + Deserialize<'de>, V: Deserialize<'de>> Deserialize<'de> for UniqueMap<K, V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct MapVisitor<K, V>(PhantomData<(K, V)>);
        impl<'de, K: Ord + Deserialize<'de>, V: Deserialize<'de>> Visitor<'de> for MapVisitor<K, V> {
            type Value = UniqueMap<K, V>;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("an object with unique keys")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut map = BTreeMap::new();
                while let Some((key, value)) = access.next_entry()? {
                    if map.insert(key, value).is_some() {
                        return Err(A::Error::custom("duplicate map key"));
                    }
                }
                Ok(UniqueMap(map))
            }
        }
        deserializer.deserialize_map(MapVisitor(PhantomData))
    }
}

/// Adapter checkpoint: at most 4096 UTF-8 bytes. Schema's character bound is
/// necessary but not sufficient for this byte bound.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(transparent)]
#[ts(type = "string")]
pub struct Checkpoint(String);

impl Checkpoint {
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        let value = value.into();
        if value.len() <= 4096 {
            Ok(Self(value))
        } else {
            Err("Checkpoint exceeds 4096 UTF-8 bytes".into())
        }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl<'de> Deserialize<'de> for Checkpoint {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}
impl JsonSchema for Checkpoint {
    fn schema_name() -> Cow<'static, str> {
        "Checkpoint".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({"type":"string","maxLength":4096,
            "description":"At most 4096 UTF-8 bytes; maxLength only bounds Unicode characters."})
    }
}

// Preserve the library's canonical JSON value representation while checking
// arbitrary nested configuration objects before duplicate keys can be lost.
struct UniqueJson(Value);
impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = UniqueJson;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("JSON with unique object keys")
            }
            fn visit_unit<E: Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Null))
            }
            fn visit_bool<E: Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Bool(value)))
            }
            fn visit_i64<E: Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Number(Number::from(value))))
            }
            fn visit_u64<E: Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Number(Number::from(value))))
            }
            fn visit_f64<E: Error>(self, value: f64) -> Result<Self::Value, E> {
                Number::from_f64(value)
                    .map(|number| UniqueJson(Value::Number(number)))
                    .ok_or_else(|| E::custom("non-finite JSON number"))
            }
            fn visit_str<E: Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::String(value.into())))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(UniqueJson(value)) = access.next_element()? {
                    values.push(value);
                }
                Ok(UniqueJson(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, access: A) -> Result<Self::Value, A::Error> {
                let map = UniqueMap::<String, UniqueJson>::deserialize(
                    serde::de::value::MapAccessDeserializer::new(access),
                )?;
                Ok(UniqueJson(Value::Object(
                    map.0
                        .into_iter()
                        .map(|(key, UniqueJson(value))| (key, value))
                        .collect(),
                )))
            }
        }
        deserializer.deserialize_any(JsonVisitor)
    }
}

pub(crate) fn deserialize_config_values<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<UniqueMap<String, Value>, D::Error> {
    let values = UniqueMap::<String, UniqueJson>::deserialize(deserializer)?;
    Ok(UniqueMap(
        values
            .0
            .into_iter()
            .map(|(key, UniqueJson(value))| (key, value))
            .collect(),
    ))
}
