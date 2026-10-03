#[derive(
    ::core::fmt::Debug,
    ::core::cmp::PartialEq,
    ::serde::Serialize,
    ::serde::Deserialize,
    ::schemars::JsonSchema,
    ::ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    WaitingOnMe,
    OwnerInput,
}

#[derive(
    ::core::fmt::Debug,
    ::core::cmp::PartialEq,
    ::serde::Serialize,
    ::serde::Deserialize,
    ::schemars::JsonSchema,
    ::ts_rs::TS,
)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Owner {
    Me {},
    Agent { binding_id: ::uuid::Uuid },
}

#[derive(::core::fmt::Debug, ::core::cmp::PartialEq, ::serde::Serialize, ::serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum UnitOwner {
    Me,
}

#[derive(
    ::core::fmt::Debug,
    ::core::cmp::PartialEq,
    ::core::cmp::Eq,
    ::serde::Serialize,
    ::serde::Deserialize,
    ::schemars::JsonSchema,
    ::ts_rs::TS,
)]
pub struct ItemRef(pub String);

#[derive(
    ::core::fmt::Debug,
    ::core::cmp::PartialEq,
    ::serde::Serialize,
    ::serde::Deserialize,
    ::schemars::JsonSchema,
    ::ts_rs::TS,
)]
#[serde(deny_unknown_fields)]
pub struct Maps {
    pub uuid_map: ::std::collections::BTreeMap<::uuid::Uuid, ::uuid::Uuid>,
    pub item_map: ::std::collections::BTreeMap<ItemRef, ItemRef>,
}
