use ariadne_coverage_inventory::{verify, Request};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::BTreeMap;
use ts_rs::TS;

mod dto {
    include!("fixtures/dto.rs");
}
use dto::{ItemRef, Maps, Owner, Status, UnitOwner};

// Executable ordering is outside the classified pure-declaration fixture.
impl Ord for ItemRef {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.cmp(&other.0)
    }
}
impl PartialOrd for ItemRef {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
fn schema<T: schemars::JsonSchema>() -> Value {
    serde_json::to_value(
        schemars::generate::SchemaSettings::draft07()
            .for_serialize()
            .into_generator()
            .into_root_schema_for::<T>(),
    )
    .unwrap()
}
#[test]
fn compiled_fixture_also_passes_the_declaration_profile() {
    let root = "crates/domain/src/lib.rs";
    let model = "crates/domain/src/models.rs";
    let sources = BTreeMap::from([
        (root.into(), "pub mod models;".into()),
        (model.into(), include_str!("fixtures/dto.rs").into()),
    ]);
    let result = verify(Request {
        inventory: sources.keys().cloned().collect(),
        sources,
        roots: vec![root.into()],
    })
    .unwrap();
    assert_eq!(result[model], ["schemars", "serde", "ts_rs"]);
}
#[test]
fn canonical_tags_and_case_have_real_serde_schema_and_typescript_outputs() {
    assert_eq!(
        serde_json::to_value(Status::WaitingOnMe).unwrap(),
        json!("waiting_on_me")
    );
    assert_eq!(
        serde_json::from_value::<Status>(json!("owner_input")).unwrap(),
        Status::OwnerInput
    );
    assert_eq!(
        serde_json::to_value(Owner::Me {}).unwrap(),
        json!({"kind": "me"})
    );
    let id = uuid::Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
    let owner = Owner::Agent { binding_id: id };
    let encoded = json!({"kind": "agent", "binding_id": id});
    assert_eq!(serde_json::to_value(&owner).unwrap(), encoded);
    assert_eq!(serde_json::from_value::<Owner>(encoded).unwrap(), owner);
    assert!(serde_json::from_value::<Owner>(json!({"kind":"me", "unknown":true})).is_err());
    // A tagged unit variant does not enforce the same unknown-field behavior.
    assert!(serde_json::from_value::<UnitOwner>(json!({"kind":"me", "unknown":true})).is_ok());
    assert_eq!(
        schema::<Status>()["enum"],
        json!(["waiting_on_me", "owner_input"])
    );
    let owner_schema = schema::<Owner>();
    let variants = owner_schema["oneOf"].as_array().unwrap();
    assert_eq!(variants[0]["properties"]["kind"]["const"], json!("me"));
    assert_eq!(variants[1]["properties"]["kind"]["const"], json!("agent"));
    assert!(variants
        .iter()
        .all(|variant| variant["additionalProperties"] == json!(false)));
    let config = ts_rs::Config::new().with_large_int("number");
    assert!(Status::export_to_string(&config)
        .unwrap()
        .contains("\"waiting_on_me\" | \"owner_input\""));
    let ts = Owner::export_to_string(&config).unwrap();
    assert!(
        ts.contains("\"kind\": \"me\"")
            && ts.contains("\"kind\": \"agent\"")
            && ts.contains("binding_id: string")
    );
}
#[test]
fn typed_map_keys_encode_as_object_keys_without_claiming_lexical_validation() {
    let id = uuid::Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
    let maps = Maps {
        uuid_map: BTreeMap::from([(id, id)]),
        item_map: BTreeMap::from([(ItemRef("1.2".into()), ItemRef("3".into()))]),
    };
    let encoded = json!({"uuid_map": {id.to_string(): id}, "item_map": {"1.2": "3"}});
    assert_eq!(serde_json::to_value(&maps).unwrap(), encoded);
    assert_eq!(serde_json::from_value::<Maps>(encoded).unwrap(), maps);
    assert_eq!(
        ItemRef("1".into()).partial_cmp(&ItemRef("2".into())),
        Some(Ordering::Less)
    );
    let generated = schema::<Maps>();
    assert_eq!(generated["properties"]["uuid_map"]["type"], json!("object"));
    assert!(generated["properties"]["uuid_map"]
        .get("propertyNames")
        .is_none());
    assert_eq!(
        generated["properties"]["uuid_map"]["additionalProperties"]["format"],
        json!("uuid")
    );
    assert_eq!(generated["definitions"]["ItemRef"]["type"], json!("string"));
    let config = ts_rs::Config::new().with_large_int("number");
    assert!(ItemRef::export_to_string(&config)
        .unwrap()
        .contains("export type ItemRef = string;"));
    let ts = Maps::export_to_string(&config).unwrap();
    assert!(
        ts.contains("uuid_map: { [key in string]: string }")
            && ts.contains("item_map: { [key in ItemRef]: ItemRef }")
    );
}
