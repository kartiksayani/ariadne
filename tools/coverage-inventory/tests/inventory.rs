use ariadne_coverage_inventory::{verify, Request};
use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};

const ROOT: &str = "crates/domain/src/lib.rs";
const MODEL: &str = "crates/domain/src/models.rs";
fn request(source: &str) -> Request {
    let sources = BTreeMap::from([
        (
            ROOT.into(),
            "pub mod models; pub use models::{Counter, Record};".into(),
        ),
        (MODEL.into(), source.into()),
    ]);
    Request {
        inventory: sources.keys().cloned().collect(),
        sources,
        roots: vec![ROOT.into()],
    }
}
fn cli(input: &str) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_ariadne-coverage-inventory"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}
#[test]
fn real_dto_profile_returns_exact_qualified_providers() {
    let source = r#"
/* ordinary comments do not execute */
#[derive(::core::fmt::Debug, ::core::cmp::PartialEq, ::core::cmp::Eq, ::core::clone::Clone, ::serde::Serialize, ::serde::Deserialize, ::schemars::JsonSchema, ::ts_rs::TS)]
pub struct Counter(#[schemars(range(min = 1, max = 9007199254740991u64))] pub u64);
#[derive(::serde::Serialize, ::serde::Deserialize, ::schemars::JsonSchema, ::ts_rs::TS)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum State { Ready, Complete { answer: String }, Other(String) }
#[derive(::serde::Serialize, ::serde::Deserialize, ::schemars::JsonSchema, ::ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub r#type: String,
    pub id: ::uuid::Uuid,
    pub at: ::chrono::DateTime<::chrono::Utc>,
    pub count: Counter,
    pub note: Option<String>,
    pub labels: Vec<String>,
    pub values: ::std::collections::BTreeMap<String, State>,
    pub state: State,
}
/// Pure data alias.
pub type Reference = crate::other::Data;
pub type Local = self::Record;
pub type Parent = super::Data;
"#;
    let result = verify(request(source)).unwrap();
    assert_eq!(result[MODEL], ["schemars", "serde", "ts_rs"]);
    assert!(result[ROOT].is_empty());
    assert_eq!(verify(request(source)).unwrap(), result);
}
#[test]
fn ordinary_comments_and_literal_docs_are_allowed_but_malformed_rust_is_not() {
    for source in [
        "// line\npub struct Empty;",
        "/* outer /* nested */ end */ pub struct Empty;",
        "#[doc = \"/* string contents */\"] pub struct Empty;",
    ] {
        assert!(verify(request(source)).is_ok(), "{source}");
    }
    for source in [
        "/* unterminated",
        "pub struct",
        "#[doc = include_str!(\"file\")] pub struct Empty;",
        "#![allow(dead_code)] pub struct Empty;",
        "#!/tool\npub struct Empty;",
    ] {
        assert!(verify(request(source)).is_err(), "{source}");
    }
}
#[test]
fn map_keys_follow_the_existing_argument_free_dto_path_grammar() {
    for key in [
        "String",
        "ItemRef",
        "crate::ids::Key",
        "self::Key",
        "super::Key",
        "::uuid::Uuid",
    ] {
        let source = format!("pub struct Maps {{ values: ::std::collections::BTreeMap<{key}, Vec<Option<String>>> }}");
        assert!(verify(request(&source)).is_ok(), "{key}");
    }
}
#[test]
fn executable_items_and_nested_expression_types_cannot_be_classified() {
    for source in [
        "pub fn execute() {}",
        "pub struct Empty; impl Empty { pub const X: u64 = run(); }",
        "pub const X: u64 = 1;",
        "pub static X: u64 = 1;",
        "pub trait Service {}",
        "extern crate attacker as serde; pub struct Empty;",
        "macro_rules! items { () => {} }",
        "pub union Data { field: u64 }",
        "pub enum Data { Variant = 1 }",
        "pub struct Data<T>(T);",
        "pub type Data<const N: usize> = u64;",
        "pub struct Data where String: Clone { value: String }",
        "pub struct Data { value: [u64; run()] }",
        "pub struct Data { value: [u64; 4] }",
        "pub struct Data { value: <Foo as Bar>::Value }",
        "pub struct Data { value: Vec<3> }",
        "pub struct Data { value: Vec<Item = String> }",
        "pub struct Data { value: Vec<'static> }",
        "pub struct Data { value: Vec<fn()> }",
        "pub struct Data { value: &String }",
        "pub struct Data { value: make_type!() }",
        "pub struct Data { value: crate::Wrapper<CONST> }",
        "pub struct Data { value: crate::Wrapper<String> }",
        "pub struct Data { value: Vec<Vec<{ run() }>> }",
        "pub struct Data { value: ::other::Type }",
        "pub struct Data { value: Vec<> }",
        "pub struct Data { value: Option<String, u64> }",
        "pub struct Data { value: Option }",
        "pub struct Data { value: ::std::collections::BTreeMap<Option<String>, String> }",
        "pub struct Data { value: ::std::collections::BTreeMap<crate::Key<String>, String> }",
        "pub struct Data { value: ::std::collections::BTreeMap<crate::Key<{ run() }>, String> }",
        "pub struct Data { value: ::std::collections::BTreeMap<make_type!(), String> }",
        "pub struct Data { value: ::std::collections::BTreeMap<fn(), String> }",
        "pub struct Data { value: ::std::collections::BTreeMap<<Key as Trait>::Id, String> }",
        "pub struct Data { value: ::std::collections::BTreeMap<String, Option<fn()>> }",
        "pub struct Data { value: ::chrono::DateTime<String> }",
        "pub struct Data { value: module::Type }",
        "pub struct Data { value: Vec::<String> }",
        "pub struct Data { value: crate::Wrapper<String>::Nested }",
    ] {
        assert!(verify(request(source)).is_err(), "{source}");
    }
}
#[test]
fn derives_and_serde_schema_hooks_have_no_alias_or_unknown_attribute_escape() {
    for attribute in [
        "#[derive(Serialize)]",
        "#[derive(::attacker::Serialize)]",
        "#[derive(::serde::Serialize<String>)]",
        "#[derive(::serde::Serialize, ::serde::Serialize)]",
        "#[derive()]",
        "#[serde(with = \"hook\")]",
        "#[serde(deserialize_with = \"hook\")]",
        "#[serde(serialize_with = \"hook\")]",
        "#[serde(default = \"hook\")]",
        "#[serde(default)]",
        "#[serde(crate = \"attacker\")]",
        "#[serde(flatten)]",
        "#[serde(from = \"Other\")]",
        "#[serde(deny_unknown_fields, deny_unknown_fields)]",
        "#[serde()]",
        "#[serde(tag = \"status\")]",
        "#[schemars(schema_with = \"hook\")]",
        "#[schemars(required)]",
        "#[ts(export)]",
        "#[cfg(any())]",
        "#[repr(C)]",
        "#[unknown]",
    ] {
        let source = format!("{attribute} pub struct Data {{ value: String }}");
        assert!(verify(request(&source)).is_err(), "{source}");
    }
    for attribute in [
        "#[serde(tag = \"other\")]",
        "#[serde(rename_all = \"kebab-case\")]",
        "#[serde(tag = \"status\", tag = \"status\")]",
    ] {
        assert!(verify(request(&format!("{attribute} pub enum State {{ Ready }}"))).is_err());
    }
    for attribute in [
        "#[schemars(range(min = 0, max = 9007199254740991u64))]",
        "#[schemars(range(min = 1, max = run()))]", "#[schemars(range(min = 1))]",
        "#[schemars(range(min = 1, min = 1, max = 9007199254740991u64))]",
        "#[schemars(with = \"Other\")]", "#[schemars()]",
        "#[schemars(range(min = 1, max = 9007199254740991u64), range(min = 1, max = 9007199254740991u64))]",
    ] { assert!(verify(request(&format!("pub struct Counter({attribute} pub u64);"))).is_err(), "{attribute}"); }
    assert!(verify(request(
        "pub enum State { #[serde(rename = \"other\")] Ready }"
    ))
    .is_err());
    assert!(verify(request(
        "pub struct Data { #[serde(default)] field: String }"
    ))
    .is_err());
    assert!(verify(request(
        "#[derive(::serde::Serialize)] #[derive(::serde::Serialize)] pub struct Data;"
    ))
    .is_err());
}
#[test]
fn facade_namespace_cannot_generate_or_bind_protected_derives() {
    for source in [
        "extern crate attacker as serde; pub mod models;",
        "use attacker as serde; pub mod models;",
        "pub use attacker as serde; pub mod models;",
        "pub use attacker::*; pub mod models;",
        "pub use attacker::serde; pub mod models;",
        "pub use attacker::serde::{self}; pub mod models;",
        "pub use attacker::{Serialize, Other}; pub mod models;",
        "pub mod serde; pub mod models;",
        "pub mod r#serde; pub mod models;",
        "pub use attacker::r#serde; pub mod models;",
        "pub use attacker::r#core::{self}; pub mod models;",
        "pub use attacker::r#Serialize; pub mod models;",
        "#[macro_use] pub mod attacker; pub mod models;",
        "items!(); pub mod models;",
        "#[path = \"elsewhere.rs\"] pub mod models;",
        "pub mod models { pub struct Data; }",
        "mod models;",
        "pub struct Root; pub mod models;",
        "unsafe pub mod models;",
    ] {
        let mut req = request("pub struct Data;");
        req.sources.insert(ROOT.into(), source.into());
        assert!(verify(req).is_err(), "{source}");
    }
    assert!(verify(request("use ::serde::Serialize; pub struct Data;")).is_err());
    assert!(verify(request("pub use crate::Data; pub struct Data;")).is_err());
}
#[test]
fn both_real_module_layouts_and_nested_ancestors_require_complete_verified_chain() {
    for parent in [
        "crates/domain/src/models.rs",
        "crates/domain/src/models/mod.rs",
    ] {
        let child = "crates/domain/src/models/nested.rs";
        let sources = BTreeMap::from([
            (ROOT.into(), "pub mod models;".into()),
            (
                parent.into(),
                "pub mod nested; pub use nested::{Record};".into(),
            ),
            (child.into(), "pub struct Record;".into()),
        ]);
        let req = Request {
            inventory: sources.keys().cloned().collect(),
            sources,
            roots: vec![ROOT.into()],
        };
        assert_eq!(verify(req).unwrap().len(), 3);
    }
    let mut req = request("pub struct Record;");
    req.inventory
        .insert("crates/domain/src/models/mod.rs".into());
    assert!(verify(req).is_err());
    let mut req = request("pub struct Record;");
    req.inventory.remove(MODEL);
    assert!(verify(req).is_err());
    let mut req = request("pub struct Record;");
    req.sources.remove(ROOT);
    assert!(verify(req).is_err());
    let mut req = request("pub struct Record;");
    req.sources.insert(ROOT.into(), "pub struct Root;".into());
    assert!(verify(req).is_err());
    let mut req = request("pub struct Record;");
    req.sources.insert(ROOT.into(), "pub mod hidden;".into());
    req.inventory.insert("crates/domain/src/hidden.rs".into());
    assert!(verify(req).is_err());
    let mut req = request("pub struct Record;");
    req.roots.push(ROOT.into());
    assert!(verify(req).is_err());
    let mut req = request("pub struct Record;");
    req.sources.insert(
        "crates/domain/src/models/nested.rs".into(),
        "pub struct Extra;".into(),
    );
    req.inventory
        .insert("crates/domain/src/models/nested.rs".into());
    req.sources.remove(MODEL);
    assert!(verify(req).is_err());
}
#[test]
fn executable_children_are_kept_in_inventory_without_becoming_declarations() {
    let mut req = request("pub struct Record;");
    req.sources
        .insert(ROOT.into(), "pub mod models; pub mod runtime;".into());
    req.inventory.insert("crates/domain/src/runtime.rs".into());
    assert_eq!(verify(req).unwrap().len(), 2);
    let mut req = request("pub struct Record;");
    req.sources
        .insert(ROOT.into(), "pub mod models; pub mod missing;".into());
    assert!(verify(req).is_err());
}
#[test]
fn cli_has_real_success_and_failure_exit_codes() {
    let value = serde_json::json!({"sources": {ROOT: "pub mod models;", MODEL: "#[derive(::serde::Serialize)] pub struct Record;"}, "roots": [ROOT], "inventory": [ROOT, MODEL]});
    let output = cli(&value.to_string());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: BTreeMap<String, Vec<String>> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response[MODEL], ["serde"]);
    for input in [
        "not json",
        "{}",
        "{\"sources\":{},\"roots\":[],\"inventory\":[],\"extra\":true}",
    ] {
        let output = cli(input);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
    let mut value = value;
    value["sources"][MODEL] = serde_json::json!("pub fn execute() {}");
    assert!(!cli(&value.to_string()).status.success());
}
