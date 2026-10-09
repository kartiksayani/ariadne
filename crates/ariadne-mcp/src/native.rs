//! Installed native composition. No default provider, owner tools or live host call.
use crate::{serve_stdio, AgentMcpService};
use ariadne_core::{
    native::{AgentResolver, NativeCoreService},
    CoreError, CoreErrorCode, QueryResult, ReadView, SessionReadResult,
};
use ariadne_domain::models::{PositiveSafeInteger, Session, UtcMillis, UuidV4};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

pub const HELP: &str = "ariadne-mcp local agent tools\nUsage: ariadne-mcp serve\n       ariadne mcp serve\n       ariadne-mcp [--help|--version]\nTools: session_read, item_messages, item_rounds, apply.\nEach tool requires an explicit registered binding_id and generation.\nARIADNE_HOME is the application data directory; default HOME/.ariadne.\nStdout contains only MCP JSON-RPC while serving.\n";

pub fn service_at(path: &Path) -> Result<AgentMcpService, CoreError> {
    let registry = AgentResolver::open_data_directory(path)?;
    let core = Arc::new(NativeCoreService::new(
        registry,
        || UuidV4::new(uuid::Uuid::new_v4().to_string()).expect("UUIDv4 generator"),
        || {
            UtcMillis::new(
                chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
            .expect("native UTC clock")
        },
        |_| {
            Err(CoreError::new(
                CoreErrorCode::Unsupported,
                "No provider verifier is composed for MCP.",
                "Use native owner setup with an installed adapter.",
            ))
        },
    ));
    let resolver = core.clone();
    let snapshots = core.clone();
    Ok(
        AgentMcpService::from_trusted_startup(
            core,
            move |binding, generation, source, attempt| {
                AgentResolver::resolve(resolver.registry(), binding, generation, source, attempt)
            },
        )?
        .with_read_notices(move |context, request, result| {
            let revision = match result {
                QueryResult::SessionRead(SessionReadResult::Items(page)) => page.snapshot_revision,
                QueryResult::SessionRead(SessionReadResult::Topics(page)) => page.snapshot_revision,
                _ => return vec![],
            };
            let snapshot = snapshots.registry().catalogue().ok().and_then(|catalogue| {
                catalogue
                    .projects
                    .into_iter()
                    .filter_map(|project| project.result.ok())
                    .filter_map(|project| project.sessions.ok())
                    .flatten()
                    .filter_map(|session| session.result.ok())
                    .find(|session| {
                        session.id == *context.session().session_id()
                            && session.project_id == *context.session().project_id()
                    })
            });
            removed_notices(snapshot.as_ref(), revision, &request.selection)
        }),
    )
}

fn removed_notices(
    session: Option<&Session>,
    revision: PositiveSafeInteger,
    selection: &ReadView,
) -> Vec<String> {
    let Some(session) = session.filter(|session| session.revision == revision) else {
        return vec!["Removed work is not shown.".into()];
    };
    let mut notices = vec![];
    if let ReadView::Items { topic_id, .. } = selection {
        let count = session
            .items
            .0
            .values()
            .filter(|item| {
                ariadne_domain::visibility::item_is_removed(session, item)
                    && topic_id
                        .as_ref()
                        .is_none_or(|topic| &item.topic_id == topic)
            })
            .count();
        if count > 0 {
            notices.push(format!("{count} removed items not shown"));
        }
    }
    let count = session
        .topics
        .0
        .values()
        .filter(|topic| ariadne_domain::visibility::topic_is_removed(session, topic))
        .count();
    if count > 0 {
        notices.push(format!("{count} removed topics not shown"));
    }
    notices
}

fn home() -> Result<PathBuf, CoreError> {
    std::env::var_os("ARIADNE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".ariadne")))
        .ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::InvalidArgument,
                "Set ARIADNE_HOME or HOME for the local application data directory.",
                "Use an explicit trusted local application data directory.",
            )
        })
}
pub fn run(args: &[&str]) -> i32 {
    match args {
        [] | ["--help" | "-h"] => {
            print!("{HELP}");
            0
        }
        ["--version" | "-V"] => {
            println!("ariadne-mcp {}", env!("CARGO_PKG_VERSION"));
            0
        }
        ["serve"] => {
            let service = match home().and_then(|path| service_at(&path)) {
                Ok(service) => service,
                Err(error) => {
                    eprintln!("{:?}: {}", error.code, error.message);
                    return error.code.cli_exit();
                }
            };
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(_) => {
                    eprintln!("Local MCP runtime could not start.");
                    return 4;
                }
            };
            match runtime.block_on(serve_stdio(service)) {
                Ok(()) => 0,
                Err(_) => {
                    eprintln!("MCP stdio protocol ended with an invalid or unavailable transport.");
                    4
                }
            }
        }
        _ => {
            eprintln!("Unsupported MCP request; use --help.");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removal_notices_respect_topic_scope_and_snapshot_revision() {
        let mut session: Session =
            serde_json::from_str(include_str!("../../../fixtures/domain/history/seed.json"))
                .unwrap();
        let topic = session.topics.0.keys().next().unwrap().clone();
        let view = |topic_id| ReadView::Items {
            topic_id,
            item_id: None,
            parent_item_id: None,
            statuses: vec![],
            archived: None,
        };
        session.items.0.values_mut().next().unwrap().removed_at = Some(session.updated_at.clone());
        assert_eq!(
            removed_notices(Some(&session), session.revision, &view(Some(topic.clone()))),
            ["1 removed items not shown"]
        );
        let other_topic = UuidV4::new("00000000-0000-4000-8000-000000000099").unwrap();
        assert!(
            removed_notices(Some(&session), session.revision, &view(Some(other_topic))).is_empty()
        );
        session.topics.0.get_mut(&topic).unwrap().removed_at = Some(session.updated_at.clone());
        assert_eq!(
            removed_notices(Some(&session), session.revision, &view(None)),
            ["2 removed items not shown", "1 removed topics not shown"]
        );
        assert_eq!(
            removed_notices(
                Some(&session),
                PositiveSafeInteger::new(2).unwrap(),
                &view(None)
            ),
            ["Removed work is not shown."]
        );
        assert_eq!(
            removed_notices(None, session.revision, &view(None)),
            ["Removed work is not shown."]
        );
    }
}
