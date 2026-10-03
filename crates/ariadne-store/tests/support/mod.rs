use ariadne_domain::history::{append_reply, AgentHistoryContext, ReplyDraft};
use ariadne_domain::models::*;
use ariadne_store::session::{Store, TransactionError};
use serde_json::Value;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

pub fn id(number: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{number:012x}")).unwrap()
}
pub fn item(value: &str) -> ItemRef {
    ItemRef::new(value).unwrap()
}
pub fn seed() -> Session {
    serde_json::from_str(include_str!(
        "../../../../fixtures/domain/history/seed.json"
    ))
    .unwrap()
}
pub fn actor() -> ReceiptActorScope {
    ReceiptActorScope::Agent { binding_id: id(3) }
}

pub struct ProjectDir {
    pub root: TempDir,
}
impl ProjectDir {
    pub fn empty() -> Self {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join(".ariadne");
        fs::create_dir(&data).unwrap();
        fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
        let project = Project {
            schema_version: SchemaVersion::new(1).unwrap(),
            id: id(1),
            display_name: "Test-owned project".into(),
        };
        write_private(
            &data.join("project.json"),
            &serde_json::to_vec(&project).unwrap(),
        );
        Self { root }
    }
    pub fn new() -> Self {
        let project = Self::empty();
        project.store().create(&seed()).unwrap();
        project
    }
    pub fn store(&self) -> Store {
        Store::open_registered(self.root.path(), id(1)).unwrap()
    }
    pub fn live(&self) -> PathBuf {
        self.root
            .path()
            .join(format!(".ariadne/sessions/{}.json", id(2).as_str()))
    }
    pub fn backup(&self) -> PathBuf {
        self.root
            .path()
            .join(format!(".ariadne/backups/{}.previous.json", id(2).as_str()))
    }
    pub fn lock(&self) -> PathBuf {
        self.root
            .path()
            .join(format!(".ariadne/locks/{}.lock", id(2).as_str()))
    }
}

pub fn write_private(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

pub fn reply(
    session: &mut Session,
    target: &str,
    operation: u64,
    expected: Option<u64>,
) -> Result<SavedReceiptData, &'static str> {
    let item_id = item(target);
    if expected.is_some_and(|expected| session.items.0[&item_id].revision.value() != expected) {
        return Err("stale_item_revision");
    }
    let context = AgentHistoryContext {
        binding_id: id(3),
        generation: id(4),
        source_input_id: None,
        attempt_id: None,
    };
    let message_id = id(operation + 10000);
    *session = append_reply(
        session,
        &context,
        ReplyDraft {
            message_id: message_id.clone(),
            item_id: item_id.clone(),
            text: format!("Explicit reply {operation}.\nFull text is retained."),
            round_id: None,
            at: UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap(),
        },
    )
    .map_err(|_| "history")?;
    session.updated_at = UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap();
    Ok(SavedReceiptData::Apply {
        allocated_refs: UniqueMap(std::collections::BTreeMap::new()),
        messages: vec![MessageIdentity {
            id: message_id,
            number: session.messages.last().unwrap().number,
        }],
        item_revisions: UniqueMap(std::collections::BTreeMap::from([(
            item_id.clone(),
            session.items.0[&item_id].revision,
        )])),
        topic_revisions: UniqueMap(std::collections::BTreeMap::new()),
        input_result_state: None,
        queue_join_state: None,
    })
}

pub fn command(target: &str, operation: u64, expected: Option<u64>) -> Value {
    serde_json::json!({"kind":"test_reply", "item_id":target, "message_id": id(operation + 10000), "expected_revision":expected, "text":format!("Explicit reply {operation}.\nFull text is retained.")})
}

pub fn transact(
    store: &Store,
    target: &str,
    operation: u64,
    expected: Option<u64>,
) -> Result<SavedReceipt, TransactionError<&'static str>> {
    store.transact(
        &id(2),
        &actor(),
        &id(operation),
        &command(target, operation, expected),
        |session| reply(session, target, operation, expected),
    )
}
